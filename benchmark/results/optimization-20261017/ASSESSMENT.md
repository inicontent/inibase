# Starting implementation assessment

Starting HEAD: `dd3ed9d72b13daa260e88b6f00327761eb52543d`, with pre-existing
working-tree edits saved in `preexisting.patch`. `baseline.sha256` records source
and dependency-lock hashes. Baseline compilation was frozen before editing under
`/private/tmp/inibase-baseline-20261017/dist`. Matrix environment JSON records every
compiled JavaScript module hash. The baseline is not a clean HEAD checkout.

No AGENTS.md was found in the repository or its ancestor paths. The starting
repository already documented experimental storage acceleration and incomplete
memory/compaction qualification in `docs/storage-acceleration.md`.

| Suspected bottleneck | Finding at baseline |
|---|---|
| Application-key column scan | Opt-in disk key indexes already existed; unindexed predicates and unsupported index shapes still scan. Changed-key overlay candidates enumerate scratch entries. |
| Sequential sparse decompression | Seekable independent gzip members and on-disk block directories already existed for optimized tables; legacy/stale-accelerator fallback still scans. Tests cover 64/128/256 KiB, large UTF-8 values, transactions and stale metadata. |
| Entire-log replay on each append | Already replaced by validated generation/identity/offset incremental replay; 30 append/refresh test consumes exactly 30 frames. Replacements, truncation and torn tails rebuild. |
| Whole-table ID maps for points | Point overrides request only selected line IDs. Disk-overlay sparse directories avoid a table-sized resident map. Bulk selections can still allocate large arrays/maps. |
| Delete forces compaction | Format-3 tombstones already append durably. Legacy format-2 deletes retain structural rewrite behavior. Automatic thresholds and explicit maintenance still compact whole affected columns. |
| Repeated scratch I/O | Verified: each set opened/closed the directory and invalidated its page; enumeration decoded every historical value, including overwritten ones. Addressed in this change. |

The first profiling run captured file opens/closes, reads/writes/stat, synchronization,
compression/decompression and subprocess calls, plus a CPU profile. Its timings
were exploratory (other baseline checks were running); operation counts remain
useful diagnostics. It recorded 6,308 fs.open, 6,379 handle.close, 12,337 fs.stat,
561 handle.sync and 85 gunzipSync calls in the 1k compact workload. It also recorded two exec and two execFile wrapper calls; these wrappers can overlap and must not be summed as distinct process launches.
Sync elapsed time includes asynchronous waiting and is not CPU attribution.
Lock/replay/compaction are represented in CPU stacks and workload phases rather
than separately exhaustive lock-wait counters. Do not claim complete attribution.

Baseline main suite: 411 passes, zero failures via `node --import tsx`.
The literal `pnpm test` attempt failed before tests because tsx's IPC socket was
blocked by the sandbox; its failure is retained in `baseline-tests.log`.
The original historical benchmark and populated-overlay benchmark were run before
editing; exploratory timing overlap is explicitly retained, not used as isolated
before/after evidence.

The isolated matrix uses sequential workers, fresh directories, rotated engine
order and three trials for each compact/CMS/high-entropy dataset at 1k/10k/100k.
Both iniBase variants have identical acceleration configuration. The first attempt
(`comparison`) was stopped because its ps sampler was denied. Its partial results
remain. The replacement `measured-comparison` runs with process-tree sampling.

The final recovery-fixed package/process/journal check run passed 427 tests in
20 files. `cursor-before.log` records the expected failure of the baseline fault
reproducer; `cursor-after.log` records the recovery-fixed success. The diagnostic
failure is not discarded or counted as a successful baseline recovery case.

A metadata concurrency experiment was measured over three rotated trials and
rejected: random/hot lookup changes were inconsistent. Its code was removed;
its results remain in `metadata-experiment/`. The final compiled tree is checked
against the final matrix environment hashes after rebuilding.

The initial version-1 concurrent smoke fixture had trailing spaces and failed its
strict body assertion because existing string validation calls trim(). Version 2
uses identical normalized input for all engines. Failed samples and matching-hash
runner source are preserved under concurrent-smoke/; normalized smoke and the full
nine-trial concurrent matrix passed. No validation behavior was changed.
