# Automatic options and row-storage qualification

This report describes a local development stage, not completion of the full storage redesign. The production DML backend remains column based.

## Public API comparison

Three rotated trials per engine/dataset/size; fresh directories and equal application values. High-entropy fixtures are deterministic SHA-256 hex text, not incompressible binary. Only `compression`, `decodeID` and `cache` are supplied (prepend defaults false). Baseline is the frozen pre-change working tree; optimized uses the four-option API and automatic indexes. SQLite has its application-key index from creation. iniBase uses full durability; SQLite uses WAL/FULL. No fsyncs or locks are disabled.

Initial 16-probe time includes draining the triggered build; post-training p50 pools 48 samples across trials. p95/p99 are omitted for these short samples. Mutation totals use two individual operations per trial; the mixed phase uses two rounds of two durable updates/reads and explicit compaction/checkpoint calls. Default-format iniBase compaction is a no-op because this workload does not enable the log. Phases inherited as `pending*` contain committed rewrites here, not populated logs. The earlier qualification covers actual logged overlays and tombstones.

| Dataset | Rows | Engine | First 16 + build ms | Trained key p50 ms | Bulk rows/s | Full ms | Projection ms | 2 updates ms | 2 deletes ms | Mixed ms | Allocated MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| compact | 1000 | baseline | 197.09 | 11.0980 | 16223 | 7.25 | 2.61 | 115.97 | 116.47 | 263.02 | 0.11 |
| compact | 1000 | optimized | 264.28 | 1.4883 | 15958 | 7.18 | 2.98 | 122.11 | 156.21 | 240.49 | 0.22 |
| compact | 1000 | sqlite | 0.39 | 0.0027 | 797740 | 0.47 | 0.34 | 0.14 | 0.15 | 0.55 | 0.20 |
| cms | 1000 | baseline | 203.16 | 11.8808 | 15316 | 8.79 | 1.96 | 118.10 | 113.57 | 256.43 | 0.12 |
| cms | 1000 | optimized | 277.68 | 1.4949 | 15745 | 8.89 | 2.22 | 110.01 | 161.30 | 236.33 | 0.22 |
| cms | 1000 | sqlite | 0.43 | 0.0028 | 254165 | 0.90 | 0.39 | 0.14 | 0.15 | 0.65 | 1.40 |
| mixed | 1000 | baseline | 236.83 | 14.0145 | 10616 | 11.41 | 2.13 | 114.87 | 162.67 | 258.17 | 0.80 |
| mixed | 1000 | optimized | 326.64 | 1.5617 | 11919 | 12.13 | 2.16 | 116.91 | 254.40 | 234.05 | 0.91 |
| mixed | 1000 | sqlite | 0.67 | 0.0029 | 235285 | 0.89 | 0.44 | 0.13 | 0.16 | 0.61 | 2.05 |
| compact | 10000 | baseline | 332.37 | 20.4440 | 22517 | 27.65 | 7.07 | 280.82 | 151.46 | 603.78 | 0.53 |
| compact | 10000 | optimized | 457.59 | 2.4155 | 22862 | 27.58 | 7.62 | 280.26 | 255.04 | 527.58 | 1.28 |
| compact | 10000 | sqlite | 0.44 | 0.0028 | 524470 | 5.88 | 3.00 | 0.14 | 0.15 | 0.69 | 1.88 |
| cms | 10000 | baseline | 392.98 | 23.9354 | 21982 | 39.55 | 6.61 | 284.12 | 192.07 | 616.47 | 0.58 |
| cms | 10000 | optimized | 537.18 | 2.3545 | 22177 | 38.21 | 6.90 | 276.09 | 345.41 | 539.41 | 1.34 |
| cms | 10000 | sqlite | 0.53 | 0.0027 | 184069 | 10.87 | 3.49 | 0.14 | 0.15 | 0.72 | 13.86 |
| mixed | 10000 | baseline | 651.66 | 40.4307 | 14897 | 63.62 | 6.69 | 276.34 | 596.90 | 607.75 | 7.47 |
| mixed | 10000 | optimized | 1007.99 | 2.4648 | 14518 | 64.61 | 7.75 | 271.23 | 1227.92 | 531.11 | 8.27 |
| mixed | 10000 | sqlite | 0.57 | 0.0029 | 148432 | 11.23 | 7.37 | 0.15 | 0.13 | 0.68 | 20.38 |
| compact | 100000 | baseline | 1569.69 | 96.9845 | 23142 | 158.05 | 51.85 | 1902.57 | 498.08 | 4084.02 | 4.70 |
| compact | 100000 | optimized | 2055.93 | 3.6030 | 23361 | 159.61 | 52.43 | 1834.00 | 1165.11 | 3586.89 | 11.48 |
| compact | 100000 | sqlite | 0.53 | 0.0027 | 173234 | 56.43 | 26.20 | 0.15 | 0.20 | 0.93 | 18.91 |
| cms | 100000 | baseline | 2053.88 | 119.1482 | 22121 | 272.33 | 50.25 | 1904.88 | 785.77 | 4078.85 | 5.20 |
| cms | 100000 | optimized | 2079.88 | 121.5995 | 22272 | 281.74 | 51.41 | 1884.23 | 769.74 | 4079.68 | 5.20 |
| cms | 100000 | sqlite | 0.54 | 0.0030 | 65891 | 129.64 | 50.12 | 0.15 | 0.14 | 0.85 | 151.88 |
| mixed | 100000 | baseline | 4110.40 | 226.6265 | 11650 | 587.92 | 50.61 | 1904.20 | 5046.78 | 4091.81 | 84.98 |
| mixed | 100000 | optimized | 4159.04 | 226.8358 | 11730 | 583.65 | 50.97 | 1885.51 | 5062.57 | 4099.18 | 84.86 |
| mixed | 100000 | sqlite | 0.66 | 0.0030 | 56263 | 138.70 | 61.52 | 0.18 | 0.18 | 1.02 | 211.85 |

## Memory, CPU and temporary storage

Runtime/RSS includes Node, caller-requested full results, fixture generation and correctness verification. Accounted bytes cover caches/evidence plus reserved maintenance, not all engine working memory. Sampled process-tree RSS and worker maxRSS are combined; short child peaks can be missed. Temporary disk is sampled every 100 ms, not an exact high-water mark. Raw phase CPU/I/O counters are retained; zero Darwin fsRead/fsWrite counters are unavailable evidence, not zero physical I/O.

| Dataset | Rows | Engine | Runtime RSS MiB | Peak RSS MiB | Peak accounted MiB | Peak temporary logical MiB | Peak temporary allocated MiB | CPU user ms | CPU system ms |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| compact | 1000 | baseline | 45.84 | 125.94 | 0.00 | 0.05 | 0.08 | 519 | 312 |
| compact | 1000 | optimized | 45.63 | 109.97 | 2.00 | 0.12 | 0.19 | 392 | 336 |
| compact | 1000 | sqlite | 45.81 | 55.75 | 0.00 | 0.00 | 0.00 | 12 | 5 |
| cms | 1000 | baseline | 45.70 | 132.77 | 0.00 | 0.05 | 0.09 | 555 | 321 |
| cms | 1000 | optimized | 45.67 | 135.81 | 2.25 | 0.13 | 0.19 | 430 | 342 |
| cms | 1000 | sqlite | 45.63 | 64.58 | 0.00 | 0.00 | 0.00 | 17 | 8 |
| mixed | 1000 | baseline | 45.59 | 136.84 | 0.00 | 0.74 | 0.78 | 755 | 337 |
| mixed | 1000 | optimized | 45.80 | 116.33 | 2.52 | 1.39 | 1.42 | 663 | 354 |
| mixed | 1000 | sqlite | 45.84 | 82.50 | 0.00 | 0.00 | 0.00 | 48 | 12 |
| compact | 10000 | baseline | 45.69 | 181.16 | 0.00 | 0.47 | 0.50 | 1278 | 1074 |
| compact | 10000 | optimized | 45.72 | 156.50 | 2.93 | 1.18 | 1.25 | 1246 | 1109 |
| compact | 10000 | sqlite | 45.75 | 102.39 | 0.00 | 0.00 | 0.00 | 90 | 18 |
| cms | 10000 | baseline | 45.66 | 204.86 | 0.00 | 0.52 | 0.55 | 1684 | 1183 |
| cms | 10000 | optimized | 45.67 | 207.91 | 5.88 | 1.24 | 1.31 | 1647 | 1144 |
| cms | 10000 | sqlite | 45.81 | 170.33 | 0.00 | 0.00 | 0.00 | 135 | 49 |
| mixed | 10000 | baseline | 45.67 | 228.98 | 0.00 | 7.41 | 7.44 | 3102 | 1216 |
| mixed | 10000 | optimized | 45.69 | 241.97 | 5.88 | 14.38 | 14.45 | 3452 | 1192 |
| mixed | 10000 | sqlite | 45.77 | 216.66 | 0.00 | 0.00 | 0.00 | 337 | 70 |
| compact | 100000 | baseline | 45.72 | 269.48 | 0.00 | 4.65 | 4.66 | 7520 | 8696 |
| compact | 100000 | optimized | 45.56 | 335.45 | 16.00 | 11.38 | 11.44 | 8718 | 8806 |
| compact | 100000 | sqlite | 45.58 | 386.61 | 0.00 | 0.00 | 0.00 | 694 | 361 |
| cms | 100000 | baseline | 45.64 | 451.33 | 0.00 | 5.15 | 5.17 | 10528 | 9487 |
| cms | 100000 | optimized | 45.61 | 449.13 | 2.00 | 5.15 | 5.71 | 10658 | 9442 |
| cms | 100000 | sqlite | 45.77 | 612.03 | 0.00 | 0.00 | 0.00 | 1344 | 890 |
| mixed | 100000 | baseline | 45.63 | 428.83 | 0.00 | 74.09 | 85.07 | 23013 | 11946 |
| mixed | 100000 | optimized | 45.70 | 508.03 | 0.00 | 74.10 | 85.32 | 22892 | 11912 |
| mixed | 100000 | sqlite | 45.58 | 643.39 | 0.00 | 0.00 | 0.00 | 3350 | 1067 |

## Immutable row-byte kernel experiment

This is a separate kernel comparison, not public iniBase versus SQLite. Both kernels store the same encoded JSON bytes and integer primary keys. Rowpack has independently compressed 32 KiB pages and an on-disk ID hash table; SQLite stores opaque BLOB rows with a primary key. One whole-dataset durable bulk publication/transaction, encoding included. Rowpack has no mutation, secondary-key, schema-validation, projection/scan, transaction integration, compaction or generation-reclamation API. Old generations can grow disk usage; it is not a production backend. A 1 MiB shared cache/reservation budget is used for rowpack and a 1 MiB SQLite page cache. Larger datasets exceed both cache settings.

Quantiles pool 384 random reads over three trials; p99 is omitted. Close/checkpoint times, raw samples, CPU/RSS and footprints before close are in `final/row-kernel/`. SQLite checkpoint cost is separate from bulk time. The kernel data differs from the API dataset, so its disk/latency values cannot be compared directly with the API table above.

| Dataset | Rows | Kernel | Bulk including encoding ms | Key p50 ms | Key p95 ms | Allocated MiB | Peak accounted MiB | Peak worker RSS MiB |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| compact | 1000 | rowpack | 49.61 | 0.0189 | 0.0461 | 0.13 | 0.35 | 61.45 |
| compact | 1000 | sqlite | 2.04 | 0.0022 | 0.0077 | 0.12 | 0.00 | 50.08 |
| compact | 10000 | rowpack | 230.68 | 0.2012 | 0.2495 | 1.54 | 0.97 | 76.09 |
| compact | 10000 | sqlite | 11.63 | 0.0022 | 0.0055 | 1.12 | 0.00 | 57.44 |
| compact | 100000 | rowpack | 2199.25 | 0.2023 | 0.3147 | 13.38 | 0.97 | 88.16 |
| compact | 100000 | sqlite | 120.57 | 0.0028 | 0.0063 | 11.47 | 0.00 | 65.42 |
| cms | 1000 | rowpack | 50.92 | 0.0657 | 0.1431 | 0.14 | 0.99 | 72.13 |
| cms | 1000 | sqlite | 6.20 | 0.0025 | 0.0053 | 1.96 | 0.00 | 53.27 |
| cms | 10000 | rowpack | 267.44 | 0.0661 | 0.1122 | 1.70 | 0.97 | 90.08 |
| cms | 10000 | sqlite | 76.66 | 0.0030 | 0.0072 | 19.58 | 0.00 | 57.25 |
| cms | 100000 | rowpack | 2625.02 | 0.0636 | 0.1147 | 15.73 | 0.97 | 158.70 |
| cms | 100000 | sqlite | 760.58 | 0.0037 | 0.0070 | 195.80 | 0.00 | 65.84 |
| entropy | 1000 | rowpack | 103.30 | 0.2652 | 0.5218 | 0.96 | 0.97 | 75.19 |
| entropy | 1000 | sqlite | 15.35 | 0.0027 | 0.0064 | 1.96 | 0.00 | 59.00 |
| entropy | 10000 | rowpack | 837.27 | 0.2670 | 0.5048 | 9.89 | 0.97 | 96.14 |
| entropy | 10000 | sqlite | 145.06 | 0.0030 | 0.0074 | 19.58 | 0.00 | 60.45 |
| entropy | 100000 | rowpack | 7544.64 | 0.2559 | 0.4875 | 104.67 | 0.97 | 183.19 |
| entropy | 100000 | sqlite | 1272.51 | 0.0038 | 0.0071 | 208.06 | 0.00 | 70.28 |

## Evidence and limits

- Machine/runtime/artifact identities: `final/measured-public/environment.json`, `dependencies.json`, `macos.txt`, `storage-hardware.txt`, `filesystem.txt`. Exact baseline/candidate source archives and the pre-existing working-tree patch are retained.
- Public comparison failures: 0. Sampler errors: 0. Kernel correctness: true.
- `public-matrix/` is exploratory: sandboxed ps sampling failed and later correctness runs overlapped it. It is retained but excluded from the measured tables. Earlier failed test logs retain fixture mistakes (wrong `.gz` filename, then signed-zero expectation); final correctness is recorded separately.
- OS caches were not evicted. Runs use one benchmark worker at a time on the local desktop; unrelated desktop activity remains possible. No enforceable process RSS limit/cgroup was available on macOS; V8 heap caps are not RSS caps.
- Full engine memory bounds and bounded-unit compaction remain incomplete. Index builds may increase insert/delete maintenance cost. Large automatic builds can hit eligibility/work limits and leave the scan fallback; maintenance diagnostics are retained in summary.json.
- No automatic authoritative format migration or group commit is introduced. SIGKILL tests qualify process crashes only, not sudden power loss or device-cache behavior.
- Historical workload defaults and published results remain unchanged. Version 5 is explicitly labeled by `--publicOptions=true`. Profiling is separate from latency measurements.

See [reproduction commands](../../qualification/README.md) and [row-storage limits](../../../docs/row-storage.md).
