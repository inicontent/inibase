# Four-option API and automatic storage: implemented stage

The public table options are now **decodeID, prepend, compression and cache**.
Persisted storage configuration is private engine state; historical log/index/
tombstone runtime inputs remain readable and supported. No application needs to
select seekability, block size or an index to use the new read policy.

This is a completed first implementation stage, **not completion of the full
database redesign**. Existing DML still uses columns. A row-based alternative is
implemented and measured as an isolated immutable kernel, not installed as the
default before it can preserve all supported features.

## Implementation and safety

- `79764d5`: four-option API, private persisted configuration, bounded query
  evidence, one automatic maintenance task per database, explicit working-memory
  reservations sharing the cache budget, independent lock ownership and cleanup.
- `5e15b17`: immutable compressed row pages, disk ID hash index/page directory,
  checksums, synchronized generation publication, active-reader snapshots,
  interruption/corruption tests and a separate kernel benchmark.
- Repeated eligible equality probes can build the existing disk indexes and
  seek directories through the same crash-atomic journal as explicit optimization.
  Thresholds and size limits are documented in [storage acceleration](../../../docs/storage-acceleration.md).
- Automatic tuning does not turn on log/tombstone formats. The existing log
  backend restricts transactions and some schemas; migrating silently would
  violate feature compatibility. Durability, validation and locks are preserved.
- All 14 original local edit hunks remain unchanged and unstaged; verification is
  retained in `preexisting-verification.json`. No pushes or deployments occurred.

## Verification and environment

Baseline: **427 tests passed** before edits. Final: **440 tests passed**, 22 test
files, zero failures (`correctness-final.log`). Added checks cover learned-index
key changes, deletion, uniqueness, transactions, concurrent readers/writers across
processes, oversized-key build rejection without primary changes, small-budget
fallback, 50,000 evictable learning entries, shared reservations and task limits.
Row-kernel checks cover compressed/uncompressed large values, UTF-8, sparse IDs,
misses, duplicates, failed publication, retained old snapshots, corrupt data/index/
directory entries and SIGKILL before/after publication followed by a new writer.
The row suite also passes with a **256 KiB** accounting budget. Process crashes
are tested; actual power-loss behavior is not qualified.

TypeScript passes. New engine modules pass Biome. Checking the existing index/file
modules retains one formatting error from the pre-existing user edit; that edit
was deliberately preserved. Earlier failed test logs are retained and explained
in the measurements rather than removed.

Machine: Apple M5, 16 GiB RAM, APPLE SSD AP0512Z NVMe, APFS with 4096-byte device
blocks; macOS 27.0.1 / Darwin 27.0.0. Node 26.9.0, SQLite 3.53.4, TypeScript 5.9.3,
tsx 4.22.4, pnpm 10.33.0. No dependency upgrades were introduced. Exact versions,
native addon/lockfile hashes, hardware output, source archives and module hashes
are retained alongside the samples.

The baseline source starts at `5dd5d0ef351aa4e3f4eb5611fdd7417ab7acc950` plus the
saved pre-existing edits. The candidate implementation is `5e15b17` plus those
same edits. Compiled tree hashes actually loaded by the measured workers:

| Artifact | SHA-256 of compiled-module hash manifest |
|---|---|
| Baseline | `3473c88ac2193162e72f7feb7c5616bf7404644654cd9e246da8b05f323101f6` |
| Candidate | `7922645d94a43931b3609c4b26589f5e9869a1a1b8859b15d1a12801ab7660b3` |

## Measured outcomes

**81 public-API trials, 54 row-kernel trials and three separate profiling trials
verified without operation/correctness failures.** The measured API matrix has
zero sampler errors. Trials rotate engine order and use fresh directories, equal
application data and full durability (SQLite WAL/FULL). OS caches were not evicted.
The earlier sandbox-limited exploratory matrix is retained and excluded from
the measured conclusions. Full tables, latency samples, CPU, RSS, disk and temporary
space results are in [MEASUREMENTS.md](MEASUREMENTS.md) and `summary.json`.

Where the policy built an index, post-training key p50 improved **7.5–26.9×**
against the pre-change defaults. Examples:

| Dataset | Baseline p50 ms | Automatic p50 ms | SQLite p50 ms |
|---|---:|---:|---:|
| 1k compact | 11.0980 | 1.4883 | 0.0027 |
| 10k high entropy | 40.4307 | 2.4648 | 0.0029 |
| 100k compact | 96.9845 | 3.6030 | 0.0027 |

Construction is a real cost: 100k compact's first 16 probes plus build took
**2055.93 ms**, versus **1569.69 ms** for baseline scans. The same case's two
durable deletes rose from **498.08 to 1165.11 ms**, and allocated storage from
**4.70 to 11.48 MiB**, because structural mutations still rebuild accelerators.
The short update/read mixed phase improved from 4084.02 to 3586.89 ms, but it has
no ongoing deletes and is not evidence of a universally better mixed workload.

100k CMS exceeds the uncompressed automatic-build limit; 100k high-entropy data
exceeds the primary-size eligibility limit. Those tables keep scans and show no
meaningful point-read gain. These are bounded fallbacks, not supported-data limits.
Diagnostics distinguish rejected work from foreground operation errors.

SQLite remained faster for all measured bulk inserts, full reads, indexed lookups,
individual durable mutations and mixed phases. The speed win among the reported
bulk/read/projection/lookup/mutation/mixed phases was the **100k high-entropy
two-column projection: 50.97 ms versus SQLite 61.52 ms** (trial medians). This
column-projection advantage already existed in baseline and is not attributed to
the new index policy. Compression saved storage: 100k CMS used **5.20 MiB versus
SQLite 151.88 MiB**, with slow scan-based key reads still present.

The row kernel shows a possible direction, not feature parity: 100k CMS integer-ID
read p50 was **0.0636 ms** versus the equivalent SQLite BLOB kernel's **0.0037 ms**;
allocated storage was **15.73 versus 195.80 MiB**. However, 100k compact row pages
used **13.38 MiB versus SQLite 11.47 MiB**, and bulk construction remained slower
in every kernel case. Kernel data/API differ from the public matrix, so comparing
their latency numbers directly would be misleading.

## Profiling and next priorities

The separate 1k compact profile observed `exec` entries falling **501 → 67** and
stream gunzip constructions **1576 → 252**. Nested `execFile` wrappers count the
same launches and must not be added again. Sampled CPU profiles corroborate less
spawn work. The tradeoff is more filesystem work: open wrappers **1833 → 3995**,
file-stat wrappers **6722 → 7180**, and synchronization calls **256 → 338**.
Asynchronous timing sums include overlap/wait and are not exclusive CPU time.
The profiles identify remaining handle/metadata overhead and write amplification;
they do not justify weakening synchronization.

1. Build a feature-complete mutable paged backend: durable log, on-disk delta
   indexes, tombstones and existing transaction/uniqueness/relations semantics.
   Keep migration versioned, recoverable and compatible before switching defaults.
2. Replace whole-column structural maintenance with bounded segments and safe
   generation reclamation. The row prototype deliberately retains old generations
   and is unsuitable for repeated production publication until reclamation exists.
3. Reduce per-row async I/O during row-index construction and amortize metadata/
   file operations over immutable generations. The current prototype narrows the
   read gap but does not compete with SQLite's bulk or point-read speed yet.
4. Complete engine-wide working-memory accounting and bounded concurrency. API
   peaks reached **508 MiB**, including runtime/caller materialization and
   unaccounted engine transients. Even the streaming row-kernel experiment peaked
   at **183 MiB** with a 1 MiB accounting limit. A cache/reservation limit is not a
   process RSS guarantee or proof of near-zero total engine RAM.
5. Extend tuning with measured read/write ratios, selectivity, index retirement
   and block-size selection. The current policy only learns eligible equality
   indexes and deliberately skips expensive builds. Evaluate group commit after
   the mutable design and synchronization profile support it, preserving durable
   acknowledgment and cross-process ordering.

The project fundamentals remain disk-resident data/indexes, bounded small engine
memory, low CPU, compact files, NVMe speed, embedded operation and a simple API,
plus correctness, durability and supported features. The column layout can change.

Exact commands and archive-based artifact reproduction are in
[qualification README](../../qualification/README.md). No universal speed or
near-zero-RAM claim is made by this stage.
