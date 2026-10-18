# PostgreSQL comparison and concurrency fixes

PostgreSQL is now a native local comparison engine alongside SQLite. These are
**public iniBase API measurements**, separate from the earlier immutable
row-kernel experiment. They do not establish PostgreSQL-level maturity or finish
the replacement runtime.

## Implementation

Commit `66783d8` fixes two reproduced correctness races:

1. Criteria-based updates/deletes previously selected physical lines before
   acquiring the writer lock. Another process could delete a preceding record,
   shifting the selection and causing a mutation of the wrong record. Selection
   and awaited publication now share the existing writer lock, as ID-based
   mutations already did.
2. A reader could begin after its recovery check while a writer was paused
   between moving a primary file to backup and publishing its replacement.
   Unchanging file identities could describe that partial state for the entire
   read. The optimistic snapshot now also brackets the read with table-journal
   absence, rejecting in-progress publication and using the existing locked
   fallback. Durability and synchronization are unchanged.

Three deterministic regressions fail on the saved baseline and pass on the
candidate. They are included in the default test command. The existing API,
features and four public table options remain intact. No format migration is
needed for these fixes.

Benchmark tooling adds a pinned `pg` client in its own private package, isolated
PostgreSQL clusters with private Unix sockets and no TCP listener, raw process and
storage sampling, rotated trials, concurrent processes, transaction rollback and
acknowledged-write crash checks. PostgreSQL is not a runtime dependency of iniBase.
An injected startup failure verifies that the harness stops a server even when
`pg_ctl start` reports failure after actually starting it.

## What the measurements show

The candidate does **not** beat SQLite or PostgreSQL on the primary measured
read/write workloads. Both competitors have lower medians for bulk inserts,
explicit index builds, full reads, projections, non-indexed filtering and mixed
work at every tested dataset/size. Indexed point reads and individual durable
mutations also remain substantially slower in iniBase. The concurrency fixes
preserve correct results; they are not presented as speed optimizations.

At 100k records, three rotated trials per engine/profile (times in ms):

| Dataset | Engine | Bulk median | Index-build median | Random-key p50 | Durable update p50 | Durable delete p50 | Allocated MiB |
|---|---|---:|---:|---:|---:|---:|---:|
| Compact | iniBase | 4372.11 | 461.72 | 3.462 | 898.600 | 576.000 | 11.48 |
| Compact | SQLite | 122.77 | 42.41 | 0.012 | 0.061 | 0.070 | 17.98 |
| Compact | PostgreSQL | 328.24 | 82.62 | 0.045 | 0.079 | 0.056 | 96.21 |
| CMS | iniBase | 4431.12 | 786.97 | 3.407 | 894.701 | 1036.580 | 12.14 |
| CMS | SQLite | 395.34 | 66.78 | 0.013 | 0.065 | 0.060 | 137.67 |
| CMS | PostgreSQL | 832.02 | 144.47 | 0.046 | 0.085 | 0.059 | 341.06 |
| SHA-256 hex text | iniBase | 9007.14 | 3115.07 | 3.699 | 891.523 | 5460.987 | 91.64 |
| SHA-256 hex text | SQLite | 1207.40 | 70.14 | 0.012 | 0.043 | 0.058 | 207.19 |
| SHA-256 hex text | PostgreSQL | 1647.77 | 162.78 | 0.043 | 0.084 | 0.063 | 381.57 |

Bulk timings include fixture generation and commits of at most 1,000 records;
index construction is a separate explicit timed phase for every engine. These
index results do not establish automatic-tuning performance. Read quantiles pool
96 samples per case; individual mutation quantiles pool 24. p99 is omitted.
Current iniBase rewrites base files on mutation. Its later `compact()` calls can
be no-ops, with rewrite costs already paid in the mutation timings. This is not
a pending-log/tombstone workload or a test of replacement-runtime compaction.

iniBase's compressed files are smaller in these configurations. PostgreSQL's
allocated column includes the complete fresh cluster and WAL. Its empty cluster
is about 38.95 MiB; server-reported table/index/TOAST relation sizes at 100k rows
are 24.80 MiB compact, 141.60 MiB CMS and 167.66 MiB entropy. SQLite has no
compression in this comparison; PostgreSQL retains its default text-storage
policy. These results do not establish a universal compression advantage.

## Correctness and recovery

- Final suite: **448 tests in 23 files, zero failures**, including transactions,
  validation, uniqueness, computed fields, relations, legacy log/block/index
  tests and process recovery. Type checking and changed-tool/core lint pass.
  The original user formatting edit in `src/index.ts` is preserved; the core
  lint check disables formatting rather than modifying that edit.
- Candidate matrix: **81/81 verified**, zero operation failures or sampler errors.
  The separately retained baseline matrix also verifies 81/81 single-process
  trials; that did not detect its concurrency bugs.
- Concurrency: **9/9 verified**, three trials per engine with three writers and
  one reader. Writers update disjoint keys, delete every fourth visited record
  and attempt maintenance every eighth cycle. Reopen verifies every final row.
  iniBase writer-cycle p50/p95 is 75.87/762.25 ms, SQLite 0.074/1.500 ms and
  PostgreSQL 0.296/5.116 ms. These cycles include reads/deletes/maintenance and
  lock waits; they are not single-update latency or an endurance qualification.
- Recovery version 2: **9/9 verified** after killing a writer and verifying all
  observed acknowledgements (at least 16 per run). PostgreSQL additionally
  receives immediate server shutdown and WAL restart. Handle opening, first
  verified read, complete verification and server restart are separate fields.
  iniBase's first verified read takes 4.56–4.99 ms in these small cases; its
  constructor time alone is not recovery latency. The process models differ,
  so these are not equivalent server-restart timing comparisons.
- Injected startup failure: expected run failure retained, server confirmed
  stopped. This tests harness cleanup, not an engine correctness failure.

These are process-crash checks, **not power-loss qualification**. They do not
prove every isolation behavior, cross-table publication interleaving, storage
failure, or corruption case. The maturity gates require broader qualification.

## Memory, CPU and temporary storage

All iniBase cache/reservation peaks remain within the configured 16 MiB allowance.
This accounting is per database within a process and does not bound total engine
working memory or RSS. Concurrent processes have separate allowances. PostgreSQL
uses 16 MiB shared buffers plus separately recorded work/maintenance memory;
these are not equal total-memory caps.

At 100k rows, iniBase worker peak RSS is about 344 MiB compact, 518 MiB CMS and
539 MiB entropy. Caller-requested full reads and verification are included in
these process peaks. The common harness also imports the PostgreSQL driver for
all workers before the recorded runtime baseline. These are not minimum
production footprints and do not establish an almost-zero-RAM engine.
PostgreSQL process-tree RSS double-counts shared mappings; it is not physical
memory. Node's 512 MiB heap cap is not an enforceable RSS limit.

Sampled iniBase temporary logical peaks at 100k rows are about 11.38 MiB compact,
12.05 MiB CMS and 144.18 MiB entropy. Sampling can miss short peaks. This confirms
that bounded segment compaction and whole-engine memory accounting remain work.
Zero sampled temporary space for another engine is not proof of zero system-wide
temporary space.

Raw worker/phase CPU and available I/O counters are retained. Worker CPU includes
client/fixture/verification work and excludes PostgreSQL server CPU. Raw process
samples retain cumulative live server CPU; they omit exited processes and are
not a complete server-CPU total. Darwin counters do not measure physical device
traffic reliably. Read timings exclude external verification where documented;
raw phase timings and latency arrays expose those boundaries.

## Artifacts, failures and reproduction

`measured/` is the initial engine at `5958d5b` plus the original working edits.
`measured-fixed/`, `concurrent/` and `recovery-verified/` use runtime commit
`66783d8` plus those same edits. The later default-test wiring changes only test
launching. Source archives, full commits, every compiled module hash, dependency
and native-binary hashes, settings, OS, CPU/RAM, raw latencies and resource samples
are retained. Both engine archives rebuild to the measured module identities;
33 archived tool-hash checks match their run metadata. The original 14 edited
files remain unchanged and unstaged.
The final tool lint cleanup removes an unused import and changes string-format
style; the pinned archives retain the exact sources used by each measured run.

Failed attempts are deliberately retained:

- `smoke/`: an iniBase harness memory query before open; corrected in `smoke-fixed/`.
- `concurrent-smoke/`: the baseline missing-key failure.
- `concurrent-fixed-smoke/`: the publication guard alone still exposed wrong-row
  writes; criteria selection required the second fix.
- `concurrent-selection-fixed-smoke/`: passing follow-up before repeated trials.
- `before-fix-regression.log`: initial environment setup error in two baseline
  regressions; `before-fix-regression-env.log` supplies a fixed test secret and
  shows all three actual regressions failing on the baseline.
- `recovery/`: passing initial version-1 runs, retained separately from version 2
  in `recovery-verified/` to distinguish lazy-open timing from actual first read.
- `startup-cleanup/`: intentional startup-failure injection with cleanup proof.

Environment: Apple M5, 10 cores, 16 GiB RAM, Apple NVMe/APFS, macOS 27.0.1 /
Darwin 27.0.0; Node 26.9.0, SQLite 3.53.4, PostgreSQL 18.6, `pg` 8.16.3,
TypeScript 5.9.3. There was no OS cache eviction. Fresh directories and client
reopening do not make these cold-NVMe measurements. All engines use durable
settings; actual PostgreSQL WAL sync method is recorded as `open_datasync` with
`fsync`, `synchronous_commit` and `full_page_writes` enabled. See
[PostgreSQL's WAL documentation](https://www.postgresql.org/docs/18/runtime-config-wal.html)
for the setting semantics.

[Exact commands and caveats](../../qualification/postgres/README.md),
[all candidate cases](measured-fixed/MEASUREMENTS.md),
[initial matrix](measured/MEASUREMENTS.md), [audit](audit.json),
[concurrency/recovery samples](SCENARIOS.json),
[maturity gates](../../../docs/maturity.md).

## Next priorities

The decisive next implementation is durable row-level mutation with bounded disk
delta indexes, followed by integration of existing API/transaction behavior,
bounded compaction and cross-process generation reclamation. Automatic tuning
and whole-engine resource limits must be qualified on that mutable backend.
Group commit is secondary while base rewrites dominate cost.

The replacement runtime and final `.sh` migration tool remain unfinished. Legacy
conversion will live in that external, version-pinned tool, preserving the original,
verifying staged output and recovering interrupted conversion. This stage does
not migrate existing data or claim that PostgreSQL maturity has been reached.
