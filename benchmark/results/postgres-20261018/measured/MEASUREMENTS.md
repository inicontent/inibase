# Public API comparison: iniBase, SQLite, PostgreSQL

Equal six-field application records; bulk commits contain at most 1,000 records. Bulk timings include fixture creation. Index construction is explicit and measured for all engines; this is not automatic-tuning evidence. Existing iniBase public backend, not the experimental row kernel. Local PostgreSQL Unix-domain connection versus embedded calls. Fresh directories, rotated trials, existing OS filesystem cache. Full durability; actual settings and hashes retained in environment/trial files.

Mixed time includes maintenance attempts: iniBase compact(), SQLite WAL checkpoint, PostgreSQL VACUUM ANALYZE plus CHECKPOINT. Current public iniBase defaults rewrite base data on mutation, so compact() can be a no-op and rewrite cost sits inside mutation latency. There is no substantial pending log/tombstone overlay in this configuration. These are different maintenance mechanisms and these short runs do not establish endurance or PostgreSQL maturity. Reopen closes/reopens the client/engine, not the PostgreSQL server. Heap/cache settings do not bound whole-engine RSS. PostgreSQL tree RSS sums shared mappings more than once; it is not physical memory. Allocated PostgreSQL footprint includes the complete fresh cluster and WAL; empty cluster and relation bytes are reported separately.

| Dataset | Rows | Engine | Bulk ms | Records/s | Index ms | Random p50/p95 ms | Full ms | Projection ms | Insert p50 ms | Update p50 ms | Delete p50 ms | Mixed incl. maintenance ms | Worker peak MiB | Sampled tree peak MiB | Allocated MiB | PG empty/relation MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| compact | 1000 | inibase | 65.281 | 15318 | 74.744 | 1.394 / 4.586 | 4.195 | 1.732 | 37.022 | 57.084 | 76.735 | 1926.479 | 109.88 | 125.80 | 0.22 | — |
| compact | 1000 | sqlite | 1.814 | 551141 | 0.324 | 0.009 / 0.020 | 0.356 | 0.166 | 0.047 | 0.036 | 0.054 | 2.162 | 57.73 | 0.00 | 0.19 | — |
| compact | 1000 | postgres | 5.748 | 173965 | 1.634 | 0.042 / 0.122 | 0.907 | 0.418 | 0.060 | 0.076 | 0.061 | 9.903 | 63.34 | 0.00 | 39.70 | 38.95 / 0.33 |
| compact | 10000 | inibase | 440.127 | 22721 | 120.164 | 1.972 / 4.198 | 18.021 | 6.596 | 34.893 | 130.432 | 120.129 | 3903.214 | 178.17 | 183.88 | 1.28 | — |
| compact | 10000 | sqlite | 12.774 | 782827 | 2.744 | 0.010 / 0.018 | 4.778 | 3.122 | 0.051 | 0.050 | 0.058 | 2.688 | 105.34 | 0.00 | 1.79 | — |
| compact | 10000 | postgres | 36.905 | 270966 | 10.977 | 0.043 / 0.089 | 6.966 | 3.084 | 0.064 | 0.077 | 0.066 | 32.971 | 89.45 | 149.59 | 57.92 | 38.95 / 2.55 |
| compact | 100000 | inibase | 4394.100 | 22758 | 462.848 | 3.469 / 4.982 | 151.418 | 55.907 | 36.006 | 934.023 | 575.161 | 25026.216 | 326.69 | 349.86 | 11.48 | — |
| compact | 100000 | sqlite | 117.676 | 849789 | 38.308 | 0.011 / 0.023 | 64.065 | 18.986 | 0.059 | 0.059 | 0.074 | 3.000 | 283.88 | 277.11 | 17.98 | — |
| compact | 100000 | postgres | 320.390 | 312119 | 71.344 | 0.047 / 0.110 | 57.699 | 20.090 | 0.071 | 0.083 | 0.059 | 97.232 | 200.06 | 306.95 | 96.21 | 38.95 / 24.80 |
| cms | 1000 | inibase | 70.033 | 14279 | 74.721 | 1.323 / 2.212 | 4.911 | 1.893 | 36.168 | 59.065 | 80.953 | 1922.018 | 120.11 | 128.36 | 0.22 | — |
| cms | 1000 | sqlite | 4.313 | 231830 | 0.407 | 0.010 / 0.031 | 0.687 | 0.389 | 0.055 | 0.041 | 0.054 | 2.400 | 65.06 | 0.00 | 1.40 | — |
| cms | 1000 | postgres | 12.338 | 81052 | 1.984 | 0.043 / 0.097 | 1.952 | 0.392 | 0.073 | 0.076 | 0.062 | 10.839 | 74.09 | 0.00 | 40.89 | 38.95 / 1.51 |
| cms | 10000 | inibase | 467.928 | 21371 | 155.161 | 2.004 / 3.808 | 26.590 | 9.058 | 36.277 | 131.753 | 167.147 | 4181.922 | 210.97 | 202.70 | 1.34 | — |
| cms | 10000 | sqlite | 43.490 | 229936 | 3.424 | 0.010 / 0.020 | 8.299 | 2.584 | 0.067 | 0.057 | 0.063 | 2.929 | 188.14 | 148.92 | 13.79 | — |
| cms | 10000 | postgres | 89.796 | 111364 | 11.890 | 0.051 / 0.094 | 15.918 | 3.696 | 0.082 | 0.074 | 0.058 | 32.554 | 156.59 | 208.05 | 69.64 | 38.95 / 14.26 |
| cms | 100000 | inibase | 4599.357 | 21742 | 783.220 | 3.351 / 4.684 | 256.558 | 52.232 | 35.891 | 886.075 | 1033.898 | 27531.010 | 506.98 | 506.78 | 12.14 | — |
| cms | 100000 | sqlite | 389.220 | 256924 | 64.895 | 0.011 / 0.024 | 127.399 | 39.672 | 0.057 | 0.062 | 0.059 | 3.597 | 548.56 | 547.97 | 137.67 | — |
| cms | 100000 | postgres | 849.141 | 117766 | 148.759 | 0.043 / 0.105 | 133.470 | 32.238 | 0.087 | 0.091 | 0.057 | 178.936 | 387.78 | 541.27 | 341.06 | 38.95 / 141.60 |
| entropy | 1000 | inibase | 92.751 | 10782 | 97.022 | 1.370 / 2.596 | 8.141 | 2.753 | 37.101 | 60.071 | 124.051 | 2189.570 | 130.22 | 141.23 | 0.91 | — |
| entropy | 1000 | sqlite | 14.245 | 70200 | 0.388 | 0.009 / 0.019 | 1.159 | 0.304 | 0.068 | 0.053 | 0.054 | 2.884 | 86.22 | 0.00 | 2.05 | — |
| entropy | 1000 | postgres | 21.031 | 47550 | 1.841 | 0.042 / 0.094 | 1.949 | 1.215 | 0.076 | 0.070 | 0.065 | 11.479 | 96.88 | 0.00 | 41.17 | 38.95 / 1.78 |
| entropy | 10000 | inibase | 759.713 | 13163 | 378.784 | 2.196 / 4.043 | 58.285 | 6.161 | 34.116 | 132.577 | 611.180 | 6846.537 | 266.64 | 271.72 | 8.27 | — |
| entropy | 10000 | sqlite | 135.522 | 73789 | 6.414 | 0.010 / 0.028 | 11.055 | 5.156 | 0.068 | 0.052 | 0.060 | 4.166 | 212.70 | 201.23 | 20.31 | — |
| entropy | 10000 | postgres | 176.934 | 56518 | 13.559 | 0.041 / 0.091 | 14.874 | 6.615 | 0.077 | 0.081 | 0.061 | 34.622 | 201.80 | 287.97 | 72.27 | 38.95 / 16.88 |
| entropy | 100000 | inibase | 9194.213 | 10876 | 3071.856 | 3.539 / 5.042 | 550.331 | 50.234 | 36.776 | 888.962 | 5408.761 | 53947.339 | 569.11 | 569.09 | 91.36 | — |
| entropy | 100000 | sqlite | 1176.909 | 84968 | 66.885 | 0.011 / 0.020 | 132.401 | 53.751 | 0.100 | 0.061 | 0.055 | 3.893 | 579.69 | 579.59 | 209.88 | — |
| entropy | 100000 | postgres | 1606.863 | 62233 | 162.541 | 0.039 / 0.086 | 141.918 | 38.921 | 0.098 | 0.086 | 0.063 | 194.795 | 460.81 | 597.77 | 368.75 | 38.95 / 167.66 |

Verified 81/81; 0 failed runs; 0 sampler/setup errors; 0 operation errors.

Pooled latency sample counts and quantiles, all phase medians, CPU/I/O/resource samples, final relation/database/cluster sizes, temporary samples, maintenance, reopen and rollback results are retained in JSON. p99 is omitted below 1,000 samples; p95 below 20. Peak RSS may occur during caller-requested full-result materialization. Sampled process/disk peaks can miss short events. Client CPU excludes PostgreSQL server CPU; raw process samples include cumulative live server CPU, not exited processes or a complete CPU total. Zero OS I/O counters do not imply zero physical I/O.
