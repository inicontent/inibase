import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2]);
const load = async (name) =>
	JSON.parse(await readFile(join(root, name), "utf8"));
const initial = await load("kernel-write-through/summary.json");
const buffered = await load("kernel-qualified/summary.json");
const aligned = await load("kernel-aligned/summary.json");
const qualified = await load("kernel-final/summary.json");
const publicAPI = await load("public-write-through/summary.json");
const checks = await readFile(join(root, "generation-full-checks.log"), "utf8");
const correctness = {
	tests: [...checks.matchAll(/ℹ tests (\d+)/g)].reduce(
		(sum, match) => sum + Number(match[1]),
		0,
	),
	failed: [...checks.matchAll(/ℹ fail (\d+)/g)].reduce(
		(sum, match) => sum + Number(match[1]),
		0,
	),
	completed: checks.includes('"files":24,"failedFiles":0'),
};
if (!correctness.completed || correctness.failed)
	throw new Error("Correctness suite incomplete or failed");
const f = (n) => n.toFixed(3),
	mib = (n) => (n / 1048576).toFixed(2);
const kernel = qualified.summaries.filter(
	(group) => group.engine === "inibase",
);
const wins = [];
for (const group of kernel) {
	for (const competitor of ["sqlite", "postgres"]) {
		const other = qualified.summaries.find(
			(item) =>
				item.engine === competitor &&
				item.profile === group.profile &&
				item.rows === group.rows,
		);
		for (const metric of [
			"bulkInsert",
			"randomID",
			"sequentialID",
			"hotID",
			"missingID",
			"durableInsert",
			"durableUpdate",
			"durableDelete",
		]) {
			const ours =
				metric === "bulkInsert"
					? group.phases[metric]
					: group.latency[metric].p50;
			const theirs =
				metric === "bulkInsert"
					? other.phases[metric]
					: other.latency[metric].p50;
			if (ours < theirs)
				wins.push({
					profile: group.profile,
					rows: group.rows,
					competitor,
					metric,
					oursMs: ours,
					theirsMs: theirs,
				});
		}
	}
}
const audit = {
	initial: initial.audit,
	buffered: buffered.audit,
	aligned: aligned.audit,
	qualified: qualified.audit,
	publicAPI: publicAPI.audit,
	correctness,
	measuredKernelSpeedWins: wins,
	qualification:
		"Internal byte-record kernel and public API are separate workloads; no feature-equivalent speedup ratio or power-loss/total-memory qualification.",
};
await writeFile(
	join(root, "audit.json"),
	`${JSON.stringify(audit, null, 2)}\n`,
);
const lines = [
	"# Durable mutable storage: implementation and measured tradeoffs",
	"",
	"This stage adds an internal mutable byte-record kernel with durable insert/update/delete batches, a disk COW primary-ID index and retained snapshots. It does not switch the public API to that backend. Application-key indexes, full API semantics/cross-table transactions, bounded compaction/reclamation and the final migration shell tool are still unfinished. No production database is converted.",
	"",
	`The five primary matrices retain ${initial.audit.trials + buffered.audit.trials + aligned.audit.trials + qualified.audit.trials + publicAPI.audit.trials} trials. Verified counts: initial ${initial.audit.verified}/${initial.audit.trials}, buffered ${buffered.audit.verified}/${buffered.audit.trials}, aligned ${aligned.audit.verified}/${aligned.audit.trials}, final ${qualified.audit.verified}/${qualified.audit.trials}, public ${publicAPI.audit.verified}/${publicAPI.audit.trials}. Failures and operation/sampling errors are retained in audit.json and raw files.`,
	"",
	"## Implementation and correctness",
	"",
	"Local commits 7118203 and 022bfcc add the kernel, bounded fresh/pooled handles, cleanup after lock-initialization sync failure, a bounded dirty-page buffer and reused compression state. Commit 1ddd7c4 versions the experimental format to 2 and aligns initial/committed ends to 4 KiB so the next transaction does not share the previous committed block under that assumption. Padding costs up to 4,095 bytes per batch; larger write units and actual failure atomicity remain platform-qualification work. Published bytes stay immutable; unpublished index nodes can be coalesced within a batch. A synchronized root manifest publishes the entire batch after data/index synchronization. Commit 27aa999 checks exact descriptor/path identity before fresh reads and writes and validates reopened snapshot descriptors. The replacement regression fails on its saved pre-fix source. No durability or locking setting is weakened.",
	"",
	"The complete suite passes 466 tests across 24 files. Eighteen focused kernel tests cover sparse/random IDs and every radix depth, uncompressed/large entropy/empty values, repeated mutations/tombstones/counts, failed streamed batches, tail repair, committed corruption/truncation, competing writer processes, readers paused across publication, retained snapshots, SIGKILL boundaries, actual sync-call EIO failures, preserved block prefixes, rejection of the earlier experimental format, and replaced paths with stale pooled descriptors. Twenty-four tables share a 256 KiB allowance and four-descriptor limit in a focused test. This is process-crash/fault-injection evidence, not actual power-loss qualification or exhaustive isolation/error qualification.",
	"",
	"## Corrected synchronization comparison",
	"",
	"Earlier macOS runs used SQLite WAL/FULL with fullfsync OFF and PostgreSQL open_datasync, while Node/libuv requests F_FULLFSYNC. Those samples remain historical platform defaults; their write ratios did not represent equal requested drive-cache flushing. All primary matrices in this report use --flush=write-through: SQLite fullfsync/checkpoint_fullfsync ON; PostgreSQL fsync_writethrough with fsync/synchronous_commit/full_page_writes ON; iniBase retains its existing sync calls. Actual settings are in raw trials. Hardware flush behavior is not power-loss-qualified.",
	"",
	"See [the design and source references](../../../docs/mutable-row-storage.md) and [the earlier report correction](../postgres-20261018/REPORT.md).",
	"",
	"## Mutable kernel before and after bounded buffering",
	"",
	"Datasets are short compact JSON, repetitive CMS HTML and entropy strings containing twenty SHA-256 hex digests. Entropy strings are not incompressible binary; large random binary values are tested for correctness only. Compression/storage conclusions apply to these particular datasets and settings.",
	"",
	"Equal JSON bytes and primary IDs are stored by iniBase's internal kernel, SQLite BLOB and PostgreSQL BYTEA. This bypasses the public schema/relations layer. Bulk batches have at most 1,000 rows. Three trials per case rotate engine order and use fresh directories. Initial version-1, intermediate buffered-version-1, aligned-version-2 and final generation-validated-version-2 matrices ran in separate epochs on the same host; cache conditions are OS-affected, not cold disk. The table compares initial version 1 with final version 2, including padding overhead. Intermediate version-1 and pre-generation-check version-2 results remain separate. Individual write cycles include a verifying point read. Reopen is a lazy constructor for iniBase; complete verification afterward checks every ID. Do not claim a recovery/reopen latency win from constructor time.",
	"",
	"| 100k dataset | Initial kernel bulk ms | Qualified kernel bulk ms | Improvement | SQLite bulk ms | PostgreSQL bulk ms | Initial/qualified worker peak MiB |",
	"|---|---:|---:|---:|---:|---:|---:|",
];
for (const profile of ["compact", "cms", "entropy"]) {
	const get = (data, engine) =>
		data.summaries.find(
			(group) =>
				group.profile === profile &&
				group.rows === 100000 &&
				group.engine === engine,
		);
	const before = get(initial, "inibase"),
		after = get(qualified, "inibase");
	lines.push(
		`| ${profile} | ${f(before.phases.bulkInsert)} | ${f(after.phases.bulkInsert)} | ${(before.phases.bulkInsert / after.phases.bulkInsert).toFixed(2)}× | ${f(get(qualified, "sqlite").phases.bulkInsert)} | ${f(get(qualified, "postgres").phases.bulkInsert)} | ${mib(before.peakWorkerRss)} / ${mib(after.peakWorkerRss)} |`,
	);
}
lines.push(
	"",
	"| 100k dataset | Engine | Random-ID cycle p50 ms | Update cycle p50 ms | Delete cycle p50 ms | Allocated MiB |",
	"|---|---|---:|---:|---:|---:|",
);
for (const group of qualified.summaries.filter((item) => item.rows === 100000))
	lines.push(
		`| ${group.profile} | ${group.engine} | ${f(group.latency.randomID.p50)} | ${f(group.latency.durableUpdate.p50)} | ${f(group.latency.durableDelete.p50)} | ${mib(group.allocated)} |`,
	);
lines.push(
	"",
	`Measured lower kernel medians versus either competitor across bulk and seven point/write-cycle metrics at all nine dataset/size cases: **${wins.length}**. ${wins.length ? "Individual cases are listed in audit.json; small differences do not establish robust superiority." : "SQLite and PostgreSQL remain faster on all those measured metrics."}`,
	"",
	"Compression reduces CMS/entropy file size relative to SQLite in these configurations; compact values lose because per-record compression and COW index metadata cost space. PostgreSQL allocated sizes include its complete fresh cluster and WAL, not just the application table; its empty-cluster footprint is retained in resources JSON. Do not attribute the whole difference to data compression.",
	"",
	"The mutable kernel removes table-sized mutation work, but its four synchronization stages (including lock initialization and manifest/directory publication) dominate individual write latency. Raw commit traces separate append/lock time, data sync, manifest sync, publication and return. Bounded page coalescing and reused compression improve bulk CPU/I/O without changing publication ordering.",
	"",
	"## Public API comparison with corrected flush requests",
	"",
	"This is the existing public column backend, not the mutable kernel. It preserves validation, application-key indexes, projections/filtering, rollback and mixed maintenance workloads. It uses the historical six-field workload with an additive explicit flush setting. Index construction is explicit, not automatic-tuning evidence. Do not turn the next table into a kernel/public speedup ratio.",
	"",
	"| 100k dataset | Engine | Bulk ms | Indexed random key p50 ms | Durable update p50 ms | Durable delete p50 ms | Mixed incl. maintenance ms | Allocated MiB |",
	"|---|---|---:|---:|---:|---:|---:|---:|",
);
for (const group of publicAPI.summaries.filter((item) => item.rows === 100000))
	lines.push(
		`| ${group.profile} | ${group.engine} | ${f(group.phases.bulkInsert)} | ${f(group.latency.randomIndexedKey.p50)} | ${f(group.latency.individualDurableUpdate.p50)} | ${f(group.latency.individualDurableDelete.p50)} | ${f(group.phases.mixedIncludingMaintenance)} | ${mib(group.allocated)} |`,
	);
lines.push(
	"",
	"Full 1k/10k/100k, compact/CMS/entropy tables and p95/raw samples are in [kernel measurements](kernel-final/MEASUREMENTS.md) and [public measurements](public-write-through/MEASUREMENTS.md). These are short workloads. The public backend still rewrites base columns; compact() can be a no-op, with rewrite costs paid in the mutations. The mutable kernel does not compact at all, so its short-cycle throughput is not sustained compacting throughput.",
	"",
	"## Memory, storage and remaining priorities",
	"",
	"The kernel reserves up to 512 KiB per active mutation, capped at the configured database allowance (256 KiB minimum). Its temporary index-page buffer uses at most 64 KiB (16 KiB at that minimum), inside the reservation. All primary data/indexes stay on disk. These are internal reservations, not total RSS bounds. The public backend, pending-request/snapshot bookkeeping, runtime/GC/native overhead and caller inputs/results are not fully qualified by this accounting. Kernel reopen verification streams results, whereas the public suite materializes full results; their RSS peaks are not equivalent API workloads. Linux hard-limit enforcement remains unqualified on this Mac.",
	"",
	"Old nodes, values, tombstones and reader snapshots are retained. Updates append bounded record/path data but repeated mutation grows disk use. Per-record compression loses cross-record compression opportunities. The current whole-table mutable layout is unsuitable as a drop-in replacement for the existing bulk/projection path. Next integrate the measured immutable compressed segments with mutable deltas, implement application-key indexes and supported transactions, then bounded compaction/reader-safe reclamation. Only a fully verified backend should replace the public engine. The final format and external restartable migration .sh remain unfinished.",
	"",
	"RSS and disk peaks are sampled and can miss short events. Temporary counters classify .tmp/pgsql_tmp; root-level staged manifests count toward total footprint but not that temporary counter. No exact temporary-disk maximum is qualified. Client CPU omits PostgreSQL server CPU; available zero OS I/O counters do not imply zero physical I/O.",
	"",
	"## Provenance and reproduction",
	"",
	"Primary source snapshots: candidate-source.tar.gz (initial mutable matrix, f8ee6f5 plus the 14 original local edits), qualified-source.tar.gz (buffered version 1 and the unchanged public backend, 022bfcc plus those edits), aligned-source.tar.gz (initial version 2, 1ddd7c4 plus those edits), and final-source.tar.gz (generation-validated version 2, 27aa999 plus those edits). The public backend does not import the experimental kernel. Compiled JavaScript and benchmark tool hashes are in every environment.json. tooling.tar.gz pins the measured worker/runner sources; report-tooling.tar.gz pins later report tools. Earlier smoke/profile runs are diagnostic only and are not pooled with the primary matrices. All raw samples, logs and failures remain in this tree. artifact-reproduction.json verifies reconstructed builds and worker/runner hashes, and retains the expected pre-fix stale-lock and generation-replacement assertion failures.",
	"",
	"```sh",
	"node node_modules/typescript/bin/tsc",
	"node benchmark/qualification/postgres/run.mjs --scenario=rowstore --flush=write-through --rows=1000,10000,100000 --profiles=compact,cms,entropy --repeats=3 --samples=32 --writes=8 --output=/private/tmp/inibase-kernel-fresh",
	"node benchmark/qualification/postgres/rowstore-report.mjs /private/tmp/inibase-kernel-fresh",
	"node benchmark/qualification/postgres/run.mjs --scenario=standard --flush=write-through --rows=1000,10000,100000 --profiles=compact,cms,entropy --repeats=3 --samples=32 --writes=8 --mixedRounds=3 --output=/private/tmp/inibase-public-fresh",
	"node benchmark/qualification/postgres/report.mjs /private/tmp/inibase-public-fresh",
	"node benchmark/qualification/checks.mjs",
	"```",
	"",
	"Run from the repository root with Node 26.9.0, installed root dependencies, benchmark-only pg 8.16.3 and local PostgreSQL 18.6. The default binary directory is /opt/homebrew/opt/postgresql@18/bin; supply --pgBin elsewhere. Output parents must exist and output directories must be fresh. See benchmark/qualification/postgres/README.md for dependency setup, archive reconstruction, platform/resource caveats and isolation. No server service is enabled and no TCP listener is used. No push, publish or deploy is performed.",
	"",
);
await writeFile(join(root, "REPORT.md"), lines.join("\n"));
console.log({
	totalPrimaryTrials:
		initial.audit.trials +
		buffered.audit.trials +
		aligned.audit.trials +
		qualified.audit.trials +
		publicAPI.audit.trials,
	kernelSpeedWins: wins.length,
});
