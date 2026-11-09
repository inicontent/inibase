# Local engine comparison

Verified trials: 81. Failed trials: 0.

Medians of trial totals; lookup quantiles pool raw per-operation samples. p99 is omitted below 1,000 samples.
Durability: iniBase full; SQLite WAL/FULL. OS filesystem cache is not evicted. RSS and peak disk are sampled, not hard limits.

| Dataset | Rows | Engine | Bulk rows/s | Full ms | Projection ms | Key p50 ms | Key p95 ms | Update p50 ms | Delete p50 ms | Mixed ms | Allocated MiB | Observed peak RSS MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| compact | 1000 | baseline-indexed | 9820 | 5.94 | 2.40 | 1.528 | 2.367 | 9.849 | 8.974 | 754.36 | 0.32 | 117.86 |
| compact | 1000 | indexed | 10298 | 5.88 | 2.25 | 1.427 | 2.215 | 9.023 | 8.758 | 820.21 | 0.32 | 117.95 |
| compact | 1000 | sqlite | 715201 | 0.47 | 0.34 | 0.003 | 0.005 | 0.040 | 0.048 | 2.55 | 0.20 | 55.98 |
| cms | 1000 | baseline-indexed | 9429 | 6.86 | 2.05 | 1.482 | 1.972 | 9.181 | 8.940 | 742.88 | 0.33 | 121.20 |
| cms | 1000 | indexed | 9496 | 7.35 | 2.17 | 1.397 | 1.884 | 9.913 | 8.935 | 752.20 | 0.33 | 119.83 |
| cms | 1000 | sqlite | 276046 | 0.80 | 0.37 | 0.003 | 0.006 | 0.044 | 0.050 | 3.56 | 1.44 | 64.50 |
| mixed | 1000 | baseline-indexed | 6951 | 10.09 | 2.08 | 1.496 | 2.519 | 9.772 | 9.138 | 800.67 | 1.00 | 130.20 |
| mixed | 1000 | indexed | 6633 | 11.03 | 2.47 | 1.438 | 2.134 | 9.149 | 8.944 | 834.16 | 1.00 | 129.50 |
| mixed | 1000 | sqlite | 238211 | 0.75 | 0.42 | 0.003 | 0.007 | 0.037 | 0.054 | 4.19 | 2.11 | 79.83 |
| compact | 10000 | baseline-indexed | 10157 | 18.91 | 8.92 | 2.069 | 3.352 | 9.024 | 9.168 | 1795.95 | 1.84 | 174.67 |
| compact | 10000 | indexed | 10240 | 20.01 | 8.20 | 2.011 | 2.833 | 9.815 | 8.727 | 1734.13 | 1.84 | 177.38 |
| compact | 10000 | sqlite | 527906 | 5.81 | 3.31 | 0.004 | 0.007 | 0.042 | 0.045 | 3.31 | 1.88 | 105.09 |
| cms | 10000 | baseline-indexed | 10158 | 26.80 | 6.79 | 1.986 | 2.799 | 9.116 | 9.210 | 1804.58 | 1.90 | 212.27 |
| cms | 10000 | indexed | 10314 | 30.12 | 6.79 | 2.062 | 3.334 | 8.265 | 8.915 | 1830.96 | 1.90 | 210.20 |
| cms | 10000 | sqlite | 189689 | 10.41 | 3.53 | 0.004 | 0.008 | 0.038 | 0.049 | 6.83 | 13.91 | 167.28 |
| mixed | 10000 | baseline-indexed | 6465 | 61.08 | 6.53 | 2.326 | 4.433 | 9.223 | 8.975 | 2284.42 | 8.67 | 234.55 |
| mixed | 10000 | indexed | 6614 | 58.73 | 6.62 | 2.110 | 3.167 | 9.022 | 9.087 | 2298.47 | 8.67 | 231.72 |
| mixed | 10000 | sqlite | 145038 | 11.39 | 7.56 | 0.004 | 0.008 | 0.044 | 0.063 | 7.25 | 20.45 | 216.22 |
| compact | 100000 | baseline-indexed | 4721 | 155.87 | 57.83 | 3.140 | 4.297 | 10.098 | 9.117 | 11743.94 | 16.70 | 278.97 |
| compact | 100000 | indexed | 4734 | 160.68 | 57.14 | 3.145 | 4.263 | 9.928 | 9.099 | 11728.00 | 16.70 | 280.05 |
| compact | 100000 | sqlite | 173475 | 56.58 | 26.29 | 0.004 | 0.008 | 0.053 | 0.053 | 7.61 | 18.94 | 385.19 |
| cms | 100000 | baseline-indexed | 4538 | 260.59 | 54.65 | 3.309 | 4.447 | 9.895 | 9.977 | 12413.49 | 17.36 | 434.95 |
| cms | 100000 | indexed | 4437 | 272.49 | 53.74 | 3.291 | 4.726 | 10.050 | 10.117 | 12649.46 | 17.36 | 440.52 |
| cms | 100000 | sqlite | 61702 | 172.51 | 53.04 | 0.005 | 0.010 | 0.055 | 0.068 | 8.52 | 147.73 | 611.89 |
| mixed | 100000 | baseline-indexed | 3105 | 566.41 | 56.11 | 3.589 | 4.847 | 10.142 | 9.953 | 17920.87 | 97.24 | 571.63 |
| mixed | 100000 | indexed | 2927 | 604.57 | 61.54 | 3.609 | 4.991 | 9.080 | 10.010 | 18075.45 | 96.73 | 495.70 |
| mixed | 100000 | sqlite | 54573 | 134.78 | 62.85 | 0.006 | 0.014 | 0.035 | 0.040 | 8.95 | 209.82 | 652.13 |

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
