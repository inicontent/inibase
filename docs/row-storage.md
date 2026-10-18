# Row-storage experiment

iniBase's requirements are disk-resident primary data and indexes, small bounded
engine working memory, compact storage, low CPU, fast NVMe access, simple embedded
operation, and durable, correct results. Column storage is not a requirement.
Validation, uniqueness, relations, transactions, cross-process coordination and
existing database readability remain requirements through any redesign.

`src/rowpack.ts` is an internal immutable **read-kernel experiment**, not a new
public backend or a migration tool. Normal iniBase operations still use the
existing backend. The experiment stores caller-encoded records together in a
stream of independently compressed 32 KiB pages, with an on-disk page directory
and an on-disk hash table mapping stable IDs directly to byte ranges. Sparse IDs
consume space proportional to record count instead of the highest ID. A point
read decompresses only pages intersecting that record, across all its fields.
Oversized records stream across pages; yielded buffers belong to the caller.

The experimental version-1 manifest names immutable generation files. Builders
sync all files and generation directory entries before publishing a synchronized
manifest by rename, then sync the directory. Open readers retain their generation.
Checksums cover manifest headers, ID slots, page descriptors and page contents.
Concurrent builders use the existing cross-process writer lock. Working-page
reservations share `DatabaseResources` with caches. There are no whole-table RAM
maps. This accounting does not qualify the whole existing engine's memory use.

Interrupted builds leave the previously published generation readable. SIGKILL
tests check before and after publication, and a subsequent writer can take the
dead process's lock. These are process-crash checks, not power-loss qualification.
Crash-left generations and older snapshots are intentionally retained: safe
reclamation across processes is **not implemented**. Repeated builds can therefore
grow disk use. The module is not exported as a package entry point and must not
be used for production data. No existing iniBase files are migrated by it.

The benchmark compares identical encoded JSON bytes and integer keys with SQLite
BLOB rows, under a single bulk commit. It isolates layout costs; it does not
compare full iniBase API behavior. It cannot establish DML or feature parity.

Before this layout can become the default, it needs:

1. A durable mutable log and disk delta indexes supporting existing transactions,
   key changes, uniqueness, deletes, relations and recovery without whole-table maps.
2. Segment-level compaction and generation reclamation with reader coordination,
   bounded temporary space and measured write amplification.
3. An end-to-end memory reservation protocol covering validation, decoding,
   concurrency, computed metadata and maintenance, separate from caller results.
4. Streaming scans/projections and application-key indexes over stable record
   locations, preserving current ordering, pagination and prepend semantics.
5. A versioned, restartable, opt-in-safe migration with rollback/recovery before
   any eventual automatic upgrade. Older processes must be excluded from upgrades.
6. Full API and crash qualification followed by workload comparisons that include
   index builds, synchronization, repeated compaction and recovery costs.

The selection between row pages, column blocks and a hybrid must follow measured
point-read, projection, write, memory and storage tradeoffs. A backend switch is
not justified by a read-kernel microbenchmark alone.
