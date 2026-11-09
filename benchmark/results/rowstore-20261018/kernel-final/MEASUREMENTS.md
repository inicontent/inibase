# Mutable byte-record kernel comparison

Datasets: compact short JSON, repetitive CMS HTML, and entropy strings made from twenty SHA-256 hex digests. The latter is not incompressible binary. Large random binary values are covered by correctness tests, not this timing matrix.

This is an internal kernel benchmark, not public iniBase API performance or feature parity. It stores identical JSON byte records using the mutable row kernel, SQLite BLOB and PostgreSQL BYTEA, with primary-ID disk indexes. Bulk commits contain at most 1,000 rows. Individual write cycles include a verifying point read; read cycles include byte verification and expected-fixture generation. Do not compare these latencies as a public-API speedup ratio.

Flush policy: write-through. SQLite fullfsync/checkpoint_fullfsync ON; PostgreSQL fsync_writethrough on Darwin, fsync elsewhere; iniBase retains Node FileHandle.sync. Actual hardware power loss not qualified.

Fresh directories and three rotated trials; OS filesystem cache is not evicted. Reopen is not cold disk. There is no compaction/reclamation in this kernel; all obsolete bytes remain in measured storage. Large values stream in the engine and full reopen verification streams every ID, avoiding whole-dataset caller results. The cache/working allowance is not a total RSS limit. PostgreSQL process-tree RSS sums double-count shared mappings; allocated footprint includes the fresh complete cluster and WAL. CPU is client-only; sampler lists include live server processes but not complete exited-process CPU.

| Dataset | Rows | Engine | Bulk ms | Random p50/p95 ms | Missing p50 ms | Insert cycle p50 ms | Update cycle p50 ms | Delete cycle p50 ms | Worker peak MiB | Tree sampled MiB | Accounted MiB | Allocated MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| compact | 1000 | inibase | 51.823 | 0.176 / 0.295 | 0.087 | 15.081 | 15.261 | 15.065 | 78.50 | 76.03 | 0.50 | 0.45 |
| compact | 1000 | sqlite | 5.976 | 0.007 / 0.015 | 0.003 | 3.849 | 3.895 | 3.911 | 56.48 | 56.47 | — | 0.17 |
| compact | 1000 | postgres | 9.530 | 0.055 / 0.202 | 0.035 | 3.937 | 3.880 | 3.548 | 65.64 | 114.91 | — | 39.52 |
| compact | 10000 | inibase | 460.747 | 0.173 / 0.377 | 0.087 | 14.812 | 14.871 | 14.909 | 99.83 | 99.80 | 0.50 | 3.61 |
| compact | 10000 | sqlite | 49.930 | 0.009 / 0.051 | 0.003 | 3.863 | 3.872 | 3.908 | 72.27 | 57.67 | — | 1.70 |
| compact | 10000 | postgres | 68.308 | 0.051 / 0.230 | 0.035 | 3.915 | 3.993 | 3.971 | 92.53 | 133.55 | — | 41.48 |
| compact | 100000 | inibase | 4281.213 | 0.167 / 0.361 | 0.083 | 14.899 | 15.181 | 14.838 | 137.55 | 137.55 | 0.50 | 35.74 |
| compact | 100000 | sqlite | 570.762 | 0.013 / 0.078 | 0.004 | 3.969 | 3.997 | 3.964 | 115.70 | 115.70 | — | 17.03 |
| compact | 100000 | postgres | 705.489 | 0.058 / 0.254 | 0.033 | 3.938 | 3.920 | 3.952 | 141.09 | 220.48 | — | 93.90 |
| cms | 1000 | inibase | 53.019 | 0.181 / 0.834 | 0.083 | 15.202 | 15.096 | 14.761 | 79.17 | 78.06 | 0.50 | 0.50 |
| cms | 1000 | sqlite | 8.999 | 0.010 / 0.030 | 0.003 | 3.944 | 3.706 | 3.842 | 61.33 | 60.59 | — | 1.94 |
| cms | 1000 | postgres | 13.574 | 0.056 / 0.184 | 0.036 | 3.536 | 3.936 | 3.978 | 69.89 | 130.53 | — | 40.91 |
| cms | 10000 | inibase | 445.833 | 0.173 / 0.250 | 0.083 | 14.985 | 14.995 | 15.075 | 100.75 | 100.72 | 0.50 | 4.09 |
| cms | 10000 | sqlite | 135.933 | 0.010 / 0.028 | 0.003 | 4.023 | 3.967 | 3.932 | 98.95 | 98.81 | — | 19.56 |
| cms | 10000 | postgres | 138.335 | 0.058 / 0.131 | 0.036 | 3.944 | 3.942 | 3.965 | 114.61 | 184.25 | — | 71.17 |
| cms | 100000 | inibase | 4185.894 | 0.173 / 0.314 | 0.085 | 14.942 | 15.212 | 15.262 | 141.25 | 141.25 | 0.50 | 40.02 |
| cms | 100000 | sqlite | 1319.956 | 0.012 / 0.052 | 0.003 | 4.029 | 3.901 | 3.963 | 149.19 | 147.23 | — | 208.86 |
| cms | 100000 | postgres | 1221.374 | 0.060 / 0.333 | 0.032 | 3.935 | 3.919 | 3.981 | 217.88 | 300.14 | — | 344.78 |
| entropy | 1000 | inibase | 91.721 | 0.187 / 0.360 | 0.084 | 14.082 | 14.906 | 15.025 | 83.97 | 82.88 | 0.50 | 1.14 |
| entropy | 1000 | sqlite | 19.743 | 0.015 / 0.040 | 0.003 | 3.913 | 3.713 | 3.848 | 64.33 | 63.17 | — | 1.98 |
| entropy | 1000 | postgres | 24.261 | 0.060 / 0.174 | 0.040 | 3.892 | 3.944 | 4.005 | 72.53 | 133.84 | — | 40.91 |
| entropy | 10000 | inibase | 835.905 | 0.188 / 0.253 | 0.084 | 14.993 | 15.023 | 14.913 | 108.55 | 108.52 | 0.50 | 11.47 |
| entropy | 10000 | sqlite | 201.940 | 0.018 / 0.359 | 0.003 | 4.005 | 3.980 | 3.963 | 105.56 | 105.28 | — | 19.60 |
| entropy | 10000 | postgres | 200.361 | 0.060 / 0.136 | 0.035 | 3.752 | 3.973 | 3.962 | 116.88 | 176.09 | — | 71.17 |
| entropy | 100000 | inibase | 7931.742 | 0.185 / 0.570 | 0.086 | 14.049 | 14.130 | 14.354 | 159.53 | 159.53 | 0.50 | 112.52 |
| entropy | 100000 | sqlite | 1993.893 | 0.017 / 0.034 | 0.003 | 3.956 | 3.991 | 3.980 | 157.63 | 156.83 | — | 205.98 |
| entropy | 100000 | postgres | 1994.247 | 0.063 / 0.165 | 0.031 | 3.899 | 3.933 | 3.977 | 217.00 | 298.63 | — | 371.76 |

Verified 81/81; failed/setup runs 0; operation errors 0; sampler errors 0.

Raw trials retain all individual samples, commit-stage traces, CPU/resource samples, actual settings, errors and exact compiled module/tool hashes. p95 is omitted below 20 samples and p99 below 1,000. Three trials do not qualify endurance. The public API, application-key indexing, scans/projections, cross-table transactions, maintenance, migration and power-loss behavior remain outside this kernel comparison.
