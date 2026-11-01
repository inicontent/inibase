# Public API comparison: iniBase, SQLite, PostgreSQL

Flush policy: write-through. SQLite fullfsync/checkpoint_fullfsync ON; PostgreSQL fsync_writethrough on Darwin, fsync elsewhere; iniBase retains Node FileHandle.sync. Actual hardware power loss not qualified.

Equal six-field application records; bulk commits contain at most 1,000 records. Bulk timings include fixture creation. Index construction is explicit and measured for all engines; this is not automatic-tuning evidence. Existing iniBase public backend, not the experimental row kernel. Local PostgreSQL Unix-domain connection versus embedded calls. Fresh directories, rotated trials, existing OS filesystem cache. Full durability; actual settings and hashes retained in environment/trial files.

Mixed time includes maintenance attempts: iniBase compact(), SQLite WAL checkpoint, PostgreSQL VACUUM ANALYZE plus CHECKPOINT. Current public iniBase defaults rewrite base data on mutation, so compact() can be a no-op and rewrite cost sits inside mutation latency. There is no substantial pending log/tombstone overlay in this configuration. These are different maintenance mechanisms and these short runs do not establish endurance or PostgreSQL maturity. Reopen closes/reopens the client/engine, not the PostgreSQL server. Heap/cache settings do not bound whole-engine RSS. PostgreSQL tree RSS sums shared mappings more than once; it is not physical memory. Allocated PostgreSQL footprint includes the complete fresh cluster and WAL; empty cluster and relation bytes are reported separately.

| Dataset | Rows | Engine | Bulk ms | Records/s | Index ms | Random p50/p95 ms | Full ms | Projection ms | Insert p50 ms | Update p50 ms | Delete p50 ms | Mixed incl. maintenance ms | Worker peak MiB | Sampled tree peak MiB | Allocated MiB | PG empty/relation MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| compact | 1000 | inibase | 67.003 | 14925 | 81.933 | 1.352 / 2.711 | 4.207 | 1.916 | 37.100 | 11.548 | 10.013 | 644.269 | 108.03 | 107.47 | 0.22 | — |
| compact | 1000 | sqlite | 5.937 | 168441 | 3.904 | 0.009 / 0.016 | 0.372 | 0.178 | 3.940 | 3.909 | 3.224 | 129.318 | 57.80 | 57.59 | 0.19 | — |
| compact | 1000 | postgres | 9.074 | 110208 | 8.942 | 0.057 / 0.138 | 1.098 | 0.478 | 3.218 | 3.994 | 3.986 | 444.236 | 63.25 | 122.98 | 39.81 | 38.95 / 0.33 |
| compact | 10000 | inibase | 449.308 | 22256 | 120.158 | 1.905 / 4.094 | 17.550 | 6.771 | 35.190 | 11.934 | 9.968 | 1037.723 | 159.56 | 159.42 | 1.28 | — |
| compact | 10000 | sqlite | 48.292 | 207075 | 6.898 | 0.011 / 0.019 | 5.343 | 3.122 | 3.941 | 3.938 | 3.116 | 130.401 | 105.73 | 89.42 | 1.79 | — |
| compact | 10000 | postgres | 72.073 | 138748 | 17.961 | 0.071 / 0.177 | 9.045 | 3.104 | 3.241 | 3.943 | 3.980 | 498.208 | 89.31 | 155.19 | 57.97 | 38.95 / 2.55 |
| compact | 100000 | inibase | 4384.113 | 22810 | 449.939 | 3.370 / 4.946 | 145.956 | 55.944 | 36.211 | 11.818 | 9.994 | 5823.783 | 316.58 | 316.58 | 11.48 | — |
| compact | 100000 | sqlite | 562.122 | 177897 | 53.809 | 0.011 / 0.018 | 55.027 | 18.117 | 3.959 | 3.963 | 3.453 | 132.543 | 284.89 | 284.48 | 17.98 | — |
| compact | 100000 | postgres | 717.905 | 139294 | 79.005 | 0.065 / 0.141 | 57.976 | 20.259 | 3.858 | 3.969 | 3.983 | 528.481 | 195.50 | 301.38 | 96.26 | 38.95 / 24.80 |
| cms | 1000 | inibase | 72.320 | 13827 | 75.970 | 1.355 / 2.288 | 4.839 | 1.978 | 36.867 | 10.154 | 9.988 | 661.021 | 117.80 | 117.73 | 0.23 | — |
| cms | 1000 | sqlite | 7.084 | 141156 | 4.825 | 0.009 / 0.018 | 0.677 | 0.378 | 3.989 | 3.976 | 3.899 | 130.439 | 65.58 | 64.89 | 1.40 | — |
| cms | 1000 | postgres | 12.799 | 78131 | 8.768 | 0.058 / 0.138 | 2.354 | 0.482 | 3.075 | 3.909 | 3.983 | 442.169 | 77.59 | 138.27 | 40.94 | 38.95 / 1.51 |
| cms | 10000 | inibase | 467.081 | 21410 | 155.926 | 1.945 / 3.733 | 25.067 | 8.784 | 36.049 | 11.984 | 9.996 | 1205.240 | 199.25 | 187.36 | 1.34 | — |
| cms | 10000 | sqlite | 100.758 | 99247 | 7.140 | 0.012 / 0.020 | 8.848 | 2.546 | 3.953 | 3.980 | 4.001 | 131.296 | 188.58 | 144.16 | 13.79 | — |
| cms | 10000 | postgres | 119.847 | 83440 | 17.951 | 0.050 / 0.120 | 16.191 | 3.156 | 3.910 | 3.973 | 4.002 | 485.089 | 165.42 | 257.89 | 69.69 | 38.95 / 14.26 |
| cms | 100000 | inibase | 4567.127 | 21896 | 792.022 | 3.307 / 4.621 | 252.132 | 54.985 | 35.080 | 11.785 | 9.959 | 7449.297 | 560.00 | 559.98 | 12.14 | — |
| cms | 100000 | sqlite | 1069.862 | 93470 | 74.935 | 0.012 / 0.018 | 121.729 | 39.673 | 3.997 | 3.931 | 3.982 | 130.288 | 547.97 | 547.94 | 149.48 | — |
| cms | 100000 | postgres | 1091.920 | 91582 | 129.621 | 0.061 / 0.154 | 135.561 | 32.607 | 3.841 | 3.974 | 3.992 | 592.458 | 387.72 | 554.11 | 330.14 | 38.95 / 141.60 |
| entropy | 1000 | inibase | 95.969 | 10420 | 98.050 | 1.391 / 2.328 | 7.820 | 3.526 | 37.026 | 10.994 | 9.164 | 799.035 | 127.58 | 126.47 | 0.92 | — |
| entropy | 1000 | sqlite | 17.990 | 55587 | 4.688 | 0.009 / 0.015 | 1.227 | 0.295 | 3.821 | 3.960 | 3.986 | 131.198 | 86.22 | 84.02 | 2.05 | — |
| entropy | 1000 | postgres | 21.287 | 46976 | 8.754 | 0.063 / 0.168 | 2.421 | 1.258 | 3.605 | 3.842 | 3.843 | 450.263 | 100.98 | 149.30 | 41.22 | 38.95 / 1.78 |
| entropy | 10000 | inibase | 755.360 | 13239 | 361.881 | 2.148 / 4.131 | 55.580 | 6.262 | 35.957 | 11.058 | 10.057 | 2538.705 | 243.50 | 243.11 | 8.27 | — |
| entropy | 10000 | sqlite | 193.921 | 51567 | 13.067 | 0.010 / 0.018 | 10.505 | 4.911 | 3.844 | 3.890 | 3.965 | 131.696 | 215.89 | 215.80 | 20.31 | — |
| entropy | 10000 | postgres | 194.651 | 51374 | 17.955 | 0.064 / 0.141 | 18.570 | 2.662 | 3.843 | 3.972 | 3.981 | 475.443 | 195.55 | 306.22 | 73.36 | 38.95 / 16.88 |
| entropy | 100000 | inibase | 9078.328 | 11015 | 3083.795 | 3.605 / 4.894 | 534.775 | 48.364 | 36.948 | 11.940 | 10.028 | 20960.800 | 474.78 | 474.63 | 91.51 | — |
| entropy | 100000 | sqlite | 1928.730 | 51848 | 77.198 | 0.011 / 0.019 | 131.545 | 54.167 | 3.912 | 4.012 | 3.981 | 133.418 | 580.88 | 580.86 | 209.90 | — |
| entropy | 100000 | postgres | 1869.002 | 53504 | 168.840 | 0.064 / 0.140 | 141.467 | 39.385 | 3.656 | 3.880 | 3.957 | 614.176 | 448.30 | 628.86 | 373.07 | 38.95 / 167.66 |

Verified 81/81; 0 failed runs; 0 sampler/setup errors; 0 operation errors.

Pooled latency sample counts and quantiles, all phase medians, CPU/I/O/resource samples, final relation/database/cluster sizes, temporary samples, maintenance, reopen and rollback results are retained in JSON. p99 is omitted below 1,000 samples; p95 below 20. Peak RSS may occur during caller-requested full-result materialization. Sampled process/disk peaks can miss short events. Client CPU excludes PostgreSQL server CPU; raw process samples include cumulative live server CPU, not exited processes or a complete CPU total. Zero OS I/O counters do not imply zero physical I/O.
