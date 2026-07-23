# Wrangler Dependency Collection Caching Benchmark

Benchmarks [PR #14819](https://github.com/cloudflare/workers-sdk/pull/14819) which caches package dependency collection results to avoid redundant filesystem walks.

## What it measures

Compares `wrangler deploy --dry-run` performance between:

- **baseline** (`wrangler@main`) -- collects package dependencies on every deploy
- **branch** (`wrangler@14819`) -- caches collected dependency results and reuses them when dependencies haven't changed

## Permutations

The CI workflow benchmarks across all combinations of:

| Dimension | Values |
|-----------|--------|
| OS | `ubuntu-latest`, `macos-latest`, `windows-latest` |
| Package Manager | `npm`, `pnpm` |
| Dependency Count | `few` (~5), `medium` (~50), `lots` (~200) |

That's **18 matrix cells**, each running 5 measured trials + 1 warmup.

## How it works

1. The `worker/` directory contains a minimal Cloudflare Worker with no dependencies
2. The workflow dynamically installs the dependency tier from `scripts/deps.json`
3. The benchmark script (`scripts/benchmark.mjs`) runs both wrangler variants in alternating order
4. Results are uploaded as artifacts and aggregated into a summary table

## Running locally

```sh
cd worker
npm install zod hono uuid dotenv chalk  # or whatever deps you want
node ../scripts/benchmark.mjs --cwd . --trials 5
```

## Results

Results appear in the GitHub Actions **job summary** after each run. Each matrix cell shows:

- Median, mean, min, max, stddev for both variants
- Speedup factor (baseline median / branch median)
- Paired delta (per-trial difference)

The final summary job aggregates all 18 cells into one comparison table.
