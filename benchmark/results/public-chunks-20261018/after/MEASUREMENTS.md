# Public API comparison: iniBase, SQLite, PostgreSQL

Flush policy: write-through. SQLite fullfsync/checkpoint_fullfsync ON; PostgreSQL fsync_writethrough on Darwin, fsync elsewhere; iniBase retains Node FileHandle.sync. Actual hardware power loss not qualified.

Equal six-field application records; bulk commits contain at most 1,000 records. Bulk timings include fixture creation. Index construction is explicit and measured for all engines; this is not automatic-tuning evidence. Existing iniBase public backend, not the experimental row kernel. Local PostgreSQL Unix-domain connection versus embedded calls. Fresh directories, rotated trials, existing OS filesystem cache. Full durability; actual settings and hashes retained in environment/trial files.

Mixed time includes maintenance attempts: iniBase compact(), SQLite WAL checkpoint, PostgreSQL VACUUM ANALYZE plus CHECKPOINT. Current public iniBase defaults rewrite base data on mutation, so compact() can be a no-op and rewrite cost sits inside mutation latency. There is no substantial pending log/tombstone overlay in this configuration. These are different maintenance mechanisms and these short runs do not establish endurance or PostgreSQL maturity. Reopen closes/reopens the client/engine, not the PostgreSQL server. Heap/cache settings do not bound whole-engine RSS. PostgreSQL tree RSS sums shared mappings more than once; it is not physical memory. Allocated PostgreSQL footprint includes the complete fresh cluster and WAL; empty cluster and relation bytes are reported separately.

| Dataset | Rows | Engine | Bulk ms | Records/s | Index ms | Random p50/p95 ms | Full ms | Projection ms | Insert p50 ms | Update p50 ms | Delete p50 ms | Mixed incl. maintenance ms | Worker peak MiB | Sampled tree peak MiB | Allocated MiB | PG empty/relation MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| compact | 100000 | inibase | 4246.910 | 23547 | 463.825 | 3.435 / 5.191 | 159.583 | 58.811 | 35.143 | 103.861 | 577.771 | 5975.921 | 334.81 | 344.33 | 11.48 | — |
| compact | 100000 | sqlite | 536.938 | 186241 | 56.037 | 0.013 / 0.044 | 60.171 | 19.960 | 3.908 | 3.908 | 3.805 | 127.270 | 282.56 | 282.03 | 17.98 | — |
| compact | 100000 | postgres | 717.736 | 139327 | 81.210 | 0.052 / 0.135 | 57.808 | 19.356 | 3.743 | 3.986 | 3.914 | 513.375 | 195.97 | 305.58 | 96.26 | 38.95 / 24.80 |
| cms | 100000 | inibase | 4312.899 | 23186 | 796.333 | 3.457 / 4.989 | 264.846 | 54.804 | 34.814 | 101.721 | 1055.142 | 8933.624 | 547.61 | 598.81 | 12.14 | — |
| cms | 100000 | sqlite | 1040.774 | 96082 | 73.729 | 0.012 / 0.021 | 134.421 | 42.348 | 3.934 | 3.797 | 3.196 | 128.231 | 547.81 | 547.80 | 153.40 | — |
| cms | 100000 | postgres | 1261.923 | 79244 | 148.662 | 0.053 / 0.261 | 143.805 | 36.230 | 3.887 | 3.919 | 3.922 | 608.487 | 399.84 | 551.14 | 340.34 | 38.95 / 141.60 |
| entropy | 100000 | inibase | 9443.013 | 10590 | 3271.069 | 3.757 / 5.227 | 577.490 | 57.314 | 35.035 | 101.873 | 5780.404 | 37036.526 | 553.52 | 576.41 | 91.77 | — |
| entropy | 100000 | sqlite | 1966.680 | 50847 | 87.203 | 0.011 / 0.019 | 144.216 | 57.125 | 3.887 | 3.927 | 3.861 | 127.057 | 582.31 | 582.25 | 209.90 | — |
| entropy | 100000 | postgres | 1988.933 | 50278 | 183.318 | 0.057 / 0.140 | 164.948 | 39.885 | 3.837 | 3.818 | 3.938 | 595.463 | 457.61 | 634.41 | 371.49 | 38.95 / 167.66 |

Verified 27/27; 0 failed runs; 0 sampler/setup errors; 0 operation errors.

Pooled latency sample counts and quantiles, all phase medians, CPU/I/O/resource samples, final relation/database/cluster sizes, temporary samples, maintenance, reopen and rollback results are retained in JSON. p99 is omitted below 1,000 samples; p95 below 20. Peak RSS may occur during caller-requested full-result materialization. Sampled process/disk peaks can miss short events. Client CPU excludes PostgreSQL server CPU; raw process samples include cumulative live server CPU, not exited processes or a complete CPU total. Zero OS I/O counters do not imply zero physical I/O.
