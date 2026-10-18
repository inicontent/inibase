# Mutable byte-record kernel comparison

Datasets: compact short JSON, repetitive CMS HTML, and entropy strings made from twenty SHA-256 hex digests. The latter is not incompressible binary. Large random binary values are covered by correctness tests, not this timing matrix.

This is an internal kernel benchmark, not public iniBase API performance or feature parity. It stores identical JSON byte records using the mutable row kernel, SQLite BLOB and PostgreSQL BYTEA, with primary-ID disk indexes. Bulk commits contain at most 1,000 rows. Individual write cycles include a verifying point read; read cycles include byte verification and expected-fixture generation. Do not compare these latencies as a public-API speedup ratio.

Flush policy: write-through. SQLite fullfsync/checkpoint_fullfsync ON; PostgreSQL fsync_writethrough on Darwin, fsync elsewhere; iniBase retains Node FileHandle.sync. Actual hardware power loss not qualified.

Fresh directories and three rotated trials; OS filesystem cache is not evicted. Reopen is not cold disk. There is no compaction/reclamation in this kernel; all obsolete bytes remain in measured storage. Large values stream in the engine and full reopen verification streams every ID, avoiding whole-dataset caller results. The cache/working allowance is not a total RSS limit. PostgreSQL process-tree RSS sums double-count shared mappings; allocated footprint includes the fresh complete cluster and WAL. CPU is client-only; sampler lists include live server processes but not complete exited-process CPU.

| Dataset | Rows | Engine | Bulk ms | Random p50/p95 ms | Missing p50 ms | Insert cycle p50 ms | Update cycle p50 ms | Delete cycle p50 ms | Worker peak MiB | Tree sampled MiB | Accounted MiB | Allocated MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| compact | 1000 | inibase | 50.708 | 0.155 / 0.269 | 0.075 | 14.908 | 15.096 | 15.705 | 79.41 | 74.81 | 0.50 | 0.45 |
| compact | 1000 | sqlite | 5.805 | 0.007 / 0.032 | 0.003 | 3.913 | 3.121 | 3.836 | 56.50 | 0.00 | — | 0.17 |
| compact | 1000 | postgres | 7.801 | 0.051 / 0.163 | 0.035 | 3.821 | 3.967 | 3.962 | 65.42 | 117.94 | — | 39.52 |
| compact | 10000 | inibase | 459.963 | 0.161 / 0.253 | 0.073 | 13.710 | 14.968 | 15.721 | 96.98 | 96.59 | 0.50 | 3.61 |
| compact | 10000 | sqlite | 48.944 | 0.008 / 0.023 | 0.003 | 3.016 | 3.135 | 3.157 | 72.22 | 59.13 | — | 1.70 |
| compact | 10000 | postgres | 73.111 | 0.048 / 0.489 | 0.036 | 3.902 | 3.954 | 3.939 | 95.33 | 149.41 | — | 41.48 |
| compact | 100000 | inibase | 4275.906 | 0.160 / 0.243 | 0.070 | 15.055 | 15.264 | 15.548 | 135.91 | 135.91 | 0.50 | 35.74 |
| compact | 100000 | sqlite | 581.807 | 0.013 / 0.035 | 0.004 | 4.000 | 3.953 | 3.963 | 116.13 | 115.88 | — | 17.03 |
| compact | 100000 | postgres | 646.183 | 0.064 / 0.316 | 0.033 | 3.798 | 3.898 | 3.962 | 140.28 | 220.20 | — | 93.90 |
| cms | 1000 | inibase | 53.900 | 0.172 / 0.851 | 0.074 | 15.905 | 15.021 | 15.839 | 79.17 | 77.38 | 0.50 | 0.50 |
| cms | 1000 | sqlite | 9.987 | 0.009 / 0.017 | 0.003 | 3.822 | 3.882 | 3.871 | 61.13 | 60.22 | — | 1.94 |
| cms | 1000 | postgres | 14.388 | 0.053 / 0.201 | 0.035 | 3.945 | 3.948 | 3.913 | 69.75 | 130.59 | — | 40.91 |
| cms | 10000 | inibase | 446.983 | 0.159 / 0.271 | 0.073 | 15.194 | 15.054 | 15.209 | 103.55 | 103.52 | 0.50 | 4.09 |
| cms | 10000 | sqlite | 136.728 | 0.011 / 0.028 | 0.003 | 4.003 | 3.887 | 3.900 | 99.23 | 99.20 | — | 19.56 |
| cms | 10000 | postgres | 129.353 | 0.053 / 0.135 | 0.037 | 3.976 | 3.925 | 3.950 | 114.89 | 184.14 | — | 71.17 |
| cms | 100000 | inibase | 4148.869 | 0.165 / 0.246 | 0.073 | 14.094 | 14.977 | 14.965 | 138.27 | 138.27 | 0.50 | 40.48 |
| cms | 100000 | sqlite | 1344.905 | 0.012 / 0.031 | 0.003 | 3.976 | 3.954 | 3.898 | 149.50 | 147.28 | — | 204.94 |
| cms | 100000 | postgres | 1216.023 | 0.058 / 0.246 | 0.033 | 3.937 | 3.937 | 3.958 | 214.08 | 296.53 | — | 345.62 |
| entropy | 1000 | inibase | 94.077 | 0.171 / 0.464 | 0.071 | 15.063 | 14.979 | 15.090 | 81.17 | 76.50 | 0.50 | 1.14 |
| entropy | 1000 | sqlite | 20.027 | 0.015 / 0.048 | 0.003 | 3.972 | 3.977 | 3.941 | 64.27 | 62.98 | — | 1.98 |
| entropy | 1000 | postgres | 26.363 | 0.065 / 0.331 | 0.033 | 3.886 | 3.873 | 3.940 | 72.70 | 134.39 | — | 40.91 |
| entropy | 10000 | inibase | 828.515 | 0.178 / 0.364 | 0.076 | 14.789 | 14.866 | 14.041 | 107.03 | 107.00 | 0.50 | 11.48 |
| entropy | 10000 | sqlite | 211.960 | 0.018 / 0.404 | 0.003 | 3.943 | 3.986 | 3.774 | 105.91 | 104.88 | — | 19.60 |
| entropy | 10000 | postgres | 195.497 | 0.059 / 0.135 | 0.037 | 3.888 | 3.968 | 3.950 | 117.80 | 188.97 | — | 71.17 |
| entropy | 100000 | inibase | 7946.169 | 0.160 / 0.264 | 0.080 | 14.927 | 15.030 | 15.109 | 156.41 | 156.06 | 0.50 | 112.52 |
| entropy | 100000 | sqlite | 2014.002 | 0.017 / 0.029 | 0.003 | 3.988 | 3.939 | 3.777 | 158.08 | 157.25 | — | 205.98 |
| entropy | 100000 | postgres | 2031.816 | 0.064 / 0.346 | 0.032 | 3.706 | 3.948 | 3.925 | 217.08 | 299.77 | — | 367.09 |

Verified 81/81; failed/setup runs 0; operation errors 0; sampler errors 0.

Raw trials retain all individual samples, commit-stage traces, CPU/resource samples, actual settings, errors and exact compiled module/tool hashes. p95 is omitted below 20 samples and p99 below 1,000. Three trials do not qualify endurance. The public API, application-key indexing, scans/projections, cross-table transactions, maintenance, migration and power-loss behavior remain outside this kernel comparison.
