# Local qualification, workload versions 3–5

The additive [three-engine qualification](postgres/README.md) compares the public
iniBase API against SQLite and native PostgreSQL, including separate concurrent
and process-crash scenarios. Historical workloads below remain unchanged.

These scripts are copied from the existing sibling benchmarks `src/local-*.mjs`
(version 2), then extended with `baseline-indexed`. Historical benchmark files and
results are unchanged. Version 3 compares the starting working tree and candidate
with **identical** seekable/log/tombstone/key-index settings. `baseline` remains
available for the historical non-indexed configuration. Do not conflate them.

Run from the iniBase repository root, after compiling both explicit local modules:

```sh
node node_modules/typescript/bin/tsc
node benchmark/qualification/local-run.mjs \
  --baseline=/absolute/frozen-baseline/dist/index.js \
  --optimized="$PWD/dist/index.js" \
  --baselineCommit=EXACT_BASELINE_ID --optimizedCommit=EXACT_CANDIDATE_ID \
  --rows=1000,10000,100000 --profiles=compact,cms,mixed \
  --repeats=3 --samples=128 --writes=32 --output=/absolute/fresh-results
node benchmark/qualification/local-report.mjs /absolute/fresh-results
```

Each run records every compiled JavaScript module hash, runtime, hardware,
configuration, raw latency samples, worker CPU/I/O/RSS, sampled process-tree RSS,
logical disk peaks, allocated/logical final sizes, correctness errors and failures.
`mixed` is deterministic high-entropy data. `cms` is repetitive content.
Each worker uses a fresh directory. Engines run sequentially and rotate order.
Successful databases are removed; failed databases remain for investigation.
The OS filesystem cache is not cleared. Reopening is not a cold-disk measurement.

Defaults use a 16 MiB cache budget, 512 MiB V8 heap cap, full iniBase durability and
SQLite WAL/FULL. Both default to the platform's fsync behavior; fullfsync is recorded.
A heap cap is not an RSS limit. Engine cache bytes are not total engine working memory.
The sampler needs permission to run `ps`; failures are retained explicitly.

`--instrument=true` runs separate diagnostic filesystem/codec/subprocess counters
and CPU profiles. Do not mix instrumented latencies into ordinary measurements.
`--blockBytes=65536|131072|262144` selects block-size controls.
`--samples=1024` enables per-trial lookup p99; reports omit p99 below 1,000 samples.
`--pending=1024` and `--writes=32` set mutation counts. Mixed timings include three
explicit compactions/checkpoints and automatic maintenance. These short workloads
are not a long-duration endurance qualification.

Focused scratch-overlay diagnostic (not durable-write throughput):

```sh
node benchmark/overlay-churn.mjs /absolute/engine/dist
```

The initial October 17 exploratory tests/profiling overlapped, so their timings are
not isolated baseline evidence. The `measured-comparison` matrix is isolated.
The first `comparison` attempt was stopped because sandbox restrictions blocked
`ps`; its partial results and sampler errors are preserved, not silently discarded.

Run every package test plus the process/journal recovery suites without the tsx
CLI IPC server (the test files and assertions are unchanged):

```sh
node benchmark/qualification/checks.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/@biomejs/biome/bin/biome check src
```

Version 4 adds configurable mixed-operation duration and ongoing deletes, individual
compaction timings, sampler counts for temporary `.tmp` files and private `.cache`
files, and tool-source hashes. Default operations and data remain version-3-compatible;
the version is explicit in every result. `tooling-v3.tar.gz` preserves the earlier
runner used for `measured-comparison`.

A longer repeated-compaction case with pooled samples sufficient for lookup p99:

```sh
node benchmark/qualification/local-run.mjs \
  --baseline=/absolute/frozen-baseline/dist/index.js \
  --optimized="$PWD/dist/index.js" --rows=10000 --profiles=cms \
  --repeats=3 --samples=1024 --writes=32 \
  --mixedRounds=12 --mixedWrites=64 --mixedDeletesEvery=8 \
  --output=/absolute/fresh-sustained-results
```

Temporary-file peaks are sampled and can miss short-lived files. They count `.tmp`
files inside the controlled database directory; this is not complete system-wide
SQLite temporary-file or physical-device I/O accounting. The runner refuses an
existing output path to preserve raw evidence.

Reconstruct this experiment's exact baseline, including the original uncommitted
source changes, into a **new** absolute directory:

```sh
benchmark/qualification/rebuild-baseline.sh /private/tmp/inibase-reproduced-baseline
```

It reads the local starting commit, applies the saved initial patch, links the
installed dependencies and compiles locally. It does not reset this working tree.
Compare the resulting source and compiled hashes with the recorded manifests.

A separate version-2 concurrent workload starts three writers and one reader at
an IPC barrier. Each writer changes disjoint application keys, deletes every eighth
row it visits, and compacts every 32 operations. The reader verifies each sampled
row against allowed committed states. Final reopen verifies all rows and keys.
Raw per-cycle writer samples include its reads, deletes and compactions; they are
not mislabeled as single-statement update latency. Process-tree RSS and per-worker
CPU/I/O counters are retained. Readers keep at most 2,048 raw latency samples while
counting every completed read.

```sh
node benchmark/qualification/concurrent.mjs \
  --baseline=/absolute/frozen-baseline/dist/index.js \
  --optimized="$PWD/dist/index.js" --rows=1000 --writes=64 --repeats=3 \
  --output=/absolute/fresh-concurrent-results
```

The initial version-1 concurrent smoke fixture had trailing spaces. Existing iniBase
string validation trims strings, so the strict equal-data assertion failed before
reader sampling. Its raw results/databases remain in concurrent-smoke/. Version 2
normalizes the input for both engines before seeding; no engine validation changed.

## Version 5: four public options and automatic indexing

`--publicOptions=true` supplies only the supported application options and adds a
separate post-training key phase. The first 16 probes and an explicit benchmark-only
maintenance drain measure learning/build cost; ordinary `get()` does not drain.
SQLite still creates its key index during table creation. This mode does not enable
the legacy log or tombstone format. Inherited `pending*` phase names describe reads
after committed base rewrites in this mode. Historical defaults remain version 4.
The runner now checks process-inspection permission before starting; use
`--allowMissingSampler=true` only for explicitly limited diagnostic runs.

The October 18 reproduction uses source archives so pre-existing local edits are
included exactly without committing someone else's changes into the engine commits:

```sh
# From this repository, with the recorded lockfile dependencies already installed.
mkdir -p /private/tmp/inibase-auto-repro-base /private/tmp/inibase-auto-repro-candidate
tar -xzf benchmark/results/automatic-20261018/baseline-source.tar.gz -C /private/tmp/inibase-auto-repro-base
tar -xzf benchmark/results/automatic-20261018/candidate-source.tar.gz -C /private/tmp/inibase-auto-repro-candidate
ln -s "$PWD/node_modules" /private/tmp/inibase-auto-repro-base/node_modules
ln -s "$PWD/node_modules" /private/tmp/inibase-auto-repro-candidate/node_modules
node node_modules/typescript/bin/tsc --project /private/tmp/inibase-auto-repro-base/tsconfig.json
node node_modules/typescript/bin/tsc --project /private/tmp/inibase-auto-repro-candidate/tsconfig.json
node benchmark/qualification/automatic-run.mjs \
  --baseline=/private/tmp/inibase-auto-repro-base/dist/index.js \
  --optimized=/private/tmp/inibase-auto-repro-candidate/dist/index.js \
  --baselineCommit=5dd5d0ef351aa4e3f4eb5611fdd7417ab7acc950 \
  --optimizedCommit=5e15b17 \
  --output=/private/tmp/inibase-automatic-repro-1/final
node benchmark/qualification/automatic-report.mjs /private/tmp/inibase-automatic-repro-1

node benchmark/qualification/checks.mjs
node node_modules/typescript/bin/tsc --noEmit
env INIBASE_MEMORY_BYTES=262144 node --import tsx tests/rowpack.test.ts
```

Use fresh destination directories. Process-tree sampling needs permission to run
`ps`. The orchestrator runs the 81 public-API trials, 54 immutable-row-kernel trials
and three instrumented trials sequentially, rotating engine order within repeats.
The public matrix uses compact, repetitive CMS and high-entropy datasets at 1k,
10k and 100k records, 16 samples per key phase, two individual mutations per phase,
eight batch updates and two mixed rounds. These are short qualification runs, not
endurance tests. All raw latency/CPU/I/O/disk/RSS samples and errors are retained.
The profiling pass is excluded from latency comparisons. Read the separate row
kernel's limitations before interpreting its SQLite comparison: it does not
implement the public engine's features or mutability.

## Row construction stage

The separate October 18 construction experiment compares the preceding immutable
row kernel with batched ID construction and reusable compression workspaces.
It is not a public-API or mutable-backend comparison. The historical workloads
above are unchanged. Reconstruct both measured artifacts in fresh directories:

```sh
mkdir /private/tmp/inibase-row-base /private/tmp/inibase-row-candidate
tar -xzf benchmark/results/adaptive-20261018/baseline-source.tar.gz -C /private/tmp/inibase-row-base
tar -xzf benchmark/results/adaptive-20261018/candidate-source.tar.gz -C /private/tmp/inibase-row-candidate
ln -s "$PWD/node_modules" /private/tmp/inibase-row-base/node_modules
ln -s "$PWD/node_modules" /private/tmp/inibase-row-candidate/node_modules
node node_modules/typescript/bin/tsc --project /private/tmp/inibase-row-base/tsconfig.json
node node_modules/typescript/bin/tsc --project /private/tmp/inibase-row-candidate/tsconfig.json

node benchmark/qualification/rowpack.mjs \
  --baseline=/private/tmp/inibase-row-base/dist \
  --dist=/private/tmp/inibase-row-candidate/dist \
  --rows=1000,10000,100000 --profiles=compact,cms,entropy \
  --budget=1048576 --repeats=3 \
  --output=/private/tmp/inibase-row-results/measured-row
node benchmark/qualification/rowpack.mjs \
  --baseline=/private/tmp/inibase-row-base/dist \
  --dist=/private/tmp/inibase-row-candidate/dist \
  --rows=100000 --profiles=cms,entropy --budget=262144 --repeats=3 \
  --output=/private/tmp/inibase-row-results/measured-small
node benchmark/qualification/row-stage-report.mjs /private/tmp/inibase-row-results

node benchmark/qualification/codec-levels.mjs \
  /private/tmp/inibase-row-candidate/dist/row-encoder.js \
  /private/tmp/inibase-row-results/codec-levels-rotated.json
node benchmark/qualification/index-allocation.mjs \
  /private/tmp/inibase-row-candidate/dist/index.js \
  /private/tmp/inibase-row-results/index-allocation.json

node benchmark/qualification/checks.mjs
env INIBASE_MEMORY_BYTES=262144 node --import tsx tests/rowpack.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

Run sequentially and permit `ps` for RSS sampling. The row runner refuses an
existing output directory. Source archives preserve the actual local TypeScript
sources/configuration used, including pre-existing edits. Compare compiled module
hashes against `adaptive-20261018/artifact-reproduction.json` and per-run
`environment.json`. The main and minimum-budget matrices contain 81 and 18 trials.
Kernel bulk timings include encoding and durable publication; SQLite's
checkpoint/close is separate. Disk data exceeds the configured cache/reservation
budgets, but those budgets do not enforce a total RSS ceiling. Closing/reopening
does not clear the OS cache. Diagnostics do not contribute latency samples to the
ordinary benchmark comparisons.

# Total-memory limits

The [total-memory protocol](MEMORY.md) distinguishes cache allowances from a
whole-deployment memory limit. Its Linux cgroup launcher includes server/client
descendants and retains out-of-memory failures. Linux enforcement remains
unqualified on the local Mac; see the
[local audit](../results/memory-20261018/REPORT.md).
