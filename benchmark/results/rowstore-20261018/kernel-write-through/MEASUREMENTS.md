# Mutable byte-record kernel comparison

Datasets: compact short JSON, repetitive CMS HTML, and entropy strings made from twenty SHA-256 hex digests. The latter is not incompressible binary. Large random binary values are covered by correctness tests, not this timing matrix.

This is an internal kernel benchmark, not public iniBase API performance or feature parity. It stores identical JSON byte records using the mutable row kernel, SQLite BLOB and PostgreSQL BYTEA, with primary-ID disk indexes. Bulk commits contain at most 1,000 rows. Individual write cycles include a verifying point read; read cycles include byte verification and expected-fixture generation. Do not compare these latencies as a public-API speedup ratio.

Flush policy: write-through. SQLite fullfsync/checkpoint_fullfsync ON; PostgreSQL fsync_writethrough on Darwin, fsync elsewhere; iniBase retains Node FileHandle.sync. Actual hardware power loss not qualified.

Fresh directories and three rotated trials; OS filesystem cache is not evicted. Reopen is not cold disk. There is no compaction/reclamation in this kernel; all obsolete bytes remain in measured storage. Large values stream in the engine and full reopen verification streams every ID, avoiding whole-dataset caller results. The cache/working allowance is not a total RSS limit. PostgreSQL process-tree RSS sums double-count shared mappings; allocated footprint includes the fresh complete cluster and WAL. CPU is client-only; sampler lists include live server processes but not complete exited-process CPU.

| Dataset | Rows | Engine | Bulk ms | Random p50/p95 ms | Missing p50 ms | Insert cycle p50 ms | Update cycle p50 ms | Delete cycle p50 ms | Worker peak MiB | Tree sampled MiB | Accounted MiB | Allocated MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| compact | 1000 | inibase | 103.793 | 0.153 / 0.261 | 0.070 | 15.013 | 14.345 | 15.836 | 83.77 | 76.23 | 0.25 | 0.38 |
| compact | 1000 | sqlite | 5.934 | 0.008 / 0.082 | 0.003 | 3.807 | 3.842 | 3.866 | 56.36 | 0.00 | — | 0.17 |
| compact | 1000 | postgres | 8.957 | 0.058 / 0.158 | 0.037 | 3.824 | 3.931 | 3.953 | 65.47 | 109.69 | — | 39.52 |
| compact | 10000 | inibase | 1064.833 | 0.154 / 0.220 | 0.074 | 14.867 | 14.710 | 14.383 | 126.33 | 126.31 | 0.25 | 4.30 |
| compact | 10000 | sqlite | 46.991 | 0.009 / 0.025 | 0.003 | 3.848 | 3.784 | 3.868 | 72.03 | 57.61 | — | 1.70 |
| compact | 10000 | postgres | 61.803 | 0.051 / 0.472 | 0.033 | 3.927 | 3.246 | 3.925 | 95.86 | 141.16 | — | 41.48 |
| compact | 100000 | inibase | 11720.249 | 0.159 / 0.644 | 0.072 | 14.852 | 14.884 | 15.021 | 158.25 | 158.23 | 0.25 | 35.27 |
| compact | 100000 | sqlite | 568.909 | 0.013 / 0.044 | 0.004 | 3.958 | 3.970 | 3.976 | 116.00 | 115.94 | — | 17.03 |
| compact | 100000 | postgres | 656.782 | 0.056 / 0.152 | 0.033 | 3.070 | 3.897 | 3.960 | 141.02 | 219.70 | — | 93.90 |
| cms | 1000 | inibase | 106.887 | 0.152 / 0.240 | 0.076 | 15.521 | 14.953 | 15.909 | 86.11 | 78.11 | 0.25 | 0.42 |
| cms | 1000 | sqlite | 9.189 | 0.010 / 0.051 | 0.003 | 3.917 | 3.945 | 3.866 | 61.11 | 61.02 | — | 1.94 |
| cms | 1000 | postgres | 14.068 | 0.054 / 0.165 | 0.032 | 3.783 | 3.856 | 3.973 | 70.72 | 130.70 | — | 40.91 |
| cms | 10000 | inibase | 1132.772 | 0.156 / 0.261 | 0.079 | 14.041 | 14.894 | 15.018 | 139.72 | 139.70 | 0.25 | 4.54 |
| cms | 10000 | sqlite | 134.919 | 0.010 / 0.022 | 0.003 | 3.936 | 3.931 | 3.975 | 99.05 | 97.41 | — | 19.56 |
| cms | 10000 | postgres | 117.569 | 0.050 / 0.124 | 0.033 | 3.836 | 3.937 | 3.832 | 112.11 | 183.84 | — | 71.17 |
| cms | 100000 | inibase | 12298.027 | 0.165 / 0.236 | 0.071 | 14.821 | 14.936 | 14.173 | 159.53 | 159.52 | 0.25 | 40.55 |
| cms | 100000 | sqlite | 1330.934 | 0.013 / 0.073 | 0.003 | 3.931 | 3.845 | 3.952 | 148.67 | 146.89 | — | 208.86 |
| cms | 100000 | postgres | 1154.620 | 0.058 / 0.140 | 0.032 | 3.165 | 3.903 | 3.938 | 213.83 | 294.80 | — | 352.54 |
| entropy | 1000 | inibase | 141.883 | 0.164 / 0.302 | 0.070 | 14.259 | 14.787 | 15.068 | 87.20 | 86.34 | 0.25 | 1.08 |
| entropy | 1000 | sqlite | 18.907 | 0.014 / 0.023 | 0.003 | 3.908 | 3.949 | 3.880 | 64.25 | 63.19 | — | 1.98 |
| entropy | 1000 | postgres | 22.812 | 0.055 / 0.190 | 0.035 | 3.732 | 3.893 | 3.945 | 72.14 | 133.72 | — | 40.91 |
| entropy | 10000 | inibase | 1535.507 | 0.171 / 0.235 | 0.075 | 14.226 | 14.839 | 15.029 | 147.06 | 147.05 | 0.25 | 10.83 |
| entropy | 10000 | sqlite | 196.063 | 0.018 / 0.078 | 0.003 | 3.960 | 3.840 | 3.874 | 105.45 | 105.23 | — | 19.60 |
| entropy | 10000 | postgres | 183.798 | 0.058 / 0.115 | 0.034 | 3.505 | 3.936 | 3.980 | 115.80 | 181.16 | — | 71.17 |
| entropy | 100000 | inibase | 16424.594 | 0.171 / 0.776 | 0.078 | 14.982 | 15.014 | 15.081 | 175.78 | 175.70 | 0.25 | 112.96 |
| entropy | 100000 | sqlite | 1952.833 | 0.017 / 0.028 | 0.003 | 3.999 | 3.849 | 3.971 | 158.00 | 157.59 | — | 205.98 |
| entropy | 100000 | postgres | 1944.748 | 0.064 / 0.148 | 0.031 | 3.140 | 3.867 | 4.002 | 212.56 | 295.02 | — | 360.52 |

Verified 81/81; failed/setup runs 0; operation errors 0; sampler errors 0.

Raw trials retain all individual samples, commit-stage traces, CPU/resource samples, actual settings, errors and exact compiled module/tool hashes. p95 is omitted below 20 samples and p99 below 1,000. Three trials do not qualify endurance. The public API, application-key indexing, scans/projections, cross-table transactions, maintenance, migration and power-loss behavior remain outside this kernel comparison.
