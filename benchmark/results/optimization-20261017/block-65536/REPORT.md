# Local engine comparison

Verified trials: 6. Failed trials: 0.

Medians of trial totals; lookup quantiles pool raw per-operation samples. p99 is omitted below 1,000 samples.
Durability: iniBase full; SQLite WAL/FULL. OS filesystem cache is not evicted. RSS and peak disk are sampled, not hard limits.

| Dataset | Rows | Engine | Bulk rows/s | Full ms | Projection ms | Key p50 ms | Key p95 ms | Update p50 ms | Delete p50 ms | Mixed ms | Allocated MiB | Observed peak RSS MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cms | 10000 | indexed | 9726 | 30.26 | 8.15 | 1.920 | 3.124 | 9.936 | 9.783 | 1833.43 | 1.92 | 196.22 |
| mixed | 10000 | indexed | 6300 | 60.93 | 6.69 | 2.032 | 3.649 | 9.898 | 9.122 | 2315.18 | 8.71 | 223.02 |

## Scope and limitations

- `baseline-indexed`: frozen starting working tree, with identical indexes, seekable blocks and tombstones to the candidate.
- `optimized`: gzip/log plus seekable columns and tombstones, no application-key index; key queries are still filtering.
- `indexed`: same candidate with seq/key disk indexes; SQLite has its seq primary key and key index.
- Full results are deliberately materialized. RSS includes runtime, caller results and verification; cache accounting is separate and is not a total-working-memory guarantee.
- All files are counted, including the 32-row individual-insert fixture, indexes, logs and scratch files present at each snapshot.
- Mixed timing includes all configured explicit compactions/checkpoints plus any automatic maintenance. SQLite checkpoints, not VACUUMs, in this additional workload.
- Per-operation latencies exclude correctness assertions; total wall/verification timings and fixture-generation costs are retained separately.
- Observed peak RSS is the maximum of sampled process-tree RSS and the worker maxRSS counter; it remains a lower bound for short-lived child-process peaks.
- Sampled peak database footprint is not an exact peak temporary-space measurement. Read/write amplification is not fully instrumented.
- Process-crash qualification is separate from this benchmark and is not power-loss qualification.
- Historical workloads/results were not rewritten. See ../../../qualification/README.md for reproduction and remaining requirements.
