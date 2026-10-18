# Three-engine public API qualification

This is a new labeled workload. Historical SQLite and immutable-row-kernel
benchmarks are unchanged. It compares the **current public iniBase engine**,
Node's SQLite, and a real local PostgreSQL server, through Node clients.
PostgreSQL is a benchmark-only dependency; it is not part of iniBase's runtime.

**Darwin flush correction:** historical `platform-default` runs used SQLite
fullfsync=OFF and PostgreSQL open_datasync, whereas Node/libuv requests
F_FULLFSYNC. They did not request equal drive-cache flushing. Keep those samples
as historical defaults; use additive `--flush=write-through` runs to request
SQLite fullfsync/checkpoint_fullfsync and PostgreSQL fsync_writethrough on macOS.
iniBase sync is unchanged. See [the protocol correction](../../../docs/mutable-row-storage.md).

The separate `--scenario=rowstore` workload compares encoded byte records using
the internal mutable row kernel, SQLite BLOB and PostgreSQL BYTEA. It bypasses
the public API and does not qualify application-key indexes, scans, validation,
relations, cross-table transactions or compaction. Write-cycle latency includes
a verifying point read; full reopen verification streams every ID. Do not pool
its samples with `standard`. For example, use fresh output directories with:

```sh
node benchmark/qualification/postgres/run.mjs \
  --scenario=rowstore --flush=write-through \
  --rows=1000,10000,100000 --profiles=compact,cms,entropy \
  --repeats=3 --samples=32 --writes=8 \
  --output=/private/tmp/inibase-rowstore-fresh
```

Install native PostgreSQL separately (the measured local version is 18.6), then:

```sh
npm ci --prefix benchmark/qualification/postgres --ignore-scripts
node node_modules/typescript/bin/tsc
mkdir -p .work /private/tmp/inibase-three-engine
node benchmark/qualification/postgres/run.mjs \
  --pgBin=/opt/homebrew/opt/postgresql@18/bin \
  --module="$PWD/dist/index.js" --budget=16777216 \
  --rows=1000,10000,100000 --profiles=compact,cms,entropy \
  --repeats=3 --samples=32 --writes=8 --mixedRounds=3 \
  --output=/private/tmp/inibase-three-engine/measured
node benchmark/qualification/postgres/report.mjs /private/tmp/inibase-three-engine/measured
```

Run from the repository root. Results directories must be fresh and their parent
must exist. The runner requires permission for `ps`, child processes, local Unix
sockets and PostgreSQL shared memory. It starts fresh isolated clusters below
`.work`, uses private short socket directories under `/private/tmp`, has no TCP
listener, and shuts clusters down after each trial. No login service is started.
Failed databases/results are retained. Do not point it at an existing database.
Homebrew may initialize its own empty default cluster during installation; the
runner does not use or start that cluster.

Each of 81 trials stores equal six-field data. Bulk commits have at most 1,000
records. Indexes on the random application key are built in an explicit timed
phase, using `optimize()` for iniBase; this is not an automatic-tuning benchmark.
Tables expose only the four supported options. Initial maintenance and reopen
precede indexed random/sequential/hot/missing probes. Full reads, projections,
non-indexed filtering, individual durable inserts/updates/deletes, reads after
mutations, transaction rollback and repeated maintenance under mixed work are
verified. Full result materialization belongs to the caller and affects RSS.

PostgreSQL uses a persistent `pg` 8.16.3 Unix-domain connection. It retains
`fsync=on`, `synchronous_commit=on`, `full_page_writes=on`, checksums and autovacuum.
Actual WAL sync method and resource settings are retained. PostgreSQL receives
16 MiB shared buffers, plus separately recorded per-operation and maintenance
memory. iniBase gets a 16 MiB shared cache/reservation allowance and SQLite a
16 MiB page cache; these are **not equal total-memory limits**. Node heaps are
capped at 512 MiB; RSS is not enforceably capped by this runner.
iniBase's accounting is shared across tables within each process, not across
independent processes. Concurrent clients each receive that allowance;
PostgreSQL shared buffers belong to the server instance.

The common adapter imports the PostgreSQL driver for every worker before the
recorded runtime baseline. RSS therefore includes that shared harness overhead;
these are not minimum production-process footprints. Per-phase process memory
and runtime baseline RSS are retained for interpretation.

The worker's CPU counters exclude PostgreSQL server CPU. Raw sampler process
lists include live server CPU time, which is incomplete for exited processes.
Summed server/client RSS counts shared mappings more than once. Treat it as a
process metric, not actual physical memory. Complete fresh cluster/WAL disk use,
empty cluster overhead and table/index relation bytes are recorded separately.
Server start/stop and connection-open times are separate from operation latency.
Reopen means closing/reopening the client for PostgreSQL, not a server restart.

Mixed timings include maintenance: iniBase compaction, SQLite WAL checkpoint,
PostgreSQL VACUUM ANALYZE and CHECKPOINT. These mechanisms do different work;
comparisons retain that cost without asserting they are identical. Three short
rounds are not an endurance qualification. Cache conditions are affected by the
OS cache; there is no cache eviction. Sampled temporary/disk/RSS peaks can miss
short events. All errors and failed smoke attempts remain available.

The current public iniBase configuration rewrites base data on mutation and does
not automatically enable its legacy update log. Its `compact()` calls can be
no-ops; the rewrite/compaction cost is already inside mutation latency. This suite
does not claim to qualify a replacement mutable log or pending tombstone overlay.

The exact measured engine source and tooling are archived with the results,
including original local edits. To reconstruct the engine in a fresh directory:

```sh
mkdir /private/tmp/inibase-postgres-engine
tar -xzf benchmark/results/postgres-20261018/engine-source.tar.gz -C /private/tmp/inibase-postgres-engine
ln -s "$PWD/node_modules" /private/tmp/inibase-postgres-engine/node_modules
node node_modules/typescript/bin/tsc --project /private/tmp/inibase-postgres-engine/tsconfig.json
```

Supply that `dist/index.js` through `--module`. Compare every compiled JavaScript
hash with `environment.json`. `measured-tooling.tar.gz` pins the tools used for
the main matrix independently of later additive scenarios. Install the isolated
client from its committed lockfile; iniBase's production dependencies are unchanged.

`measured/` uses the initial engine archive above. The concurrency checks found
two races and led to commit `66783d8`. `measured-fixed/`, `concurrent/` and
`recovery/` use `candidate-source.tar.gz` instead. `artifact-reproduction.json`
verifies every compiled JavaScript hash for both archives. Do not pool versions.
`scenario-tooling.tar.gz` preserves the additive runner and scenarios used after
the fix. To reproduce those scenarios using the candidate module:

```sh
node benchmark/qualification/postgres/run.mjs \
  --scenario=concurrent --rows=1000 --profiles=compact --repeats=3 --writes=32 \
  --module=/absolute/candidate/dist/index.js \
  --output=/private/tmp/inibase-three-engine/concurrent
node benchmark/qualification/postgres/run.mjs \
  --scenario=recovery --rows=1000 --profiles=compact --repeats=3 --writes=32 \
  --module=/absolute/candidate/dist/index.js \
  --output=/private/tmp/inibase-three-engine/recovery
node benchmark/qualification/postgres/scenarios-report.mjs /private/tmp/inibase-three-engine
```

Concurrency starts three writers and one reader at a barrier. Writers use
disjoint keys, perform individual updates, delete every fourth row they visit,
and attempt maintenance every eighth cycle. Reader values must match a permitted
committed state; only designated deletions may be absent. Reopen verifies every
remaining row. SQLite waits up to 10 seconds for busy locks in this scenario;
there are no hidden application retries. Raw writer-cycle samples include reads,
deletes and maintenance and are not single-statement update latency. Reader
samples retain the first 2,048 values while counting every read.

Recovery kills a writer with SIGKILL after observing durable acknowledgements,
then verifies those receipts after reopening. PostgreSQL additionally receives
an immediate server shutdown and restart, qualifying WAL restart rather than
merely client termination. Unobserved acknowledgements may have committed, so
the oracle permits those states while checking that untouched data is preserved.
These are process-crash checks, not power-loss qualification or systematic
injection of every filesystem failure.

Recovery workload version 2 records handle-open time, time through the first
verified read (including lazy recovery), and complete verification separately.
PostgreSQL crash/restart includes server recovery and remains a separate field.
The retained result tree keeps the initial version-1 runs in `recovery/` and
version 2 in `recovery-verified/`; its final scenario summary is regenerated with:

```sh
node benchmark/qualification/postgres/scenarios-report.mjs \
  benchmark/results/postgres-20261018 recovery-verified
```

See [the maturity gates](../../../docs/maturity.md) for work still required before
the replacement runtime can be released. Passing this matrix does not establish
PostgreSQL's feature breadth or operational maturity.
