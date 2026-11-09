# Row construction measurements

Immutable storage kernel only: these are not full iniBase API comparisons. Equal encoded JSON bytes and integer keys; row kernels gzip pages, SQLite stores opaque BLOBs with WAL/FULL. Three rotated trials, fresh directories, warm/OS-cache-affected reads, no cache eviction. Bulk includes caller fixture encoding, disk index construction and durable publication. SQLite checkpoint/close is separate and retained in raw results. High entropy means deterministic SHA-256 hex text, not incompressible binary.

The baseline is the previous immutable row kernel. Candidate adds batched disk ID construction and reusable compression contexts. One MiB cache/reservation/page-cache settings apply to the main matrix; 256 KiB settings apply to the minimum-budget matrix. These are accounting/cache settings, not RSS limits. The replacement public runtime, mutable transactions and migration are not implemented by these measurements.

| Run | Dataset | Rows | Engine | Bulk ms | Read p50 ms | Read p95 ms | Allocated MiB | Peak RSS MiB | Accounted MiB | Sampled temporary MiB | CPU user ms | CPU system ms |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| measured-row | compact | 1000 | baseline | 47.89 | 0.0219 | 0.0492 | 0.13 | 61.33 | 0.35 | 0.00 | 39 | 15 |
| measured-row | compact | 1000 | rowpack | 31.16 | 0.0213 | 0.0466 | 0.12 | 61.41 | 0.50 | 0.00 | 30 | 7 |
| measured-row | compact | 1000 | sqlite | 2.05 | 0.0017 | 0.0038 | 0.12 | 49.97 | 0.00 | 0.00 | 5 | 2 |
| measured-row | compact | 10000 | baseline | 233.79 | 0.1968 | 0.2551 | 1.54 | 76.14 | 0.97 | 0.00 | 174 | 102 |
| measured-row | compact | 10000 | rowpack | 68.97 | 0.0907 | 0.1500 | 1.47 | 74.53 | 0.97 | 0.22 | 83 | 20 |
| measured-row | compact | 10000 | sqlite | 11.20 | 0.0019 | 0.0042 | 1.12 | 57.55 | 0.00 | 0.00 | 15 | 4 |
| measured-row | compact | 100000 | baseline | 2235.19 | 0.1918 | 0.2605 | 13.32 | 87.78 | 0.97 | 0.00 | 1158 | 1199 |
| measured-row | compact | 100000 | rowpack | 416.11 | 0.0880 | 0.1716 | 12.62 | 86.27 | 0.97 | 2.93 | 392 | 118 |
| measured-row | compact | 100000 | sqlite | 108.09 | 0.0025 | 0.0053 | 11.47 | 65.33 | 0.00 | 0.00 | 89 | 31 |
| measured-row | cms | 1000 | baseline | 50.88 | 0.0663 | 0.1425 | 0.14 | 72.06 | 0.99 | 0.00 | 53 | 18 |
| measured-row | cms | 1000 | rowpack | 36.01 | 0.0608 | 0.1418 | 0.14 | 70.59 | 0.99 | 0.00 | 43 | 10 |
| measured-row | cms | 1000 | sqlite | 6.43 | 0.0025 | 0.0056 | 1.96 | 53.27 | 0.00 | 0.00 | 7 | 6 |
| measured-row | cms | 10000 | baseline | 268.45 | 0.0660 | 0.1114 | 1.70 | 90.67 | 0.97 | 0.00 | 192 | 109 |
| measured-row | cms | 10000 | rowpack | 108.17 | 0.0559 | 0.1320 | 1.62 | 74.78 | 0.97 | 0.06 | 110 | 29 |
| measured-row | cms | 10000 | sqlite | 77.35 | 0.0030 | 0.0082 | 19.58 | 57.34 | 0.00 | 0.00 | 34 | 50 |
| measured-row | cms | 100000 | baseline | 2616.62 | 0.0632 | 0.1156 | 15.73 | 161.00 | 0.97 | 0.00 | 1425 | 1328 |
| measured-row | cms | 100000 | rowpack | 719.04 | 0.0565 | 0.1377 | 14.08 | 88.00 | 0.97 | 2.96 | 619 | 206 |
| measured-row | cms | 100000 | sqlite | 747.64 | 0.0038 | 0.0105 | 195.80 | 65.94 | 0.00 | 0.00 | 260 | 492 |
| measured-row | entropy | 1000 | baseline | 103.66 | 0.2559 | 0.4793 | 0.96 | 75.78 | 0.97 | 0.00 | 132 | 19 |
| measured-row | entropy | 1000 | rowpack | 51.03 | 0.1017 | 0.2034 | 0.85 | 75.17 | 0.97 | 0.00 | 70 | 11 |
| measured-row | entropy | 1000 | sqlite | 14.65 | 0.0026 | 0.0071 | 1.96 | 58.56 | 0.00 | 0.00 | 21 | 7 |
| measured-row | entropy | 10000 | baseline | 739.78 | 0.2475 | 0.4517 | 9.89 | 96.00 | 0.97 | 0.00 | 695 | 116 |
| measured-row | entropy | 10000 | rowpack | 235.94 | 0.0997 | 0.2109 | 8.73 | 77.83 | 0.97 | 0.25 | 256 | 35 |
| measured-row | entropy | 10000 | sqlite | 134.82 | 0.0029 | 0.0066 | 19.58 | 59.67 | 0.00 | 0.00 | 98 | 50 |
| measured-row | entropy | 100000 | baseline | 7676.45 | 0.2547 | 0.4884 | 104.95 | 176.09 | 0.97 | 0.00 | 6350 | 1518 |
| measured-row | entropy | 100000 | rowpack | 2053.65 | 0.0972 | 0.1902 | 88.71 | 92.06 | 0.97 | 4.93 | 1969 | 254 |
| measured-row | entropy | 100000 | sqlite | 1277.92 | 0.0038 | 0.0078 | 208.06 | 68.81 | 0.00 | 0.00 | 863 | 437 |
| measured-small | cms | 100000 | baseline | 2631.63 | 0.0628 | 0.1122 | 15.75 | 161.83 | 0.25 | 0.00 | 1441 | 1319 |
| measured-small | cms | 100000 | rowpack | 857.42 | 0.0563 | 0.1173 | 14.00 | 85.38 | 0.25 | 3.55 | 733 | 226 |
| measured-small | cms | 100000 | sqlite | 733.13 | 0.0036 | 0.0075 | 195.80 | 65.08 | 0.00 | 0.00 | 262 | 485 |
| measured-small | entropy | 100000 | baseline | 7489.28 | 0.2550 | 0.4891 | 104.84 | 179.94 | 0.25 | 0.00 | 6262 | 1418 |
| measured-small | entropy | 100000 | rowpack | 3323.43 | 0.1312 | 0.2639 | 88.75 | 91.61 | 0.25 | 3.18 | 3239 | 286 |
| measured-small | entropy | 100000 | sqlite | 1293.01 | 0.0037 | 0.0077 | 208.06 | 68.03 | 0.00 | 0.00 | 844 | 432 |

Read quantiles pool 384 samples across three trials. p99 is omitted. RSS is the maximum of sampled worker RSS and the worker maxRSS counter; the kernels spawn no descendants. Runtime baseline, phase heap/external/ArrayBuffer values, full CPU/I/O counters, logical/allocated disk and temporary samples are retained. Temporary peaks are sampled, not exact high-water marks; files disappearing during sampling are counted as racingPaths. Zero Darwin filesystem counters do not establish zero physical I/O.

## Buffered index I/O

Candidate counters count logical requested bytes and buffered readExact/writeExact operations, not device I/O or necessarily individual syscalls. They exclude the primary/page-directory writes and separate spool creation. The new builder deliberately exchanges extra sequential I/O and temporary storage for fewer small random operations and promises.

| Rows | Entries | Read requests | Write requests | Read MiB | Write MiB | Spool MiB | Partitions |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 1000 | 5 | 4 | 0.12 | 0.09 | 0.03 | 1 |
| 10000 | 10000 | 128 | 118 | 2.83 | 2.53 | 0.31 | 31 |
| 100000 | 100000 | 1408 | 1310 | 35.47 | 32.41 | 3.05 | 255 |

## Audit

- measured-row: 81/81 verified; 0 failed trials.
- measured-small: 18/18 verified; 0 failed trials.
- Sampler errors: 0.
- Earlier baseline-row, after-row, encoder-row and paired-row directories are discovery/stage measurements, not pooled into the final tables. paired-row retains three temporary/startup sampling races before the final sampler fix.
- Core artifact identities and benchmark source hashes are in each environment.json. Baseline/candidate source archives, test logs, allocation/codec diagnostics and the saved original working edits are retained.
- No fsync or lock weakening. SIGKILL tests are process-crash qualification, not power-loss qualification.
- Memory accounting still does not cover the whole existing public engine. The row kernel remains experimental, retains old generations, and lacks mutable transaction/compaction/reclamation support.
