import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import tools from "../../tools.js";

// These tests validate the MCP surface rather than any Apple app: the shape of
// the tool definitions, and how the running server answers bad requests. They
// need no permissions and run anywhere.

const ROOT = join(import.meta.dir, "..", "..");

type ToolResult = {
	content?: { type: string; text: string }[];
	isError?: boolean;
};

/** Minimal newline-delimited JSON-RPC client over the server's stdio. */
class McpClient {
	private process: ChildProcessWithoutNullStreams | undefined;
	private buffer = "";
	private nextId = 1;
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();

	async start(): Promise<void> {
		const child = spawn("bun", ["run", "index.ts"], {
			cwd: ROOT,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;

		child.stdout.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString();
			let newline = this.buffer.indexOf("\n");
			while (newline !== -1) {
				const line = this.buffer.slice(0, newline).trim();
				this.buffer = this.buffer.slice(newline + 1);
				if (line) {
					this.handleLine(line);
				}
				newline = this.buffer.indexOf("\n");
			}
		});

		await this.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "handler-tests", version: "1.0.0" },
		});
		this.notify("notifications/initialized");
	}

	private handleLine(line: string): void {
		let message: { id?: number; result?: unknown; error?: { message: string } };
		try {
			message = JSON.parse(line);
		} catch {
			return; // Server logs go to stderr; ignore anything unparseable.
		}
		if (typeof message.id !== "number") {
			return;
		}
		const waiter = this.pending.get(message.id);
		if (!waiter) {
			return;
		}
		this.pending.delete(message.id);
		if (message.error) {
			waiter.reject(new Error(message.error.message));
		} else {
			waiter.resolve(message.result);
		}
	}

	private send(payload: Record<string, unknown>): void {
		this.process?.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	private notify(method: string): void {
		this.send({ jsonrpc: "2.0", method });
	}

	request(method: string, params: unknown = {}): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for ${method}`));
			}, 15000);

			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	async callTool(name: string, args: unknown): Promise<ToolResult> {
		return (await this.request("tools/call", {
			name,
			arguments: args,
		})) as ToolResult;
	}

	stop(): void {
		this.process?.kill();
	}
}

describe("MCP tool definitions", () => {
	it("exposes a non-empty tool list", () => {
		expect(Array.isArray(tools)).toBe(true);
		expect(tools.length).toBeGreaterThan(0);
	});

	it("gives every tool a unique, well-formed name", () => {
		const names = tools.map((tool) => tool.name);
		expect(new Set(names).size).toBe(names.length);

		for (const name of names) {
			expect(name).toMatch(/^[a-z][a-z0-9_-]*$/);
		}
	});

	it("gives every tool a description and an object input schema", () => {
		for (const tool of tools) {
			expect(typeof tool.description).toBe("string");
			expect(tool.description!.length).toBeGreaterThan(0);
			expect(tool.inputSchema.type).toBe("object");
			expect(tool.inputSchema.properties).toBeDefined();
		}
	});

	it("documents every property with a type and a description", () => {
		for (const tool of tools) {
			const properties = (tool.inputSchema.properties ?? {}) as Record<
				string,
				{ type?: unknown; description?: unknown }
			>;

			for (const [key, schema] of Object.entries(properties)) {
				expect(typeof schema.type, `${tool.name}.${key} type`).toBe("string");
				expect(
					typeof schema.description,
					`${tool.name}.${key} description`,
				).toBe("string");
			}
		}
	});

	it("only marks properties that exist as required", () => {
		for (const tool of tools) {
			const properties = Object.keys(tool.inputSchema.properties ?? {});
			const required = (tool.inputSchema.required ?? []) as string[];

			for (const key of required) {
				expect(properties, `${tool.name} requires "${key}"`).toContain(key);
			}
		}
	});

	it("constrains every operation parameter to an enum and requires it", () => {
		for (const tool of tools) {
			const properties = (tool.inputSchema.properties ?? {}) as Record<
				string,
				{ enum?: unknown }
			>;
			const operation = properties.operation;
			if (!operation) {
				continue;
			}

			expect(Array.isArray(operation.enum), `${tool.name}.operation enum`).toBe(
				true,
			);
			expect((operation.enum as string[]).length).toBeGreaterThan(0);
			expect(tool.inputSchema.required as string[]).toContain("operation");
		}
	});

	it("matches the tools declared in the DXT manifest", () => {
		// The .dxt package advertises its own tool list, which silently drifts
		// from tools.ts when a tool is added in one place only.
		const manifest = JSON.parse(
			readFileSync(join(ROOT, "manifest.json"), "utf8"),
		) as { tools: { name: string; description: string }[] };

		expect(manifest.tools.map((tool) => tool.name).sort()).toEqual(
			tools.map((tool) => tool.name).sort(),
		);
	});
});

describe("MCP request handling", () => {
	let client: McpClient;

	beforeAll(async () => {
		client = new McpClient();
		await client.start();
	});

	afterAll(() => {
		client?.stop();
	});

	it("advertises every tool over tools/list", async () => {
		const result = (await client.request("tools/list")) as {
			tools: { name: string }[];
		};

		expect(result.tools.map((tool) => tool.name).sort()).toEqual(
			tools.map((tool) => tool.name).sort(),
		);
	});

	it("reports an unknown tool as an error instead of crashing", async () => {
		const result = await client.callTool("not_a_real_tool", {});

		expect(result.isError).toBe(true);
		expect(result.content?.[0]?.text).toContain("Unknown tool");
	});

	it("rejects arguments that fail the type guard", async () => {
		const result = await client.callTool("health", {
			operation: "definitely_not_an_operation",
		});

		expect(result.isError).toBe(true);
		expect(result.content?.[0]?.text).toContain("Invalid arguments");
	});

	it("rejects an operation that is missing a required parameter", async () => {
		// query needs a metric; the guard should refuse before any file is read.
		const result = await client.callTool("health", { operation: "query" });

		expect(result.isError).toBe(true);
		expect(result.content?.[0]?.text).toContain("Invalid arguments");
	});

	it("reports a failure as an error result rather than a transport error", async () => {
		const result = await client.callTool("health", {
			operation: "listMetrics",
			directory: "/definitely/not/a/health/folder",
		});

		expect(result.isError).toBe(true);
		expect(result.content?.[0]?.text).toContain("No Health Auto Export folder");
	});

	it("stays responsive after handling bad requests", async () => {
		const result = (await client.request("tools/list")) as {
			tools: { name: string }[];
		};

		expect(result.tools.length).toBe(tools.length);
	});
});
