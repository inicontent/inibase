import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2]);
const environment = JSON.parse(
	await readFile(join(root, "environment.json"), "utf8"),
);
const failures = JSON.parse(
	await readFile(join(root, "failures.json"), "utf8"),
);
const trials = [];
for (const name of (await readdir(root)).sort()) {
	if (
		!/^(inibase|sqlite|postgres)-.*-\d+\.json$/.test(name) ||
		name.endsWith(".resources.json")
	)
		continue;
	const data = JSON.parse(await readFile(join(root, name), "utf8"));
	if (data.workloadVersion !== "mutable-row-kernel-1")
		throw new Error(`Unexpected workload: ${name}`);
	const resources = JSON.parse(
		await readFile(
			join(root, name.replace(/\.json$/, ".resources.json")),
			"utf8",
		),
	);
	trials.push({ name, data, resources });
}
const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
};
const quantile = (values, percentile) =>
	values.length
		? [...values].sort((a, b) => a - b)[
				Math.ceil(values.length * percentile) - 1
			]
		: null;
const summaries = [];
for (const profile of ["compact", "cms", "entropy"])
	for (const rows of [1000, 10000, 100000])
		for (const engine of ["inibase", "sqlite", "postgres"]) {
			const group = trials.filter(
				({ data }) =>
					data.options.profile === profile &&
					data.options.rows === rows &&
					data.options.engine === engine,
			);
			if (!group.length) continue;
			const good = group.filter(
				({ data, resources }) =>
					data.verified &&
					resources.status?.code === 0 &&
					!data.errors.length &&
					!resources.errors.length,
			);
			const phases = {},
				latency = {};
			for (const name of Object.keys(good[0]?.data.timings ?? {}))
				phases[name] = median(good.map(({ data }) => data.timings[name].ms));
			for (const name of Object.keys(good[0]?.data.latency ?? {})) {
				const values = good.flatMap(({ data }) => data.latency[name]);
				latency[name] = {
					samples: values.length,
					p50: quantile(values, 0.5),
					p95: values.length >= 20 ? quantile(values, 0.95) : null,
					p99: values.length >= 1000 ? quantile(values, 0.99) : null,
				};
			}
			const commitStages = {};
			for (const phase of [
				"appended",
				"data-synced",
				"manifest-synced",
				"published",
				"completed",
			]) {
				const values = good
					.flatMap(({ data }) => data.commitTraces ?? [])
					.map((trace) =>
						phase === "completed"
							? trace.completedMs
							: trace.trace.find((item) => item.phase === phase)?.ms,
					)
					.filter(Number.isFinite);
				if (values.length)
					commitStages[phase] = {
						samples: values.length,
						p50CumulativeMs: quantile(values, 0.5),
					};
			}
			const resourceSamples = group.flatMap(
				({ resources }) => resources.samples,
			);
			summaries.push({
				profile,
				rows,
				engine,
				trials: group.length,
				verified: good.length,
				phases,
				latency,
				commitStages,
				peakWorkerRss: Math.max(
					0,
					...group.map(({ data }) => data.usageEnd.maxRSS * 1024),
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
				peakTemporary: Math.max(
					0,
					...resourceSamples.map((sample) => sample.disk.temporaryLogical),
				),
			});
		}
const audit = {
	trials: trials.length,
	verified: trials.filter(({ data }) => data.verified).length,
	failures,
	operationErrors: trials.flatMap(({ name, data }) =>
		data.errors.map((error) => ({ name, ...error })),
	),
	samplerErrors: trials.flatMap(({ name, resources }) =>
		resources.errors.map((error) => ({ name, ...error })),
	),
};
await writeFile(
	join(root, "summary.json"),
	`${JSON.stringify({ environment, audit, summaries }, null, 2)}\n`,
);
const ms = (value) => (value == null ? "—" : value.toFixed(3)),
	mib = (value) => (value / 1048576).toFixed(2);
const lines = [
	"# Mutable byte-record kernel comparison",
	"",
	"Datasets: compact short JSON, repetitive CMS HTML, and entropy strings made from twenty SHA-256 hex digests. The latter is not incompressible binary. Large random binary values are covered by correctness tests, not this timing matrix.",
	"",
	"This is an internal kernel benchmark, not public iniBase API performance or feature parity. It stores identical JSON byte records using the mutable row kernel, SQLite BLOB and PostgreSQL BYTEA, with primary-ID disk indexes. Bulk commits contain at most 1,000 rows. Individual write cycles include a verifying point read; read cycles include byte verification and expected-fixture generation. Do not compare these latencies as a public-API speedup ratio.",
	"",
	`Flush policy: ${environment.flush}. ${environment.flushPolicy}`,
	"",
	"Fresh directories and three rotated trials; OS filesystem cache is not evicted. Reopen is not cold disk. There is no compaction/reclamation in this kernel; all obsolete bytes remain in measured storage. Large values stream in the engine and full reopen verification streams every ID, avoiding whole-dataset caller results. The cache/working allowance is not a total RSS limit. PostgreSQL process-tree RSS sums double-count shared mappings; allocated footprint includes the fresh complete cluster and WAL. CPU is client-only; sampler lists include live server processes but not complete exited-process CPU.",
	"",
	"| Dataset | Rows | Engine | Bulk ms | Random p50/p95 ms | Missing p50 ms | Insert cycle p50 ms | Update cycle p50 ms | Delete cycle p50 ms | Worker peak MiB | Tree sampled MiB | Accounted MiB | Allocated MiB |",
	"|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
];
for (const group of summaries)
	lines.push(
		`| ${group.profile} | ${group.rows} | ${group.engine} | ${ms(group.phases.bulkInsert)} | ${ms(group.latency.randomID?.p50)} / ${ms(group.latency.randomID?.p95)} | ${ms(group.latency.missingID?.p50)} | ${ms(group.latency.durableInsert?.p50)} | ${ms(group.latency.durableUpdate?.p50)} | ${ms(group.latency.durableDelete?.p50)} | ${mib(group.peakWorkerRss)} | ${mib(group.peakSampledTreeRss)} | ${group.engine === "inibase" ? mib(group.peakAccountedBytes) : "—"} | ${mib(group.allocated)} |`,
	);
lines.push(
	"",
	`Verified ${audit.verified}/${audit.trials}; failed/setup runs ${audit.failures.length}; operation errors ${audit.operationErrors.length}; sampler errors ${audit.samplerErrors.length}.`,
	"",
	"Raw trials retain all individual samples, commit-stage traces, CPU/resource samples, actual settings, errors and exact compiled module/tool hashes. p95 is omitted below 20 samples and p99 below 1,000. Three trials do not qualify endurance. The public API, application-key indexing, scans/projections, cross-table transactions, maintenance, migration and power-loss behavior remain outside this kernel comparison.",
	"",
);
await writeFile(join(root, "MEASUREMENTS.md"), lines.join("\n"));
console.log(audit);
