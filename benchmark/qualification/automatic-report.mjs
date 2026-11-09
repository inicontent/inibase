import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const root = resolve(process.argv[2]);
const matrix = join(root, "final/measured-public");
const data = JSON.parse(await readFile(join(matrix, "results.json"), "utf8"));
const median = (values) => {
	const s = [...values].sort((a, b) => a - b);
	return s.length % 2
		? s[Math.floor(s.length / 2)]
		: (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const quantile = (values, p) =>
	[...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const groups = new Map();
for (const row of data.results) {
	const key = `${row.profile}|${row.rows}|${row.engine}`;
	if (!groups.has(key)) groups.set(key, []);
	groups.get(key).push(row);
}
const summaries = [];
for (const [key, rows] of groups) {
	const [profile, count, engine] = key.split("|");
	const resources = await Promise.all(
		rows.map((row) =>
			readFile(
				join(
					matrix,
					`${engine}-${profile}-${count}-${row.options.repeat}.resources.json`,
				),
				"utf8",
			).then(JSON.parse),
		),
	);
	const probes = rows.flatMap((row) => row.latency.afterTrainingKey);
	const background = rows.map((row) => row.automatic ?? null);
	summaries.push({
		profile,
		rows: Number(count),
		engine,
		trials: rows.length,
		learnedIndexes: rows.map((row) =>
			row.learnedConfig ? JSON.parse(row.learnedConfig).indexes : [],
		),
		background,
		timings: Object.fromEntries(
			Object.keys(rows[0].timings).map((name) => [
				name,
				median(rows.map((row) => row.timings[name])),
			]),
		),
		initialQueriesAndDrainMs: median(
			rows.map(
				(row) =>
					row.timings.randomKeyWall + (row.timings.automaticBuildDrain ?? 0),
			),
		),
		postTraining: {
			count: probes.length,
			p50: quantile(probes, 0.5),
			p95: probes.length >= 100 ? quantile(probes, 0.95) : null,
			p99: probes.length >= 1000 ? quantile(probes, 0.99) : null,
		},
		disk: Object.fromEntries(
			["logical", "allocated"].map((name) => [
				name,
				median(rows.map((row) => row.stored[name])),
			]),
		),
		peakRss: Math.max(
			...resources.flatMap((value) =>
				value.resourceSamples.map((sample) => sample.processTreeRss ?? 0),
			),
			...rows.map((row) => row.endUsage.maxRSS * 1024),
		),
		runtimeRss: median(rows.map((row) => row.runtimeBaselineRss)),
		peakAccountedBytes: Math.max(
			...rows.flatMap((row) => [
				...row.phases.map(
					(phase) => phase.engineMemory?.peakAccountedBytes ?? 0,
				),
				row.automatic?.peakAccountedBytes ?? 0,
			]),
		),
		peakTemporaryLogical: Math.max(
			0,
			...resources.flatMap((value) =>
				value.resourceSamples.map((sample) => sample.temporaryLogical ?? 0),
			),
		),
		peakTemporaryAllocated: Math.max(
			0,
			...resources.flatMap((value) =>
				value.resourceSamples.map((sample) => sample.temporaryAllocated ?? 0),
			),
		),
		samplerErrors: resources.flatMap((value) =>
			value.resourceSamples.filter((sample) => sample.error),
		),
		cpuUserMs:
			median(
				rows.map(
					(row) => row.endUsage.userCPUTime - row.startUsage.userCPUTime,
				),
			) / 1000,
		cpuSystemMs:
			median(
				rows.map(
					(row) => row.endUsage.systemCPUTime - row.startUsage.systemCPUTime,
				),
			) / 1000,
	});
}
const kernelRoot = join(root, "final/row-kernel"),
	kernels = [];
for (const name of await readdir(kernelRoot))
	if (
		/^(rowpack|sqlite)-.*-\d+\.json$/.test(name) &&
		!name.includes(".resources.")
	)
		kernels.push(JSON.parse(await readFile(join(kernelRoot, name), "utf8")));
const kernelSummaries = [];
for (const profile of ["compact", "cms", "entropy"])
	for (const n of [1000, 10000, 100000])
		for (const engine of ["rowpack", "sqlite"]) {
			const rows = kernels.filter(
				(row) =>
					row.config.profile === profile &&
					row.config.rows === n &&
					row.config.engine === engine,
			);
			if (!rows.length) continue;
			const latency = rows.flatMap((row) => row.latency);
			kernelSummaries.push({
				profile,
				rows: n,
				engine,
				trials: rows.length,
				bulkMs: median(rows.map((row) => row.timings.bulkIncludingEncoding)),
				p50: quantile(latency, 0.5),
				p95: quantile(latency, 0.95),
				p99: null,
				allocated: median(rows.map((row) => row.stored.allocated)),
				logical: median(rows.map((row) => row.stored.logical)),
				peakAccountedBytes: Math.max(
					...rows.map((row) => row.memory?.peakAccountedBytes ?? 0),
				),
				peakWorkerRss: Math.max(
					...rows.map((row) => row.endUsage.maxRSS * 1024),
				),
				verified: rows.every((row) => row.verified),
			});
		}
await writeFile(
	join(root, "summary.json"),
	JSON.stringify(
		{
			metadata: data.metadata,
			summaries,
			kernelSummaries,
			failures: data.failures,
		},
		null,
		2,
	) + "\n",
);
const f = (value, digits = 2) => Number(value).toFixed(digits),
	mib = (value) => f(value / 1048576);
const lines = [
	"# Automatic options and row-storage qualification",
	"",
	"This report describes a local development stage, not completion of the full storage redesign. The production DML backend remains column based.",
	"",
	"## Public API comparison",
	"",
	"Three rotated trials per engine/dataset/size; fresh directories and equal application values. High-entropy fixtures are deterministic SHA-256 hex text, not incompressible binary. Only `compression`, `decodeID` and `cache` are supplied (prepend defaults false). Baseline is the frozen pre-change working tree; optimized uses the four-option API and automatic indexes. SQLite has its application-key index from creation. iniBase uses full durability; SQLite uses WAL/FULL. No fsyncs or locks are disabled.",
	"",
	"Initial 16-probe time includes draining the triggered build; post-training p50 pools 48 samples across trials. p95/p99 are omitted for these short samples. Mutation totals use two individual operations per trial; the mixed phase uses two rounds of two durable updates/reads and explicit compaction/checkpoint calls. Default-format iniBase compaction is a no-op because this workload does not enable the log. Phases inherited as `pending*` contain committed rewrites here, not populated logs. The earlier qualification covers actual logged overlays and tombstones.",
	"",
	"| Dataset | Rows | Engine | First 16 + build ms | Trained key p50 ms | Bulk rows/s | Full ms | Projection ms | 2 updates ms | 2 deletes ms | Mixed ms | Allocated MiB |",
	"|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
];
for (const s of summaries)
	lines.push(
		`| ${s.profile} | ${s.rows} | ${s.engine} | ${f(s.initialQueriesAndDrainMs)} | ${f(s.postTraining.p50, 4)} | ${f((s.rows * 1000) / s.timings.bulkInsert, 0)} | ${f(s.timings.fullRead)} | ${f(s.timings.projection)} | ${f(s.timings.individualDurableUpdates)} | ${f(s.timings.individualDurableDeletes)} | ${f(s.timings.mixedIncludingRepeatedCompaction)} | ${mib(s.disk.allocated)} |`,
	);
lines.push(
	"",
	"## Memory, CPU and temporary storage",
	"",
	"Runtime/RSS includes Node, caller-requested full results, fixture generation and correctness verification. Accounted bytes cover caches/evidence plus reserved maintenance, not all engine working memory. Sampled process-tree RSS and worker maxRSS are combined; short child peaks can be missed. Temporary disk is sampled every 100 ms, not an exact high-water mark. Raw phase CPU/I/O counters are retained; zero Darwin fsRead/fsWrite counters are unavailable evidence, not zero physical I/O.",
	"",
	"| Dataset | Rows | Engine | Runtime RSS MiB | Peak RSS MiB | Peak accounted MiB | Peak temporary logical MiB | Peak temporary allocated MiB | CPU user ms | CPU system ms |",
	"|---|---:|---|---:|---:|---:|---:|---:|---:|---:|",
);
for (const s of summaries)
	lines.push(
		`| ${s.profile} | ${s.rows} | ${s.engine} | ${mib(s.runtimeRss)} | ${mib(s.peakRss)} | ${mib(s.peakAccountedBytes)} | ${mib(s.peakTemporaryLogical)} | ${mib(s.peakTemporaryAllocated)} | ${f(s.cpuUserMs, 0)} | ${f(s.cpuSystemMs, 0)} |`,
	);
lines.push(
	"",
	"## Immutable row-byte kernel experiment",
	"",
	"This is a separate kernel comparison, not public iniBase versus SQLite. Both kernels store the same encoded JSON bytes and integer primary keys. Rowpack has independently compressed 32 KiB pages and an on-disk ID hash table; SQLite stores opaque BLOB rows with a primary key. One whole-dataset durable bulk publication/transaction, encoding included. Rowpack has no mutation, secondary-key, schema-validation, projection/scan, transaction integration, compaction or generation-reclamation API. Old generations can grow disk usage; it is not a production backend. A 1 MiB shared cache/reservation budget is used for rowpack and a 1 MiB SQLite page cache. Larger datasets exceed both cache settings.",
	"",
	"Quantiles pool 384 random reads over three trials; p99 is omitted. Close/checkpoint times, raw samples, CPU/RSS and footprints before close are in `final/row-kernel/`. SQLite checkpoint cost is separate from bulk time. The kernel data differs from the API dataset, so its disk/latency values cannot be compared directly with the API table above.",
	"",
	"| Dataset | Rows | Kernel | Bulk including encoding ms | Key p50 ms | Key p95 ms | Allocated MiB | Peak accounted MiB | Peak worker RSS MiB |",
	"|---|---:|---|---:|---:|---:|---:|---:|---:|",
);
for (const s of kernelSummaries)
	lines.push(
		`| ${s.profile} | ${s.rows} | ${s.engine} | ${f(s.bulkMs)} | ${f(s.p50, 4)} | ${f(s.p95, 4)} | ${mib(s.allocated)} | ${mib(s.peakAccountedBytes)} | ${mib(s.peakWorkerRss)} |`,
	);
lines.push(
	"",
	"## Evidence and limits",
	"",
	"- Machine/runtime/artifact identities: `final/measured-public/environment.json`, `dependencies.json`, `macos.txt`, `storage-hardware.txt`, `filesystem.txt`. Exact baseline/candidate source archives and the pre-existing working-tree patch are retained.",
	"- Public comparison failures: " +
		data.failures.length +
		". Sampler errors: " +
		summaries.reduce((sum, s) => sum + s.samplerErrors.length, 0) +
		". Kernel correctness: " +
		kernelSummaries.every((s) => s.verified) +
		".",
	"- `public-matrix/` is exploratory: sandboxed ps sampling failed and later correctness runs overlapped it. It is retained but excluded from the measured tables. Earlier failed test logs retain fixture mistakes (wrong `.gz` filename, then signed-zero expectation); final correctness is recorded separately.",
	"- OS caches were not evicted. Runs use one benchmark worker at a time on the local desktop; unrelated desktop activity remains possible. No enforceable process RSS limit/cgroup was available on macOS; V8 heap caps are not RSS caps.",
	"- Full engine memory bounds and bounded-unit compaction remain incomplete. Index builds may increase insert/delete maintenance cost. Large automatic builds can hit eligibility/work limits and leave the scan fallback; maintenance diagnostics are retained in summary.json.",
	"- No automatic authoritative format migration or group commit is introduced. SIGKILL tests qualify process crashes only, not sudden power loss or device-cache behavior.",
	"- Historical workload defaults and published results remain unchanged. Version 5 is explicitly labeled by `--publicOptions=true`. Profiling is separate from latency measurements.",
	"",
	"See [reproduction commands](../../qualification/README.md) and [row-storage limits](../../../docs/row-storage.md).",
	"",
);
await writeFile(join(root, "MEASUREMENTS.md"), lines.join("\n"));
console.log(`Wrote ${join(root, "MEASUREMENTS.md")}`);
