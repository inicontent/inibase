# Public API chunked write optimization

The public API now batches sparse column edits before compression. Local commit d80ca74 changes File.replace; the journal, synchronization, writer locks, file format and public options are unchanged. The experimental row kernel is not involved. Existing databases need no migration for this change.

The 81 new standard trials all verified (81 actual), with zero operation, sampler or setup failures. The complete correctness/recovery suite passed 469 tests across 25 files. Focused regressions cover chunk boundaries, CR/LF/CRLF, Unicode, multi-member gzip, oversized values, beyond-EOF edits and truncated gzip cleanup. Existing process-crash and multi-process tests ran; this is not actual power-loss qualification.

The isolated 100,000-row rewrite diagnostic reduced compressor writes from 100,000 to 8 for the same 500,000 input bytes. Its five instrumented samples fell from 540–561 ms to 16–20 ms. Separate public-update profiles retain the same 16 synchronization calls and 26 opens per update, with roughly 40–57 ms summed synchronization wait. Those async counters include waiting/overlap and are not additive CPU attribution. CPU profiles and raw filesystem counters are retained separately from timing trials.

## Durable update latency and mixed workload

Update p50 is pooled across 24 individual writes per cell (8 per trial × 3). Each cell uses 100,000 records. Mixed time is the median of three trials and includes maintenance attempts and its mutations. Current public iniBase rewrites base columns; compact() may be a no-op. These are not pending-tombstone or repeated bounded-compaction results.

| Dataset | iniBase before update ms | iniBase after update ms | Speedup | SQLite update ms | PostgreSQL update ms | Mixed before / after seconds |
|---|---:|---:|---:|---:|---:|---:|
| compact | 914.85 | 103.86 | 8.8× | 3.91 | 3.99 | 25.55 / 5.98 |
| cms | 941.50 | 101.72 | 9.3× | 3.80 | 3.92 | 28.80 / 8.93 |
| entropy | 929.92 | 101.87 | 9.1× | 3.93 | 3.82 | 56.60 / 37.04 |

Across the 234 descriptive comparisons in speed-wins.json (9 dataset/size cases × 2 alternatives × 13 timed work/query metrics), iniBase had no lower median than SQLite or PostgreSQL. Lazy reopen/control-only timings are excluded. This optimization is a measured improvement to iniBase, not evidence it now beats either alternative.

All measured sizes (no claim of universal superiority):

| Dataset | Rows | Update before / after ms | Mixed speedup | After delete ms |
|---|---:|---:|---:|---:|
| cms | 1000 | 59.90 / 50.17 | 1.09× | 82.01 |
| compact | 1000 | 58.89 / 48.94 | 1.08× | 76.97 |
| entropy | 1000 | 58.87 / 48.13 | 1.08× | 124.75 |
| cms | 10000 | 132.01 / 57.22 | 1.71× | 166.81 |
| compact | 10000 | 131.12 / 57.99 | 1.84× | 118.92 |
| entropy | 10000 | 129.42 / 56.03 | 1.38× | 604.96 |
| cms | 100000 | 941.50 / 101.72 | 3.22× | 1055.14 |
| compact | 100000 | 914.85 / 103.86 | 4.28× | 577.77 |
| entropy | 100000 | 929.92 / 101.87 | 1.53× | 5780.40 |

## Memory, files and remaining cost

The editor uses a 64 KiB output buffer and bounded UTF-8 encoding pieces; unchanged large cells stream without decoding/materialization. It honors downstream backpressure, including extensions and oversized replacements. Caller-owned inputs/results, stream/native compression buffers and other public engine working memory are not all covered by the existing database resource accounting. The configured 16 MiB allowance is not a total RSS bound. No near-zero-RAM or enforced whole-process limit is claimed.

| Dataset | Rows | iniBase before/after peak worker MiB | SQLite / PostgreSQL peak worker MiB | iniBase allocated before/after MiB |
|---|---:|---:|---:|---:|
| cms | 100000 | 497.39 / 547.61 | 547.81 / 399.84 | 12.14 / 12.14 |
| compact | 100000 | 327.34 / 334.81 | 282.56 / 195.97 | 11.48 / 11.48 |
| entropy | 100000 | 468.16 / 553.52 | 582.31 / 457.61 | 91.43 / 91.77 |

The public engine still rewrites entire changed columns. Deletes additionally rebuild shifted disk locations and indexes. Indexed lookups still perform substantial file/metadata work. Durable commits still synchronize multiple files and directories. These structural costs remain; no claim of SQLite/PostgreSQL maturity or broadly superior speed is justified. Next priorities remain a fully integrated mutable-delta path with supported transactions, stable locations/application-key indexes, durable tombstones and bounded compaction. The final replacement format and restartable migration shell tool remain unfinished; a dummy migration is not supplied.

## Measurement and reproduction

Baseline is the retained 81-trial matched-flush public matrix under ../rowstore-20261018/public-write-through. Its imported public engine modules match the immediately measured pre-change build; the only differing baseline module is the unimported experimental rowstore.js. Baseline/source and tooling identity checks are in baseline-artifact-check.json and reproduction.json. The new single-trial before/ folder is diagnostic only: its smaller workload settings differ, and a short isolated rewrite profile overlapped part of its run. It is excluded from comparisons. Raw data is retained.

All three engines use equal six-field application records and the unchanged suite, fresh directories, rotated order, three trials, 1k/10k/100k rows and a 16 MiB cache allowance. The larger fixtures exceed that allowance. SQLite WAL/FULL requests fullfsync/checkpoint_fullfsync; PostgreSQL fsync, synchronous_commit, full_page_writes and Darwin fsync_writethrough are enabled; iniBase synchronization is unchanged. PostgreSQL 18.6 uses a private Unix socket and no service/TCP listener. Node 26.9.0, SQLite 3.53.4, Apple M5/16 GiB/APFS/NVMe/macOS 27.0.1. Exact runtime/hardware/dependencies, all JS/tool hashes and settings are retained in artifacts. Cache was not evicted; reopen is not cold disk.

Latency p95 is reported only with at least 20 samples and p99 with 1000 (not reached). Worker/200 ms process-tree RSS and disk/temp peaks, CPU and available I/O counters are in matrix summaries/raw files. Sampling can miss short peaks; PG tree RSS double-counts shared mappings, worker CPU excludes the PG server, and zero I/O counters do not mean no physical I/O. Native Mac hard RSS limits are unavailable in this environment; Linux cgroup tooling remains unqualified here. Peak temporary classification covers .tmp/pgsql_tmp, not every possible root-level temporary file.

Run from the repository root after installing the pinned root dependencies and benchmark-only pg driver as described in benchmark/qualification/postgres/README.md. Output directories must be fresh:

```sh
node node_modules/typescript/bin/tsc
node benchmark/qualification/checks.mjs
node benchmark/qualification/postgres/run.mjs --engines=inibase,sqlite,postgres --rows=100000 --profiles=compact,cms,entropy --repeats=3 --samples=32 --writes=8 --mixedRounds=3 --flush=write-through --output=/private/tmp/inibase-chunks-large
node benchmark/qualification/postgres/run.mjs --engines=inibase,sqlite,postgres --rows=1000,10000 --profiles=compact,cms,entropy --repeats=3 --samples=32 --writes=8 --mixedRounds=3 --flush=write-through --output=/private/tmp/inibase-chunks-small
node benchmark/qualification/postgres/report.mjs /private/tmp/inibase-chunks-large
node benchmark/qualification/postgres/report.mjs /private/tmp/inibase-chunks-small
```

For exact archived builds and the instrumented compressor-write profile, see reproduction.json and REPRODUCE.sh in this directory. All changes are local; nothing was pushed, published or deployed.
