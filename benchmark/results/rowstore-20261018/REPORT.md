# Durable mutable storage: implementation and measured tradeoffs

This stage adds an internal mutable byte-record kernel with durable insert/update/delete batches, a disk COW primary-ID index and retained snapshots. It does not switch the public API to that backend. Application-key indexes, full API semantics/cross-table transactions, bounded compaction/reclamation and the final migration shell tool are still unfinished. No production database is converted.

The five primary matrices retain 405 trials. Verified counts: initial 81/81, buffered 81/81, aligned 81/81, final 81/81, public 81/81. Failures and operation/sampling errors are retained in audit.json and raw files.

## Implementation and correctness

Local commits 7118203 and 022bfcc add the kernel, bounded fresh/pooled handles, cleanup after lock-initialization sync failure, a bounded dirty-page buffer and reused compression state. Commit 1ddd7c4 versions the experimental format to 2 and aligns initial/committed ends to 4 KiB so the next transaction does not share the previous committed block under that assumption. Padding costs up to 4,095 bytes per batch; larger write units and actual failure atomicity remain platform-qualification work. Published bytes stay immutable; unpublished index nodes can be coalesced within a batch. A synchronized root manifest publishes the entire batch after data/index synchronization. Commit 27aa999 checks exact descriptor/path identity before fresh reads and writes and validates reopened snapshot descriptors. The replacement regression fails on its saved pre-fix source. No durability or locking setting is weakened.

The complete suite passes 466 tests across 24 files. Eighteen focused kernel tests cover sparse/random IDs and every radix depth, uncompressed/large entropy/empty values, repeated mutations/tombstones/counts, failed streamed batches, tail repair, committed corruption/truncation, competing writer processes, readers paused across publication, retained snapshots, SIGKILL boundaries, actual sync-call EIO failures, preserved block prefixes, rejection of the earlier experimental format, and replaced paths with stale pooled descriptors. Twenty-four tables share a 256 KiB allowance and four-descriptor limit in a focused test. This is process-crash/fault-injection evidence, not actual power-loss qualification or exhaustive isolation/error qualification.

## Corrected synchronization comparison

Earlier macOS runs used SQLite WAL/FULL with fullfsync OFF and PostgreSQL open_datasync, while Node/libuv requests F_FULLFSYNC. Those samples remain historical platform defaults; their write ratios did not represent equal requested drive-cache flushing. All primary matrices in this report use --flush=write-through: SQLite fullfsync/checkpoint_fullfsync ON; PostgreSQL fsync_writethrough with fsync/synchronous_commit/full_page_writes ON; iniBase retains its existing sync calls. Actual settings are in raw trials. Hardware flush behavior is not power-loss-qualified.

See [the design and source references](../../../docs/mutable-row-storage.md) and [the earlier report correction](../postgres-20261018/REPORT.md).

## Mutable kernel before and after bounded buffering

Datasets are short compact JSON, repetitive CMS HTML and entropy strings containing twenty SHA-256 hex digests. Entropy strings are not incompressible binary; large random binary values are tested for correctness only. Compression/storage conclusions apply to these particular datasets and settings.

Equal JSON bytes and primary IDs are stored by iniBase's internal kernel, SQLite BLOB and PostgreSQL BYTEA. This bypasses the public schema/relations layer. Bulk batches have at most 1,000 rows. Three trials per case rotate engine order and use fresh directories. Initial version-1, intermediate buffered-version-1, aligned-version-2 and final generation-validated-version-2 matrices ran in separate epochs on the same host; cache conditions are OS-affected, not cold disk. The table compares initial version 1 with final version 2, including padding overhead. Intermediate version-1 and pre-generation-check version-2 results remain separate. Individual write cycles include a verifying point read. Reopen is a lazy constructor for iniBase; complete verification afterward checks every ID. Do not claim a recovery/reopen latency win from constructor time.

| 100k dataset | Initial kernel bulk ms | Qualified kernel bulk ms | Improvement | SQLite bulk ms | PostgreSQL bulk ms | Initial/qualified worker peak MiB |
|---|---:|---:|---:|---:|---:|---:|
| compact | 11720.249 | 4281.213 | 2.74× | 570.762 | 705.489 | 158.25 / 137.55 |
| cms | 12298.027 | 4185.894 | 2.94× | 1319.956 | 1221.374 | 159.53 / 141.25 |
| entropy | 16424.594 | 7931.742 | 2.07× | 1993.893 | 1994.247 | 175.78 / 159.53 |

| 100k dataset | Engine | Random-ID cycle p50 ms | Update cycle p50 ms | Delete cycle p50 ms | Allocated MiB |
|---|---|---:|---:|---:|---:|
| compact | inibase | 0.167 | 15.181 | 14.838 | 35.74 |
| compact | sqlite | 0.013 | 3.997 | 3.964 | 17.03 |
| compact | postgres | 0.058 | 3.920 | 3.952 | 93.90 |
| cms | inibase | 0.173 | 15.212 | 15.262 | 40.02 |
| cms | sqlite | 0.012 | 3.901 | 3.963 | 208.86 |
| cms | postgres | 0.060 | 3.919 | 3.981 | 344.78 |
| entropy | inibase | 0.185 | 14.130 | 14.354 | 112.52 |
| entropy | sqlite | 0.017 | 3.991 | 3.980 | 205.98 |
| entropy | postgres | 0.063 | 3.933 | 3.977 | 371.76 |

Measured lower kernel medians versus either competitor across bulk and seven point/write-cycle metrics at all nine dataset/size cases: **0**. SQLite and PostgreSQL remain faster on all those measured metrics.

Compression reduces CMS/entropy file size relative to SQLite in these configurations; compact values lose because per-record compression and COW index metadata cost space. PostgreSQL allocated sizes include its complete fresh cluster and WAL, not just the application table; its empty-cluster footprint is retained in resources JSON. Do not attribute the whole difference to data compression.

The mutable kernel removes table-sized mutation work, but its four synchronization stages (including lock initialization and manifest/directory publication) dominate individual write latency. Raw commit traces separate append/lock time, data sync, manifest sync, publication and return. Bounded page coalescing and reused compression improve bulk CPU/I/O without changing publication ordering.

## Public API comparison with corrected flush requests

This is the existing public column backend, not the mutable kernel. It preserves validation, application-key indexes, projections/filtering, rollback and mixed maintenance workloads. It uses the historical six-field workload with an additive explicit flush setting. Index construction is explicit, not automatic-tuning evidence. Do not turn the next table into a kernel/public speedup ratio.

| 100k dataset | Engine | Bulk ms | Indexed random key p50 ms | Durable update p50 ms | Durable delete p50 ms | Mixed incl. maintenance ms | Allocated MiB |
|---|---|---:|---:|---:|---:|---:|---:|
| compact | inibase | 4357.216 | 3.702 | 914.846 | 570.150 | 25551.621 | 11.48 |
| compact | sqlite | 538.858 | 0.011 | 3.975 | 3.808 | 130.383 | 17.98 |
| compact | postgres | 698.019 | 0.059 | 3.951 | 3.966 | 524.343 | 96.26 |
| cms | inibase | 4477.192 | 3.541 | 941.500 | 1061.500 | 28801.014 | 12.14 |
| cms | sqlite | 1078.094 | 0.011 | 3.969 | 3.995 | 132.161 | 149.48 |
| cms | postgres | 1135.949 | 0.068 | 3.824 | 3.969 | 598.537 | 327.50 |
| entropy | inibase | 9417.097 | 3.915 | 929.925 | 5682.866 | 56598.354 | 91.43 |
| entropy | sqlite | 1930.092 | 0.011 | 3.942 | 3.963 | 126.874 | 205.98 |
| entropy | postgres | 2006.897 | 0.049 | 3.972 | 3.907 | 624.390 | 381.15 |

Full 1k/10k/100k, compact/CMS/entropy tables and p95/raw samples are in [kernel measurements](kernel-final/MEASUREMENTS.md) and [public measurements](public-write-through/MEASUREMENTS.md). These are short workloads. The public backend still rewrites base columns; compact() can be a no-op, with rewrite costs paid in the mutations. The mutable kernel does not compact at all, so its short-cycle throughput is not sustained compacting throughput.

## Memory, storage and remaining priorities

The kernel reserves up to 512 KiB per active mutation, capped at the configured database allowance (256 KiB minimum). Its temporary index-page buffer uses at most 64 KiB (16 KiB at that minimum), inside the reservation. All primary data/indexes stay on disk. These are internal reservations, not total RSS bounds. The public backend, pending-request/snapshot bookkeeping, runtime/GC/native overhead and caller inputs/results are not fully qualified by this accounting. Kernel reopen verification streams results, whereas the public suite materializes full results; their RSS peaks are not equivalent API workloads. Linux hard-limit enforcement remains unqualified on this Mac.

Old nodes, values, tombstones and reader snapshots are retained. Updates append bounded record/path data but repeated mutation grows disk use. Per-record compression loses cross-record compression opportunities. The current whole-table mutable layout is unsuitable as a drop-in replacement for the existing bulk/projection path. Next integrate the measured immutable compressed segments with mutable deltas, implement application-key indexes and supported transactions, then bounded compaction/reader-safe reclamation. Only a fully verified backend should replace the public engine. The final format and external restartable migration .sh remain unfinished.

RSS and disk peaks are sampled and can miss short events. Temporary counters classify .tmp/pgsql_tmp; root-level staged manifests count toward total footprint but not that temporary counter. No exact temporary-disk maximum is qualified. Client CPU omits PostgreSQL server CPU; available zero OS I/O counters do not imply zero physical I/O.

## Provenance and reproduction

Primary source snapshots: candidate-source.tar.gz (initial mutable matrix, f8ee6f5 plus the 14 original local edits), qualified-source.tar.gz (buffered version 1 and the unchanged public backend, 022bfcc plus those edits), aligned-source.tar.gz (initial version 2, 1ddd7c4 plus those edits), and final-source.tar.gz (generation-validated version 2, 27aa999 plus those edits). The public backend does not import the experimental kernel. Compiled JavaScript and benchmark tool hashes are in every environment.json. tooling.tar.gz pins the measured worker/runner sources; report-tooling.tar.gz pins later report tools. Earlier smoke/profile runs are diagnostic only and are not pooled with the primary matrices. All raw samples, logs and failures remain in this tree. artifact-reproduction.json verifies reconstructed builds and worker/runner hashes, and retains the expected pre-fix stale-lock and generation-replacement assertion failures.

```sh
node node_modules/typescript/bin/tsc
node benchmark/qualification/postgres/run.mjs --scenario=rowstore --flush=write-through --rows=1000,10000,100000 --profiles=compact,cms,entropy --repeats=3 --samples=32 --writes=8 --output=/private/tmp/inibase-kernel-fresh
node benchmark/qualification/postgres/rowstore-report.mjs /private/tmp/inibase-kernel-fresh
node benchmark/qualification/postgres/run.mjs --scenario=standard --flush=write-through --rows=1000,10000,100000 --profiles=compact,cms,entropy --repeats=3 --samples=32 --writes=8 --mixedRounds=3 --output=/private/tmp/inibase-public-fresh
node benchmark/qualification/postgres/report.mjs /private/tmp/inibase-public-fresh
node benchmark/qualification/checks.mjs
```

Run from the repository root with Node 26.9.0, installed root dependencies, benchmark-only pg 8.16.3 and local PostgreSQL 18.6. The default binary directory is /opt/homebrew/opt/postgresql@18/bin; supply --pgBin elsewhere. Output parents must exist and output directories must be fresh. See benchmark/qualification/postgres/README.md for dependency setup, archive reconstruction, platform/resource caveats and isolation. No server service is enabled and no TCP listener is used. No push, publish or deploy is performed.
