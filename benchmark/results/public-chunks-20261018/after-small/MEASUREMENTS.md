# Public API comparison: iniBase, SQLite, PostgreSQL

Flush policy: write-through. SQLite fullfsync/checkpoint_fullfsync ON; PostgreSQL fsync_writethrough on Darwin, fsync elsewhere; iniBase retains Node FileHandle.sync. Actual hardware power loss not qualified.

Equal six-field application records; bulk commits contain at most 1,000 records. Bulk timings include fixture creation. Index construction is explicit and measured for all engines; this is not automatic-tuning evidence. Existing iniBase public backend, not the experimental row kernel. Local PostgreSQL Unix-domain connection versus embedded calls. Fresh directories, rotated trials, existing OS filesystem cache. Full durability; actual settings and hashes retained in environment/trial files.

Mixed time includes maintenance attempts: iniBase compact(), SQLite WAL checkpoint, PostgreSQL VACUUM ANALYZE plus CHECKPOINT. Current public iniBase defaults rewrite base data on mutation, so compact() can be a no-op and rewrite cost sits inside mutation latency. There is no substantial pending log/tombstone overlay in this configuration. These are different maintenance mechanisms and these short runs do not establish endurance or PostgreSQL maturity. Reopen closes/reopens the client/engine, not the PostgreSQL server. Heap/cache settings do not bound whole-engine RSS. PostgreSQL tree RSS sums shared mappings more than once; it is not physical memory. Allocated PostgreSQL footprint includes the complete fresh cluster and WAL; empty cluster and relation bytes are reported separately.

| Dataset | Rows | Engine | Bulk ms | Records/s | Index ms | Random p50/p95 ms | Full ms | Projection ms | Insert p50 ms | Update p50 ms | Delete p50 ms | Mixed incl. maintenance ms | Worker peak MiB | Sampled tree peak MiB | Allocated MiB | PG empty/relation MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| compact | 1000 | inibase | 63.348 | 15786 | 69.091 | 1.381 / 2.391 | 4.191 | 1.862 | 35.199 | 48.942 | 76.968 | 1710.693 | 109.52 | 115.67 | 0.22 | — |
| compact | 1000 | sqlite | 5.897 | 169574 | 4.012 | 0.009 / 0.017 | 0.369 | 0.175 | 3.923 | 3.814 | 3.273 | 128.061 | 57.95 | 57.69 | 0.19 | — |
| compact | 1000 | postgres | 9.846 | 101566 | 8.833 | 0.057 / 0.141 | 1.095 | 0.489 | 3.828 | 3.881 | 3.803 | 412.463 | 63.64 | 123.25 | 39.80 | 38.95 / 0.33 |
| compact | 10000 | inibase | 439.208 | 22768 | 123.063 | 1.970 / 4.327 | 17.838 | 6.741 | 35.999 | 57.993 | 118.924 | 2124.532 | 175.23 | 208.28 | 1.28 | — |
| compact | 10000 | sqlite | 48.954 | 204273 | 6.749 | 0.011 / 0.025 | 5.329 | 2.947 | 3.925 | 3.917 | 3.221 | 125.385 | 105.80 | 95.39 | 1.79 | — |
| compact | 10000 | postgres | 71.037 | 140771 | 16.940 | 0.070 / 0.174 | 8.698 | 3.066 | 3.811 | 3.958 | 3.941 | 486.157 | 90.38 | 152.31 | 57.97 | 38.95 / 2.55 |
| cms | 1000 | inibase | 72.472 | 13798 | 75.921 | 1.346 / 2.329 | 4.913 | 1.929 | 35.758 | 50.167 | 82.013 | 1725.626 | 116.53 | 120.77 | 0.22 | — |
| cms | 1000 | sqlite | 8.068 | 123949 | 4.071 | 0.010 / 0.019 | 0.683 | 0.345 | 3.981 | 3.933 | 3.930 | 129.498 | 65.58 | 64.92 | 1.40 | — |
| cms | 1000 | postgres | 13.002 | 76914 | 9.820 | 0.078 / 0.490 | 2.297 | 0.500 | 3.248 | 3.869 | 3.972 | 444.927 | 74.81 | 138.50 | 40.94 | 38.95 / 1.51 |
| cms | 10000 | inibase | 466.029 | 21458 | 153.395 | 1.944 / 3.701 | 27.059 | 8.936 | 37.835 | 57.222 | 166.813 | 2452.360 | 204.34 | 230.91 | 1.34 | — |
| cms | 10000 | sqlite | 95.970 | 104199 | 6.728 | 0.011 / 0.027 | 8.669 | 2.759 | 3.865 | 3.839 | 3.894 | 132.217 | 188.42 | 144.28 | 13.79 | — |
| cms | 10000 | postgres | 120.548 | 82955 | 19.234 | 0.076 / 0.274 | 19.294 | 4.896 | 3.821 | 3.214 | 3.277 | 475.429 | 196.33 | 306.44 | 69.69 | 38.95 / 14.26 |
| entropy | 1000 | inibase | 93.122 | 10739 | 94.826 | 1.394 / 2.504 | 8.078 | 3.470 | 34.986 | 48.135 | 124.747 | 2012.593 | 128.83 | 130.78 | 0.91 | — |
| entropy | 1000 | sqlite | 18.041 | 55429 | 3.808 | 0.009 / 0.017 | 1.260 | 0.308 | 3.942 | 3.951 | 3.914 | 131.252 | 86.39 | 84.20 | 2.05 | — |
| entropy | 1000 | postgres | 23.089 | 43310 | 8.666 | 0.058 / 0.163 | 2.553 | 1.433 | 3.770 | 3.117 | 3.960 | 445.128 | 85.00 | 148.88 | 41.22 | 38.95 / 1.78 |
| entropy | 10000 | inibase | 768.273 | 13016 | 376.126 | 2.238 / 4.054 | 57.279 | 5.750 | 36.518 | 56.031 | 604.965 | 5034.165 | 251.42 | 280.25 | 8.27 | — |
| entropy | 10000 | sqlite | 194.881 | 51313 | 13.895 | 0.010 / 0.019 | 10.909 | 5.078 | 3.969 | 3.908 | 3.966 | 129.330 | 215.77 | 215.67 | 20.31 | — |
| entropy | 10000 | postgres | 194.018 | 51542 | 19.834 | 0.063 / 0.158 | 18.970 | 2.606 | 3.798 | 3.911 | 3.942 | 463.471 | 191.66 | 313.91 | 73.36 | 38.95 / 16.88 |

Verified 54/54; 0 failed runs; 0 sampler/setup errors; 0 operation errors.

Pooled latency sample counts and quantiles, all phase medians, CPU/I/O/resource samples, final relation/database/cluster sizes, temporary samples, maintenance, reopen and rollback results are retained in JSON. p99 is omitted below 1,000 samples; p95 below 20. Peak RSS may occur during caller-requested full-result materialization. Sampled process/disk peaks can miss short events. Client CPU excludes PostgreSQL server CPU; raw process samples include cumulative live server CPU, not exited processes or a complete CPU total. Zero OS I/O counters do not imply zero physical I/O.
