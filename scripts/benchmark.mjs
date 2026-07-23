/**
 * Benchmark runner for comparing wrangler deploy --dry-run performance.
 *
 * Runs two wrangler variants (baseline = main, branch = PR #14819) in
 * alternating order with warmup, computes stats, and outputs results as JSON
 * to stdout for the CI workflow to consume.
 *
 * Usage:
 *   node scripts/benchmark.mjs --cwd <worker-dir> [--trials 5]
 *
 * Environment:
 *   WRANGLER_BASELINE_CMD  - command for baseline (default: npx https://pkg.pr.new/wrangler@main)
 *   WRANGLER_BRANCH_CMD    - command for branch   (default: npx https://pkg.pr.new/wrangler@14819)
 *
 * @module benchmark
 */

import { spawn } from "node:child_process";
import { arch, cpus, freemem, platform, totalmem, type } from "node:os";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
	options: {
		cwd: { type: "string" },
		trials: { type: "string", default: "5" },
	},
});

const workerDir = args.cwd;
if (!workerDir) {
	console.error("Usage: node benchmark.mjs --cwd <worker-dir>");
	process.exit(1);
}

const TRIALS = parseInt(args.trials, 10);
if (!Number.isFinite(TRIALS) || TRIALS < 1) {
	console.error("--trials must be a positive integer");
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Variant commands
// ---------------------------------------------------------------------------

const BASELINE_CMD =
	process.env.WRANGLER_BASELINE_CMD ||
	"npx https://pkg.pr.new/wrangler@main";
const BRANCH_CMD =
	process.env.WRANGLER_BRANCH_CMD ||
	"npx https://pkg.pr.new/wrangler@14819";

const variants = {
	baseline: `${BASELINE_CMD} deploy --dry-run`,
	branch: `${BRANCH_CMD} deploy --dry-run`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawns a shell command and returns the elapsed wall-clock time in ms.
 *
 * @param {string} command - The shell command to run
 * @param {string} cwd - Working directory
 * @returns {Promise<number>} Elapsed time in milliseconds
 */
async function timeCommand(command, cwd) {
	const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max per run
	const startedAt = performance.now();
	await new Promise((resolve, reject) => {
		const isWindows = process.platform === "win32";
		const shell = isWindows
			? process.env.COMSPEC || "cmd"
			: "/bin/sh";
		const shellArgs = isWindows ? ["/c", command] : ["-c", command];

		const child = spawn(shell, shellArgs, {
			cwd,
			env: {
				...process.env,
				WRANGLER_SEND_METRICS: "false",
				NO_UPDATE_CHECK: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Command timed out after ${TIMEOUT_MS}ms: ${command}`));
		}, TIMEOUT_MS);

		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					`Command failed (${signal ?? code}): ${command}\nstdout: ${stdout}\nstderr: ${stderr}`
				)
			);
		});
	});
	return performance.now() - startedAt;
}

/**
 * Computes the median of an array of numbers.
 * For even-length arrays, returns the average of the two middle values.
 *
 * @param {number[]} values - Array of numbers
 * @returns {number} The median value
 */
function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[mid - 1] + sorted[mid]) / 2
		: sorted[mid];
}

/**
 * Computes the arithmetic mean of an array of numbers.
 *
 * @param {number[]} values - Array of numbers
 * @returns {number} The mean value
 */
function mean(values) {
	return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Computes sample standard deviation (Bessel's correction, N-1).
 *
 * @param {number[]} values - Array of numbers (length >= 2)
 * @returns {number} The sample standard deviation
 */
function stddev(values) {
	if (values.length < 2) return 0;
	const m = mean(values);
	const variance =
		values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
	return Math.sqrt(variance);
}

/**
 * Formats milliseconds to a fixed-precision string.
 *
 * @param {number} ms - Milliseconds
 * @returns {string} Formatted string like "1234.5 ms"
 */
function fmtMs(ms) {
	return `${ms.toFixed(1)} ms`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const variantNames = /** @type {const} */ (["baseline", "branch"]);

console.error(`\nWrangler Lockfile Resolution Benchmark`);
console.error(`======================================`);
console.error(`Trials: ${TRIALS} (+ 1 warmup each)`);
console.error(`Worker dir: ${workerDir}`);
console.error(`Baseline: ${variants.baseline}`);
console.error(`Branch:   ${variants.branch}\n`);

// --- Warmup ---
for (const name of variantNames) {
	console.error(`[warmup] ${name}...`);
	const ms = await timeCommand(variants[name], workerDir);
	console.error(`[warmup] ${name}: ${fmtMs(ms)}\n`);
}

// --- Measured runs (alternating) ---
const runs = { baseline: [], branch: [] };

for (let i = 0; i < TRIALS; i++) {
	// Alternate starting order to reduce ordering bias
	const order = i % 2 === 0 ? ["baseline", "branch"] : ["branch", "baseline"];
	for (const name of order) {
		console.error(`[run ${i + 1}/${TRIALS}] ${name}...`);
		const ms = await timeCommand(variants[name], workerDir);
		runs[name].push(ms);
		console.error(`[run ${i + 1}/${TRIALS}] ${name}: ${fmtMs(ms)}`);
	}
	console.error();
}

// --- Compute stats ---

/**
 * Computes summary statistics for an array of timing values.
 *
 * @param {number[]} values - Array of timing values in ms
 * @returns {{ median: number, mean: number, min: number, max: number, stddev: number }}
 */
function computeStats(values) {
	return {
		median: median(values),
		mean: mean(values),
		min: Math.min(...values),
		max: Math.max(...values),
		stddev: stddev(values),
	};
}

const stats = {
	baseline: computeStats(runs.baseline),
	branch: computeStats(runs.branch),
};

const speedup = stats.baseline.median / stats.branch.median;

// --- Paired deltas ---
const pairedDeltas = runs.branch.map(
	(duration, index) => duration - runs.baseline[index]
);
const deltaStats = computeStats(pairedDeltas);

// --- Environment info ---
const cpuModel = cpus()[0]?.model ?? "unknown";
const totalRam = Math.round(totalmem() / 1024 / 1024 / 1024);

// --- Output JSON to stdout ---
const result = {
	environment: {
		node: process.version,
		os: `${platform()} ${arch()} (${type()})`,
		cpu: cpuModel,
		ram_gb: totalRam,
	},
	config: {
		trials: TRIALS,
		baseline_cmd: variants.baseline,
		branch_cmd: variants.branch,
	},
	raw_runs: runs,
	stats,
	paired_delta: deltaStats,
	speedup: parseFloat(speedup.toFixed(3)),
};

// JSON to stdout (for CI to capture)
console.log(JSON.stringify(result, null, 2));

// Human-readable summary to stderr
console.error(`\nSummary`);
console.error(`-------`);
console.error(`  baseline median: ${fmtMs(stats.baseline.median)} (stddev: ${fmtMs(stats.baseline.stddev)})`);
console.error(`  branch   median: ${fmtMs(stats.branch.median)} (stddev: ${fmtMs(stats.branch.stddev)})`);
console.error(`  paired delta median: ${fmtMs(deltaStats.median)}`);
if (speedup > 1.01) {
	console.error(`\n  Result: branch is ${speedup.toFixed(2)}x faster\n`);
} else if (speedup < 0.99) {
	console.error(
		`\n  Result: branch is ${(1 / speedup).toFixed(2)}x slower\n`
	);
} else {
	console.error(`\n  Result: roughly the same (${speedup.toFixed(2)}x)\n`);
}
