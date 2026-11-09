# October 18: bounded row construction

This stage improves the experimental immutable row-storage kernel and removes a
redundant allocation in the public engine's disk-key-index builder. The public
engine still uses its existing backend. These measurements do not establish
replacement-runtime feature parity or complete the requested redesign.

## Changes and source identity

- `e0dcbbb`: reuse the disk-key-index bucket initialization buffer. At 100,000
  indexed rows this removes one 1 MiB allocation; file contents and publication
  behavior are unchanged. Allocation diagnostics are separate from throughput runs.
- `56fb976`: spool row ID locations sequentially, partition on disk, and construct
  the same disk hash format using a reusable 128 KiB workspace. Reuse one bounded
  raw-deflate context, producing independently decodable standard gzip pages.
  Validate spool length, checksums and entry counts before durable publication.
- Add cross-process publication, collision/wraparound, corrupted-spool and
  additional SIGKILL checks. No synchronization or locking was removed.

Baseline is `13d127d`, the preceding row-kernel implementation. Exact full commits
are in `baseline-commit.txt` and `candidate-commit.txt`. Source archives include
the pre-existing working-tree edits without adding those edits to our commits.
`artifact-reproduction.json` confirms that both archives rebuild to every compiled
module hash used by the final benchmarks. `preexisting-verification.json` verifies
that the original 14 edited files retain their original changes.

## Results

Equal encoded JSON records and integer keys, one durable bulk publication, three
rotated trials per case, fresh directories. SQLite uses BLOB rows, WAL/FULL, and
the same configured page-cache allowance. Compression is performed by the row
kernel; SQLite does not compress these BLOBs. Bulk timings include fixture encoding
and index construction. SQLite checkpoint/close is recorded separately.

| 100k records, 1 MiB budget | Previous kernel bulk ms | New kernel bulk ms | SQLite bulk ms | Previous/new peak RSS MiB | New/SQLite allocated MiB |
|---|---:|---:|---:|---:|---:|
| Compact | 2235 | 416 | 108 | 88 / 86 | 12.62 / 11.47 |
| Repetitive CMS | 2617 | 719 | 748 | 161 / 88 | 14.08 / 195.80 |
| SHA-256 hex text | 7676 | 2054 | 1278 | 176 / 92 | 88.71 / 208.06 |

Bulk construction improves 3.6–5.4 times at 100k rows relative to the previous
kernel. CMS and entropy peak RSS fall about 45–48%; compact RSS barely changes.
RSS is the largest observed worker/sampled RSS across the three trials. Bulk and
disk columns are medians. These are complete process measurements, including Node.

The 100k CMS bulk median is 4% below SQLite, but trial ranges overlap:
candidate 710–791 ms, SQLite 722–750 ms. This is insufficient evidence of a robust
speed advantage. SQLite wins all other bulk cases and every point-read case.
CMS read p95 regresses from 0.116 to 0.138 ms even though its median improves.
Compression substantially reduces CMS/entropy disk footprint; compact records
remain larger than SQLite. No universal superiority is claimed.

At the 256 KiB minimum budget, new CMS bulk time is 857 ms versus SQLite 733 ms;
entropy is 3323 versus 1293 ms. The smaller compression workspace increases CPU
cost. Both kernels remain within their reported cache/reservation allowances.
Neither allowance bounds total RSS or the whole public engine's memory use.

See [MEASUREMENTS.md](MEASUREMENTS.md) for all 1k/10k/100k cases, pooled read p50/p95,
CPU, allocated disk, sampled temporary peaks and index I/O. Each read cell pools
384 random samples; p99 is deliberately omitted. Raw latency, missing-read,
reopen, phase-memory and resource samples remain in the run directories.

## Tradeoffs and limitations

At 100k rows, index construction issues 1408 buffered reads and 1310 writes,
requesting about 35.5/32.4 MiB. The old loop performed approximately 100k tiny
reads and writes of 32 bytes each. Extra sequential I/O and a 3.05 MiB spool buy
fewer small random operations and promises. These counters are logical requests,
not physical device I/O. Auxiliary live payload is bounded by roughly three times
the spool size plus filesystem metadata. Sampled temporary peaks are 2.9–4.9 MiB
in the main 100k cases and may miss short-lived files.

The kernel still lacks mutable transactions, application-key indexes, segment
compaction and safe cross-process generation reclamation. Retaining old and
crash-left generations means repeated publication grows disk use. The public
engine's existing delete/rewrite costs and broader memory gaps are not fixed by
this stage. Production durability, validation and public features remain on the
existing backend; the experimental module is not a package entry point.

Final replacement-runtime integration must preserve all those features before
switching formats. Legacy code will live in the separate version-pinned migration
tool, with the requested `.sh` entry point. That tool has not been delivered in
this construction-only stage because the replacement mutable format is unfinished.
It must safely stage, verify, synchronize and publish migrated databases, retaining
the original and recovering interrupted conversion. No existing user data was
migrated by this work.

## Verification and environment

The pre-edit suite passed 440 tests. The final suite passes 445 tests in 22 files;
all 13 row-kernel tests also pass with the minimum 256 KiB budget. Results
are retained in `final-checks.log` and `final-row-process-small.log`. Coverage includes multiple process builders with an
active reader, retained old snapshots, shuffled sparse IDs, collision chains,
oversized values, compressed/uncompressed pages, corrupt private spools and
SIGKILL around construction, synchronization and publication. SIGKILL tests qualify
process-crash behavior, not actual power-loss durability.

Final benchmark matrices verify 99/99 trials with zero operation failures or
sampler errors: 81 main trials and 18 minimum-budget trials. Earlier discovery
runs remain separate; `paired-row` retains three benign disappearing-path sampler
races predating the final sampler fix. No raw failures were silently discarded.

Apple M5, 10 cores, 16 GiB RAM; Apple NVMe/APFS; Darwin 27.0.0; Node 26.9.0,
SQLite 3.53.4, TypeScript 5.9.3, tsx 4.22.4. Per-run `environment.json` records
runtime components, module hashes, CPU, RAM, options and benchmark-tool hash.
Dependencies are unchanged from the preceding qualification stage. No OS cache
eviction was performed: reopen means reopening under the existing filesystem
cache. V8's 256 MiB heap cap is not an enforced RSS limit. Temporary space is
sampled; Darwin's resource I/O counters do not establish actual device traffic.

`measured-tooling.tar.gz` preserves the benchmark source matching recorded tool
hashes, before a final import-order formatting pass. Exact reproduction commands are in
[the qualification README](../../qualification/README.md#row-construction-stage).
