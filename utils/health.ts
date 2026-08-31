import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Configuration
const CONFIG = {
	// Guards against walking an entire iCloud Drive if a user points the tool
	// at a very broad directory.
	MAX_SCAN_DEPTH: 4,
	MAX_FILES: 500,
	MAX_FILE_BYTES: 64 * 1024 * 1024,
	// Cap on raw samples handed back for a single query so a multi-year export
	// cannot blow up the MCP response.
	MAX_SAMPLES: 1000,
	MAX_WORKOUTS: 200,
	// Parsed exports are cached per-directory and invalidated when any file's
	// size or mtime changes, so repeated queries do not re-read the archive.
	CACHE_TTL_MS: 30_000,
};

// Environment variable used to point the tool at the folder that the Health
// Auto Export app writes into. This is the most reliable way to locate the
// exports, because the destination folder is chosen by the user inside the
// app; the candidate paths below are best-effort fallbacks.
const DIR_ENV_VAR = "APPLE_MCP_HEALTH_DIR";

const ICLOUD_ROOT = join(homedir(), "Library", "Mobile Documents");

// Best-effort locations, tried in order when no directory is configured.
function candidateDirectories(): string[] {
	const home = homedir();
	const cloudDocs = join(ICLOUD_ROOT, "com~apple~CloudDocs");
	return [
		join(cloudDocs, "HealthAutoExport"),
		join(cloudDocs, "Health Auto Export"),
		join(cloudDocs, "HealthExport"),
		join(home, "Dropbox", "Apps", "HealthAutoExport"),
		join(home, "Dropbox", "Health Auto Export"),
		join(home, "Documents", "HealthAutoExport"),
		join(home, "Downloads", "HealthAutoExport"),
	];
}

type Quantity = {
	qty: number;
	units?: string;
};

type MetricSample = {
	date: Date;
	// Simple metrics carry a single `qty`. Composite ones (blood pressure,
	// sleep analysis) carry several named numbers instead, so both are kept.
	qty?: number;
	fields: Record<string, number>;
	source?: string;
};

type Metric = {
	name: string;
	units: string;
	samples: MetricSample[];
};

type Workout = {
	name: string;
	start?: Date;
	end?: Date;
	durationSeconds?: number;
	quantities: Record<string, Quantity>;
	source?: string;
};

type ExportFile = {
	path: string;
	modified: Date;
	metricNames: string[];
	workoutCount: number;
};

type ExportData = {
	directory: string;
	files: ExportFile[];
	metrics: Map<string, Metric>;
	workouts: Workout[];
	skipped: { path: string; reason: string }[];
};

type Bucket = {
	period: string;
	count: number;
	sum: number;
	avg: number;
	min: number;
	max: number;
};

type Aggregation = "none" | "daily" | "weekly" | "monthly" | "total";

type Result<T> = ({ success: true } & T) | { success: false; message: string };

/**
 * Parse the timestamps that Health Auto Export writes, e.g.
 * "2024-01-15 07:30:00 +0000". That layout is not valid ISO 8601 and is parsed
 * inconsistently across JS engines, so it is normalised by hand. Plain ISO
 * strings are accepted too. A timestamp without an offset is read as local
 * time, matching how the app records it.
 */
function parseHealthDate(value: unknown): Date | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	const match = trimmed.match(
		/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,6}))?\s*(Z|[+-]\d{2}:?\d{2})?$/,
	);

	if (!match) {
		const fallback = new Date(trimmed);
		return Number.isNaN(fallback.getTime()) ? undefined : fallback;
	}

	const [, year, month, day, hour, minute, second, fraction, offset] = match;
	const millis = fraction ? `.${fraction.padEnd(3, "0").slice(0, 3)}` : "";
	let zone = "";
	if (offset === "Z") {
		zone = "Z";
	} else if (offset) {
		zone = offset.includes(":")
			? offset
			: `${offset.slice(0, 3)}:${offset.slice(3)}`;
	}

	const iso = `${year}-${month}-${day}T${hour}:${minute}:${second ?? "00"}${millis}${zone}`;
	const parsed = new Date(iso);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Parse a user-supplied date boundary. Accepts anything parseHealthDate does,
 * plus a bare "YYYY-MM-DD". A bare day is anchored to the start of that local
 * day as a start boundary and to the end of it as an end boundary, so a range
 * of "2024-03-01" to "2024-03-02" covers both days in full rather than
 * stopping at midnight.
 */
function parseBoundary(
	value: string | undefined,
	edge: "start" | "end" = "start",
): Date | undefined {
	if (!value) {
		return undefined;
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
		const [year, month, day] = value.trim().split("-").map(Number);
		return edge === "end"
			? new Date(year as number, (month as number) - 1, day as number, 23, 59, 59, 999)
			: new Date(year as number, (month as number) - 1, day as number);
	}
	return parseHealthDate(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toQuantity(value: unknown): Quantity | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return { qty: value };
	}
	if (
		isRecord(value) &&
		typeof value.qty === "number" &&
		Number.isFinite(value.qty)
	) {
		return {
			qty: value.qty,
			units: typeof value.units === "string" ? value.units : undefined,
		};
	}
	return undefined;
}

/**
 * Turn one entry of a metric's `data` array into a sample. Every finite number
 * on the entry is kept as a field, which keeps composite metrics such as
 * blood_pressure (systolic/diastolic) and sleep_analysis (deep/rem/awake)
 * usable without hard-coding a schema per metric.
 */
function parseSample(entry: unknown): MetricSample | undefined {
	if (!isRecord(entry)) {
		return undefined;
	}

	const date = parseHealthDate(entry.date) ?? parseHealthDate(entry.startDate);
	if (!date) {
		return undefined;
	}

	const fields: Record<string, number> = {};
	for (const [key, raw] of Object.entries(entry)) {
		if (typeof raw === "number" && Number.isFinite(raw)) {
			fields[key] = raw;
		}
	}

	const sample: MetricSample = { date, fields };
	if (typeof entry.qty === "number" && Number.isFinite(entry.qty)) {
		sample.qty = entry.qty;
	}
	if (typeof entry.source === "string") {
		sample.source = entry.source;
	}
	return sample;
}

function parseWorkout(entry: unknown): Workout | undefined {
	if (!isRecord(entry)) {
		return undefined;
	}

	const name =
		typeof entry.name === "string"
			? entry.name
			: typeof entry.workoutActivityType === "string"
				? entry.workoutActivityType
				: undefined;
	const start = parseHealthDate(entry.start) ?? parseHealthDate(entry.startDate);
	if (!name && !start) {
		return undefined;
	}

	const quantities: Record<string, Quantity> = {};
	for (const [key, raw] of Object.entries(entry)) {
		if (
			key === "duration" ||
			key === "name" ||
			key === "start" ||
			key === "end"
		) {
			continue;
		}
		const quantity = toQuantity(raw);
		if (quantity) {
			quantities[key] = quantity;
		}
	}

	return {
		name: name ?? "Workout",
		start,
		end: parseHealthDate(entry.end) ?? parseHealthDate(entry.endDate),
		durationSeconds:
			typeof entry.duration === "number" && Number.isFinite(entry.duration)
				? entry.duration
				: undefined,
		quantities,
		source: typeof entry.source === "string" ? entry.source : undefined,
	};
}

/**
 * Health Auto Export nests its payload under `data`, but shortcut- and
 * webhook-driven exports sometimes write the bare object. Both are accepted.
 */
function extractPayload(json: unknown): Record<string, unknown> | undefined {
	if (!isRecord(json)) {
		return undefined;
	}
	if (isRecord(json.data)) {
		return json.data;
	}
	if (Array.isArray(json.metrics) || Array.isArray(json.workouts)) {
		return json;
	}
	return undefined;
}

async function walkForJson(
	directory: string,
	depth: number,
	found: string[],
): Promise<void> {
	if (depth > CONFIG.MAX_SCAN_DEPTH || found.length >= CONFIG.MAX_FILES) {
		return;
	}

	let entries: Awaited<ReturnType<typeof fs.readdir>>;
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (found.length >= CONFIG.MAX_FILES) {
			return;
		}
		if (entry.name.startsWith(".")) {
			continue;
		}
		const full = join(directory, entry.name);
		if (entry.isDirectory()) {
			await walkForJson(full, depth + 1, found);
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
			found.push(full);
		}
	}
}

async function directoryExists(candidate: string): Promise<boolean> {
	try {
		const stats = await fs.stat(candidate);
		return stats.isDirectory();
	} catch {
		return false;
	}
}

/**
 * Look for a Health Auto Export iCloud container, whose folder name varies by
 * app version (iCloud~com~...~HealthAutoExport). Matching on the name avoids
 * guessing the exact bundle identifier.
 */
async function findICloudContainer(): Promise<string | undefined> {
	let entries: Awaited<ReturnType<typeof fs.readdir>>;
	try {
		entries = await fs.readdir(ICLOUD_ROOT, { withFileTypes: true });
	} catch {
		return undefined;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || !/healthautoexport/i.test(entry.name)) {
			continue;
		}
		const documents = join(ICLOUD_ROOT, entry.name, "Documents");
		if (await directoryExists(documents)) {
			return documents;
		}
		return join(ICLOUD_ROOT, entry.name);
	}
	return undefined;
}

async function resolveDirectory(
	explicit?: string,
): Promise<{ directory?: string; searched: string[] }> {
	const searched: string[] = [];

	if (explicit) {
		const expanded = explicit.startsWith("~")
			? join(homedir(), explicit.slice(1))
			: explicit;
		searched.push(expanded);
		return {
			directory: (await directoryExists(expanded)) ? expanded : undefined,
			searched,
		};
	}

	const fromEnv = process.env[DIR_ENV_VAR];
	if (fromEnv) {
		searched.push(fromEnv);
		if (await directoryExists(fromEnv)) {
			return { directory: fromEnv, searched };
		}
	}

	const container = await findICloudContainer();
	if (container) {
		searched.push(container);
		return { directory: container, searched };
	}

	for (const candidate of candidateDirectories()) {
		searched.push(candidate);
		if (await directoryExists(candidate)) {
			return { directory: candidate, searched };
		}
	}

	return { searched };
}

// Cache of parsed exports keyed by directory, invalidated by file signature.
const cache = new Map<
	string,
	{ signature: string; expires: number; data: ExportData }
>();

/**
 * Read and merge every export file in a directory. Later files win when two
 * exports contain the same metric sample, because Health Auto Export commonly
 * re-exports overlapping windows and the newest file holds the corrected data.
 */
async function loadExports(directory: string): Promise<ExportData> {
	const paths: string[] = [];
	await walkForJson(directory, 0, paths);

	const stats = await Promise.all(
		paths.map(async (path) => {
			try {
				const stat = await fs.stat(path);
				return { path, size: stat.size, modified: stat.mtime };
			} catch {
				return undefined;
			}
		}),
	);

	const usable = stats.filter(
		(entry): entry is { path: string; size: number; modified: Date } =>
			entry !== undefined,
	);
	usable.sort((a, b) => a.modified.getTime() - b.modified.getTime());

	const signature = usable
		.map((entry) => `${entry.path}:${entry.size}:${entry.modified.getTime()}`)
		.join("|");
	const cached = cache.get(directory);
	if (cached && cached.signature === signature && cached.expires > Date.now()) {
		return cached.data;
	}

	const metrics = new Map<string, Metric>();
	// Keyed by metric name and timestamp so a later file overwrites an earlier
	// sample for the same instant instead of double counting it.
	const sampleIndex = new Map<string, { metric: string; sample: MetricSample }>();
	const workoutIndex = new Map<string, Workout>();
	const files: ExportFile[] = [];
	const skipped: { path: string; reason: string }[] = [];

	for (const entry of usable) {
		if (entry.size > CONFIG.MAX_FILE_BYTES) {
			skipped.push({ path: entry.path, reason: "file larger than 64MB" });
			continue;
		}

		let payload: Record<string, unknown> | undefined;
		try {
			payload = extractPayload(
				JSON.parse(await fs.readFile(entry.path, "utf8")),
			);
		} catch (error) {
			skipped.push({
				path: entry.path,
				reason: `unreadable JSON: ${error instanceof Error ? error.message : String(error)}`,
			});
			continue;
		}

		if (!payload) {
			skipped.push({
				path: entry.path,
				reason: "not a Health Auto Export file",
			});
			continue;
		}

		const metricNames: string[] = [];
		if (Array.isArray(payload.metrics)) {
			for (const rawMetric of payload.metrics) {
				if (!isRecord(rawMetric) || typeof rawMetric.name !== "string") {
					continue;
				}
				const name = rawMetric.name;
				const units = typeof rawMetric.units === "string" ? rawMetric.units : "";
				const metric = metrics.get(name) ?? { name, units, samples: [] };
				if (units && !metric.units) {
					metric.units = units;
				}
				metrics.set(name, metric);
				metricNames.push(name);

				const rows = Array.isArray(rawMetric.data) ? rawMetric.data : [];
				for (const row of rows) {
					const sample = parseSample(row);
					if (!sample) {
						continue;
					}
					sampleIndex.set(`${name} ${sample.date.getTime()}`, {
						metric: name,
						sample,
					});
				}
			}
		}

		let workoutCount = 0;
		if (Array.isArray(payload.workouts)) {
			for (const rawWorkout of payload.workouts) {
				const workout = parseWorkout(rawWorkout);
				if (!workout) {
					continue;
				}
				workoutCount += 1;
				workoutIndex.set(
					`${workout.name} ${workout.start?.getTime() ?? "?"}`,
					workout,
				);
			}
		}

		files.push({
			path: entry.path,
			modified: entry.modified,
			metricNames,
			workoutCount,
		});
	}

	for (const { metric, sample } of sampleIndex.values()) {
		metrics.get(metric)?.samples.push(sample);
	}
	for (const metric of metrics.values()) {
		metric.samples.sort((a, b) => a.date.getTime() - b.date.getTime());
	}

	const workouts = [...workoutIndex.values()].sort(
		(a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0),
	);

	const data: ExportData = { directory, files, metrics, workouts, skipped };
	cache.set(directory, {
		signature,
		expires: Date.now() + CONFIG.CACHE_TTL_MS,
		data,
	});
	return data;
}

async function openExports(
	explicitDirectory?: string,
): Promise<Result<{ data: ExportData }>> {
	const { directory, searched } = await resolveDirectory(explicitDirectory);

	if (!directory) {
		return {
			success: false,
			message: [
				"No Health Auto Export folder found.",
				"",
				"Set up an export first:",
				"1. In the Health Auto Export app, create an automation with format JSON",
				"   and a destination folder in iCloud Drive, Dropbox or Files.",
				"2. Point this tool at that folder, either by passing the 'directory'",
				`   argument or by setting the ${DIR_ENV_VAR} environment variable.`,
				"",
				`Looked in: ${searched.join(", ") || "(no candidates)"}`,
			].join("\n"),
		};
	}

	try {
		const data = await loadExports(directory);
		if (data.files.length === 0) {
			// The per-file reasons are the whole diagnostic when an export turns
			// out not to have the shape this parser expects, so surface them
			// rather than only reporting that nothing was readable.
			const reasons = data.skipped
				.slice(0, 10)
				.map((entry) => `- ${entry.path}: ${entry.reason}`);
			const more =
				data.skipped.length > reasons.length
					? [`- ...and ${data.skipped.length - reasons.length} more`]
					: [];

			return {
				success: false,
				message: [
					`Found the folder "${directory}" but could not read any Health Auto Export JSON from it.`,
					data.skipped.length === 0
						? "It contains no .json files at all. Check that the app's automation uses the JSON format — CSV exports are not supported."
						: "Files examined:",
					...reasons,
					...more,
					data.skipped.length === 0
						? ""
						: "\nIf these are Health Auto Export files, the export format may differ from what this tool expects; the reasons above say what it found instead.",
				]
					.filter(Boolean)
					.join("\n"),
			};
		}
		return { success: true, data };
	} catch (error) {
		return {
			success: false,
			message: `Failed to read health exports from "${directory}": ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function inRange(date: Date, from?: Date, to?: Date): boolean {
	if (from && date.getTime() < from.getTime()) {
		return false;
	}
	if (to && date.getTime() > to.getTime()) {
		return false;
	}
	return true;
}

function periodKey(date: Date, aggregation: Aggregation): string {
	const year = date.getFullYear();
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");

	if (aggregation === "monthly") {
		return `${year}-${month}`;
	}
	if (aggregation === "weekly") {
		// ISO week: shift to the Thursday of the sample's week, then count weeks
		// from the first Thursday of that year.
		const thursday = new Date(
			date.getFullYear(),
			date.getMonth(),
			date.getDate(),
		);
		thursday.setDate(thursday.getDate() + 3 - ((thursday.getDay() + 6) % 7));
		const firstThursday = new Date(thursday.getFullYear(), 0, 4);
		firstThursday.setDate(
			firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7),
		);
		const week =
			1 +
			Math.round(
				(thursday.getTime() - firstThursday.getTime()) /
					(7 * 24 * 60 * 60 * 1000),
			);
		return `${thursday.getFullYear()}-W${`${week}`.padStart(2, "0")}`;
	}
	return `${year}-${month}-${day}`;
}

/**
 * Bucket samples and report sum, average, min and max for each period. All four
 * are returned because the meaningful statistic depends on the metric — steps
 * are summed, resting heart rate is averaged — and the export does not say
 * which applies.
 */
function aggregate(
	samples: MetricSample[],
	aggregation: Aggregation,
	field: string,
): Bucket[] {
	const buckets = new Map<string, number[]>();

	for (const sample of samples) {
		const value =
			field === "qty" ? (sample.qty ?? sample.fields.qty) : sample.fields[field];
		if (typeof value !== "number") {
			continue;
		}
		const key =
			aggregation === "total" ? "total" : periodKey(sample.date, aggregation);
		const existing = buckets.get(key);
		if (existing) {
			existing.push(value);
		} else {
			buckets.set(key, [value]);
		}
	}

	return [...buckets.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([period, values]) => {
			const sum = values.reduce((total, value) => total + value, 0);
			return {
				period,
				count: values.length,
				sum,
				avg: sum / values.length,
				min: Math.min(...values),
				max: Math.max(...values),
			};
		});
}

function numericFields(metric: Metric): string[] {
	const names = new Set<string>();
	for (const sample of metric.samples) {
		for (const key of Object.keys(sample.fields)) {
			names.add(key);
		}
	}
	return [...names].sort();
}

function dateRangeOf(samples: MetricSample[]): { first?: Date; last?: Date } {
	if (samples.length === 0) {
		return {};
	}
	return {
		first: samples[0]?.date,
		last: samples[samples.length - 1]?.date,
	};
}

/**
 * Resolve a user-supplied metric name against the export. Health Auto Export
 * names metrics in snake_case ("resting_heart_rate"); accepting spaces, dashes
 * and partial matches keeps the tool usable without an exact spelling.
 */
function resolveMetricName(
	metrics: Map<string, Metric>,
	requested: string,
): { name?: string; candidates: string[]; matched: boolean } {
	const normalise = (value: string) =>
		value.toLowerCase().replace(/[\s_-]+/g, "");
	const names = [...metrics.keys()];

	const exact = names.find((name) => normalise(name) === normalise(requested));
	if (exact) {
		return { name: exact, candidates: [], matched: true };
	}

	// Try the request as written, then with a plural dropped, so "steps" still
	// reaches "step_count".
	const targets = [normalise(requested)];
	const singular = requested.trim().replace(/s$/i, "");
	if (singular && singular !== requested.trim()) {
		targets.push(normalise(singular));
	}

	for (const target of targets) {
		if (!target) {
			continue;
		}
		const partial = names.filter((name) => normalise(name).includes(target));
		if (partial.length === 1) {
			return { name: partial[0], candidates: [], matched: true };
		}
		if (partial.length > 1) {
			return { candidates: partial, matched: true };
		}
	}

	// Nothing resembled the request, so offer the full list instead.
	return { candidates: names, matched: false };
}

/**
 * resolveMetricName only returns names it read out of this map, so the lookup
 * cannot miss. Keeping the invariant here avoids a cast at the call site.
 */
function requireMetric(metrics: Map<string, Metric>, name: string): Metric {
	const metric = metrics.get(name);
	if (!metric) {
		throw new Error(`Metric "${name}" is missing from the export index`);
	}
	return metric;
}

async function getSources(directory?: string): Promise<
	Result<{
		directory: string;
		files: ExportFile[];
		skipped: { path: string; reason: string }[];
		metricCount: number;
		workoutCount: number;
	}>
> {
	const opened = await openExports(directory);
	if (!opened.success) {
		return opened;
	}

	return {
		success: true,
		directory: opened.data.directory,
		files: opened.data.files,
		skipped: opened.data.skipped,
		metricCount: opened.data.metrics.size,
		workoutCount: opened.data.workouts.length,
	};
}

async function listMetrics(directory?: string): Promise<
	Result<{
		directory: string;
		metrics: {
			name: string;
			units: string;
			sampleCount: number;
			fields: string[];
			first?: Date;
			last?: Date;
		}[];
	}>
> {
	const opened = await openExports(directory);
	if (!opened.success) {
		return opened;
	}

	const metrics = [...opened.data.metrics.values()]
		.map((metric) => ({
			name: metric.name,
			units: metric.units,
			sampleCount: metric.samples.length,
			fields: numericFields(metric),
			...dateRangeOf(metric.samples),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	return { success: true, directory: opened.data.directory, metrics };
}

async function queryMetric(options: {
	metric: string;
	startDate?: string;
	endDate?: string;
	aggregation?: Aggregation;
	field?: string;
	limit?: number;
	directory?: string;
}): Promise<
	Result<{
		metric: string;
		units: string;
		aggregation: Aggregation;
		field: string;
		totalMatched: number;
		buckets?: Bucket[];
		samples?: MetricSample[];
	}>
> {
	const opened = await openExports(options.directory);
	if (!opened.success) {
		return opened;
	}

	const {
		name,
		candidates,
		matched: candidatesAreNearMisses,
	} = resolveMetricName(opened.data.metrics, options.metric);
	if (!name) {
		const shown = candidates.slice(0, 25).join(", ");
		const more = candidates.length > 25 ? ", ..." : "";
		const hint =
			candidates.length === 0
				? ""
				: candidatesAreNearMisses
					? ` Did you mean: ${shown}${more}?`
					: ` Available metrics: ${shown}${more}.`;
		return {
			success: false,
			message: `No metric matching "${options.metric}" in the export.${hint}`,
		};
	}

	const metric = requireMetric(opened.data.metrics, name);
	const from = parseBoundary(options.startDate);
	const to = parseBoundary(options.endDate, "end");

	if (options.startDate && !from) {
		return {
			success: false,
			message: `Could not parse startDate "${options.startDate}".`,
		};
	}
	if (options.endDate && !to) {
		return {
			success: false,
			message: `Could not parse endDate "${options.endDate}".`,
		};
	}

	const matched = metric.samples.filter((sample) =>
		inRange(sample.date, from, to),
	);
	const aggregation: Aggregation = options.aggregation ?? "none";
	const field = options.field ?? "qty";

	if (aggregation === "none") {
		const limit = Math.min(
			options.limit ?? CONFIG.MAX_SAMPLES,
			CONFIG.MAX_SAMPLES,
		);
		return {
			success: true,
			metric: name,
			units: metric.units,
			aggregation,
			field,
			totalMatched: matched.length,
			// Newest first, so a truncated response keeps the most recent data.
			samples: matched.slice(-limit).reverse(),
		};
	}

	return {
		success: true,
		metric: name,
		units: metric.units,
		aggregation,
		field,
		totalMatched: matched.length,
		buckets: aggregate(matched, aggregation, field),
	};
}

async function listWorkouts(options: {
	startDate?: string;
	endDate?: string;
	limit?: number;
	directory?: string;
}): Promise<Result<{ totalMatched: number; workouts: Workout[] }>> {
	const opened = await openExports(options.directory);
	if (!opened.success) {
		return opened;
	}

	const from = parseBoundary(options.startDate);
	const to = parseBoundary(options.endDate, "end");
	const matched = opened.data.workouts.filter((workout) =>
		workout.start ? inRange(workout.start, from, to) : !from && !to,
	);
	const limit = Math.min(options.limit ?? 50, CONFIG.MAX_WORKOUTS);

	return {
		success: true,
		totalMatched: matched.length,
		workouts: matched.slice(-limit).reverse(),
	};
}

/**
 * Digest of every metric over a window: one row per metric with the totals a
 * caller would otherwise need one query each to get.
 */
async function getSummary(options: {
	startDate?: string;
	endDate?: string;
	directory?: string;
}): Promise<
	Result<{
		directory: string;
		from?: Date;
		to?: Date;
		metrics: {
			name: string;
			units: string;
			field: string;
			count: number;
			sum: number;
			avg: number;
			min: number;
			max: number;
		}[];
		workoutCount: number;
	}>
> {
	const opened = await openExports(options.directory);
	if (!opened.success) {
		return opened;
	}

	const from = parseBoundary(options.startDate);
	const to = parseBoundary(options.endDate, "end");

	const metrics = [...opened.data.metrics.values()]
		.map((metric) => {
			const matched = metric.samples.filter((sample) =>
				inRange(sample.date, from, to),
			);
			// Composite metrics carry no `qty`, so summarise their first field
			// rather than dropping them from the digest entirely.
			const field = matched.some((sample) => sample.qty !== undefined)
				? "qty"
				: (numericFields(metric)[0] ?? "qty");
			const [bucket] = aggregate(matched, "total", field);
			if (!bucket) {
				return undefined;
			}
			return {
				name: metric.name,
				units: metric.units,
				field,
				count: bucket.count,
				sum: bucket.sum,
				avg: bucket.avg,
				min: bucket.min,
				max: bucket.max,
			};
		})
		.filter((row): row is NonNullable<typeof row> => row !== undefined)
		.sort((a, b) => a.name.localeCompare(b.name));

	const workoutCount = opened.data.workouts.filter((workout) =>
		workout.start ? inRange(workout.start, from, to) : !from && !to,
	).length;

	return {
		success: true,
		directory: opened.data.directory,
		from,
		to,
		metrics,
		workoutCount,
	};
}

export default {
	getSources,
	listMetrics,
	queryMetric,
	listWorkouts,
	getSummary,
};

export type { Aggregation, Bucket, ExportFile, Metric, MetricSample, Workout };
