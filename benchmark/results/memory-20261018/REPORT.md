# Total-memory comparison: local qualification status

No hard-total-memory benchmark has been qualified on this host. The local resident-memory-limit attempt and container executable inventory are retained in audit.json. The previous 81 verified trials had 16 MiB cache allowances, not total-memory limits. No new engine speed or constrained-memory result is claimed here.

Observed maxima across three existing trials at 100,000 records (MiB):

| Dataset | Engine | Worker peak RSS | Sampled server/client RSS sum | Engine accounting peak |
|---|---|---:|---:|---:|
| compact | inibase | 344.14 | 339.67 | 16.00 |
| compact | sqlite | 284.17 | 274.64 | not instrumented |
| compact | postgres | 194.56 | 300.77 | not instrumented |
| cms | inibase | 518.22 | 516.36 | 16.00 |
| cms | sqlite | 548.00 | 529.09 | not instrumented |
| cms | postgres | 381.41 | 545.67 | not instrumented |
| entropy | inibase | 539.06 | 549.55 | 16.00 |
| entropy | sqlite | 579.59 | 579.56 | not instrumented |
| entropy | postgres | 453.97 | 620.80 | not instrumented |

RSS includes the Node runtime, common PostgreSQL-driver harness, caller-requested materialized results and verification. PostgreSQL RSS sums double-count shared mappings; they are not physical-memory totals. Sampling can miss peaks. Engine accounting is incomplete and is not RSS. These observations neither establish which engine fits a hard limit nor predict how reclaim would change speed or memory. Do not subtract a runtime baseline and label the remainder engine memory.

The Linux launcher in benchmark/qualification/memory-limit.mjs uses a fresh delegated cgroup per command, memory.max, memory.swap.max=0 and group OOM handling. It captures kernel memory/CPU/I/O counters and cleans descendants, including detached PostgreSQL processes. It refuses unsupported hosts rather than substituting a heap/cache setting. Its Linux execution and OOM containment remain unqualified on this Mac.

Reproduce this audit from the repository root:

```sh
node benchmark/qualification/memory-audit.mjs /Users/karimamahtil/APPS/inibase/benchmark/results/postgres-20261018/measured-fixed /private/tmp/inibase-memory-audit-fresh
```

The current public iniBase engine has no demonstrated total-memory advantage. SQLite remains the performance reference to beat; compact compressed files remain iniBase's demonstrated advantage in these particular configurations. Memory pressure cannot be assumed to reverse the measured speed ranking.
