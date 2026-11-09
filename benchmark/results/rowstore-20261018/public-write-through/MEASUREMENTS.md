# Public API comparison: iniBase, SQLite, PostgreSQL

Flush policy: write-through. SQLite fullfsync/checkpoint_fullfsync ON; PostgreSQL fsync_writethrough on Darwin, fsync elsewhere; iniBase retains Node FileHandle.sync. Actual hardware power loss not qualified.

Equal six-field application records; bulk commits contain at most 1,000 records. Bulk timings include fixture creation. Index construction is explicit and measured for all engines; this is not automatic-tuning evidence. Existing iniBase public backend, not the experimental row kernel. Local PostgreSQL Unix-domain connection versus embedded calls. Fresh directories, rotated trials, existing OS filesystem cache. Full durability; actual settings and hashes retained in environment/trial files.

Mixed time includes maintenance attempts: iniBase compact(), SQLite WAL checkpoint, PostgreSQL VACUUM ANALYZE plus CHECKPOINT. Current public iniBase defaults rewrite base data on mutation, so compact() can be a no-op and rewrite cost sits inside mutation latency. There is no substantial pending log/tombstone overlay in this configuration. These are different maintenance mechanisms and these short runs do not establish endurance or PostgreSQL maturity. Reopen closes/reopens the client/engine, not the PostgreSQL server. Heap/cache settings do not bound whole-engine RSS. PostgreSQL tree RSS sums shared mappings more than once; it is not physical memory. Allocated PostgreSQL footprint includes the complete fresh cluster and WAL; empty cluster and relation bytes are reported separately.

| Dataset | Rows | Engine | Bulk ms | Records/s | Index ms | Random p50/p95 ms | Full ms | Projection ms | Insert p50 ms | Update p50 ms | Delete p50 ms | Mixed incl. maintenance ms | Worker peak MiB | Sampled tree peak MiB | Allocated MiB | PG empty/relation MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| compact | 1000 | inibase | 62.875 | 15905 | 73.009 | 1.396 / 2.699 | 4.347 | 1.843 | 34.130 | 58.893 | 77.965 | 1841.979 | 110.81 | 131.53 | 0.22 | — |
| compact | 1000 | sqlite | 5.063 | 197518 | 3.789 | 0.009 / 0.016 | 0.371 | 0.181 | 3.954 | 3.899 | 3.159 | 127.356 | 57.56 | 57.28 | 0.19 | — |
| compact | 1000 | postgres | 8.770 | 114025 | 9.825 | 0.059 / 0.153 | 1.153 | 0.527 | 3.210 | 4.004 | 3.949 | 433.765 | 63.20 | 123.03 | 39.81 | 38.95 / 0.33 |
| compact | 10000 | inibase | 424.547 | 23554 | 120.028 | 1.988 / 4.281 | 18.508 | 9.159 | 39.234 | 131.124 | 120.083 | 3917.675 | 178.66 | 178.58 | 1.28 | — |
| compact | 10000 | sqlite | 46.802 | 213666 | 6.227 | 0.011 / 0.017 | 5.261 | 1.623 | 3.875 | 3.773 | 3.063 | 126.178 | 111.11 | 104.41 | 1.79 | — |
| compact | 10000 | postgres | 70.867 | 141109 | 16.985 | 0.056 / 0.145 | 8.923 | 3.811 | 3.151 | 3.929 | 3.952 | 469.271 | 89.61 | 158.30 | 57.97 | 38.95 / 2.55 |
| compact | 100000 | inibase | 4357.216 | 22950 | 494.361 | 3.702 / 6.842 | 161.691 | 57.857 | 35.050 | 914.846 | 570.150 | 25551.621 | 327.34 | 322.31 | 11.48 | — |
| compact | 100000 | sqlite | 538.858 | 185578 | 53.973 | 0.011 / 0.021 | 57.366 | 19.276 | 3.906 | 3.975 | 3.808 | 130.383 | 284.19 | 283.73 | 17.98 | — |
| compact | 100000 | postgres | 698.019 | 143263 | 79.836 | 0.059 / 0.153 | 60.941 | 19.942 | 3.938 | 3.951 | 3.966 | 524.343 | 195.64 | 302.06 | 96.26 | 38.95 / 24.80 |
| cms | 1000 | inibase | 68.302 | 14641 | 74.058 | 1.447 / 2.543 | 5.008 | 2.144 | 34.083 | 59.902 | 81.007 | 1887.848 | 120.22 | 140.14 | 0.22 | — |
| cms | 1000 | sqlite | 8.921 | 112093 | 3.953 | 0.010 / 0.045 | 0.846 | 0.442 | 3.972 | 3.959 | 3.955 | 132.677 | 65.52 | 64.70 | 1.40 | — |
| cms | 1000 | postgres | 13.069 | 76519 | 9.787 | 0.054 / 0.144 | 2.407 | 0.534 | 3.089 | 3.968 | 3.876 | 423.993 | 74.61 | 138.02 | 40.94 | 38.95 / 1.51 |
| cms | 10000 | inibase | 478.076 | 20917 | 151.927 | 2.070 / 4.276 | 27.953 | 9.232 | 35.265 | 132.007 | 169.685 | 4203.140 | 211.41 | 209.33 | 1.34 | — |
| cms | 10000 | sqlite | 99.970 | 100030 | 7.697 | 0.012 / 0.027 | 8.709 | 2.642 | 3.891 | 3.113 | 3.788 | 128.292 | 187.39 | 143.55 | 13.79 | — |
| cms | 10000 | postgres | 123.888 | 80718 | 19.044 | 0.060 / 0.128 | 18.616 | 4.153 | 3.119 | 3.867 | 3.866 | 455.988 | 195.19 | 257.59 | 69.69 | 38.95 / 14.26 |
| cms | 100000 | inibase | 4477.192 | 22335 | 817.357 | 3.541 / 5.201 | 298.543 | 65.728 | 34.940 | 941.500 | 1061.500 | 28801.014 | 497.39 | 497.30 | 12.14 | — |
| cms | 100000 | sqlite | 1078.094 | 92756 | 75.162 | 0.011 / 0.019 | 128.776 | 41.019 | 3.941 | 3.969 | 3.995 | 132.161 | 549.08 | 547.91 | 149.48 | — |
| cms | 100000 | postgres | 1135.949 | 88032 | 147.429 | 0.068 / 0.179 | 142.238 | 33.189 | 3.831 | 3.824 | 3.969 | 598.537 | 382.98 | 548.33 | 327.50 | 38.95 / 141.60 |
| entropy | 1000 | inibase | 93.951 | 10644 | 101.041 | 1.425 / 2.354 | 8.186 | 2.177 | 34.872 | 58.870 | 124.058 | 2168.563 | 128.75 | 145.36 | 0.91 | — |
| entropy | 1000 | sqlite | 19.914 | 50216 | 4.784 | 0.010 / 0.032 | 1.282 | 0.340 | 3.961 | 3.921 | 3.928 | 129.123 | 86.41 | 86.41 | 2.05 | — |
| entropy | 1000 | postgres | 22.921 | 43627 | 8.822 | 0.067 / 0.257 | 2.461 | 1.319 | 3.890 | 3.918 | 3.974 | 440.748 | 84.81 | 150.97 | 41.22 | 38.95 / 1.78 |
| entropy | 10000 | inibase | 768.047 | 13020 | 392.930 | 2.275 / 4.412 | 59.984 | 6.316 | 35.944 | 129.419 | 639.165 | 6955.876 | 248.03 | 259.28 | 8.27 | — |
| entropy | 10000 | sqlite | 198.037 | 50496 | 12.826 | 0.011 / 0.023 | 11.283 | 5.423 | 3.876 | 3.195 | 3.861 | 127.011 | 214.84 | 214.73 | 20.31 | — |
| entropy | 10000 | postgres | 214.029 | 46723 | 20.009 | 0.060 / 0.232 | 18.522 | 5.056 | 3.835 | 3.916 | 3.935 | 438.856 | 205.08 | 317.86 | 73.36 | 38.95 / 16.88 |
| entropy | 100000 | inibase | 9417.097 | 10619 | 3241.954 | 3.915 / 5.322 | 584.089 | 61.945 | 35.911 | 929.925 | 5682.866 | 56598.354 | 468.16 | 503.78 | 91.43 | — |
| entropy | 100000 | sqlite | 1930.092 | 51811 | 84.088 | 0.011 / 0.021 | 142.447 | 57.810 | 3.859 | 3.942 | 3.963 | 126.874 | 581.03 | 581.03 | 205.98 | — |
| entropy | 100000 | postgres | 2006.897 | 49828 | 191.110 | 0.049 / 0.119 | 165.021 | 40.098 | 3.808 | 3.972 | 3.907 | 624.390 | 464.22 | 619.83 | 381.15 | 38.95 / 167.66 |

Verified 81/81; 0 failed runs; 0 sampler/setup errors; 0 operation errors.

Pooled latency sample counts and quantiles, all phase medians, CPU/I/O/resource samples, final relation/database/cluster sizes, temporary samples, maintenance, reopen and rollback results are retained in JSON. p99 is omitted below 1,000 samples; p95 below 20. Peak RSS may occur during caller-requested full-result materialization. Sampled process/disk peaks can miss short events. Client CPU excludes PostgreSQL server CPU; raw process samples include cumulative live server CPU, not exited processes or a complete CPU total. Zero OS I/O counters do not imply zero physical I/O.
