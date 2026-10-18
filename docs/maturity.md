# Reliability and release qualification

The target is a small embedded database with predictable memory, compact disk
storage, low CPU overhead, durable writes and fast NVMe access. Ease of use means
four table options (`decodeID`, `prepend`, `compression`, `cache`), automatic
internal maintenance, useful errors and observable behavior. Column storage is
not a requirement. PostgreSQL and SQLite are comparison engines, not replacement
dependencies for iniBase.

PostgreSQL-level confidence in supported behavior is a long-term engineering
target, not a claim established by passing tests or winning a benchmark. This
project does not currently have equivalent operational evidence. The scope is
iniBase's supported embedded API; broader SQL, network serving, replication and
high availability require separate designs and qualification if added.

## Required gates before replacing the runtime

| Gate | Evidence required | Current gap |
|---|---|---|
| Public behavior | Existing validation, uniqueness, relations, computed fields, ordering, prepend, projections, pagination and transactions pass against the replacement | Mutable byte-record kernel exists; public behavior is not integrated |
| Durable mutation | Acknowledged commits survive injected process crashes; append, sync and publication failures return correct errors | Mutable kernel has primary-ID COW batches and focused crash/sync checks; application indexes, full API and broader qualification remain unfinished |
| Transactions | Documented isolation and atomicity; rollback, partial failure, cross-table changes and concurrent conflicts qualified | Existing engine tests do not qualify a replacement |
| Corruption handling | Checksums, malformed lengths, stale generations, truncated/replaced logs, disk-full and I/O failures fail safely | Kernel checksums and crash tests cover only part of this |
| Maintenance | Sustained writes/deletes across repeated bounded compactions, active readers and generation reclamation | Mutable compaction and safe reclamation are unfinished |
| Resource bounds | Database-wide accounting for caches, temporary state, validation, decoding, handles and concurrent operations; enforceable limits where available | Current cache accounting does not cover the whole engine |
| Migration | Version-pinned external `.sh` conversion, validation, interrupted-run recovery, original retained and source writers excluded | Deliver after the replacement mutable format stabilizes |
| Backup/restore | Documented consistent backup boundary, validated restore and compatibility policy | Replacement tooling remains work |
| Operations | Integrity checking, useful diagnostics and bounded maintenance controls without extra table knobs | Needs integration with the replacement |
| Performance | Raw repeated iniBase/SQLite/PostgreSQL comparisons including durability, index construction, maintenance, errors, memory and disk | Public-engine baseline exists; replacement-runtime comparison remains work |
| Release confidence | Repeatable tests across supported Node/OS/filesystems, seeded randomized histories, long-running stress, documented remaining limits | Local macOS results alone are insufficient |

Process death is not a power-loss test. Actual power-loss qualification requires
an appropriate hardware/filesystem test setup, validated storage flush behavior,
and checks of every acknowledged commit after recovery. A passing local SIGKILL
suite must never be reported as that qualification.

## Comparison policy

Keep historical workloads and add labeled versions. Use equal application data
and comparable commit boundaries, retaining source/module hashes, drivers,
versions, configuration, raw samples, errors and test artifacts. Report costs
where they occur: index construction, connection setup, synchronization,
checkpoint/vacuum/compaction, recovery and migration. Count actual completed
operations rather than hiding maintenance from throughput.

PostgreSQL uses a persistent local Unix-domain connection and a fresh isolated
cluster with no TCP listener. Keep `fsync`, `synchronous_commit` and
`full_page_writes` enabled, and record the actual WAL synchronization method.
Its shared buffers, per-operation memory and background processes differ from
an embedded cache budget. They are recorded separately rather than described as
an equal total memory cap. SQLite uses WAL/FULL; iniBase uses full durability.

On Darwin, those historical default settings did not request equal drive-cache
flushing: Node/libuv requests F_FULLFSYNC, SQLite fullfsync was OFF and PostgreSQL
used open_datasync. New `--flush=write-through` comparisons explicitly request
SQLite fullfsync and PostgreSQL fsync_writethrough, preserving iniBase's sync.
See the [flush correction and mutable-kernel scope](mutable-row-storage.md).

Include complete PostgreSQL cluster/WAL footprint as well as relation/database
size and empty-cluster baseline. Include client and server processes; summed RSS
can count shared pages more than once and is not physical-memory usage. Keep
client CPU separate when server CPU cannot be completely accounted for. Node's
heap limit is not an RSS limit. Do not call reopen a cold-disk measurement.

The public-engine comparison and the immutable row-kernel experiment are different
workloads and must remain visibly separate. Explicit benchmark index construction
is not evidence that automatic indexing chose correctly. Automatic tuning needs
its own training, build-cost, eviction and sustained-workload measurements.

Cache/reservation accounting is currently per database within a process. Multiple
processes have separate allowances. Neither that accounting nor a configured
PostgreSQL shared-buffer size is a hard bound on total database-process memory.

## Next implementation priorities

1. Durable mutable row segments and bounded disk delta/secondary indexes.
2. Integrate existing API behavior and supported transaction semantics.
3. Bounded compaction, active-reader coordination and generation reclamation.
4. Whole-engine memory accounting and I/O failure qualification.
5. Automatic tuning, migration shell tooling, backup/restore and release stress.

Only measured improvements that pass the correctness gates should become defaults.
Do not promise universal speed advantages or reduce durability to obtain them.

References: [PostgreSQL WAL settings](https://www.postgresql.org/docs/18/runtime-config-wal.html),
[node-postgres query API](https://node-postgres.com/features/queries).
