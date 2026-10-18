# Mutable row-storage kernel, experimental version 2

`src/rowstore.ts` implements durable byte-record batches, stable numeric-ID
lookups, deletes and retained read snapshots. It is an **internal kernel**, not
the public iniBase backend, a format migration or a PostgreSQL-maturity claim.
The public API continues using its existing storage path. No additional table
options or production dependencies are introduced.

## Disk layout and atomicity

One UUID-named append file holds independently compressed value chunks and a
compressed radix-16 primary-ID tree. Both data and indexes live on disk. The
tree branches on four bits of the stable ID, compresses common prefixes and
uses at most fourteen branch levels plus one 192-byte leaf along a lookup path. It supports IDs from
zero through Number.MAX_SAFE_INTEGER without a highest-ID-sized sparse file.
Checksums cover index nodes, chunk descriptors, raw values and manifest JSON.
Pointer, size, traversal-depth and decompression bounds are validated.

Values stream through 32 KiB chunks, including values larger than the working
budget. An empty value is distinct from a missing/deleted ID through `has()`.
A tombstone changes the leaf and live-row count; it does not rewrite base data.
Repeated changes to the same ID in a batch have normal last-write-wins semantics.
This byte-layer kernel does not enforce schema/application-key uniqueness.

Each batch holds the existing cross-process writer lock. It truncates only bytes
after the previously published end, then appends values and replacement index
paths. Published bytes are immutable. Nodes created within the current batch
can be updated in place because no published snapshot can reach them. This
avoids retaining a fresh path for every insertion within a bulk transaction.

Version 2 starts the append region at 4 KiB and pads every committed end to a
4 KiB boundary. The next transaction never modifies a filesystem block containing
the previous committed prefix under this block-size assumption. Version 1 lacked
this separation; its process-crash samples are retained as intermediate evidence,
not a power-loss-safe format claim. The format-2 kernel rejects version 1 rather
than attempting an in-place upgrade. This changes only experimental files;
existing public iniBase databases are unaffected. Larger storage sectors/write
units and actual failure atomicity still require platform qualification.
Padding adds at most 4,095 bytes per transaction, including bulk batches.

Commit synchronizes the data/index append file, writes and synchronizes a
checksummed staged manifest, renames it over CURRENT.rowstore and synchronizes
the directory. Success is returned only afterward. Synchronization is not
disabled by the new kernel. The writer lock keeps its existing sync behavior.
The manifest names the generation, root, committed end, count and sequence.
There is no whole-log replay on ordinary reads or reopen.

A reader captures a manifest and uses only that immutable root and its bounded
end. A writer cannot expose half a batch through that snapshot. An interrupted
unpublished append is ignored and truncated on the next write. A published
truncation, generation mismatch or checksum failure is an error; it is not
silently treated as an uncommitted tail. Older snapshots stay readable after
new commits. A failed sync after rename can leave a visible new generation and
returns an error: callers must treat such a commit outcome as indeterminate.

## Resource accounting

Mutations reserve up to 512 KiB before allocating their workspace, capped at
the configured database allowance (256 KiB minimum). Decompression reserves 256 KiB.
That includes a 64 KiB append buffer, 32 KiB raw chunk, bounded reusable
compression output/native context allowance and bounded index path state.
A private dirty-page cache holds at most sixteen 4 KiB index pages, or four at
the smaller budget. It coalesces updates only to unpublished bytes and flushes
every dirty range before data synchronization. Reads of already flushed ranges
do not force unrelated pending append bytes out. This cache is covered by the
working reservation rather than an additional memory allowance.
The compressor keeps level 6 and uses a smaller window/memory setting at the
256 KiB budget, with a possible compression-ratio cost.
Inputs and yielded/materialized outputs belong to the caller. There are no
whole-table ID/value maps, retained background queues or engine value caches.
The shared resource manager bounds pooled **and fresh** descriptors, including
this kernel's lock, manifest, publication and directory handles. The existing
public backend still has allocations and file operations outside this protocol.

The working allowance is not a process RSS or complete JavaScript/native-allocation
proof. Runtime overhead, garbage collection, caller inputs/results and retained
snapshot objects still consume memory. The local Mac cannot qualify a hard
whole-process-group memory cap. Async input producers must not recursively call
operations requiring the same fully reserved resource budget; a general
reentrant streaming/transaction resource protocol remains integration work.

## Tests and remaining gates

Focused tests cover seeded histories, sparse/random/missing IDs, duplicate-ID
updates, deletion/resurrection/counts, compressed large entropy values, empty
values, failed streamed batches, unpublished tails, committed truncation, index
and value corruption, competing processes, paused publication readers, retained
snapshots, process death at publication boundaries, actual sync-call errors and
shared memory/descriptor limits across 24 tables. Hook failures and sync-call
failures are separate checks. SIGKILL is **not power-loss qualification**.

This is not a finished mutable replacement. It still needs:

- Streaming scans/projections, application-key indexes and integrity traversal.
- Existing validation, uniqueness, relations, computed fields, prepend/order and
  full API semantics, including atomic cross-table transactions.
- Bounded segment compaction, cross-process reader leases and safe reclamation.
- Exhaustive filesystem fault/disk-full handling and broader isolation/stress
  qualification across supported platforms.
- A finalized new-format runtime and the external restartable migration `.sh`
  tool, consistent backup and restore, and operational diagnostics.

No published history or old snapshot bytes are reclaimed yet. Repeated updates
therefore grow disk usage, and a never-compacted COW index has write amplification.
Per-record compression also loses cross-record compression opportunities. The
intended next experiment is to combine mutable deltas with compressed immutable
segments; measurements must justify that integration. Do not promote this kernel
to the default or promise a compact sustained-write database before those gates.

## Comparison policy and macOS flush correction

The additive `--scenario=rowstore` benchmark compares equal JSON byte records
through this kernel, SQLite BLOB rows and PostgreSQL BYTEA rows with primary-ID
indexes. It bypasses iniBase's public schema/relations layer and is not comparable
to the public six-column workload as a speedup ratio. Bulk batches contain at
most 1,000 rows; individual durable write cycles include a verifying point read.
Reopen verification streams every ID rather than materializing a full dataset.
There are no compactions in this stage; file growth must be reported, not hidden.

The earlier macOS suite used SQLite synchronous=FULL with fullfsync=OFF,
PostgreSQL's default open_datasync and Node FileHandle.sync. **These do not
request equal drive-cache flushing on Darwin.** libuv 1.52.1 requests
F_FULLFSYNC (with documented fallback) for Node sync; SQLite requires fullfsync
explicitly, and PostgreSQL offers fsync_writethrough. Earlier default-mode
samples remain historical, not evidence of equal physical-flush latency.

New runs with `--flush=write-through` turn SQLite fullfsync and
checkpoint_fullfsync ON, select PostgreSQL fsync_writethrough on Darwin (fsync
elsewhere) and leave iniBase sync unchanged. Actual settings are retained.
These requests still do not qualify hardware power-loss behavior or prove that
every system/storage layer honors flush requests.

References: [libuv 1.52.1 synchronization source](https://raw.githubusercontent.com/libuv/libuv/v1.52.1/src/unix/fs.c),
[SQLite fullfsync](https://www.sqlite.org/pragma.html#pragma_fullfsync),
[PostgreSQL WAL synchronization](https://www.postgresql.org/docs/18/runtime-config-wal.html#GUC-WAL-SYNC-METHOD).
