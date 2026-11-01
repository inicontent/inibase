# Automatic incremental updates and deletes

Public table options remain `decodeID`, `prepend`, `compression`, and `cache`.
No log, tombstone, index, or block tuning is required from applications.

For append-layout tables with at least 128 physical records and only simple,
non-computed columns, small updates and deletes automatically use the existing
format-3 checksummed update log. The initial transition is serialized with writers:
persist an empty log file, then atomically publish and synchronize the format
marker. Subsequent point mutations append a durable frame and update a rebuildable,
disk-backed overlay. Deletes append tombstones. Base column/index bytes and row
positions do not change for each individual mutation. Queries, uniqueness,
aggregates and pagination use the merged view. Existing on-disk key indexes are
reconciled with updated keys and deleted IDs.

The 128-row threshold avoids changing tiny tables for a transition with fixed
synchronization and scratch-file costs. It is a general storage policy, independent
of record values or benchmark fixtures. No data is migrated merely by opening a
table. Log-format databases remain readable by format-3 readers. The additive
`automatic` marker describes engine policy; it does not change frame/cell encoding.
Existing explicit log-table behavior is preserved.

Automatic batches contain at most 256 selected rows. Payloads are conservatively
estimated before encoding, including repeats across matching rows. Their estimate
must fit the smaller of 64 KiB and one sixteenth of the database resource allowance.
Merged per-record overlays are checked against the same conservative size bound;
several small column updates trigger folding before accumulating an oversized row.
Updates that explicitly supply ID/creation metadata use the existing base path.
Automatic delta mutations share a reservation of at most 512 KiB (or the entire
allowance when smaller), across every table in the database. Lock initialization
and overlay descriptors use the shared descriptor manager. This reservation does
not claim to bound all inherited engine paths, metadata, caller inputs/results,
V8/native allocations, or process RSS. Whole-engine memory qualification remains
unfinished.

Accumulation limits for automatic mode are at most 2,048 distinct overlaid IDs and
8 MiB of log data, reduced by the existing deployment limits when lower. The next
writer folds accumulated changes before appending more. Explicit `compact()` also
folds changes. Compaction streams one column at a time through bounded compressor
input chunks; primary data, seek directories, indexes, the empty log and the new
generation marker publish through the existing durable file journal. Compaction
still rewrites the affected columns (all columns when removing tombstones). It is
bounded in working buffers, not incremental in I/O or scheduling time. There is no
background maintenance queue, and a large compaction can still stall a writer.

Transactions, schema/config changes, prepend layouts, complex/computed schemas,
broad changes and oversized payloads retain their existing supported paths.
Sorted reads with pending automatic deltas fold first and use the existing disk
sort path, avoiding the explicit-log backend's whole-table JavaScript sort.
Compressed sort keys are streamed to temporary plain columns and removed afterward;
native sort receives an explicit working-set size. This trades RAM for temporary
disk space proportional to the selected sort columns. Valid cached sort results
avoid that decompression. Query-cache names include the folded log generation.
When necessary, the engine first folds acknowledged deltas and durably leaves
automatic log mode under the same writer lock, then performs the operation.
Transactions retain the existing journal, isolation and one-staged-mutation-per-
table contract. They do not append public, prematurely visible transaction frames.
Stable IDs are resolved across any compaction that shifts physical row numbers.
A future point operation can select the incremental path again. Workloads that
frequently alternate these paths can pay extra folding/transition costs.

Consequently, this change removes whole-column rewrites from eligible ordinary
point updates and deletes. It does not remove all rewrites from the database.
Segment-level compaction and incremental transaction/complex-field support remain
necessary to eliminate those costs universally.

## Recovery

There is no new binary format and no destructive conversion in this stage. A
process interrupted before marker publication retains the original base plus an
unused empty log. After publication it has a valid format-3 table and empty log.
Log append recovery retains complete valid frames, repairs torn tails before a
later append, and rejects corruption. Compaction retains the existing rollback/
roll-forward journal protocol; acknowledged mutations survive an interrupted fold.

The automatic marker survives compaction. Leaving automatic mode first completes
a durable compaction, then publishes a non-log marker. An interruption between
these steps leaves either a valid empty-log table or a valid materialized table.
Synchronization errors are propagated and are never acknowledged as successful
writes. An error after bytes were written may have an indeterminate outcome.

Tests include independent writers/readers, indexed key changes and uniqueness,
tombstones, compaction/reopen, transaction commit/rollback, schema changes,
oversized values, low-budget multi-table writes, SIGKILL during marker publication,
append, synchronization and partial compaction, and injected synchronization error.
SIGKILL tests are process-crash tests, not power-loss qualification.

The final replacement architecture and external restartable migration shell tool
requested earlier are separate unfinished work. No dummy migration is needed or
provided for this existing-format optimization.
