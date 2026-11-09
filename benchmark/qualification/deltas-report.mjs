import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2]);
const read = async (p) => JSON.parse(await readFile(p, "utf8"));
const previous = await Promise.all(
	["after", "after-small"].map((name) =>
		read(`benchmark/results/public-chunks-20261018/${name}/summary.json`),
	),
);
const before = previous.flatMap((m) => m.summaries);
const initial = await read(join(root, "comparison/summary.json")),
	after = await read(join(root, "qualified/summary.json")),
	stress = await read(join(root, "stress/summary.json"));
for (const matrix of [...previous, initial, after, stress]) {
	assert.equal(matrix.metadata.flush, "write-through");
	assert.equal(matrix.audit.trials, matrix.audit.verified);
	for (const name of ["failures", "samplerErrors", "operationErrors"])
		assert.equal(matrix.audit[name].length, 0);
}
const comparisons = [];
for (const current of after.summaries.filter((s) => s.engine === "inibase")) {
	const old = before.find(
		(s) =>
			s.engine === "inibase" &&
			s.profile === current.profile &&
			s.rows === current.rows,
	);
	const peer = (engine) =>
		after.summaries.find(
			(s) =>
				s.engine === engine &&
				s.profile === current.profile &&
				s.rows === current.rows,
		);
	comparisons.push({
		profile: current.profile,
		rows: current.rows,
		before: old,
		after: current,
		sqlite: peer("sqlite"),
		postgres: peer("postgres"),
		updateSpeedup:
			old.latency.individualDurableUpdate.p50 /
			current.latency.individualDurableUpdate.p50,
		deleteSpeedup:
			old.latency.individualDurableDelete.p50 /
			current.latency.individualDurableDelete.p50,
		mixedSpeedup:
			old.phases.mixedIncludingMaintenance /
			current.phases.mixedIncludingMaintenance,
	});
}
const wins = [];
let candidates = 0;
for (const c of comparisons)
	for (const engine of ["sqlite", "postgres"]) {
		for (const key of [
			"bulkInsert",
			"explicitIndexBuild",
			"fullRead",
			"projection",
			"nonIndexedFilter",
			"individualDurableInsert",
			"individualDurableUpdate",
			"individualDurableDelete",
			"mixedIncludingMaintenance",
		]) {
			candidates++;
			if (c.after.phases[key] < c[engine].phases[key])
				wins.push({
					profile: c.profile,
					rows: c.rows,
					engine,
					metric: key,
					ini: c.after.phases[key],
					peer: c[engine].phases[key],
				});
		}
		for (const key of [
			"randomIndexedKey",
			"sequentialIndexedKey",
			"hotIndexedKey",
			"missingIndexedKey",
			"afterUpdateRead",
			"afterDeleteRead",
		]) {
			candidates++;
			if (c.after.latency[key].p50 < c[engine].latency[key].p50)
				wins.push({
					profile: c.profile,
					rows: c.rows,
					engine,
					metric: key,
					ini: c.after.latency[key].p50,
					peer: c[engine].latency[key].p50,
				});
		}
	}
const scenarios = await read(join(root, "SCENARIOS.json"));
for (const scenario of scenarios) {
	assert.equal(scenario.failures.length, 0);
	for (const s of scenario.summary) {
		assert.equal(s.trials, s.verified);
		assert.equal(s.operationErrors.length, 0);
		assert.equal(s.samplerErrors.length, 0);
	}
}
const checks = await readFile(
	join(root, "final-qualification-checks.log"),
	"utf8",
);
assert.ok(checks.includes('"failedFiles":0'));
const testCount = [...checks.matchAll(/ℹ tests (\d+)/g)].reduce(
	(n, m) => n + Number(m[1]),
	0,
);
const audit = {
	implementation: "0c7db4d and 3d4c67e plus preserved original edits",
	tests: testCount,
	initial: initial.audit,
	qualified: after.audit,
	stress: stress.audit,
	scenarios,
	comparisons,
	speedComparisons: { candidates, wins },
};
await writeFile(
	join(root, "audit.json"),
	`${JSON.stringify(audit, null, 2)}\n`,
);
const ms = (n) => n.toFixed(2),
	sec = (n) => (n / 1000).toFixed(2),
	mib = (n) => (n / 1048576).toFixed(2);
const lines = [
	"# Automatic durable deltas: public API qualification",
	"",
	"Ordinary eligible point updates append checksummed durable frames; deletes append tombstones. They do not replace base columns or their indexes. Selection, validation, uniqueness and merged reads remain on the public API. Local implementation: 0c7db4d and 3d4c67e plus the original fourteen preserved local edits. No table options were added: decodeID, prepend, compression and cache remain the public configuration.",
	"",
	"This removes per-operation rewrites for append-layout, simple non-computed tables with at least 128 physical rows, small payloads and at most 256 selected rows. It does not remove every rewrite: transactions, schema changes, nested/related/computed schemas, prepend, broad or oversized changes retain supported materialized paths. Automatic compaction and explicit maintenance still rewrite affected columns (all columns when removing tombstones). Whole-engine RAM qualification and segment-level bounded-I/O compaction remain unfinished. See docs/automatic-deltas.md for exact policy and recovery.",
	"",
	`Final verification: ${testCount} tests passed across 26 files. Final standard matrix: ${after.audit.verified}/${after.audit.trials}; forced-maintenance stress: ${stress.audit.verified}/${stress.audit.trials}; concurrent/recovery results are in SCENARIOS.json. All primary comparisons have zero recorded operation, setup and sampler errors. An earlier full-suite attempt and initial 81-trial development matrix are retained and not pooled with the final build.`,
	"",
	"## Point writes at 100,000 records",
	"",
	"P50 pools 24 durable operations (8 × 3 trials); activation costs are included, not discarded. P95 is available in raw summaries; sample counts do not support p99. Previous version is the measured public chunked-rewrite build d80ca74, not an internal byte-record kernel.",
	"",
	"| Dataset | Update before → after ms | Update speedup | Delete before → after ms | Delete speedup | SQLite update / delete ms | PostgreSQL update / delete ms |",
	"|---|---:|---:|---:|---:|---:|---:|",
];
for (const c of comparisons.filter((c) => c.rows === 100000))
	lines.push(
		`| ${c.profile} | ${ms(c.before.latency.individualDurableUpdate.p50)} → ${ms(c.after.latency.individualDurableUpdate.p50)} | ${c.updateSpeedup.toFixed(1)}× | ${ms(c.before.latency.individualDurableDelete.p50)} → ${ms(c.after.latency.individualDurableDelete.p50)} | ${c.deleteSpeedup.toFixed(1)}× | ${ms(c.sqlite.latency.individualDurableUpdate.p50)} / ${ms(c.sqlite.latency.individualDurableDelete.p50)} | ${ms(c.postgres.latency.individualDurableUpdate.p50)} / ${ms(c.postgres.latency.individualDurableDelete.p50)} |`,
	);
lines.push(
	"",
	"Separate instrumented public-update profiles show 16 synchronization calls and 26 opens before, versus 2 synchronization calls and 7 opens for steady-state delta writes. The first activation used 7 synchronization calls and remains included in benchmark samples. Synchronization was not disabled: unchanged primary/index files need no replacement publication; each append still waits for durable log synchronization. These counters/CPU profiles are diagnostic and not pooled with the uninstrumented trials.",
	"",
	"## Maintenance-inclusive comparisons",
	"",
	"Mixed time includes updates, read verification, deletes and three real compaction calls. This configuration now has pending frames/tombstones, so iniBase compact() performs work rather than being a no-op. Transaction rollback also first folds prior deltas and is reported separately in raw phases. These short cycles do not establish endurance or PostgreSQL maturity.",
	"",
	"| Dataset | Rows | Mixed before → after seconds | Speedup | SQLite / PostgreSQL seconds | Update / delete after p50 ms |",
	"|---|---:|---:|---:|---:|---:|",
);
for (const c of comparisons.sort(
	(a, b) => a.rows - b.rows || a.profile.localeCompare(b.profile),
))
	lines.push(
		`| ${c.profile} | ${c.rows} | ${sec(c.before.phases.mixedIncludingMaintenance)} → ${sec(c.after.phases.mixedIncludingMaintenance)} | ${c.mixedSpeedup.toFixed(2)}× | ${sec(c.sqlite.phases.mixedIncludingMaintenance)} / ${sec(c.postgres.phases.mixedIncludingMaintenance)} | ${ms(c.after.latency.individualDurableUpdate.p50)} / ${ms(c.after.latency.individualDurableDelete.p50)} |`,
	);
lines.push(
	"",
	"The separate stress matrix uses 10k CMS rows, 80 writes, 80 lookup samples, eight mixed rounds, three trials and INIBASE_MAX_OVERLAY_RECORDS=64. The lower deployment limit forces automatic folds within the workload as well as explicit maintenance. The complete cost remains in operation and mixed timings; it is not subtracted. PostgreSQL and SQLite receive identical application data/operations and full durability. See stress/MEASUREMENTS.md and stress-configuration.json. This is a short stress run, not long-duration endurance.",
	"",
	"## Memory and storage",
	"",
	"Automatic point working reservations share the database allowance, including caches/overlays across all tables. Payload estimates and merged per-row overlays are bounded conservatively; accumulation is capped at 2,048 IDs / 8 MiB before the next write folds (deployment limits can lower these). A small-budget test exercises twelve tables, parallel updates/deletes, sorted reads and four pooled descriptors with a 256 KiB resource allowance. This is not a 256 KiB process-RSS result. Inherited engine paths, native buffers, metadata, caller results and runtime/GC are not all qualified by this accounting.",
	"",
	"| Dataset | Worker peak before / after MiB | iniBase allocated before / after MiB | SQLite / PG allocated MiB |",
	"|---|---:|---:|---:|",
);
for (const c of comparisons.filter((c) => c.rows === 100000))
	lines.push(
		`| ${c.profile} | ${mib(c.before.peakWorkerRss)} / ${mib(c.after.peakWorkerRss)} | ${mib(c.before.allocated)} / ${mib(c.after.allocated)} | ${mib(c.sqlite.allocated)} / ${mib(c.postgres.allocated)} |`,
	);
lines.push(
	"",
	"Full reads deliberately materialize caller-requested results; peak process RSS includes those objects and GC. Disk footprints include logs/indexes/scratch at observation time; final maintenance can remove the pending log. PostgreSQL totals include the complete fresh cluster and WAL; empty-cluster and relation bytes are reported separately in raw summaries. Compaction still needs staged replacement space. Sorted compressed reads use temporary plain sort columns and a size-limited native sort rather than materializing all rows in JavaScript; large-sort temporary-space peaks are not qualified by the standard suite. Cache entries are generation-aware, and compaction invalidates query caches.",
	"",
	"## Correctness and limits",
	"",
	"Tests cover indexed keys changed/deleted, uniqueness after tombstones, pagination and sums, explicit compaction/reopen, encrypted IDs, metadata edits, large values, broad updates, schema/prepend fallback, transaction commit/rollback, independent writers/readers, small shared allowances, SIGKILL around marker publication/append/synchronization/partial compaction and injected synchronization failure. Existing torn/replaced log, stale metadata and journal recovery checks ran. Failed synchronization is rejected; an unacknowledged write can have an indeterminate outcome. These are process-crash/EIO tests, not hardware power-loss qualification.",
	"",
	`Across ${candidates} descriptive timed work/query comparisons, iniBase has ${wins.length} lower medians than the alternatives. All entries, including any narrow wins, are recorded in audit.json. Lazy reopen/control-only phases are excluded. Lower descriptive medians from three trials do not establish statistical or universal superiority. SQLite/PostgreSQL comparisons, all slower cases, CPU/I/O counters and latency samples remain in qualified/summary.json and raw files.`,
	"",
	"## Reproduction and provenance",
	"",
	"Source and tooling SHA-256 identities are in every environment.json. reproduction.json rebuilds the baseline, initial development and final measured source snapshots and checks every emitted JavaScript module and benchmark tool. Exact runtime/dependency/binary identities are in dependencies.json and dependency-verification.json. The baseline is the prior public-chunks-20261018 after/ and after-small/ matrices. The initial comparison/ matrix used initial-source.tar.gz and is retained separately. The intermediate-* matrices used intermediate-source.tar.gz before the compressed-sort ownership fix and are also excluded from final aggregation. Final primary results use qualified-source.tar.gz. The original fourteen local edits remain unstaged and preserved.",
	"",
	"All runs use equal six-field application data, 1k/10k/100k compact/CMS/SHA-derived high-entropy text fixtures (not incompressible binary), three rotated isolated trials and fresh directories. The largest data exceeds the 16 MiB engine allowance. SQLite WAL/FULL requests fullfsync/checkpoint_fullfsync; PostgreSQL fsync, synchronous_commit, full_page_writes and Darwin fsync_writethrough are enabled; iniBase acknowledgements retain synchronous durable logging and the existing locks. No group commit or weakened synchronization was introduced. PostgreSQL is a private Unix-socket cluster, not a service. OS filesystem cache was not evicted; reopen is not cold disk.",
	"",
	"Host: Apple M5, 16 GiB, APFS/NVMe, macOS 27.0.1; Node 26.9.0, SQLite 3.53.4 and PostgreSQL 18.6. CPU counters omit PostgreSQL server CPU from worker-only figures. Process-tree RSS sums PG shared mappings more than once; 200 ms memory/disk sampling can miss peaks. Available zero I/O counters do not imply zero physical I/O. Native Mac hard RSS limits are unavailable here, and Linux cgroup tooling remains unqualified. Exact settings and these limits are retained rather than equating cache allowances with enforced memory caps.",
	"",
	"Run REPRODUCE.sh from this directory for exact archived builds, checks and the standard comparison. Fresh output directories are required. No data conversion, push, publication or deployment occurred. This existing-format optimization needs no conversion script; the final replacement format and external migration tool requested earlier remain separate unfinished work.",
	"",
);
const readLines = [
	"",
	"Pending-change point reads at 100k records (p50 ms):",
	"",
	"| Dataset | After updates before → after | After deletes before → after |",
	"|---|---:|---:|",
];
for (const c of comparisons.filter((c) => c.rows === 100000))
	readLines.push(
		`| ${c.profile} | ${ms(c.before.latency.afterUpdateRead.p50)} → ${ms(c.after.latency.afterUpdateRead.p50)} | ${ms(c.before.latency.afterDeleteRead.p50)} → ${ms(c.after.latency.afterDeleteRead.p50)} |`,
	);
readLines.push(
	"",
	"Delta reconciliation adds read work; the improvement is primarily in mutations. These results do not show a general read-speed win.",
	"",
);
lines.splice(lines.indexOf("## Memory and storage"), 0, ...readLines);
const winLines = [
	"",
	"Observed lower medians (three trials; descriptive only):",
	"",
	"| Dataset | Rows | Metric | iniBase ms | Alternative | Alternative ms |",
	"|---|---:|---|---:|---|---:|",
];
for (const win of wins)
	winLines.push(
		`| ${win.profile} | ${win.rows} | ${win.metric} | ${ms(win.ini)} | ${win.engine} | ${ms(win.peer)} |`,
	);
winLines.push(
	"",
	"All other timed comparisons in this set were slower. This narrow result does not establish a general speed advantage.",
	"",
);
const provenance = lines.indexOf("## Reproduction and provenance");
if (wins.length) lines.splice(provenance, 0, ...winLines);
await writeFile(join(root, "REPORT.md"), lines.join("\n"));
console.log(
	JSON.stringify({
		tests: testCount,
		standard: after.audit.verified,
		stress: stress.audit.verified,
		speedComparisons: candidates,
		wins: wins.length,
	}),
);
