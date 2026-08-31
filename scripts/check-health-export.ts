#!/usr/bin/env bun

/**
 * Diagnostic for the health tool: point it at a Health Auto Export folder and
 * it reports what the parser can actually read, without needing the MCP server
 * wired into a client first.
 *
 *   bun run scripts/check-health-export.ts ~/path/to/HealthAutoExport
 *
 * With no argument it uses APPLE_MCP_HEALTH_DIR, then the same automatic
 * search the tool itself performs.
 */

import health from "../utils/health.js";

const directory = process.argv[2];

function heading(text: string): void {
	console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

heading("Export folder");
const sources = await health.getSources(directory);
if (!sources.success) {
	console.log(sources.message);
	// Only worth saying when the parser actually looked inside files and
	// rejected them; a missing folder is a configuration problem instead.
	if (sources.message.includes("Files examined:")) {
		console.log(
			"\nIf these are genuine Health Auto Export files, the reasons above are what",
		);
		console.log(
			"the parser needs to change to read them. Send one along with a sample file.",
		);
	}
	process.exit(1);
}

console.log(`Folder:   ${sources.directory}`);
console.log(`Files:    ${sources.files.length}`);
console.log(`Metrics:  ${sources.metricCount}`);
console.log(`Workouts: ${sources.workoutCount}`);

for (const file of sources.files) {
	console.log(
		`  - ${file.path} (${file.metricNames.length} metrics, ${file.workoutCount} workouts)`,
	);
}

if (sources.skipped.length > 0) {
	heading("Skipped files");
	for (const entry of sources.skipped) {
		console.log(`  - ${entry.path}: ${entry.reason}`);
	}
}

heading("Metrics found");
const metrics = await health.listMetrics(directory);
if (!metrics.success) {
	console.log(metrics.message);
	process.exit(1);
}

if (metrics.metrics.length === 0) {
	console.log("(none)");
} else {
	for (const metric of metrics.metrics) {
		const units = metric.units ? ` ${metric.units}` : "";
		const range =
			metric.first && metric.last
				? `, ${metric.first.toISOString().slice(0, 10)} to ${metric.last.toISOString().slice(0, 10)}`
				: "";
		console.log(`  - ${metric.name}${units} (${metric.sampleCount} samples${range})`);
	}
}

// A real query over whichever metric has the most data, to prove the whole
// path works rather than just the file listing.
const busiest = [...metrics.metrics].sort(
	(a, b) => b.sampleCount - a.sampleCount,
)[0];

if (busiest) {
	heading(`Sample query: ${busiest.name}, last 7 daily buckets`);
	const query = await health.queryMetric({
		metric: busiest.name,
		aggregation: "daily",
		directory,
	});

	if (!query.success) {
		console.log(query.message);
	} else {
		for (const bucket of (query.buckets ?? []).slice(-7)) {
			console.log(
				`  ${bucket.period}: sum ${Math.round(bucket.sum * 100) / 100}, avg ${Math.round(bucket.avg * 100) / 100} (n=${bucket.count})`,
			);
		}
	}
}

heading("Result");
console.log("The parser reads this export. The health tool will work on it.");
