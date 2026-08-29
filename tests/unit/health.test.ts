import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import healthModule from "../../utils/health.js";

// These tests read Health Auto Export files off disk rather than talking to any
// Apple app, so unlike the integration suites they run anywhere.

type Json = Record<string, unknown>;

let root: string;

async function writeExport(
	directory: string,
	fileName: string,
	payload: Json,
	modified?: Date,
): Promise<string> {
	await fs.mkdir(directory, { recursive: true });
	const path = join(directory, fileName);
	await fs.writeFile(path, JSON.stringify(payload), "utf8");
	if (modified) {
		await fs.utimes(path, modified, modified);
	}
	return path;
}

function metric(name: string, units: string, data: Json[]): Json {
	return { name, units, data };
}

beforeAll(async () => {
	root = await fs.mkdtemp(join(tmpdir(), "apple-mcp-health-"));
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("Health Auto Export parsing", () => {
	describe("listMetrics", () => {
		it("reports every metric with units, sample counts and date range", async () => {
			const directory = join(root, "list-metrics");
			await writeExport(directory, "export.json", {
				data: {
					metrics: [
						metric("step_count", "count", [
							{ date: "2024-01-15 00:00:00 +0000", qty: 8421, source: "iPhone" },
							{ date: "2024-01-16 00:00:00 +0000", qty: 10233, source: "iPhone" },
						]),
						metric("blood_pressure", "mmHg", [
							{
								date: "2024-01-15 08:00:00 +0000",
								systolic: 118,
								diastolic: 76,
							},
						]),
					],
					workouts: [],
				},
			});

			const result = await healthModule.listMetrics(directory);
			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.metrics.map((entry) => entry.name)).toEqual([
				"blood_pressure",
				"step_count",
			]);

			const steps = result.metrics.find((entry) => entry.name === "step_count");
			expect(steps?.units).toBe("count");
			expect(steps?.sampleCount).toBe(2);
			expect(steps?.first?.getTime()).toBe(Date.UTC(2024, 0, 15));
			expect(steps?.last?.getTime()).toBe(Date.UTC(2024, 0, 16));

			// Composite metrics expose their individual numbers as fields.
			const pressure = result.metrics.find(
				(entry) => entry.name === "blood_pressure",
			);
			expect(pressure?.fields).toEqual(["diastolic", "systolic"]);
		});
	});

	describe("query", () => {
		let directory: string;

		beforeAll(async () => {
			directory = join(root, "query");
			// No UTC offset, so these are read as local time and bucket into the
			// named calendar day regardless of the machine's time zone.
			await writeExport(directory, "export.json", {
				data: {
					metrics: [
						metric("step_count", "count", [
							{ date: "2024-03-01 09:00:00", qty: 1000 },
							{ date: "2024-03-01 18:00:00", qty: 2000 },
							{ date: "2024-03-02 09:00:00", qty: 500 },
							{ date: "2024-03-03 09:00:00", qty: 4000 },
						]),
						metric("blood_pressure", "mmHg", [
							{ date: "2024-03-01 08:00:00", systolic: 120, diastolic: 80 },
							{ date: "2024-03-02 08:00:00", systolic: 130, diastolic: 84 },
						]),
					],
				},
			});
		});

		it("returns raw samples newest first", async () => {
			const result = await healthModule.queryMetric({
				metric: "step_count",
				directory,
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.totalMatched).toBe(4);
			expect(result.samples?.map((sample) => sample.qty)).toEqual([
				4000, 500, 2000, 1000,
			]);
		});

		it("honours the limit, keeping the most recent samples", async () => {
			const result = await healthModule.queryMetric({
				metric: "step_count",
				limit: 2,
				directory,
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.totalMatched).toBe(4);
			expect(result.samples?.map((sample) => sample.qty)).toEqual([4000, 500]);
		});

		it("filters by date range inclusively", async () => {
			const result = await healthModule.queryMetric({
				metric: "step_count",
				startDate: "2024-03-02",
				endDate: "2024-03-02",
				directory,
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.totalMatched).toBe(1);
			expect(result.samples?.[0]?.qty).toBe(500);
		});

		it("groups by day with sum, average, min and max", async () => {
			const result = await healthModule.queryMetric({
				metric: "step_count",
				aggregation: "daily",
				directory,
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.buckets).toEqual([
				{ period: "2024-03-01", count: 2, sum: 3000, avg: 1500, min: 1000, max: 2000 },
				{ period: "2024-03-02", count: 1, sum: 500, avg: 500, min: 500, max: 500 },
				{ period: "2024-03-03", count: 1, sum: 4000, avg: 4000, min: 4000, max: 4000 },
			]);
		});

		it("collapses everything into one bucket for 'total'", async () => {
			const result = await healthModule.queryMetric({
				metric: "step_count",
				aggregation: "total",
				directory,
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.buckets).toHaveLength(1);
			expect(result.buckets?.[0]?.sum).toBe(7500);
			expect(result.buckets?.[0]?.count).toBe(4);
		});

		it("aggregates a named field of a composite metric", async () => {
			const result = await healthModule.queryMetric({
				metric: "blood_pressure",
				aggregation: "total",
				field: "systolic",
				directory,
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.buckets?.[0]?.avg).toBe(125);
			expect(result.buckets?.[0]?.max).toBe(130);
		});

		it("matches metric names loosely", async () => {
			const result = await healthModule.queryMetric({
				metric: "Step Count",
				directory,
			});

			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.metric).toBe("step_count");
		});

		it("matches a plural request against a singular metric name", async () => {
			const result = await healthModule.queryMetric({
				metric: "steps",
				directory,
			});

			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.metric).toBe("step_count");
		});

		it("lists the available metrics when nothing resembles the request", async () => {
			const result = await healthModule.queryMetric({
				metric: "vo2max",
				directory,
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.message).toContain("Available metrics");
			expect(result.message).toContain("step_count");
		});

		it("offers the near misses when a request is ambiguous", async () => {
			const ambiguous = join(root, "ambiguous");
			await writeExport(ambiguous, "export.json", {
				data: {
					metrics: [
						metric("heart_rate", "bpm", [
							{ date: "2024-03-01 09:00:00", qty: 70 },
						]),
						metric("resting_heart_rate", "bpm", [
							{ date: "2024-03-01 06:00:00", qty: 55 },
						]),
					],
				},
			});

			const result = await healthModule.queryMetric({
				metric: "heart_rate",
				directory: ambiguous,
			});

			// An exact name wins even though it is also a substring of the other.
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.metric).toBe("heart_rate");

			const vague = await healthModule.queryMetric({
				metric: "heart",
				directory: ambiguous,
			});

			expect(vague.success).toBe(false);
			if (vague.success) return;
			expect(vague.message).toContain("Did you mean");
			expect(vague.message).toContain("resting_heart_rate");
		});

		it("rejects an unparseable date boundary", async () => {
			const result = await healthModule.queryMetric({
				metric: "step_count",
				startDate: "last tuesday",
				directory,
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.message).toContain("startDate");
		});
	});

	describe("overlapping exports", () => {
		it("keeps the newest file's value instead of double counting", async () => {
			const directory = join(root, "overlap");

			// Health Auto Export re-exports overlapping windows, so the same
			// timestamp routinely appears in more than one file.
			await writeExport(
				directory,
				"older.json",
				{
					data: {
						metrics: [
							metric("step_count", "count", [
								{ date: "2024-05-01 12:00:00 +0000", qty: 100 },
								{ date: "2024-05-02 12:00:00 +0000", qty: 200 },
							]),
						],
					},
				},
				new Date("2024-05-02T00:00:00Z"),
			);

			await writeExport(
				directory,
				"newer.json",
				{
					data: {
						metrics: [
							metric("step_count", "count", [
								// Same instant as above, corrected upward.
								{ date: "2024-05-02 12:00:00 +0000", qty: 250 },
								{ date: "2024-05-03 12:00:00 +0000", qty: 300 },
							]),
						],
					},
				},
				new Date("2024-05-04T00:00:00Z"),
			);

			const result = await healthModule.queryMetric({
				metric: "step_count",
				aggregation: "total",
				directory,
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.totalMatched).toBe(3);
			expect(result.buckets?.[0]?.sum).toBe(650);
		});
	});

	describe("workouts", () => {
		it("parses names, durations and quantity fields", async () => {
			const directory = join(root, "workouts");
			await writeExport(directory, "export.json", {
				data: {
					metrics: [],
					workouts: [
						{
							name: "Outdoor Run",
							start: "2024-02-10 07:00:00 +0000",
							end: "2024-02-10 07:45:00 +0000",
							duration: 2700,
							distance: { qty: 8.1, units: "km" },
							activeEnergyBurned: { qty: 540, units: "kJ" },
						},
						{
							name: "Yoga",
							start: "2024-02-12 18:00:00 +0000",
							end: "2024-02-12 18:30:00 +0000",
							duration: 1800,
						},
					],
				},
			});

			const result = await healthModule.listWorkouts({ directory });
			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.totalMatched).toBe(2);
			// Newest first.
			expect(result.workouts[0]?.name).toBe("Yoga");

			const run = result.workouts[1];
			expect(run?.name).toBe("Outdoor Run");
			expect(run?.durationSeconds).toBe(2700);
			expect(run?.quantities.distance).toEqual({ qty: 8.1, units: "km" });
			expect(run?.start?.getTime()).toBe(Date.UTC(2024, 1, 10, 7, 0, 0));
		});

		it("filters workouts by date range", async () => {
			const result = await healthModule.listWorkouts({
				startDate: "2024-02-11",
				directory: join(root, "workouts"),
			});

			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.totalMatched).toBe(1);
			expect(result.workouts[0]?.name).toBe("Yoga");
		});
	});

	describe("summary", () => {
		it("reports one row per metric plus a workout count", async () => {
			const directory = join(root, "summary");
			await writeExport(directory, "export.json", {
				data: {
					metrics: [
						metric("step_count", "count", [
							{ date: "2024-04-01 12:00:00", qty: 5000 },
							{ date: "2024-04-02 12:00:00", qty: 7000 },
						]),
						metric("resting_heart_rate", "bpm", [
							{ date: "2024-04-01 12:00:00", qty: 58 },
							{ date: "2024-04-02 12:00:00", qty: 62 },
						]),
						metric("blood_pressure", "mmHg", [
							{ date: "2024-04-01 08:00:00", systolic: 120, diastolic: 80 },
							{ date: "2024-04-02 08:00:00", systolic: 124, diastolic: 82 },
						]),
					],
					workouts: [
						{ name: "Walk", start: "2024-04-01 09:00:00", duration: 600 },
					],
				},
			});

			const result = await healthModule.getSummary({ directory });
			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.workoutCount).toBe(1);

			const steps = result.metrics.find((row) => row.name === "step_count");
			expect(steps?.sum).toBe(12000);

			const heartRate = result.metrics.find(
				(row) => row.name === "resting_heart_rate",
			);
			expect(heartRate?.avg).toBe(60);
			expect(heartRate?.min).toBe(58);
			expect(heartRate?.max).toBe(62);
			expect(heartRate?.field).toBe("qty");
		});

		it("summarises a composite metric on one of its fields", async () => {
			const result = await healthModule.getSummary({
				directory: join(root, "summary"),
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			// blood_pressure has no `qty`, so it must still appear rather than
			// being silently dropped from the digest.
			const pressure = result.metrics.find(
				(row) => row.name === "blood_pressure",
			);
			expect(pressure).toBeDefined();
			expect(pressure?.field).toBe("diastolic");
			expect(pressure?.min).toBe(80);
			expect(pressure?.max).toBe(82);
		});

		it("narrows to the requested window", async () => {
			const result = await healthModule.getSummary({
				startDate: "2024-04-02",
				directory: join(root, "summary"),
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			const steps = result.metrics.find((row) => row.name === "step_count");
			expect(steps?.count).toBe(1);
			expect(steps?.sum).toBe(7000);
		});
	});

	describe("sources", () => {
		it("lists usable files and explains the ones it skipped", async () => {
			const directory = join(root, "sources");
			await writeExport(directory, "good.json", {
				data: {
					metrics: [
						metric("step_count", "count", [
							{ date: "2024-06-01 12:00:00", qty: 42 },
						]),
					],
				},
			});
			await writeExport(directory, "unrelated.json", { hello: "world" });
			await fs.writeFile(join(directory, "broken.json"), "{not json", "utf8");

			const result = await healthModule.getSources(directory);
			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.files).toHaveLength(1);
			expect(result.metricCount).toBe(1);
			expect(result.skipped).toHaveLength(2);
			expect(
				result.skipped.some((entry) => entry.reason.includes("unreadable JSON")),
			).toBe(true);
			expect(
				result.skipped.some((entry) =>
					entry.reason.includes("not a Health Auto Export file"),
				),
			).toBe(true);
		});

		it("finds exports in nested subfolders", async () => {
			const directory = join(root, "nested");
			await writeExport(join(directory, "2024", "06"), "export.json", {
				data: {
					metrics: [
						metric("step_count", "count", [
							{ date: "2024-06-01 12:00:00", qty: 99 },
						]),
					],
				},
			});

			const result = await healthModule.getSources(directory);
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.files).toHaveLength(1);
		});

		it("accepts a payload that is not nested under 'data'", async () => {
			const directory = join(root, "flat");
			await writeExport(directory, "export.json", {
				metrics: [
					metric("step_count", "count", [
						{ date: "2024-07-01 12:00:00", qty: 7 },
					]),
				],
			});

			const result = await healthModule.listMetrics(directory);
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.metrics[0]?.name).toBe("step_count");
		});
	});

	describe("configuration errors", () => {
		it("explains how to set up exports when the folder is missing", async () => {
			const result = await healthModule.listMetrics(
				join(root, "does-not-exist"),
			);

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.message).toContain("No Health Auto Export folder found");
			expect(result.message).toContain("APPLE_MCP_HEALTH_DIR");
		});

		it("says so when the folder holds no export files", async () => {
			const directory = join(root, "empty");
			await fs.mkdir(directory, { recursive: true });

			const result = await healthModule.listMetrics(directory);
			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.message).toContain("no readable Health Auto Export JSON");
		});
	});
});
