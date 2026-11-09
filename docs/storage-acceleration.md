# Experimental disk acceleration (3.9.0-dev.0)

This is a local development build, not a production-readiness or SQLite-superiority claim.
Existing format-1, format-2 and format-3 databases remain readable. Automatic tuning
only creates derived accelerators; it does not change authoritative log formats or
reduce durability. No replacement database engine is introduced.

## Application options

```ts
await db.createTable("records", schema, {
  decodeID: true,
  prepend: false,
  compression: true,
  cache: false,
});

console.log(db.memoryUsage());
await db.close();
```

These are the four exported `TableConfig` properties and the four properties
returned by `getTable().config`. Existing persisted storage flags and legacy
runtime inputs remain understood internally. The historical `optimize`,
`enableTombstones` and `compact` maintenance methods remain available for
compatibility; ordinary applications need not choose block sizes or indexes.

## Automatic read optimization

The engine observes eligible top-level scalar equality searches without retaining
query values. After at least 16 probes and 64 ms of cumulative search work, it may
build a disk index and seek directories using the existing journaled publication
path. Missing-key probes count too. Numeric-looking string predicates, nested
fields, relations, computed fields and non-equality operators keep their existing
paths. The existing internal-ID accelerator is included when a build qualifies.

One maintenance task is allowed per database, shared across instances in the
process, with no pending-task queue. A nonblocking writer lock prevents competing
builds across processes. Maintenance gets an independent async lock context so it
cannot accidentally inherit a foreground operation's reentrant ownership.
`close()` drains maintenance. Failures retain the scan fallback and are reported
by `memoryUsage().maintenanceErrors` and `maintenanceLastError`.

This first policy is intentionally limited: 128–100,000 rows, at most 8 MiB of
compressed/raw primary files, a 16 MiB uncompressed build-work limit and 64 KiB
indexed cells. It requires a database budget of at least 4 MiB, reserves 2 MiB for
build working space, limits index growth using the current table footprint, and
waits ten minutes before another attempt on the same column. Evidence counters
are evictable entries in the shared cache. Larger tables and values still work;
they retain existing paths when a build exceeds these limits. The policy does not
currently measure write/read ratios, remove unused indexes, select block sizes
from workload evidence or adapt the primary storage layout. Index maintenance can
increase delete/insert cost; benchmark results include those costs.

Automatic log/tombstone migration is deliberately deferred: the current log
backend restricts supported transactions and schemas. Turning it on silently
would break existing features. Future automatic writes need a backend that
preserves those features first. Column storage is an implementation choice, not
a project requirement; see [the row-storage experiment](row-storage.md).

`optimize` accepts simple top-level application columns. Unsupported predicate/type
shapes continue through the existing filtering path; an index is not a new query
language. Equality candidates are decoded and verified, including hash collisions.
No application-specific key names or fixture values receive special treatment.

The existing transaction API remains available on ordinary/seekable legacy tables.
The existing restriction on transactions for log-enabled tables is **not removed**.
Nested fields, computed fields, prepend layout and relations keep their legacy
paths; log tables retain their existing simple-schema/append-layout restrictions.

## Storage and migration

* Primary column names and cell encoding are unchanged. Compressed columns contain
  independently decodable, standards-compliant concatenated gzip members. Existing
  gzip readers can still scan them. Raw columns also get seek directories.
* `<column>.seek` has a version-1, CRC-checked header and fixed-size, CRC-checked
  block descriptors: row ranges, compressed offsets/lengths, raw lengths/checksums.
  Blocks are 64, 128 (default), or 256 KiB uncompressed. Oversized cells can span
  blocks, including split UTF-8 sequences; only requested cells are assembled.
* `<column>.lookup` has a version-1 header tied to the primary and ID-file
  identities. Internal-ID indexes use a sparse numeric directory. Automatically learned or historically explicit key
  indexes use on-disk hash buckets and checksummed collision chains. Locations
  include stable IDs and physical row positions; the seek directory makes those
  positions directly readable without decompressing the preceding stream.
* `.seek.config` version 1 records accelerator configuration. `optimize`, DML
  rewrites, compaction and supported transaction staging publish accelerator files
  with their primary columns through the same journal. An old engine changing a
  primary file makes its accelerator stale; new readers fall back to scanning.
* Tombstones require explicit **format 3**: `.format` carries `tombstones: true`
  and `minReader: "3.9.0"`. Ordinary `log: true` still creates format 2 with its
  original `minReader: "3.8.0"`. Format-3 deletes append durable tombstones. Reads,
  projections, criteria, counts, pagination, aggregates and uniqueness merge them.
  Physical row-count metadata includes not-yet-compacted deleted slots; public
  counts exclude those slots. Stable IDs are never renumbered by compaction.

**Migration procedure:** stop older engine processes, quiesce writers, take a
consistent backup or filesystem snapshot, then call the explicit migration APIs.
Do not run older, already-open legacy readers across a format migration: older
builds can cache the absence of a format marker. After migration, open all clients
with a conforming reader. Pre-marker/detector engines may ignore newer markers;
they must not be used to open the upgraded database.

Interrupted accelerator publication recovers all journaled files together:
no commit marker rolls back; a commit marker rolls forward. Interrupted tombstone
enablement leaves the old or new complete marker; existing update frames and base
columns are unchanged. Crash-left, recognizable staging files are reclaimed under
the writer lock. Unknown scratch names are retained. Private overlay scratch files
from provably dead processes on the same host are reclaimable; foreign-host or
ambiguous owners are not deleted.

Do not manually alter primary data, indexes or logs. Missing/stale accelerators
fall back; malformed/checksum-invalid metadata fails closed. Rebuild derived
accelerators with `optimize` after investigating the cause. A damaged primary or
authoritative log requires recovery/restore, not deleting its format marker.

## Replay, durability and recovery

Log refresh serializes per table and retains a validated byte boundary, generation,
file identity and last-frame checksum witness. Unchanged refreshes do no replay;
validated appends replay only their suffix. Replacement, shrinkage, same-size
rewrite, generation change and torn tails invalidate the cursor. The writer repairs
a torn EOF before appending. Frame scanning reads bounded frames, rather than
accumulating the remainder of a corrupt log. Full-prefix CRC/generation validation
runs on rebuild/reopen and before compaction retires an authoritative log.

Previously validated prefixes are trusted between refreshes under the append-only
writer protocol. Arbitrary out-of-protocol modifications to an older prefix that
preserve the boundary witness are not an immediate online scrub; reopen/compaction
detects them. This is not continuous whole-file bit-rot qualification.

A single frame is appended and synchronized before acknowledgment. A public put
spanning several frames uses journaled whole-log staging so a process crash cannot
expose only its first frames. Regular-file sync errors and unexpected directory
sync failures propagate. Unknown commit-sync outcomes retain recovery state.
Failed rollback retains its journal/backups. Publication directory entries are
synchronized before the commit marker; supported existing directory-fsync caveats
remain. Locks are not weakened, and `full` remains the durability default.

SIGKILL tests exercise append, synchronization, compaction and migration publication.
They validate **process-crash recovery, not sudden power-loss behavior**. Qualification
against actual power failures and filesystem/device write-cache behavior is outstanding.

## Memory and storage: important incomplete requirements

`INIBASE_MEMORY_BYTES` (default 16 MiB, minimum 256 KiB) is a shared **cache and reserved-maintenance accounting
limit** across all instances of one database in a process. It charges overlay page
buffers, decoded overlay cache entries conservatively, column block buffers and
directory pages, small workload-evidence counters and newly reserved background
working space. `workingBytes` and `peakAccountedBytes` expose the reservations;
this is still not all engine allocation. Overlays themselves are rebuildable sparse disk directories plus
append-only values, not table-sized resident Maps. `INIBASE_MAX_OPEN_FILES` (default
32, minimum 4) bounds the reusable scratch-handle pool, including in-progress opens
and closes. `close()` releases that database's resources when its last instance closes.

**This is not yet a hard database-wide working-memory limit.** Frame JSON encoding/
decoding (up to the existing 16 MiB frame bound), input formatting, wide-schema
parallel reads, metadata/computed caches, bulk selections, in-process sorts, result
assembly and concurrent operations are not all reserved against that budget.
Caller-requested full results and runtime/V8 overhead are separate, but even after
excluding them this requirement is incomplete. Do not size a server as though
16 MiB were the engine's total RAM requirement. Node heap limits are not RSS limits.

Compaction is streaming and no longer builds whole-table ID-to-line Maps. However,
it still rewrites whole affected columns and holds the writer lock. It is **not yet
bounded-I/O/latency segment compaction**. Explicit and automatic compaction cost must
remain in workload timings. Structural rewrites can temporarily hold staged, backup
and primary copies; accelerator preparation adds further temporary files.

Further tradeoffs:

* Smaller gzip blocks lose cross-block compression and add metadata/members.
* Indexes add disk space and write amplification. Appends reuse all but the last
  column block, but application-key indexes still rebuild on base rewrites.
* Sparse ID directories have small allocated footprints but logical lengths
  proportional to the largest live ID. Sparse-aware backups matter after churn.
* Changed-key lookups can still scan disk-overlay entries; a paged secondary delta
  index is a remaining priority. Non-indexed searches remain scans.
* The existing per-table log/overlay backpressure settings remain; a large single
  public operation can exceed a pre-write threshold before subsequent maintenance.
* No group-commit coordinator or background compactor is introduced. Automatic
  index preparation is the only new background maintenance. Existing
  fsyncs and cross-process writer locking remain in force.

## Verification and reproduction

```sh
pnpm exec tsc --noEmit
pnpm test
pnpm exec tsx tests/storage-process.test.ts
pnpm exec tsx tests/journal-hardening.test.ts
pnpm exec biome check src
pnpm exec tsc
```

Benchmark tooling, exact artifact identities, raw samples, failures and reproduction
commands are in [qualification tooling](../benchmark/qualification/README.md),
[the earlier optimization report](../benchmark/results/optimization-20261017/REPORT.md)
and [the automatic-options report](../benchmark/results/automatic-20261018/REPORT.md).
