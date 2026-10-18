# Overlay churn optimization

The starting checkout already contained incremental replay, seekable gzip blocks,
disk indexes and tombstones. This change improves that implementation without
changing the authoritative storage format or public API.

## Changes

* Index source identity checks use `stat` directly. The same device, inode, size
  and nanosecond mtime fields are compared; content identity checks remain in place.
* Overlay ID-directory writes use the existing bounded descriptor pool. A successful
  positional write updates an already-cached directory page rather than evicting it.
* A process-private `.keys` file holds each first-seen internal ID as eight bytes.
  Enumeration reads 4 KiB chunks and resolves each current value through the disk
  directory. It no longer parses every superseded scratch value. Sparse numeric
  IDs do not force scans across sparse-file holes. Tombstones remain enumerable.

There is no extra resident ID map, no background worker, and no change to fsync,
locking, journal publication or acknowledgment. The extra file participates in
handle eviction, close/clear, and dead-process scratch cleanup. Enumeration releases
its file handle before yielding or doing another lookup, including at a four-handle
limit. A truncated ID list fails closed.

## Compatibility and recovery

The `.keys` file is derived process-private scratch, not durable data. Existing
primary columns, indexes, format markers and logs are unchanged. No database
migration or version bump is required. On reopen or replay invalidation, the log
rebuilds the overlay and the ID list. The existing interrupted migration and
compaction journal protocol is unchanged. Missing or corrupt authoritative data
must still fail or recover through its existing protocol; scratch is not authority.

Each touched ID adds eight logical scratch bytes (plus filesystem allocation and
one pool-managed descriptor while cached). The 4 KiB enumeration buffer replaces
per-historical-value decoding. Scratch value history still grows until overlay
reset/compaction. Current entry values still use the shared cache budget.

## Scope that remains incomplete

This does not establish a hard bound on **all** engine working memory. Existing
unreserved frame encoding, large values, schema/metadata, selections, sorting,
concurrent operations and materialized results must be distinguished from cache
accounting. The existing 16 MiB setting must not be advertised as total RAM usage.

Compaction still rewrites affected columns under the writer lock, rather than
publishing bounded segments. Key-index rebuild amplification, changed-key delta
scans and individual insert cost remain. No group commit was added: it would need
an ordering/error/recovery protocol across processes, not simply fewer sync calls.

Regression tests cover churn, sparse IDs, cache eviction, tombstones, reset and
truncated ID streams. Existing process-crash/recovery tests cover log append/sync,
compaction and migration publication, concurrent indexed mutations and uniqueness.
SIGKILL testing is not actual power-loss qualification.

Measurements and commands are under `benchmark/results/optimization-20261017/`
and `benchmark/qualification/README.md`.

A follow-up recovery fix invalidates the incremental cursor when applying a local
committed frame to scratch fails. Previously the cursor could advance before the
scratch write failed, allowing a retry to miss the already-durable frame. The new
failure-injection regression requires the next refresh to recover that frame from
the authoritative log. Normal append/sync ordering is unchanged. Benchmark artifact
hashes distinguish the performance commit from this subsequent error-path fix.

A bounded metadata-batching experiment was rejected after three rotated trials:
point/hot-key timings did not improve consistently. The candidate source keeps the
existing snapshot checks. Its raw samples remain in `metadata-experiment/`.
