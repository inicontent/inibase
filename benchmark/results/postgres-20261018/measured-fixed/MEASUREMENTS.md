# Public API comparison: iniBase, SQLite, PostgreSQL

Equal six-field application records; bulk commits contain at most 1,000 records. Bulk timings include fixture creation. Index construction is explicit and measured for all engines; this is not automatic-tuning evidence. Existing iniBase public backend, not the experimental row kernel. Local PostgreSQL Unix-domain connection versus embedded calls. Fresh directories, rotated trials, existing OS filesystem cache. Full durability; actual settings and hashes retained in environment/trial files.

Mixed time includes maintenance attempts: iniBase compact(), SQLite WAL checkpoint, PostgreSQL VACUUM ANALYZE plus CHECKPOINT. Current public iniBase defaults rewrite base data on mutation, so compact() can be a no-op and rewrite cost sits inside mutation latency. There is no substantial pending log/tombstone overlay in this configuration. These are different maintenance mechanisms and these short runs do not establish endurance or PostgreSQL maturity. Reopen closes/reopens the client/engine, not the PostgreSQL server. Heap/cache settings do not bound whole-engine RSS. PostgreSQL tree RSS sums shared mappings more than once; it is not physical memory. Allocated PostgreSQL footprint includes the complete fresh cluster and WAL; empty cluster and relation bytes are reported separately.

| Dataset | Rows | Engine | Bulk ms | Records/s | Index ms | Random p50/p95 ms | Full ms | Projection ms | Insert p50 ms | Update p50 ms | Delete p50 ms | Mixed incl. maintenance ms | Worker peak MiB | Sampled tree peak MiB | Allocated MiB | PG empty/relation MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| compact | 1000 | inibase | 63.392 | 15775 | 73.220 | 1.443 / 3.333 | 4.521 | 1.951 | 36.014 | 58.859 | 76.945 | 1959.502 | 112.28 | 126.42 | 0.22 | — |
| compact | 1000 | sqlite | 2.114 | 473084 | 0.338 | 0.009 / 0.025 | 0.399 | 0.196 | 0.040 | 0.044 | 0.056 | 2.447 | 57.70 | 0.00 | 0.19 | — |
| compact | 1000 | postgres | 6.338 | 157783 | 1.703 | 0.049 / 0.143 | 0.932 | 0.460 | 0.063 | 0.075 | 0.059 | 11.076 | 63.28 | 0.00 | 39.70 | 38.95 / 0.33 |
| compact | 10000 | inibase | 492.054 | 20323 | 124.935 | 2.156 / 4.345 | 18.248 | 6.926 | 36.312 | 141.116 | 124.031 | 4084.898 | 174.89 | 182.91 | 1.28 | — |
| compact | 10000 | sqlite | 14.446 | 692219 | 3.047 | 0.011 / 0.035 | 5.324 | 3.387 | 0.057 | 0.058 | 0.062 | 2.900 | 105.52 | 0.00 | 1.79 | — |
| compact | 10000 | postgres | 42.727 | 234046 | 12.145 | 0.046 / 0.093 | 7.284 | 2.865 | 0.087 | 0.087 | 0.059 | 35.096 | 89.53 | 143.89 | 57.92 | 38.95 / 2.55 |
| compact | 100000 | inibase | 4372.105 | 22872 | 461.716 | 3.462 / 5.050 | 157.194 | 58.324 | 36.194 | 898.600 | 576.000 | 25196.162 | 344.14 | 339.67 | 11.48 | — |
| compact | 100000 | sqlite | 122.765 | 814563 | 42.413 | 0.012 / 0.038 | 59.165 | 18.749 | 0.069 | 0.061 | 0.070 | 2.901 | 284.17 | 274.64 | 17.98 | — |
| compact | 100000 | postgres | 328.239 | 304656 | 82.623 | 0.045 / 0.098 | 58.452 | 20.479 | 0.074 | 0.079 | 0.056 | 99.245 | 194.56 | 300.77 | 96.21 | 38.95 / 24.80 |
| cms | 1000 | inibase | 73.143 | 13672 | 78.804 | 1.466 / 2.352 | 5.081 | 3.177 | 35.179 | 60.074 | 81.420 | 1948.590 | 118.72 | 131.67 | 0.22 | — |
| cms | 1000 | sqlite | 4.311 | 231978 | 0.376 | 0.010 / 0.028 | 0.706 | 0.397 | 0.068 | 0.053 | 0.058 | 2.772 | 65.55 | 0.00 | 1.40 | — |
| cms | 1000 | postgres | 13.178 | 75882 | 2.500 | 0.053 / 0.191 | 2.276 | 0.540 | 0.082 | 0.081 | 0.063 | 12.652 | 73.80 | 135.28 | 40.89 | 38.95 / 1.51 |
| cms | 10000 | inibase | 462.080 | 21641 | 154.060 | 2.027 / 4.023 | 25.872 | 9.282 | 36.009 | 133.388 | 170.050 | 4204.468 | 236.06 | 239.89 | 1.34 | — |
| cms | 10000 | sqlite | 45.172 | 221376 | 3.293 | 0.011 / 0.021 | 8.052 | 2.671 | 0.062 | 0.060 | 0.055 | 3.474 | 187.73 | 187.92 | 13.79 | — |
| cms | 10000 | postgres | 91.649 | 109112 | 12.707 | 0.057 / 0.110 | 15.981 | 3.839 | 0.082 | 0.082 | 0.060 | 33.670 | 166.31 | 206.48 | 69.64 | 38.95 / 14.26 |
| cms | 100000 | inibase | 4431.121 | 22568 | 786.966 | 3.407 / 5.071 | 261.075 | 54.878 | 36.237 | 894.701 | 1036.580 | 27692.271 | 518.22 | 516.36 | 12.14 | — |
| cms | 100000 | sqlite | 395.336 | 252949 | 66.784 | 0.013 / 0.043 | 133.234 | 40.956 | 0.066 | 0.065 | 0.060 | 3.361 | 548.00 | 529.09 | 137.67 | — |
| cms | 100000 | postgres | 832.020 | 120189 | 144.468 | 0.046 / 0.101 | 142.208 | 32.337 | 0.088 | 0.085 | 0.059 | 191.176 | 381.41 | 545.67 | 341.06 | 38.95 / 141.60 |
| entropy | 1000 | inibase | 96.128 | 10403 | 98.822 | 1.482 / 2.348 | 8.022 | 3.641 | 35.953 | 58.868 | 127.084 | 2180.412 | 128.81 | 140.19 | 0.91 | — |
| entropy | 1000 | sqlite | 15.006 | 66639 | 0.423 | 0.009 / 0.032 | 1.277 | 0.337 | 0.069 | 0.055 | 0.056 | 3.192 | 86.03 | 0.00 | 2.05 | — |
| entropy | 1000 | postgres | 25.694 | 38920 | 1.986 | 0.045 / 0.160 | 2.461 | 1.407 | 0.128 | 0.075 | 0.068 | 13.188 | 96.89 | 146.19 | 41.17 | 38.95 / 1.78 |
| entropy | 10000 | inibase | 790.232 | 12655 | 381.794 | 2.204 / 4.225 | 59.153 | 5.960 | 36.043 | 129.432 | 616.719 | 6945.898 | 262.95 | 260.22 | 8.27 | — |
| entropy | 10000 | sqlite | 131.916 | 75806 | 6.350 | 0.011 / 0.030 | 11.301 | 5.041 | 0.077 | 0.059 | 0.074 | 3.445 | 215.42 | 215.41 | 20.31 | — |
| entropy | 10000 | postgres | 171.476 | 58317 | 13.404 | 0.044 / 0.097 | 15.967 | 2.549 | 0.115 | 0.097 | 0.065 | 34.741 | 201.67 | 287.81 | 72.27 | 38.95 / 16.88 |
| entropy | 100000 | inibase | 9007.136 | 11102 | 3115.074 | 3.699 / 4.880 | 566.905 | 58.378 | 36.161 | 891.523 | 5460.987 | 54239.027 | 539.06 | 549.55 | 91.64 | — |
| entropy | 100000 | sqlite | 1207.400 | 82823 | 70.135 | 0.012 / 0.027 | 166.801 | 54.068 | 0.083 | 0.043 | 0.058 | 3.971 | 579.59 | 579.56 | 207.19 | — |
| entropy | 100000 | postgres | 1647.766 | 60688 | 162.782 | 0.043 / 0.106 | 147.655 | 40.006 | 0.088 | 0.084 | 0.063 | 197.887 | 453.97 | 620.80 | 381.57 | 38.95 / 167.66 |

Verified 81/81; 0 failed runs; 0 sampler/setup errors; 0 operation errors.

Pooled latency sample counts and quantiles, all phase medians, CPU/I/O/resource samples, final relation/database/cluster sizes, temporary samples, maintenance, reopen and rollback results are retained in JSON. p99 is omitted below 1,000 samples; p95 below 20. Peak RSS may occur during caller-requested full-result materialization. Sampled process/disk peaks can miss short events. Client CPU excludes PostgreSQL server CPU; raw process samples include cumulative live server CPU, not exited processes or a complete CPU total. Zero OS I/O counters do not imply zero physical I/O.
