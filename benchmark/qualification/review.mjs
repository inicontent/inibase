// Build the concise measured findings after the raw suites finish.
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const root = resolve(
	process.argv[2] ?? "benchmark/results/optimization-20261017",
);
const read = async (name) =>
	JSON.parse(await readFile(join(root, name), "utf8"));
const final = await read("final-comparison/summary.json");
const sustained = await read("sustained/summary.json");
const f = (n, digits = 2) => Number(n).toFixed(digits);
const mib = (n) => f(n / 1048576);
const find = (profile, rows, engine) =>
	final.summaries.find(
		(x) => x.profile === profile && x.rows === rows && x.engine === engine,
	);
const lines = [
	"# Local iniBase optimization results",
	"",
	"Implemented local changes and measurements are complete for this optimization stage. The full requested redesign remains incomplete: the shared setting bounds caches rather than all working memory, and compaction still rewrites whole columns under the table lock.",
	"",
	"## Source and validation",
	"",
	"- Baseline: dd3ed9d72b13daa260e88b6f00327761eb52543d plus the pre-existing working tree in preexisting.patch. baseline.sha256 records exact source hashes.",
	"- Final engine: 102ec04 plus the same pre-existing source edits. final-artifact.sha256 and each matrix environment.json record exact compiled identities. Benchmark tooling has a separate commit and source hashes.",
	"- Local commits: 2ae5b20 (stat identities), d78a478 (overlay I/O and enumeration), 102ec04 (scratch-error recovery), 511d710 (benchmark tooling/documentation). No push or deployment.",
	"- Baseline package suite: 411 passed. Final package + process/journal suites: 427 passed, zero failures. TypeScript passed. The repository-wide formatter reports one pre-existing edit in src/index.ts; changed storage files pass.",
	"- The literal pnpm test attempt was blocked by tsx CLI IPC restrictions; checks.mjs runs the same files with node --import tsx and includes additional process/journal tests.",
	"- A failure injection after durable append reproduced stale recovery in the baseline (cursor-before.log); the final engine recovers the appended frame (cursor-after.log). SIGKILL tests are process-crash qualification, not power-loss qualification.",
	"",
	"## Final measured comparison",
	"",
	`Final matrix: ${final.summaries.reduce((n, x) => n + x.trials, 0)} verified trials; ${final.failures.length} failures. Three rotated trials per engine/profile/size, fresh directories, full durability. SQLite uses WAL/FULL; actual PRAGMAs are in raw results. The OS filesystem cache was not evicted.`,
	"",
	"100k rows; medians of trial totals and pooled raw lookup samples:",
	"",
	"| Data | Engine | Bulk rows/s | Full read ms | Projection ms | Key p50 / p95 ms | Durable update p50 ms | Mixed s | Allocated MiB | Observed RSS MiB |",
	"|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
];
for (const profile of ["compact", "cms", "mixed"])
	for (const engine of ["baseline-indexed", "indexed", "sqlite"]) {
		const x = find(profile, 100000, engine);
		lines.push(
			`| ${profile} | ${engine} | ${f(100000000 / x.timings.bulkInsert, 0)} | ${f(x.timings.fullRead)} | ${f(x.timings.projection)} | ${f(x.latency.randomKey.p50, 3)} / ${f(x.latency.randomKey.p95, 3)} | ${f(x.latency.individualDurableUpdates.p50, 3)} | ${f(x.timings.mixedIncludingRepeatedCompaction / 1000)} | ${mib(x.storage.stored.allocated)} | ${mib(x.peakTreeRss)} |`,
		);
	}
lines.push(
	"",
	"All 1k/10k/100k results, CPU/I/O counters, raw latency samples, failures, sampled RSS and temporary-footprint traces are retained in final-comparison/. Full table: final-comparison/REPORT.md.",
	"",
	"## Workloads faster than SQLite",
	"",
);
const metrics = [
	"bulkInsert",
	"fullRead",
	"warmFullRead",
	"projection",
	"randomKey",
	"sequentialKey",
	"hotKey",
	"missingKey",
	"nonIndexedFilter",
	"individualDurableInserts",
	"individualDurableUpdates",
	"individualDurableDeletes",
	"pendingUpdateReads",
	"pendingDeleteReads",
	"mixedIncludingRepeatedCompaction",
];
let wins = 0;
for (const profile of ["compact", "cms", "mixed"])
	for (const rows of [1000, 10000, 100000]) {
		const a = find(profile, rows, "indexed"),
			b = find(profile, rows, "sqlite");
		for (const metric of metrics)
			if (a.timings[metric] < b.timings[metric]) {
				wins++;
				lines.push(
					`- ${profile}, ${rows} rows, ${metric}: iniBase ${f(a.timings[metric], 3)} ms vs SQLite ${f(b.timings[metric], 3)} ms (median of three totals; no confidence interval).`,
				);
			}
	}
if (!wins)
	lines.push(
		"No measured application operation had a lower median than SQLite in this final matrix.",
	);
lines.push(
	"",
	"Every listed operation outside those specific wins remains slower in the measured matrix. Small differences are descriptive observations, not proof of a general advantage. IniBase's main advantage here is compressed storage footprint.",
	"",
	"## Longer mixed workload",
	"",
	"10k repetitive CMS rows, 12 explicit compactions/checkpoints, up to 64 updates plus reads per round, an ongoing delete every eighth selected operation, automatic compaction at the configured overlay threshold, and 1,024 lookup samples per trial. Maintenance remains inside total mixed time.",
	"",
	"| Engine | Mixed s | Key p50 / p95 / p99 ms | Peak .tmp logical MiB | Peak cache MiB |",
	"|---|---:|---:|---:|---:|",
);
for (const x of sustained.summaries)
	lines.push(
		`| ${x.engine} | ${f(x.timings.mixedIncludingRepeatedCompaction / 1000)} | ${f(x.latency.randomKey.p50, 3)} / ${f(x.latency.randomKey.p95, 3)} / ${f(x.latency.randomKey.p99, 3)} | ${mib(x.peakTemporaryLogical)} | ${mib(x.peakAccountedCache)} |`,
	);
lines.push(
	"",
	`Sustained trial failures: ${sustained.failures.length}. Per-compaction times and actual update/read/delete counts are in each raw worker result. This is a longer local test, not an indefinite steady-state or power-loss qualification.`,
	"",
	"## Memory, storage and remaining work",
	"",
	"- 100k CMS and high-entropy data exceed the 16 MiB configured cache budget. Accounted caches remain within that limit. Observed RSS includes Node, caller materialized reads, input and verification, plus unaccounted engine transients; it is not a total-engine-memory bound.",
	"- --max-old-space-size=512 is an enforceable V8 heap cap, not an RSS or process-tree cap. A Linux cgroup was unavailable on this macOS host. No actual power-loss/device-write-cache qualification was performed.",
	"- Disk includes primary data, indexes, logs and fixtures. Temporary .tmp and scratch .cache footprint samples can miss short peaks and exclude temporary files elsewhere on the system. Zero Darwin fsRead/fsWrite counters do not mean zero physical I/O.",
	"- The new dense scratch ID directory costs eight logical bytes per touched ID, filesystem allocation and one reusable descriptor. It avoids obsolete payload decoding; the values scratch file still retains history until overlay reset/compaction. No authoritative format migration is required.",
	"- Metadata batching was rejected because three rotated trials showed no consistent speed gain. Its raw samples are retained. Early overlapping baseline diagnostics and the interrupted ps-restricted attempt are preserved and excluded from the isolated comparison.",
	"- Highest priorities remain total working-memory reservations/concurrency admission, segment compaction with crash-safe reader reclamation, incremental key-index maintenance and changed-key delta indexes. Group commit needs cross-process ordering, error and recovery coordination; synchronization was not weakened.",
	"",
	"## Reproduction",
	"",
	"See ../../qualification/README.md for exact build, checks, matrix, block-size and sustained commands. Reconstruct the baseline using git archive dd3ed9d, apply preexisting.patch, link the installed node_modules, and compile with the recorded TypeScript dependency. The report and raw environment/source hashes identify every artifact. Use a new results directory for each run.",
	"",
);
const median = (values) =>
	values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const quantile = (values, p) =>
	values.sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
lines.push(
	"## Focused overlay diagnostics",
	"",
	"Scratch-only diagnostics; these numbers are not durable application throughput.",
	"",
	"| Cache budget | Version | 4096 scratch writes ms | Scan p50 ms |",
	"|---|---|---:|---:|",
);
for (const budget of ["default", "small"])
	for (const engine of ["baseline", "final"]) {
		const prefix =
			budget === "small"
				? `overlay-small-${engine}`
				: engine === "baseline"
					? "overlay-recheck-baseline"
					: "overlay-final";
		const values = await Promise.all(
			[1, 2, 3].map((i) => read(`${prefix}-${i}.json`)),
		);
		lines.push(
			`| ${budget === "small" ? "256 KiB" : "16 MiB"} | ${engine} | ${f(median(values.map((x) => x.writesMs)))} | ${f(median(values.flatMap((x) => x.scanMs)), 3)} |`,
		);
	}
const concurrent = await read("concurrent/results.json");
lines.push(
	"",
	"## Concurrent readers/writers",
	"",
	"Three writers and one reader, fresh 1k-row CMS fixtures, three rotated trials. Writer cycles include verification reads, every eighth delete and every 32nd compaction. RSS covers engine worker processes; parent fixture/measurement-harness overhead is separate.",
	"",
	"| Engine | Durable mutations/s | Reader reads/s | Writer-cycle p50 / p95 ms | Writer samples | Observed worker-tree RSS MiB |",
	"|---|---:|---:|---:|---:|---:|",
);
for (const engine of ["baseline-indexed", "indexed", "sqlite"]) {
	const values = concurrent.results.filter((x) => x.engine === engine);
	if (values.some((x) => !x.verified))
		throw new Error(`Concurrent failure: ${engine}`);
	const cycles = values.flatMap((x) =>
		x.workers.filter((w) => w.role === "writer").flatMap((w) => w.latency),
	);
	const mutations = values.map(
		(x) =>
			(x.workers
				.filter((w) => w.role === "writer")
				.reduce((n, w) => n + w.counts.updates + w.counts.deletes, 0) /
				x.elapsedMs) *
			1000,
	);
	const reads = values.map(
		(x) =>
			(x.workers.find((w) => w.role === "reader").operations / x.elapsedMs) *
			1000,
	);
	const rss = Math.max(
		0,
		...values.flatMap((x) => x.samples.map((s) => s.processTreeRss ?? 0)),
	);
	lines.push(
		`| ${engine} | ${f(median(mutations))} | ${f(median(reads))} | ${f(quantile(cycles, 0.5), 3)} / ${f(quantile(cycles, 0.95), 3)} | ${cycles.length} | ${mib(rss)} |`,
	);
}
lines.push(
	"",
	"Writer-cycle p99 is omitted below 1,000 samples. Reader raw samples and per-worker CPU/I/O counters are retained. Reopen verifies final rows, changed keys and deletions.",
);
const blocks = [
	await read("block-65536/summary.json"),
	final,
	await read("block-262144/summary.json"),
];
lines.push(
	"",
	"## Block sizes",
	"",
	"10k rows, candidate engine, three trials; block controls use eight individual-write samples after the read phases, while the main 128 KiB matrix uses 32. Storage below is taken immediately after initial bulk insertion, before that separate fixture. Only the matching bulk/read phases are compared.",
	"",
	"| Data | Block KiB | Bulk rows/s | Full ms | Key p50 ms | Initial allocated MiB |",
	"|---|---:|---:|---:|---:|---:|",
);
for (const profile of ["cms", "mixed"])
	for (let index = 0; index < blocks.length; index++) {
		const x = blocks[index].summaries.find(
			(x) =>
				x.engine === "indexed" && x.rows === 10000 && x.profile === profile,
		);
		lines.push(
			`| ${profile} | ${[64, 128, 256][index]} | ${f((x.rows / x.timings.bulkInsert) * 1000, 0)} | ${f(x.timings.fullRead)} | ${f(x.latency.randomKey.p50, 3)} | ${mib(x.storage.afterInsert.allocated)} |`,
		);
	}
lines.push(
	"",
	"Total footprints include indexes and block directories. Exact per-file metadata overhead and physical read/write amplification are not fully qualified. The default remains 128 KiB; these controls do not establish one universally optimal block size.",
);
const profiles = await read("profile-final/results.json");
lines.push(
	"",
	"## Diagnostic operation counts",
	"",
	"Separate instrumented 1k-row compact runs with identical settings; asynchronous timings include waiting and are not CPU attribution. CPU profiles and raw counters are retained.",
	"",
	"| Operation | Baseline calls | Final calls |",
	"|---|---:|---:|",
);
for (const name of [
	"fs.open",
	"handle.close",
	"fs.stat",
	"handle.read",
	"handle.write",
	"handle.sync",
	"zlib.gunzipSync",
	"zlib.createGunzip",
	"subprocess.exec",
	"subprocess.execFile",
]) {
	const count = (engine) =>
		profiles.results.find((x) => x.engine === engine)?.instrumentation
			?.totals?.[name]?.calls ?? 0;
	lines.push(
		`| ${name} | ${count("baseline-indexed")} | ${count("indexed")} |`,
	);
}
lines.push("");
const recheck = await read("sustained-recheck/results.json");
lines.push("## Sustained recheck", "", "The first sustained set had a slower candidate median (27.33 s versus 20.82 s) and later trials of both engines slowed. Four additional trials per iniBase build used alternating AB/BA engine order. Both sets are retained; the recheck does not erase the earlier regression.", "");
for (const engine of ["baseline-indexed", "indexed"]) {
 const values = recheck.results.filter(x => x.engine === engine).map(x => x.timings.mixedIncludingRepeatedCompaction / 1000).sort((a,b)=>a-b);
 const center = (values[1] + values[2]) / 2;
 lines.push(`- ${engine}: four-trial median ${f(center)} s; individual trials ${values.map(x=>f(x)).join(", ")} s.`);
}
lines.push("", "These runs do not establish a consistent sustained-throughput gain or isolate the cause of the earlier timing gap. Original and recheck CPU/IO counters, per-compaction samples and timestamps remain available.", "", "The initial concurrent smoke version used trailing-space input and failed the equal-data assertion because existing iniBase string validation trims strings. The version-2 fixture supplies identical normalized input to all engines. Failed smoke results, databases and its matching-hash runner source are retained.", "", "The unchanged historical, computed-field, populated-overlay and full-durability benchmarks were rerun sequentially for the frozen baseline and final local source. Their raw logs are retained. The durability-none comparison was not run under this task's fsync constraint. Baseline reconstruction and final artifact hashes both verified exactly; all 14 pre-existing edited files match the initial patch byte for byte.", "");
await writeFile(join(root, "REPORT.md"), lines.join("\n"));
console.log(`Wrote ${join(root, "REPORT.md")}`);
