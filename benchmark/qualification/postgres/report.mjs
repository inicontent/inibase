import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2]);
const metadata = JSON.parse(
	await readFile(join(root, "environment.json"), "utf8"),
);
const failures = JSON.parse(
	await readFile(join(root, "failures.json"), "utf8"),
);
const trials = [];
for (const name of await readdir(root)) {
	if (
		!/^(inibase|sqlite|postgres)-.*-\d+\.json$/.test(name) ||
		name.endsWith(".resources.json")
	)
		continue;
	const data = JSON.parse(await readFile(join(root, name), "utf8"));
	const resources = JSON.parse(
		await readFile(
			join(root, name.replace(/\.json$/, ".resources.json")),
			"utf8",
		),
	);
	trials.push({ data, resources });
}
const median = (input) => {
	const a = [...input].sort((a, b) => a - b);
	return a.length % 2
		? a[Math.floor(a.length / 2)]
		: (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const quantile = (input, p) =>
	input.length
		? [...input].sort((a, b) => a - b)[Math.ceil(input.length * p) - 1]
		: null;
const summaries = [];
for (const profile of ["compact", "cms", "entropy"])
	for (const rows of [1000, 10000, 100000])
		for (const engine of ["inibase", "sqlite", "postgres"]) {
			const group = trials.filter(
				({ data }) =>
					data.options.engine === engine &&
					data.options.profile === profile &&
					data.options.rows === rows,
			);
			if (!group.length) continue;
			const good = group.filter(
				({ data, resources }) => data.verified && resources.status?.code === 0,
			);
			const phases = {},
				latency = {};
			for (const phase of Object.keys(good[0]?.data.timings ?? {}))
				phases[phase] = median(good.map(({ data }) => data.timings[phase].ms));
			for (const phase of Object.keys(good[0]?.data.latency ?? {})) {
				const values = good.flatMap(({ data }) => data.latency[phase]);
				latency[phase] = {
					samples: values.length,
					p50: quantile(values, 0.5),
					p95: values.length >= 20 ? quantile(values, 0.95) : null,
					p99: values.length >= 1000 ? quantile(values, 0.99) : null,
				};
			}
			const resourceSamples = group.flatMap(
				({ resources }) => resources.samples,
			);
			const summary = {
				profile,
				rows,
				engine,
				trials: group.length,
				verified: good.length,
				phases,
				latency,
				bulkRecordsPerSecond: phases.bulkInsert
					? (rows * 1000) / phases.bulkInsert
					: null,
				peakWorkerRss: Math.max(
					0,
					...group.map(({ data }) => (data.usageEnd?.maxRSS ?? 0) * 1024),
				),
				peakSampledTreeRss: Math.max(
					0,
					...resourceSamples.map((sample) => sample.rss),
				),
				peakAccountedBytes: Math.max(
					0,
					...group.flatMap(({ data }) =>
						data.phases.map((phase) => phase.memory?.peakAccountedBytes ?? 0),
					),
				),
				allocated: median(
					group.map(({ resources }) => resources.finalDisk.allocated),
				),
				logical: median(
					group.map(({ resources }) => resources.finalDisk.logical),
				),
				peakSampledDisk: Math.max(
					0,
					...resourceSamples.map((sample) => sample.disk.allocated),
				),
				peakTemporary: Math.max(
					0,
					...resourceSamples.map((sample) => sample.disk.temporaryLogical),
				),
				postgresEmptyAllocated:
					engine === "postgres"
						? median(
								group.map(
									({ resources }) => resources.setup.emptyDisk.allocated,
								),
							)
						: null,
				postgresRelationBytes:
					engine === "postgres"
						? median(
								good.map(({ data }) =>
									Number(data.final.database.records_bytes),
								),
							)
						: null,
				samplerErrors: group.flatMap(({ resources }) => resources.errors),
			};
			summaries.push(summary);
		}
const audit = {
	trials: trials.length,
	verified: trials.filter(({ data }) => data.verified).length,
	failures,
	samplerErrors: trials.flatMap(({ resources }) => resources.errors),
	operationErrors: trials.flatMap(({ data }) => data.errors),
};
await writeFile(
	join(root, "summary.json"),
	`${JSON.stringify({ metadata, audit, summaries }, null, 2)}\n`,
);
const mib = (n) => (n / 1048576).toFixed(2),
	ms = (n) => (n == null ? "—" : n.toFixed(3));
const lines = [
	"# Public API comparison: iniBase, SQLite, PostgreSQL",
	"",
	`Flush policy: ${metadata.flush ?? "historical platform-default"}. ${metadata.flushPolicy ?? "Historical Darwin defaults did not request equal drive-cache flushing; see docs/mutable-row-storage.md."}`,
	"",
	"Equal six-field application records; bulk commits contain at most 1,000 records. Bulk timings include fixture creation. Index construction is explicit and measured for all engines; this is not automatic-tuning evidence. Existing iniBase public backend, not the experimental row kernel. Local PostgreSQL Unix-domain connection versus embedded calls. Fresh directories, rotated trials, existing OS filesystem cache. Full durability; actual settings and hashes retained in environment/trial files.",
	"",
	"Mixed time includes maintenance attempts: iniBase compact(), SQLite WAL checkpoint, PostgreSQL VACUUM ANALYZE plus CHECKPOINT. Current public iniBase defaults rewrite base data on mutation, so compact() can be a no-op and rewrite cost sits inside mutation latency. There is no substantial pending log/tombstone overlay in this configuration. These are different maintenance mechanisms and these short runs do not establish endurance or PostgreSQL maturity. Reopen closes/reopens the client/engine, not the PostgreSQL server. Heap/cache settings do not bound whole-engine RSS. PostgreSQL tree RSS sums shared mappings more than once; it is not physical memory. Allocated PostgreSQL footprint includes the complete fresh cluster and WAL; empty cluster and relation bytes are reported separately.",
	"",
	"| Dataset | Rows | Engine | Bulk ms | Records/s | Index ms | Random p50/p95 ms | Full ms | Projection ms | Insert p50 ms | Update p50 ms | Delete p50 ms | Mixed incl. maintenance ms | Worker peak MiB | Sampled tree peak MiB | Allocated MiB | PG empty/relation MiB |",
	"|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
];
for (const s of summaries)
	lines.push(
		`| ${s.profile} | ${s.rows} | ${s.engine} | ${ms(s.phases.bulkInsert)} | ${s.bulkRecordsPerSecond?.toFixed(0) ?? "—"} | ${ms(s.phases.explicitIndexBuild)} | ${ms(s.latency.randomIndexedKey?.p50)} / ${ms(s.latency.randomIndexedKey?.p95)} | ${ms(s.phases.fullRead)} | ${ms(s.phases.projection)} | ${ms(s.latency.individualDurableInsert?.p50)} | ${ms(s.latency.individualDurableUpdate?.p50)} | ${ms(s.latency.individualDurableDelete?.p50)} | ${ms(s.phases.mixedIncludingMaintenance)} | ${mib(s.peakWorkerRss)} | ${mib(s.peakSampledTreeRss)} | ${mib(s.allocated)} | ${s.engine === "postgres" ? `${mib(s.postgresEmptyAllocated)} / ${mib(s.postgresRelationBytes)}` : "—"} |`,
	);
lines.push(
	"",
	`Verified ${audit.verified}/${audit.trials}; ${failures.length} failed runs; ${audit.samplerErrors.length} sampler/setup errors; ${audit.operationErrors.length} operation errors.`,
	"",
	"Pooled latency sample counts and quantiles, all phase medians, CPU/I/O/resource samples, final relation/database/cluster sizes, temporary samples, maintenance, reopen and rollback results are retained in JSON. p99 is omitted below 1,000 samples; p95 below 20. Peak RSS may occur during caller-requested full-result materialization. Sampled process/disk peaks can miss short events. Client CPU excludes PostgreSQL server CPU; raw process samples include cumulative live server CPU, not exited processes or a complete CPU total. Zero OS I/O counters do not imply zero physical I/O.",
	"",
);
await writeFile(join(root, "MEASUREMENTS.md"), lines.join("\n"));
console.log(audit);
