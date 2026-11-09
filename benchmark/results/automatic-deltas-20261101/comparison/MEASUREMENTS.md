# Public API comparison: iniBase, SQLite, PostgreSQL

Flush policy: write-through. SQLite fullfsync/checkpoint_fullfsync ON; PostgreSQL fsync_writethrough on Darwin, fsync elsewhere; iniBase retains Node FileHandle.sync. Actual hardware power loss not qualified.

Equal six-field application records; bulk commits contain at most 1,000 records. Bulk timings include fixture creation. Index construction is explicit and measured for all engines; this is not automatic-tuning evidence. Existing iniBase public backend, not the experimental row kernel. Local PostgreSQL Unix-domain connection versus embedded calls. Fresh directories, rotated trials, existing OS filesystem cache. Full durability; actual settings and hashes retained in environment/trial files.

Mixed time includes maintenance attempts: iniBase compact(), SQLite WAL checkpoint, PostgreSQL VACUUM ANALYZE plus CHECKPOINT. Current public iniBase defaults rewrite base data on mutation, so compact() can be a no-op and rewrite cost sits inside mutation latency. There is no substantial pending log/tombstone overlay in this configuration. These are different maintenance mechanisms and these short runs do not establish endurance or PostgreSQL maturity. Reopen closes/reopens the client/engine, not the PostgreSQL server. Heap/cache settings do not bound whole-engine RSS. PostgreSQL tree RSS sums shared mappings more than once; it is not physical memory. Allocated PostgreSQL footprint includes the complete fresh cluster and WAL; empty cluster and relation bytes are reported separately.

| Dataset | Rows | Engine | Bulk ms | Records/s | Index ms | Random p50/p95 ms | Full ms | Projection ms | Insert p50 ms | Update p50 ms | Delete p50 ms | Mixed incl. maintenance ms | Worker peak MiB | Sampled tree peak MiB | Allocated MiB | PG empty/relation MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| compact | 1000 | inibase | 65.111 | 15358 | 70.188 | 1.351 / 2.323 | 4.019 | 1.794 | 35.069 | 11.481 | 9.818 | 650.212 | 105.83 | 104.56 | 0.22 | — |
| compact | 1000 | sqlite | 4.872 | 205258 | 3.926 | 0.010 / 0.017 | 0.362 | 0.179 | 3.925 | 3.929 | 3.217 | 129.215 | 58.05 | 57.73 | 0.19 | — |
| compact | 1000 | postgres | 9.766 | 102391 | 9.777 | 0.070 / 0.271 | 1.082 | 0.479 | 3.804 | 3.940 | 3.989 | 433.456 | 63.39 | 123.00 | 39.81 | 38.95 / 0.33 |
| compact | 10000 | inibase | 432.108 | 23142 | 123.036 | 1.982 / 4.029 | 15.844 | 9.113 | 35.981 | 11.044 | 9.870 | 1022.940 | 159.58 | 159.36 | 1.28 | — |
| compact | 10000 | sqlite | 48.998 | 204090 | 6.898 | 0.011 / 0.017 | 5.352 | 3.034 | 3.933 | 3.870 | 3.889 | 127.509 | 105.77 | 91.31 | 1.79 | — |
| compact | 10000 | postgres | 67.933 | 147204 | 17.766 | 0.066 / 0.164 | 8.480 | 3.043 | 3.004 | 3.952 | 3.991 | 473.150 | 89.72 | 158.08 | 57.97 | 38.95 / 2.55 |
| compact | 100000 | inibase | 4327.028 | 23111 | 449.939 | 3.345 / 4.833 | 159.586 | 57.463 | 36.090 | 11.018 | 9.917 | 5885.035 | 313.14 | 313.14 | 11.48 | — |
| compact | 100000 | sqlite | 548.967 | 182160 | 54.084 | 0.011 / 0.018 | 54.952 | 18.092 | 3.845 | 3.977 | 3.421 | 127.395 | 283.92 | 283.33 | 17.98 | — |
| compact | 100000 | postgres | 662.944 | 150842 | 81.043 | 0.058 / 0.128 | 56.856 | 18.907 | 3.231 | 3.983 | 3.986 | 528.491 | 197.03 | 304.77 | 96.26 | 38.95 / 24.80 |
| cms | 1000 | inibase | 70.294 | 14226 | 73.919 | 1.359 / 2.218 | 4.920 | 1.991 | 35.898 | 10.168 | 9.228 | 669.405 | 117.28 | 117.25 | 0.23 | — |
| cms | 1000 | sqlite | 6.872 | 145515 | 4.415 | 0.010 / 0.019 | 0.679 | 0.365 | 3.902 | 3.901 | 3.584 | 130.498 | 65.80 | 65.00 | 1.40 | — |
| cms | 1000 | postgres | 13.000 | 76920 | 7.846 | 0.059 / 0.149 | 2.392 | 0.516 | 3.861 | 3.846 | 3.982 | 431.804 | 77.73 | 138.88 | 40.94 | 38.95 / 1.51 |
| cms | 10000 | inibase | 419.057 | 23863 | 141.875 | 1.928 / 3.578 | 27.285 | 8.890 | 34.969 | 10.956 | 9.747 | 1181.159 | 201.16 | 199.25 | 1.34 | — |
| cms | 10000 | sqlite | 101.954 | 98083 | 6.973 | 0.011 / 0.020 | 8.524 | 2.559 | 3.963 | 3.862 | 3.889 | 126.448 | 188.75 | 143.88 | 13.79 | — |
| cms | 10000 | postgres | 112.675 | 88751 | 15.784 | 0.075 / 0.166 | 18.832 | 3.303 | 3.234 | 3.792 | 3.435 | 461.199 | 168.28 | 257.48 | 69.69 | 38.95 / 14.26 |
| cms | 100000 | inibase | 4558.191 | 21939 | 798.516 | 3.307 / 4.687 | 256.055 | 54.329 | 35.061 | 10.966 | 9.085 | 7425.999 | 568.20 | 567.48 | 12.14 | — |
| cms | 100000 | sqlite | 1046.035 | 95599 | 69.987 | 0.012 / 0.020 | 121.540 | 40.513 | 3.959 | 3.807 | 3.943 | 132.637 | 548.39 | 547.30 | 153.40 | — |
| cms | 100000 | postgres | 1114.192 | 89751 | 129.431 | 0.069 / 0.922 | 134.198 | 32.578 | 3.813 | 3.837 | 3.916 | 588.704 | 392.53 | 544.22 | 326.18 | 38.95 / 141.60 |
| entropy | 1000 | inibase | 95.923 | 10425 | 98.220 | 1.378 / 2.257 | 7.822 | 3.791 | 35.951 | 10.803 | 9.781 | 792.807 | 126.45 | 125.75 | 0.92 | — |
| entropy | 1000 | sqlite | 17.975 | 55634 | 3.782 | 0.009 / 0.016 | 1.179 | 0.341 | 3.099 | 3.820 | 3.812 | 129.352 | 86.44 | 84.20 | 2.05 | — |
| entropy | 1000 | postgres | 22.743 | 43970 | 9.683 | 0.061 / 0.165 | 2.716 | 0.531 | 3.770 | 3.914 | 3.030 | 436.227 | 86.52 | 151.64 | 41.22 | 38.95 / 1.78 |
| entropy | 10000 | inibase | 748.920 | 13353 | 372.998 | 2.179 / 4.127 | 55.766 | 5.766 | 36.019 | 11.108 | 9.935 | 2553.642 | 239.80 | 239.75 | 8.27 | — |
| entropy | 10000 | sqlite | 193.893 | 51575 | 13.005 | 0.011 / 0.018 | 10.478 | 5.191 | 3.903 | 3.931 | 3.902 | 132.097 | 217.38 | 217.27 | 20.31 | — |
| entropy | 10000 | postgres | 194.949 | 51296 | 19.969 | 0.061 / 0.131 | 17.855 | 4.005 | 3.894 | 3.955 | 3.834 | 450.440 | 202.58 | 324.45 | 73.36 | 38.95 / 16.88 |
| entropy | 100000 | inibase | 9189.182 | 10882 | 3087.335 | 3.586 / 4.972 | 561.960 | 57.407 | 36.965 | 11.631 | 9.754 | 20929.757 | 547.58 | 547.55 | 92.22 | — |
| entropy | 100000 | sqlite | 1920.131 | 52080 | 78.919 | 0.011 / 0.018 | 131.035 | 53.280 | 3.808 | 3.972 | 4.002 | 132.134 | 580.06 | 580.00 | 209.90 | — |
| entropy | 100000 | postgres | 1832.854 | 54560 | 170.883 | 0.074 / 0.162 | 144.764 | 39.389 | 3.843 | 3.923 | 3.877 | 615.952 | 362.91 | 539.52 | 375.24 | 38.95 / 167.66 |

Verified 81/81; 0 failed runs; 0 sampler/setup errors; 0 operation errors.

Pooled latency sample counts and quantiles, all phase medians, CPU/I/O/resource samples, final relation/database/cluster sizes, temporary samples, maintenance, reopen and rollback results are retained in JSON. p99 is omitted below 1,000 samples; p95 below 20. Peak RSS may occur during caller-requested full-result materialization. Sampled process/disk peaks can miss short events. Client CPU excludes PostgreSQL server CPU; raw process samples include cumulative live server CPU, not exited processes or a complete CPU total. Zero OS I/O counters do not imply zero physical I/O.
