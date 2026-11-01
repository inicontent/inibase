# Public API comparison: iniBase, SQLite, PostgreSQL

Flush policy: write-through. SQLite fullfsync/checkpoint_fullfsync ON; PostgreSQL fsync_writethrough on Darwin, fsync elsewhere; iniBase retains Node FileHandle.sync. Actual hardware power loss not qualified.

Equal six-field application records; bulk commits contain at most 1,000 records. Bulk timings include fixture creation. Index construction is explicit and measured for all engines; this is not automatic-tuning evidence. Existing iniBase public backend, not the experimental row kernel. Local PostgreSQL Unix-domain connection versus embedded calls. Fresh directories, rotated trials, existing OS filesystem cache. Full durability; actual settings and hashes retained in environment/trial files.

Mixed time includes maintenance attempts: iniBase compact(), SQLite WAL checkpoint, PostgreSQL VACUUM ANALYZE plus CHECKPOINT. Current public iniBase defaults rewrite base data on mutation, so compact() can be a no-op and rewrite cost sits inside mutation latency. There is no substantial pending log/tombstone overlay in this configuration. These are different maintenance mechanisms and these short runs do not establish endurance or PostgreSQL maturity. Reopen closes/reopens the client/engine, not the PostgreSQL server. Heap/cache settings do not bound whole-engine RSS. PostgreSQL tree RSS sums shared mappings more than once; it is not physical memory. Allocated PostgreSQL footprint includes the complete fresh cluster and WAL; empty cluster and relation bytes are reported separately.

| Dataset | Rows | Engine | Bulk ms | Records/s | Index ms | Random p50/p95 ms | Full ms | Projection ms | Insert p50 ms | Update p50 ms | Delete p50 ms | Mixed incl. maintenance ms | Worker peak MiB | Sampled tree peak MiB | Allocated MiB | PG empty/relation MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cms | 10000 | inibase | 482.172 | 20740 | 156.818 | 1.797 / 2.952 | 26.972 | 9.135 | 38.003 | 10.051 | 9.819 | 14276.297 | 233.69 | 232.30 | 1.33 | — |
| cms | 10000 | sqlite | 102.117 | 97927 | 7.127 | 0.010 / 0.016 | 8.719 | 2.588 | 3.925 | 3.976 | 3.957 | 3131.814 | 193.28 | 193.75 | 14.77 | — |
| cms | 10000 | postgres | 121.647 | 82205 | 16.994 | 0.046 / 0.095 | 15.326 | 2.261 | 3.981 | 3.988 | 3.979 | 4043.699 | 167.78 | 276.64 | 70.91 | 38.95 / 14.41 |

Verified 9/9; 0 failed runs; 0 sampler/setup errors; 0 operation errors.

Pooled latency sample counts and quantiles, all phase medians, CPU/I/O/resource samples, final relation/database/cluster sizes, temporary samples, maintenance, reopen and rollback results are retained in JSON. p99 is omitted below 1,000 samples; p95 below 20. Peak RSS may occur during caller-requested full-result materialization. Sampled process/disk peaks can miss short events. Client CPU excludes PostgreSQL server CPU; raw process samples include cumulative live server CPU, not exited processes or a complete CPU total. Zero OS I/O counters do not imply zero physical I/O.
