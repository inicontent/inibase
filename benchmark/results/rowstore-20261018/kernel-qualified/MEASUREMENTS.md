# Mutable byte-record kernel comparison

Datasets: compact short JSON, repetitive CMS HTML, and entropy strings made from twenty SHA-256 hex digests. The latter is not incompressible binary. Large random binary values are covered by correctness tests, not this timing matrix.

This is an internal kernel benchmark, not public iniBase API performance or feature parity. It stores identical JSON byte records using the mutable row kernel, SQLite BLOB and PostgreSQL BYTEA, with primary-ID disk indexes. Bulk commits contain at most 1,000 rows. Individual write cycles include a verifying point read; read cycles include byte verification and expected-fixture generation. Do not compare these latencies as a public-API speedup ratio.

Flush policy: write-through. SQLite fullfsync/checkpoint_fullfsync ON; PostgreSQL fsync_writethrough on Darwin, fsync elsewhere; iniBase retains Node FileHandle.sync. Actual hardware power loss not qualified.

Fresh directories and three rotated trials; OS filesystem cache is not evicted. Reopen is not cold disk. There is no compaction/reclamation in this kernel; all obsolete bytes remain in measured storage. Large values stream in the engine and full reopen verification streams every ID, avoiding whole-dataset caller results. The cache/working allowance is not a total RSS limit. PostgreSQL process-tree RSS sums double-count shared mappings; allocated footprint includes the fresh complete cluster and WAL. CPU is client-only; sampler lists include live server processes but not complete exited-process CPU.

| Dataset | Rows | Engine | Bulk ms | Random p50/p95 ms | Missing p50 ms | Insert cycle p50 ms | Update cycle p50 ms | Delete cycle p50 ms | Worker peak MiB | Tree sampled MiB | Accounted MiB | Allocated MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| compact | 1000 | inibase | 51.687 | 0.154 / 0.258 | 0.076 | 14.897 | 14.864 | 14.906 | 78.00 | 76.56 | 0.50 | 0.38 |
| compact | 1000 | sqlite | 5.150 | 0.007 / 0.025 | 0.003 | 3.864 | 3.208 | 3.246 | 56.66 | 0.00 | — | 0.17 |
| compact | 1000 | postgres | 8.681 | 0.057 / 0.167 | 0.037 | 3.925 | 3.965 | 3.962 | 65.53 | 115.41 | — | 39.52 |
| compact | 10000 | inibase | 445.830 | 0.167 / 0.324 | 0.077 | 14.920 | 14.097 | 15.058 | 101.55 | 101.52 | 0.50 | 3.52 |
| compact | 10000 | sqlite | 47.902 | 0.009 / 0.024 | 0.003 | 3.781 | 3.851 | 3.763 | 72.08 | 57.61 | — | 1.70 |
| compact | 10000 | postgres | 65.233 | 0.053 / 0.177 | 0.036 | 3.953 | 3.999 | 3.973 | 95.41 | 135.44 | — | 41.48 |
| compact | 100000 | inibase | 4221.758 | 0.161 / 0.243 | 0.075 | 14.774 | 14.427 | 14.901 | 138.42 | 138.42 | 0.50 | 35.68 |
| compact | 100000 | sqlite | 568.131 | 0.014 / 0.034 | 0.004 | 3.931 | 3.962 | 3.996 | 115.78 | 115.78 | — | 17.03 |
| compact | 100000 | postgres | 683.741 | 0.059 / 0.280 | 0.031 | 3.900 | 3.924 | 3.951 | 141.94 | 220.36 | — | 93.90 |
| cms | 1000 | inibase | 52.826 | 0.166 / 0.743 | 0.078 | 14.992 | 14.952 | 15.026 | 78.25 | 76.94 | 0.50 | 0.42 |
| cms | 1000 | sqlite | 10.055 | 0.009 / 0.026 | 0.003 | 3.953 | 3.736 | 3.087 | 61.20 | 58.78 | — | 1.94 |
| cms | 1000 | postgres | 11.708 | 0.051 / 0.170 | 0.036 | 3.027 | 3.879 | 3.930 | 69.88 | 118.20 | — | 40.91 |
| cms | 10000 | inibase | 446.525 | 0.166 / 0.260 | 0.077 | 14.993 | 15.222 | 15.193 | 103.42 | 103.39 | 0.50 | 3.99 |
| cms | 10000 | sqlite | 132.955 | 0.010 / 0.022 | 0.003 | 3.983 | 3.924 | 3.958 | 98.94 | 94.23 | — | 19.56 |
| cms | 10000 | postgres | 129.827 | 0.051 / 0.124 | 0.035 | 3.895 | 3.952 | 3.240 | 113.20 | 183.75 | — | 71.17 |
| cms | 100000 | inibase | 4078.728 | 0.155 / 0.231 | 0.071 | 14.104 | 14.919 | 14.502 | 140.84 | 140.41 | 0.50 | 40.45 |
| cms | 100000 | sqlite | 1300.797 | 0.013 / 0.031 | 0.003 | 3.742 | 3.794 | 3.941 | 148.84 | 146.41 | — | 203.00 |
| cms | 100000 | postgres | 1146.055 | 0.056 / 0.129 | 0.032 | 3.184 | 3.926 | 3.985 | 211.66 | 293.17 | — | 350.96 |
| entropy | 1000 | inibase | 88.193 | 0.166 / 0.280 | 0.072 | 14.816 | 14.702 | 15.857 | 83.13 | 79.03 | 0.50 | 1.08 |
| entropy | 1000 | sqlite | 17.860 | 0.014 / 0.023 | 0.003 | 3.989 | 3.854 | 3.918 | 64.31 | 63.61 | — | 1.98 |
| entropy | 1000 | postgres | 21.930 | 0.056 / 0.150 | 0.031 | 3.726 | 3.905 | 3.948 | 72.50 | 133.94 | — | 40.91 |
| entropy | 10000 | inibase | 809.157 | 0.168 / 0.232 | 0.076 | 15.083 | 15.037 | 14.913 | 107.11 | 107.06 | 0.50 | 11.44 |
| entropy | 10000 | sqlite | 200.861 | 0.019 / 0.441 | 0.003 | 3.991 | 3.925 | 3.928 | 106.14 | 105.14 | — | 19.60 |
| entropy | 10000 | postgres | 186.994 | 0.059 / 0.135 | 0.034 | 3.952 | 3.882 | 3.960 | 114.91 | 185.38 | — | 71.17 |
| entropy | 100000 | inibase | 7763.411 | 0.177 / 0.237 | 0.072 | 14.950 | 14.938 | 14.921 | 157.97 | 157.95 | 0.50 | 112.50 |
| entropy | 100000 | sqlite | 2008.092 | 0.017 / 0.035 | 0.003 | 3.985 | 3.904 | 3.967 | 161.14 | 160.44 | — | 202.07 |
| entropy | 100000 | postgres | 1918.876 | 0.063 / 0.146 | 0.032 | 3.144 | 3.897 | 3.944 | 220.02 | 301.17 | — | 360.52 |

Verified 81/81; failed/setup runs 0; operation errors 0; sampler errors 0.

Raw trials retain all individual samples, commit-stage traces, CPU/resource samples, actual settings, errors and exact compiled module/tool hashes. p95 is omitted below 20 samples and p99 below 1,000. Three trials do not qualify endurance. The public API, application-key indexing, scans/projections, cross-table transactions, maintenance, migration and power-loss behavior remain outside this kernel comparison.
