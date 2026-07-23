/**
 * Benchmark runner for comparing wrangler deploy --dry-run performance,
 * designed to measure dependency-collection caching (PR #14819).
 *
 * For each variant (baseline = main, branch = PR #14819), runs deploy
 * multiple times in sequence on the same machine:
 *   - 1st run  = "cold" (no cache exists)
 *   - 2nd+ runs = "warm" (cache populated by the 1st run)
 *
 * The key metric is warm-run performance: baseline (main) walks the
 * filesystem every time, while branch (#14819) reuses cached results
 * when dependencies haven't changed.
 *
 * Usage:
 *   node scripts/benchmark.mjs --cwd <worker-dir> [--trials 5] [--warm-runs 3]
 *
 * Environment:
 *   WRANGLER_BASELINE_CMD  - command for baseline (default: npx https://pkg.pr.new/wrangler@main)
 *   WRANGLER_BRANCH_CMD    - command for branch   (default: npx https://pkg.pr.new/wrangler@14819)
 *
 * @module benchmark
 */

import { spawn } from "node:child_process";
import { arch, cpus, platform, totalmem, type } from "node:os";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
	options: {
		cwd: { type: "string" },
		trials: { type: "string", default: "5" },
		"warm-runs": { type: "string", default: "3" },
	},
});

const workerDir = args.cwd;
if (!workerDir) {
	console.error(
		"Usage: node benchmark.mjs --cwd <worker-dir> [--trials 5] [--warm-runs 3]"
	);
	process.exit(1);
}

const TRIALS = parseInt(args.trials, 10);
if (!Number.isFinite(TRIALS) || TRIALS < 1) {
	console.error("--trials must be a positive integer");
	process.exit(1);
}

const WARM_RUNS = parseInt(args["warm-runs"], 10);
if (!Number.isFinite(WARM_RUNS) || WARM_RUNS < 1) {
	console.error("--warm-runs must be a positive integer");
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
		const shell = isWindows ? process.env.COMSPEC || "cmd" : "/bin/sh";
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
			reject(
				new Error(`Command timed out after ${TIMEOUT_MS}ms: ${command}`)
			);
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
 * Runs a variant's deploy command multiple times in sequence, returning
 * the cold (1st) and warm (2nd+) timings. This simulates repeated deploys
 * on the same machine where the branch variant can leverage its cache.
 *
 * @param {string} command - The full deploy command to run
 * @param {string} cwd - Working directory
 * @param {number} warmRuns - Number of warm (cached) runs after the cold run
 * @returns {Promise<{ cold: number, warm: number[] }>} Cold and warm timings in ms
 */
async function runColdThenWarm(command, cwd, warmRuns) {
	const cold = await timeCommand(command, cwd);
	const warm = [];
	for (let i = 0; i < warmRuns; i++) {
		warm.push(await timeCommand(command, cwd));
	}
	return { cold, warm };
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

console.error(`\nWrangler Dependency Collection Caching Benchmark`);
console.error(`=================================================`);
console.error(`Trials: ${TRIALS}`);
console.error(`Warm runs per trial: ${WARM_RUNS}`);
console.error(`Worker dir: ${workerDir}`);
console.error(`Baseline: ${variants.baseline}`);
console.error(`Branch:   ${variants.branch}\n`);

// --- Warmup (npx cache / JIT) ---
// Run each variant once to ensure npx has fetched the package.
// This timing is discarded entirely.
for (const name of variantNames) {
	console.error(`[npx-warmup] ${name}...`);
	const ms = await timeCommand(variants[name], workerDir);
	console.error(`[npx-warmup] ${name}: ${fmtMs(ms)} (discarded)\n`);
}

// --- Measured trials ---
// Each trial: for each variant, run 1 cold + N warm deploys in sequence.
// We alternate which variant goes first across trials to reduce ordering bias.

/** @type {{ baseline: { cold: number, warm: number[] }[], branch: { cold: number, warm: number[] }[] }} */
const runs = { baseline: [], branch: [] };

for (let i = 0; i < TRIALS; i++) {
	const order =
		i % 2 === 0 ? ["baseline", "branch"] : ["branch", "baseline"];

	for (const name of order) {
		console.error(
			`[trial ${i + 1}/${TRIALS}] ${name}: 1 cold + ${WARM_RUNS} warm...`
		);
		const result = await runColdThenWarm(
			variants[name],
			workerDir,
			WARM_RUNS
		);
		runs[name].push(result);

		const warmMedian = median(result.warm);
		console.error(
			`[trial ${i + 1}/${TRIALS}] ${name}: cold=${fmtMs(result.cold)}, warm median=${fmtMs(warmMedian)}`
		);
	}
	console.error();
}

// --- Compute stats ---

/**
 * Extracts all warm-run timings from trial results, flattened into a single array.
 *
 * @param {{ cold: number, warm: number[] }[]} trialResults - Array of trial results
 * @returns {number[]} Flattened warm timings
 */
function flatWarm(trialResults) {
	return trialResults.flatMap((t) => t.warm);
}

/**
 * Extracts all cold-run timings from trial results.
 *
 * @param {{ cold: number, warm: number[] }[]} trialResults - Array of trial results
 * @returns {number[]} Cold timings
 */
function coldRuns(trialResults) {
	return trialResults.map((t) => t.cold);
}

const stats = {
	baseline: {
		cold: computeStats(coldRuns(runs.baseline)),
		warm: computeStats(flatWarm(runs.baseline)),
	},
	branch: {
		cold: computeStats(coldRuns(runs.branch)),
		warm: computeStats(flatWarm(runs.branch)),
	},
};

// Key metrics: warm-vs-warm speedup (the cache benefit)
const warmSpeedup = stats.baseline.warm.median / stats.branch.warm.median;

// Cold-vs-cold comparison (cache shouldn't help on 1st run)
const coldSpeedup = stats.baseline.cold.median / stats.branch.cold.median;

// Branch self-speedup: how much faster is warm vs cold for the branch?
const branchCacheSpeedup = stats.branch.cold.median / stats.branch.warm.median;

// --- Paired deltas (warm medians per trial) ---
const baselineWarmMedians = runs.baseline.map((t) => median(t.warm));
const branchWarmMedians = runs.branch.map((t) => median(t.warm));
const pairedDeltas = branchWarmMedians.map(
	(duration, index) => duration - baselineWarmMedians[index]
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
		warm_runs_per_trial: WARM_RUNS,
		baseline_cmd: variants.baseline,
		branch_cmd: variants.branch,
	},
	raw_runs: runs,
	stats,
	paired_delta: deltaStats,
	speedup: {
		warm: parseFloat(warmSpeedup.toFixed(3)),
		cold: parseFloat(coldSpeedup.toFixed(3)),
		branch_cache: parseFloat(branchCacheSpeedup.toFixed(3)),
	},
};

// JSON to stdout (for CI to capture)
console.log(JSON.stringify(result, null, 2));

// Human-readable summary to stderr
console.error(`\nSummary`);
console.error(`-------`);
console.error(`  Cold runs (1st deploy, no cache):`);
console.error(
	`    baseline: ${fmtMs(stats.baseline.cold.median)} (stddev: ${fmtMs(stats.baseline.cold.stddev)})`
);
console.error(
	`    branch:   ${fmtMs(stats.branch.cold.median)} (stddev: ${fmtMs(stats.branch.cold.stddev)})`
);
console.error(
	`    cold speedup: ${coldSpeedup.toFixed(2)}x`
);
console.error();
console.error(`  Warm runs (2nd+ deploy, cache populated):`);
console.error(
	`    baseline: ${fmtMs(stats.baseline.warm.median)} (stddev: ${fmtMs(stats.baseline.warm.stddev)})`
);
console.error(
	`    branch:   ${fmtMs(stats.branch.warm.median)} (stddev: ${fmtMs(stats.branch.warm.stddev)})`
);
console.error(
	`    warm speedup: ${warmSpeedup.toFixed(2)}x`
);
console.error();
console.error(
	`  Branch cache benefit (cold vs warm): ${branchCacheSpeedup.toFixed(2)}x`
);
console.error(`  Paired warm delta median: ${fmtMs(deltaStats.median)}`);

if (warmSpeedup > 1.01) {
	console.error(
		`\n  Result: branch warm runs are ${warmSpeedup.toFixed(2)}x faster\n`
	);
} else if (warmSpeedup < 0.99) {
	console.error(
		`\n  Result: branch warm runs are ${(1 / warmSpeedup).toFixed(2)}x slower\n`
	);
} else {
	console.error(
		`\n  Result: warm runs are roughly the same (${warmSpeedup.toFixed(2)}x)\n`
	);
}
