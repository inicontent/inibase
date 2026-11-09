# Public API comparison: iniBase, SQLite, PostgreSQL

Flush policy: write-through. SQLite fullfsync/checkpoint_fullfsync ON; PostgreSQL fsync_writethrough on Darwin, fsync elsewhere; iniBase retains Node FileHandle.sync. Actual hardware power loss not qualified.

Equal six-field application records; bulk commits contain at most 1,000 records. Bulk timings include fixture creation. Index construction is explicit and measured for all engines; this is not automatic-tuning evidence. Existing iniBase public backend, not the experimental row kernel. Local PostgreSQL Unix-domain connection versus embedded calls. Fresh directories, rotated trials, existing OS filesystem cache. Full durability; actual settings and hashes retained in environment/trial files.

Mixed time includes maintenance attempts: iniBase compact(), SQLite WAL checkpoint, PostgreSQL VACUUM ANALYZE plus CHECKPOINT. Current public iniBase defaults rewrite base data on mutation, so compact() can be a no-op and rewrite cost sits inside mutation latency. There is no substantial pending log/tombstone overlay in this configuration. These are different maintenance mechanisms and these short runs do not establish endurance or PostgreSQL maturity. Reopen closes/reopens the client/engine, not the PostgreSQL server. Heap/cache settings do not bound whole-engine RSS. PostgreSQL tree RSS sums shared mappings more than once; it is not physical memory. Allocated PostgreSQL footprint includes the complete fresh cluster and WAL; empty cluster and relation bytes are reported separately.

| Dataset | Rows | Engine | Bulk ms | Records/s | Index ms | Random p50/p95 ms | Full ms | Projection ms | Insert p50 ms | Update p50 ms | Delete p50 ms | Mixed incl. maintenance ms | Worker peak MiB | Sampled tree peak MiB | Allocated MiB | PG empty/relation MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| compact | 1000 | inibase | 67.014 | 14922 | 73.640 | 1.365 / 2.716 | 4.222 | 1.969 | 36.919 | 11.643 | 9.904 | 644.342 | 105.19 | 105.14 | 0.22 | — |
| compact | 1000 | sqlite | 6.042 | 165498 | 4.805 | 0.009 / 0.022 | 0.379 | 0.168 | 3.941 | 3.899 | 3.211 | 128.465 | 57.86 | 57.61 | 0.19 | — |
| compact | 1000 | postgres | 10.105 | 98957 | 9.696 | 0.060 / 0.143 | 1.145 | 0.506 | 3.878 | 3.986 | 3.988 | 445.104 | 63.53 | 123.28 | 39.81 | 38.95 / 0.33 |
| compact | 10000 | inibase | 448.919 | 22276 | 121.028 | 1.942 / 4.102 | 17.397 | 5.967 | 37.006 | 11.757 | 10.013 | 1040.797 | 160.98 | 160.75 | 1.28 | — |
| compact | 10000 | sqlite | 47.921 | 208676 | 7.083 | 0.011 / 0.018 | 5.421 | 3.235 | 3.940 | 3.865 | 3.001 | 129.626 | 105.58 | 89.00 | 1.79 | — |
| compact | 10000 | postgres | 66.874 | 149536 | 17.243 | 0.078 / 0.171 | 8.615 | 2.955 | 3.901 | 3.978 | 3.967 | 511.198 | 87.19 | 153.70 | 57.97 | 38.95 / 2.55 |
| compact | 100000 | inibase | 4444.394 | 22500 | 442.311 | 3.311 / 5.167 | 149.644 | 57.817 | 37.074 | 11.838 | 9.932 | 5897.561 | 310.83 | 310.83 | 11.48 | — |
| compact | 100000 | sqlite | 559.049 | 178875 | 52.585 | 0.011 / 0.016 | 54.764 | 18.246 | 3.982 | 3.964 | 3.753 | 128.293 | 284.05 | 283.39 | 17.98 | — |
| compact | 100000 | postgres | 666.991 | 149927 | 78.158 | 0.055 / 0.137 | 58.679 | 19.299 | 3.776 | 3.987 | 3.942 | 541.957 | 195.67 | 300.38 | 96.26 | 38.95 / 24.80 |
| cms | 1000 | inibase | 72.305 | 13830 | 82.962 | 1.360 / 2.404 | 4.953 | 1.963 | 36.931 | 10.919 | 9.924 | 652.073 | 119.02 | 118.75 | 0.23 | — |
| cms | 1000 | sqlite | 7.981 | 125305 | 4.149 | 0.009 / 0.019 | 0.687 | 0.369 | 3.961 | 3.969 | 3.858 | 131.551 | 65.69 | 65.11 | 1.40 | — |
| cms | 1000 | postgres | 12.804 | 78102 | 8.898 | 0.060 / 0.160 | 2.412 | 0.505 | 3.858 | 3.913 | 3.948 | 450.223 | 74.91 | 138.44 | 40.94 | 38.95 / 1.51 |
| cms | 10000 | inibase | 473.057 | 21139 | 160.050 | 1.947 / 3.571 | 24.948 | 8.713 | 37.002 | 11.986 | 9.989 | 1218.597 | 203.70 | 202.75 | 1.34 | — |
| cms | 10000 | sqlite | 102.954 | 97130 | 7.712 | 0.012 / 0.020 | 8.868 | 2.627 | 3.966 | 3.221 | 3.788 | 129.444 | 188.33 | 144.45 | 13.79 | — |
| cms | 10000 | postgres | 120.780 | 82795 | 17.101 | 0.060 / 0.114 | 17.727 | 3.120 | 3.796 | 3.825 | 3.956 | 473.075 | 166.25 | 257.28 | 69.69 | 38.95 / 14.26 |
| cms | 100000 | inibase | 4556.300 | 21948 | 791.871 | 3.337 / 4.811 | 253.325 | 52.895 | 36.005 | 11.830 | 9.981 | 7429.991 | 554.45 | 554.45 | 12.14 | — |
| cms | 100000 | sqlite | 1075.748 | 92959 | 71.990 | 0.012 / 0.020 | 121.688 | 39.532 | 3.837 | 3.978 | 3.923 | 132.509 | 548.13 | 548.08 | 149.48 | — |
| cms | 100000 | postgres | 1120.874 | 89216 | 131.188 | 0.061 / 0.183 | 135.017 | 33.057 | 3.955 | 3.859 | 3.964 | 597.343 | 396.31 | 561.66 | 330.14 | 38.95 / 141.60 |
| entropy | 1000 | inibase | 93.306 | 10717 | 97.919 | 1.378 / 2.256 | 7.976 | 1.935 | 36.986 | 10.950 | 9.883 | 795.849 | 126.88 | 125.45 | 0.92 | — |
| entropy | 1000 | sqlite | 17.880 | 55929 | 4.112 | 0.009 / 0.016 | 1.181 | 0.315 | 3.833 | 3.823 | 3.838 | 131.341 | 86.47 | 84.23 | 2.05 | — |
| entropy | 1000 | postgres | 22.070 | 45311 | 8.893 | 0.059 / 0.154 | 2.387 | 1.307 | 3.771 | 3.868 | 4.000 | 445.442 | 85.38 | 149.23 | 41.22 | 38.95 / 1.78 |
| entropy | 10000 | inibase | 759.895 | 13160 | 363.502 | 2.104 / 4.182 | 55.279 | 5.528 | 37.813 | 11.668 | 9.984 | 2562.624 | 237.92 | 237.42 | 8.27 | — |
| entropy | 10000 | sqlite | 196.970 | 50769 | 12.961 | 0.010 / 0.021 | 10.744 | 4.992 | 3.184 | 3.952 | 3.943 | 132.948 | 212.52 | 212.36 | 20.31 | — |
| entropy | 10000 | postgres | 198.889 | 50279 | 18.099 | 0.061 / 0.132 | 15.759 | 3.759 | 3.849 | 3.951 | 3.976 | 474.274 | 205.27 | 312.72 | 73.36 | 38.95 / 16.88 |
| entropy | 100000 | inibase | 9170.060 | 10905 | 3080.422 | 3.583 / 4.986 | 534.133 | 56.087 | 36.894 | 11.028 | 9.723 | 20882.802 | 477.23 | 477.33 | 91.44 | — |
| entropy | 100000 | sqlite | 1922.937 | 52004 | 81.028 | 0.011 / 0.019 | 132.097 | 53.496 | 3.821 | 3.996 | 3.996 | 133.998 | 582.83 | 582.84 | 209.90 | — |
| entropy | 100000 | postgres | 1843.309 | 54250 | 168.267 | 0.070 / 0.161 | 144.320 | 38.952 | 3.828 | 3.912 | 3.918 | 625.511 | 458.94 | 634.31 | 373.07 | 38.95 / 167.66 |

Verified 81/81; 0 failed runs; 0 sampler/setup errors; 0 operation errors.

Pooled latency sample counts and quantiles, all phase medians, CPU/I/O/resource samples, final relation/database/cluster sizes, temporary samples, maintenance, reopen and rollback results are retained in JSON. p99 is omitted below 1,000 samples; p95 below 20. Peak RSS may occur during caller-requested full-result materialization. Sampled process/disk peaks can miss short events. Client CPU excludes PostgreSQL server CPU; raw process samples include cumulative live server CPU, not exited processes or a complete CPU total. Zero OS I/O counters do not imply zero physical I/O.
