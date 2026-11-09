# Local engine comparison

Verified trials: 81. Failed trials: 0.

Medians of trial totals; lookup quantiles pool raw per-operation samples. p99 is omitted below 1,000 samples.
Durability: iniBase full; SQLite WAL/FULL. OS filesystem cache is not evicted. RSS and peak disk are sampled, not hard limits.

| Dataset | Rows | Engine | Bulk rows/s | Full ms | Projection ms | Key p50 ms | Key p95 ms | Update p50 ms | Delete p50 ms | Mixed ms | Allocated MiB | Observed peak RSS MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| compact | 1000 | baseline-indexed | 9886 | 5.88 | 2.20 | 1.449 | 1.976 | 9.090 | 9.016 | 738.09 | 0.32 | 120.78 |
| compact | 1000 | indexed | 10415 | 5.75 | 2.21 | 1.404 | 1.748 | 9.003 | 8.895 | 712.93 | 0.32 | 118.53 |
| compact | 1000 | sqlite | 850823 | 0.44 | 0.31 | 0.003 | 0.005 | 0.034 | 0.046 | 2.21 | 0.20 | 55.86 |
| cms | 1000 | baseline-indexed | 8186 | 6.71 | 2.00 | 1.476 | 2.074 | 8.935 | 8.729 | 675.22 | 0.33 | 120.97 |
| cms | 1000 | indexed | 9739 | 6.81 | 1.96 | 1.420 | 1.858 | 8.020 | 8.688 | 708.56 | 0.33 | 118.31 |
| cms | 1000 | sqlite | 243898 | 0.90 | 0.36 | 0.003 | 0.007 | 0.037 | 0.051 | 3.51 | 1.44 | 64.92 |
| mixed | 1000 | baseline-indexed | 6721 | 10.23 | 2.20 | 1.471 | 2.051 | 9.016 | 8.989 | 790.80 | 1.00 | 126.78 |
| mixed | 1000 | indexed | 7004 | 9.62 | 1.99 | 1.381 | 1.899 | 9.012 | 8.998 | 804.97 | 1.00 | 124.63 |
| mixed | 1000 | sqlite | 239337 | 0.78 | 0.40 | 0.003 | 0.007 | 0.039 | 0.047 | 3.59 | 2.11 | 79.88 |
| compact | 10000 | baseline-indexed | 10432 | 19.66 | 7.69 | 2.027 | 2.751 | 9.633 | 8.988 | 1705.92 | 1.84 | 194.66 |
| compact | 10000 | indexed | 10751 | 17.45 | 7.25 | 1.979 | 2.863 | 9.114 | 9.094 | 1681.84 | 1.84 | 174.05 |
| compact | 10000 | sqlite | 544602 | 6.06 | 3.90 | 0.004 | 0.006 | 0.032 | 0.041 | 2.83 | 1.88 | 105.09 |
| cms | 10000 | baseline-indexed | 10032 | 27.14 | 6.55 | 1.993 | 2.744 | 9.169 | 8.995 | 1799.99 | 1.90 | 203.56 |
| cms | 10000 | indexed | 10169 | 28.04 | 7.46 | 1.961 | 3.047 | 9.039 | 8.961 | 1764.14 | 1.90 | 196.50 |
| cms | 10000 | sqlite | 194523 | 11.45 | 3.45 | 0.004 | 0.007 | 0.043 | 0.049 | 6.26 | 13.91 | 167.05 |
| mixed | 10000 | baseline-indexed | 6689 | 58.89 | 6.61 | 2.132 | 3.082 | 9.806 | 9.077 | 2267.34 | 8.67 | 239.67 |
| mixed | 10000 | indexed | 6672 | 59.83 | 7.26 | 2.084 | 2.977 | 9.245 | 8.883 | 2295.08 | 8.67 | 312.27 |
| mixed | 10000 | sqlite | 145692 | 11.27 | 7.58 | 0.004 | 0.007 | 0.035 | 0.061 | 7.75 | 20.45 | 216.03 |
| compact | 100000 | baseline-indexed | 4743 | 157.84 | 56.78 | 3.125 | 4.092 | 10.068 | 9.922 | 11443.73 | 16.70 | 294.31 |
| compact | 100000 | indexed | 4795 | 152.54 | 53.70 | 3.043 | 4.051 | 10.024 | 9.262 | 11544.01 | 16.70 | 283.91 |
| compact | 100000 | sqlite | 177749 | 54.97 | 25.73 | 0.004 | 0.007 | 0.050 | 0.064 | 7.06 | 18.94 | 386.23 |
| cms | 100000 | baseline-indexed | 4666 | 255.74 | 52.45 | 3.145 | 4.225 | 9.719 | 9.090 | 12044.92 | 17.36 | 446.80 |
| cms | 100000 | indexed | 4710 | 259.26 | 52.31 | 3.093 | 3.965 | 8.927 | 9.102 | 12090.65 | 17.36 | 475.78 |
| cms | 100000 | sqlite | 66568 | 132.11 | 49.07 | 0.005 | 0.010 | 0.059 | 0.061 | 8.08 | 153.26 | 612.94 |
| mixed | 100000 | baseline-indexed | 3317 | 558.65 | 58.92 | 3.509 | 4.439 | 10.825 | 10.048 | 17043.92 | 97.38 | 565.97 |
| mixed | 100000 | indexed | 3347 | 556.23 | 55.87 | 3.365 | 4.328 | 10.039 | 10.021 | 17003.86 | 97.24 | 555.02 |
| mixed | 100000 | sqlite | 53135 | 132.07 | 58.98 | 0.006 | 0.009 | 0.039 | 0.041 | 10.28 | 211.85 | 653.66 |

## Scope and limitations

- `baseline-indexed`: frozen starting working tree, with identical indexes, seekable blocks and tombstones to the candidate.
- `optimized`: gzip/log plus seekable columns and tombstones, no application-key index; key queries are still filtering.
- `indexed`: same candidate with seq/key disk indexes; SQLite has its seq primary key and key index.
- Full results are deliberately materialized. RSS includes runtime, caller results and verification; cache accounting is separate and is not a total-working-memory guarantee.
- All files are counted, including the 32-row individual-insert fixture, indexes, logs and scratch files present at each snapshot.
- Mixed timing includes three explicit compactions/checkpoints plus any automatic maintenance. SQLite checkpoints, not VACUUMs, in this additional workload.
- Per-operation latencies exclude correctness assertions; total wall/verification timings and fixture-generation costs are retained separately.
- Observed peak RSS is the maximum of sampled process-tree RSS and the worker maxRSS counter; it remains a lower bound for short-lived child-process peaks.
- Sampled peak database footprint is not an exact peak temporary-space measurement. Read/write amplification is not fully instrumented.
- Process-crash qualification is separate from this benchmark and is not power-loss qualification.
- Historical workloads/results were not rewritten. See ../../../qualification/README.md for reproduction and remaining requirements.
