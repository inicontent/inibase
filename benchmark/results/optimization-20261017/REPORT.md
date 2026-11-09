# Local iniBase optimization results

Implemented local changes and measurements are complete for this optimization stage. The full requested redesign remains incomplete: the shared setting bounds caches rather than all working memory, and compaction still rewrites whole columns under the table lock.

## Source and validation

- Baseline: dd3ed9d72b13daa260e88b6f00327761eb52543d plus the pre-existing working tree in preexisting.patch. baseline.sha256 records exact source hashes.
- Final engine: 102ec04 plus the same pre-existing source edits. final-artifact.sha256 and each matrix environment.json record exact compiled identities. Benchmark tooling has a separate commit and source hashes.
- Local commits: 2ae5b20 (stat identities), d78a478 (overlay I/O and enumeration), 102ec04 (scratch-error recovery), 511d710 (benchmark tooling/documentation). No push or deployment.
- Baseline package suite: 411 passed. Final package + process/journal suites: 427 passed, zero failures. TypeScript passed. The repository-wide formatter reports one pre-existing edit in src/index.ts; changed storage files pass.
- The literal pnpm test attempt was blocked by tsx CLI IPC restrictions; checks.mjs runs the same files with node --import tsx and includes additional process/journal tests.
- A failure injection after durable append reproduced stale recovery in the baseline (cursor-before.log); the final engine recovers the appended frame (cursor-after.log). SIGKILL tests are process-crash qualification, not power-loss qualification.

## Final measured comparison

Final matrix: 81 verified trials; 0 failures. Three rotated trials per engine/profile/size, fresh directories, full durability. SQLite uses WAL/FULL; actual PRAGMAs are in raw results. The OS filesystem cache was not evicted.

100k rows; medians of trial totals and pooled raw lookup samples:

| Data | Engine | Bulk rows/s | Full read ms | Projection ms | Key p50 / p95 ms | Durable update p50 ms | Mixed s | Allocated MiB | Observed RSS MiB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| compact | baseline-indexed | 4721 | 155.87 | 57.83 | 3.140 / 4.297 | 10.098 | 11.74 | 16.70 | 278.97 |
| compact | indexed | 4734 | 160.68 | 57.14 | 3.145 / 4.263 | 9.928 | 11.73 | 16.70 | 280.05 |
| compact | sqlite | 173475 | 56.58 | 26.29 | 0.004 / 0.008 | 0.053 | 0.01 | 18.94 | 385.19 |
| cms | baseline-indexed | 4538 | 260.59 | 54.65 | 3.309 / 4.447 | 9.895 | 12.41 | 17.36 | 434.95 |
| cms | indexed | 4437 | 272.49 | 53.74 | 3.291 / 4.726 | 10.050 | 12.65 | 17.36 | 440.52 |
| cms | sqlite | 61702 | 172.51 | 53.04 | 0.005 / 0.010 | 0.055 | 0.01 | 147.73 | 611.89 |
| mixed | baseline-indexed | 3105 | 566.41 | 56.11 | 3.589 / 4.847 | 10.142 | 17.92 | 97.24 | 571.63 |
| mixed | indexed | 2927 | 604.57 | 61.54 | 3.609 / 4.991 | 9.080 | 18.08 | 96.73 | 495.70 |
| mixed | sqlite | 54573 | 134.78 | 62.85 | 0.006 / 0.014 | 0.035 | 0.01 | 209.82 | 652.13 |

All 1k/10k/100k results, CPU/I/O counters, raw latency samples, failures, sampled RSS and temporary-footprint traces are retained in final-comparison/. Full table: final-comparison/REPORT.md.

## Workloads faster than SQLite

- mixed, 10000 rows, projection: iniBase 6.624 ms vs SQLite 7.561 ms (median of three totals; no confidence interval).
- mixed, 100000 rows, projection: iniBase 61.541 ms vs SQLite 62.854 ms (median of three totals; no confidence interval).

Every listed operation outside those specific wins remains slower in the measured matrix. Small differences are descriptive observations, not proof of a general advantage. IniBase's main advantage here is compressed storage footprint.

## Longer mixed workload

10k repetitive CMS rows, 12 explicit compactions/checkpoints, up to 64 updates plus reads per round, an ongoing delete every eighth selected operation, automatic compaction at the configured overlay threshold, and 1,024 lookup samples per trial. Maintenance remains inside total mixed time.

| Engine | Mixed s | Key p50 / p95 / p99 ms | Peak .tmp logical MiB | Peak cache MiB |
|---|---:|---:|---:|---:|
| baseline-indexed | 20.82 | 2.056 / 2.936 / 4.524 | 1.76 | 16.00 |
| indexed | 27.33 | 1.962 / 6.010 / 12.263 | 1.80 | 16.00 |
| sqlite | 0.06 | 0.003 / 0.005 / 0.010 | 0.00 | 0.00 |

Sustained trial failures: 0. Per-compaction times and actual update/read/delete counts are in each raw worker result. This is a longer local test, not an indefinite steady-state or power-loss qualification.

## Memory, storage and remaining work

- 100k CMS and high-entropy data exceed the 16 MiB configured cache budget. Accounted caches remain within that limit. Observed RSS includes Node, caller materialized reads, input and verification, plus unaccounted engine transients; it is not a total-engine-memory bound.
- --max-old-space-size=512 is an enforceable V8 heap cap, not an RSS or process-tree cap. A Linux cgroup was unavailable on this macOS host. No actual power-loss/device-write-cache qualification was performed.
- Disk includes primary data, indexes, logs and fixtures. Temporary .tmp and scratch .cache footprint samples can miss short peaks and exclude temporary files elsewhere on the system. Zero Darwin fsRead/fsWrite counters do not mean zero physical I/O.
- The new dense scratch ID directory costs eight logical bytes per touched ID, filesystem allocation and one reusable descriptor. It avoids obsolete payload decoding; the values scratch file still retains history until overlay reset/compaction. No authoritative format migration is required.
- Metadata batching was rejected because three rotated trials showed no consistent speed gain. Its raw samples are retained. Early overlapping baseline diagnostics and the interrupted ps-restricted attempt are preserved and excluded from the isolated comparison.
- Highest priorities remain total working-memory reservations/concurrency admission, segment compaction with crash-safe reader reclamation, incremental key-index maintenance and changed-key delta indexes. Group commit needs cross-process ordering, error and recovery coordination; synchronization was not weakened.

## Reproduction

See ../../qualification/README.md for exact build, checks, matrix, block-size and sustained commands. Reconstruct the baseline using git archive dd3ed9d, apply preexisting.patch, link the installed node_modules, and compile with the recorded TypeScript dependency. The report and raw environment/source hashes identify every artifact. Use a new results directory for each run.

## Focused overlay diagnostics

Scratch-only diagnostics; these numbers are not durable application throughput.

| Cache budget | Version | 4096 scratch writes ms | Scan p50 ms |
|---|---|---:|---:|
| 16 MiB | baseline | 270.00 | 57.767 |
| 16 MiB | final | 101.71 | 0.280 |
| 256 KiB | baseline | 269.57 | 56.571 |
| 256 KiB | final | 99.61 | 4.142 |

## Concurrent readers/writers

Three writers and one reader, fresh 1k-row CMS fixtures, three rotated trials. Writer cycles include verification reads, every eighth delete and every 32nd compaction. RSS covers engine worker processes; parent fixture/measurement-harness overhead is separate.

| Engine | Durable mutations/s | Reader reads/s | Writer-cycle p50 / p95 ms | Writer samples | Observed worker-tree RSS MiB |
|---|---:|---:|---:|---:|---:|
| baseline-indexed | 57.19 | 343.77 | 14.136 / 235.000 | 576 | 331.14 |
| indexed | 64.74 | 383.44 | 13.152 / 187.056 | 576 | 327.13 |
| sqlite | 6315.10 | 43471.89 | 0.061 / 0.424 | 576 | 188.28 |

Writer-cycle p99 is omitted below 1,000 samples. Reader raw samples and per-worker CPU/I/O counters are retained. Reopen verifies final rows, changed keys and deletions.

## Block sizes

10k rows, candidate engine, three trials; block controls use eight individual-write samples after the read phases, while the main 128 KiB matrix uses 32. Storage below is taken immediately after initial bulk insertion, before that separate fixture. Only the matching bulk/read phases are compared.

| Data | Block KiB | Bulk rows/s | Full ms | Key p50 ms | Initial allocated MiB |
|---|---:|---:|---:|---:|---:|
| cms | 64 | 9726 | 30.26 | 1.920 | 1.86 |
| cms | 128 | 10314 | 30.12 | 2.062 | 1.85 |
| cms | 256 | 9875 | 28.32 | 1.936 | 1.84 |
| mixed | 64 | 6300 | 60.93 | 2.032 | 8.84 |
| mixed | 128 | 6614 | 58.73 | 2.110 | 8.79 |
| mixed | 256 | 6058 | 61.15 | 2.230 | 8.75 |

Total footprints include indexes and block directories. Exact per-file metadata overhead and physical read/write amplification are not fully qualified. The default remains 128 KiB; these controls do not establish one universally optimal block size.

## Diagnostic operation counts

Separate instrumented 1k-row compact runs with identical settings; asynchronous timings include waiting and are not CPU attribution. CPU profiles and raw counters are retained.

| Operation | Baseline calls | Final calls |
|---|---:|---:|
| fs.open | 6308 | 5242 |
| handle.close | 6379 | 5313 |
| fs.stat | 12337 | 13044 |
| handle.read | 5339 | 4230 |
| handle.write | 663 | 663 |
| handle.sync | 561 | 561 |
| zlib.gunzipSync | 85 | 85 |
| zlib.createGunzip | 202 | 202 |
| subprocess.exec | 2 | 2 |
| subprocess.execFile | 2 | 2 |

## Sustained recheck

The first sustained set had a slower candidate median (27.33 s versus 20.82 s) and later trials of both engines slowed. Four additional trials per iniBase build used alternating AB/BA engine order. Both sets are retained; the recheck does not erase the earlier regression.

- baseline-indexed: four-trial median 20.05 s; individual trials 19.99, 20.04, 20.06, 20.20 s.
- indexed: four-trial median 19.90 s; individual trials 19.71, 19.87, 19.93, 20.14 s.

These runs do not establish a consistent sustained-throughput gain or isolate the cause of the earlier timing gap. Original and recheck CPU/IO counters, per-compaction samples and timestamps remain available.

The initial concurrent smoke version used trailing-space input and failed the equal-data assertion because existing iniBase string validation trims strings. The version-2 fixture supplies identical normalized input to all engines. Failed smoke results, databases and its matching-hash runner source are retained.

The unchanged historical, computed-field, populated-overlay and full-durability benchmarks were rerun sequentially for the frozen baseline and final local source. Their raw logs are retained. The durability-none comparison was not run under this task's fsync constraint. Baseline reconstruction and final artifact hashes both verified exactly; all 14 pre-existing edited files match the initial patch byte for byte.
