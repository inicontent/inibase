# Automatic durable deltas: public API qualification

Ordinary eligible point updates append checksummed durable frames; deletes append tombstones. They do not replace base columns or their indexes. Selection, validation, uniqueness and merged reads remain on the public API. Local implementation: 0c7db4d and 3d4c67e plus the original fourteen preserved local edits. No table options were added: decodeID, prepend, compression and cache remain the public configuration.

This removes per-operation rewrites for append-layout, simple non-computed tables with at least 128 physical rows, small payloads and at most 256 selected rows. It does not remove every rewrite: transactions, schema changes, nested/related/computed schemas, prepend, broad or oversized changes retain supported materialized paths. Automatic compaction and explicit maintenance still rewrite affected columns (all columns when removing tombstones). Whole-engine RAM qualification and segment-level bounded-I/O compaction remain unfinished. See docs/automatic-deltas.md for exact policy and recovery.

Final verification: 488 tests passed across 26 files. Final standard matrix: 81/81; forced-maintenance stress: 9/9; concurrent/recovery results are in SCENARIOS.json. All primary comparisons have zero recorded operation, setup and sampler errors. An earlier full-suite attempt and initial 81-trial development matrix are retained and not pooled with the final build.

## Point writes at 100,000 records

P50 pools 24 durable operations (8 × 3 trials); activation costs are included, not discarded. P95 is available in raw summaries; sample counts do not support p99. Previous version is the measured public chunked-rewrite build d80ca74, not an internal byte-record kernel.

| Dataset | Update before → after ms | Update speedup | Delete before → after ms | Delete speedup | SQLite update / delete ms | PostgreSQL update / delete ms |
|---|---:|---:|---:|---:|---:|---:|
| compact | 103.86 → 11.82 | 8.8× | 577.77 → 9.99 | 57.8× | 3.96 / 3.45 | 3.97 / 3.98 |
| cms | 101.72 → 11.79 | 8.6× | 1055.14 → 9.96 | 105.9× | 3.93 / 3.98 | 3.97 / 3.99 |
| entropy | 101.87 → 11.94 | 8.5× | 5780.40 → 10.03 | 576.4× | 4.01 / 3.98 | 3.88 / 3.96 |

Separate instrumented public-update profiles show 16 synchronization calls and 26 opens before, versus 2 synchronization calls and 7 opens for steady-state delta writes. The first activation used 7 synchronization calls and remains included in benchmark samples. Synchronization was not disabled: unchanged primary/index files need no replacement publication; each append still waits for durable log synchronization. These counters/CPU profiles are diagnostic and not pooled with the uninstrumented trials.

## Maintenance-inclusive comparisons

Mixed time includes updates, read verification, deletes and three real compaction calls. This configuration now has pending frames/tombstones, so iniBase compact() performs work rather than being a no-op. Transaction rollback also first folds prior deltas and is reported separately in raw phases. These short cycles do not establish endurance or PostgreSQL maturity.

| Dataset | Rows | Mixed before → after seconds | Speedup | SQLite / PostgreSQL seconds | Update / delete after p50 ms |
|---|---:|---:|---:|---:|---:|
| cms | 1000 | 1.73 → 0.66 | 2.61× | 0.13 / 0.44 | 10.15 / 9.99 |
| compact | 1000 | 1.71 → 0.64 | 2.66× | 0.13 / 0.44 | 11.55 / 10.01 |
| entropy | 1000 | 2.01 → 0.80 | 2.52× | 0.13 / 0.45 | 10.99 / 9.16 |
| cms | 10000 | 2.45 → 1.21 | 2.03× | 0.13 / 0.49 | 11.98 / 10.00 |
| compact | 10000 | 2.12 → 1.04 | 2.05× | 0.13 / 0.50 | 11.93 / 9.97 |
| entropy | 10000 | 5.03 → 2.54 | 1.98× | 0.13 / 0.48 | 11.06 / 10.06 |
| cms | 100000 | 8.93 → 7.45 | 1.20× | 0.13 / 0.59 | 11.79 / 9.96 |
| compact | 100000 | 5.98 → 5.82 | 1.03× | 0.13 / 0.53 | 11.82 / 9.99 |
| entropy | 100000 | 37.04 → 20.96 | 1.77× | 0.13 / 0.61 | 11.94 / 10.03 |

The separate stress matrix uses 10k CMS rows, 80 writes, 80 lookup samples, eight mixed rounds, three trials and INIBASE_MAX_OVERLAY_RECORDS=64. The lower deployment limit forces automatic folds within the workload as well as explicit maintenance. The complete cost remains in operation and mixed timings; it is not subtracted. PostgreSQL and SQLite receive identical application data/operations and full durability. See stress/MEASUREMENTS.md and stress-configuration.json. This is a short stress run, not long-duration endurance.


Pending-change point reads at 100k records (p50 ms):

| Dataset | After updates before → after | After deletes before → after |
|---|---:|---:|
| cms | 2.82 → 3.20 | 3.24 → 2.93 |
| compact | 2.89 → 3.34 | 3.23 → 3.09 |
| entropy | 2.82 → 3.24 | 3.61 → 3.06 |

Delta reconciliation adds read work; the improvement is primarily in mutations. These results do not show a general read-speed win.

## Memory and storage

Automatic point working reservations share the database allowance, including caches/overlays across all tables. Payload estimates and merged per-row overlays are bounded conservatively; accumulation is capped at 2,048 IDs / 8 MiB before the next write folds (deployment limits can lower these). A small-budget test exercises twelve tables, parallel updates/deletes, sorted reads and four pooled descriptors with a 256 KiB resource allowance. This is not a 256 KiB process-RSS result. Inherited engine paths, native buffers, metadata, caller results and runtime/GC are not all qualified by this accounting.

| Dataset | Worker peak before / after MiB | iniBase allocated before / after MiB | SQLite / PG allocated MiB |
|---|---:|---:|---:|
| cms | 547.61 / 560.00 | 12.14 / 12.14 | 149.48 / 330.14 |
| compact | 334.81 / 316.58 | 11.48 / 11.48 | 17.98 / 96.26 |
| entropy | 553.52 / 474.78 | 91.77 / 91.51 | 209.90 / 373.07 |

Full reads deliberately materialize caller-requested results; peak process RSS includes those objects and GC. Disk footprints include logs/indexes/scratch at observation time; final maintenance can remove the pending log. PostgreSQL totals include the complete fresh cluster and WAL; empty-cluster and relation bytes are reported separately in raw summaries. Compaction still needs staged replacement space. Sorted compressed reads use temporary plain sort columns and a size-limited native sort rather than materializing all rows in JavaScript; large-sort temporary-space peaks are not qualified by the standard suite. Cache entries are generation-aware, and compaction invalidates query caches.

## Correctness and limits

Tests cover indexed keys changed/deleted, uniqueness after tombstones, pagination and sums, explicit compaction/reopen, encrypted IDs, metadata edits, large values, broad updates, schema/prepend fallback, transaction commit/rollback, independent writers/readers, small shared allowances, SIGKILL around marker publication/append/synchronization/partial compaction and injected synchronization failure. Existing torn/replaced log, stale metadata and journal recovery checks ran. Failed synchronization is rejected; an unacknowledged write can have an indeterminate outcome. These are process-crash/EIO tests, not hardware power-loss qualification.

Across 270 descriptive timed work/query comparisons, iniBase has 1 lower medians than the alternatives. All entries, including any narrow wins, are recorded in audit.json. Lazy reopen/control-only phases are excluded. Lower descriptive medians from three trials do not establish statistical or universal superiority. SQLite/PostgreSQL comparisons, all slower cases, CPU/I/O counters and latency samples remain in qualified/summary.json and raw files.


Observed lower medians (three trials; descriptive only):

| Dataset | Rows | Metric | iniBase ms | Alternative | Alternative ms |
|---|---:|---|---:|---|---:|
| entropy | 100000 | projection | 48.36 | sqlite | 54.17 |

All other timed comparisons in this set were slower. This narrow result does not establish a general speed advantage.

## Reproduction and provenance

Source and tooling SHA-256 identities are in every environment.json. reproduction.json rebuilds the baseline, initial development and final measured source snapshots and checks every emitted JavaScript module and benchmark tool. Exact runtime/dependency/binary identities are in dependencies.json and dependency-verification.json. The baseline is the prior public-chunks-20261018 after/ and after-small/ matrices. The initial comparison/ matrix used initial-source.tar.gz and is retained separately. The intermediate-* matrices used intermediate-source.tar.gz before the compressed-sort ownership fix and are also excluded from final aggregation. Final primary results use qualified-source.tar.gz. The original fourteen local edits remain unstaged and preserved.

All runs use equal six-field application data, 1k/10k/100k compact/CMS/SHA-derived high-entropy text fixtures (not incompressible binary), three rotated isolated trials and fresh directories. The largest data exceeds the 16 MiB engine allowance. SQLite WAL/FULL requests fullfsync/checkpoint_fullfsync; PostgreSQL fsync, synchronous_commit, full_page_writes and Darwin fsync_writethrough are enabled; iniBase acknowledgements retain synchronous durable logging and the existing locks. No group commit or weakened synchronization was introduced. PostgreSQL is a private Unix-socket cluster, not a service. OS filesystem cache was not evicted; reopen is not cold disk.

Host: Apple M5, 16 GiB, APFS/NVMe, macOS 27.0.1; Node 26.9.0, SQLite 3.53.4 and PostgreSQL 18.6. CPU counters omit PostgreSQL server CPU from worker-only figures. Process-tree RSS sums PG shared mappings more than once; 200 ms memory/disk sampling can miss peaks. Available zero I/O counters do not imply zero physical I/O. Native Mac hard RSS limits are unavailable here, and Linux cgroup tooling remains unqualified. Exact settings and these limits are retained rather than equating cache allowances with enforced memory caps.

Run REPRODUCE.sh from this directory for exact archived builds, checks and the standard comparison. Fresh output directories are required. No data conversion, push, publication or deployment occurred. This existing-format optimization needs no conversion script; the final replacement format and external migration tool requested earlier remain separate unfinished work.
