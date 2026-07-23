# Wrangler Dependency Collection Caching Benchmark

Benchmarks [PR #14819](https://github.com/cloudflare/workers-sdk/pull/14819) which caches package dependency collection results to avoid redundant filesystem walks.

## What it measures

Compares `wrangler deploy --dry-run` performance between:

- **baseline** (`wrangler@main`) -- collects package dependencies by walking the filesystem on every deploy
- **branch** (`wrangler@14819`) -- caches collected dependency results and reuses them when dependencies haven't changed

The benchmark is designed to exercise the caching behavior by running multiple deploys in sequence on the same machine:

- **Cold run** (1st deploy) -- no cache exists, both variants walk the filesystem
- **Warm runs** (2nd+ deploys) -- the branch variant can skip filesystem walks by reusing cached results

## Permutations

The CI workflow benchmarks across all combinations of:

| Dimension | Values |
|-----------|--------|
| OS | `ubuntu-latest`, `macos-latest`, `windows-latest` |
| Package Manager | `npm`, `pnpm` |
| Dependency Count | `few` (~5), `medium` (~50), `lots` (~200) |

That's **18 matrix cells**, each running 5 trials. Each trial consists of 1 cold run + 3 warm runs per variant.

## How it works

1. The `worker/` directory contains a minimal Cloudflare Worker with no dependencies
2. The workflow dynamically installs the dependency tier from `scripts/deps.json`
3. The benchmark script (`scripts/benchmark.mjs`) runs both wrangler variants, each doing 1 cold + 3 warm deploys in sequence per trial, alternating which variant goes first
4. Results are uploaded as artifacts and aggregated into a summary table

## Running locally

```sh
cd worker
npm install zod hono uuid dotenv chalk  # or whatever deps you want
node ../scripts/benchmark.mjs --cwd . --trials 5 --warm-runs 3
```

## Results

Results appear in the GitHub Actions **job summary** after each run. Each matrix cell shows:

- Cold and warm median timings for both variants
- **Warm speedup** -- baseline warm median / branch warm median (the key metric)
- **Cache benefit** -- how much faster the branch's warm runs are vs its cold run
- Paired warm delta (per-trial difference)

The final summary job aggregates all 18 cells into one comparison table.
