import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2]);
const median = (values) => {
	const s = [...values].sort((a, b) => a - b);
	return s.length % 2
		? s[Math.floor(s.length / 2)]
		: (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const percentile = (values, p) =>
	[...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const summaries = [],
	audits = [];
for (const run of ["measured-row", "measured-small"]) {
	const directory = join(root, run),
		metadata = JSON.parse(
			await readFile(join(directory, "environment.json"), "utf8"),
		);
	const samples = [];
	for (const name of await readdir(directory))
		if (
			/^(baseline|rowpack|sqlite)-.*-\d+\.json$/.test(name) &&
			!name.includes(".resources.")
		)
			samples.push(JSON.parse(await readFile(join(directory, name), "utf8")));
	const failures = JSON.parse(
		await readFile(join(directory, "failures.json"), "utf8"),
	);
	audits.push({
		run,
		metadata,
		trials: samples.length,
		verified: samples.filter((row) => row.verified).length,
		failures,
	});
	for (const profile of ["compact", "cms", "entropy"])
		for (const rows of [1000, 10000, 100000])
			for (const engine of ["baseline", "rowpack", "sqlite"]) {
				const values = samples.filter(
					(row) =>
						row.config.profile === profile &&
						row.config.rows === rows &&
						row.config.engine === engine,
				);
				if (!values.length) continue;
				const resources = await Promise.all(
					values.map((row) =>
						readFile(
							join(
								directory,
								`${engine}-${profile}-${rows}-${row.config.repeat + 1}.resources.json`,
							),
							"utf8",
						).then(JSON.parse),
					),
				);
				const latency = values.flatMap((row) => row.latency);
				summaries.push({
					run,
					profile,
					rows,
					engine,
					trials: values.length,
					budget: metadata.budgetBytes,
					bulkMs: median(
						values.map((row) => row.timings.bulkIncludingEncoding),
					),
					p50: percentile(latency, 0.5),
					p95: percentile(latency, 0.95),
					p99: null,
					sampleCount: latency.length,
					allocated: median(values.map((row) => row.stored.allocated)),
					logical: median(values.map((row) => row.stored.logical)),
					peakRss: Math.max(
						...values.map((row) => row.endUsage.maxRSS * 1024),
						...resources.flatMap((row) =>
							row.samples.map((sample) => sample.rss ?? 0),
						),
					),
					runtimeRss: median(values.map((row) => row.runtimeRss)),
					peakAccounted: Math.max(
						0,
						...values.map((row) => row.memory?.peakAccountedBytes ?? 0),
					),
					peakTemporary: Math.max(
						0,
						...resources.flatMap((row) =>
							row.samples.map((sample) => sample.temporaryLogical ?? 0),
						),
					),
					peakTemporaryAllocated: Math.max(
						0,
						...resources.flatMap((row) =>
							row.samples.map((sample) => sample.temporaryAllocated ?? 0),
						),
					),
					cpuUserMs:
						median(
							values.map(
								(row) => row.endUsage.userCPUTime - row.startUsage.userCPUTime,
							),
						) / 1000,
					cpuSystemMs:
						median(
							values.map(
								(row) =>
									row.endUsage.systemCPUTime - row.startUsage.systemCPUTime,
							),
						) / 1000,
					racingPaths: resources.reduce(
						(sum, row) =>
							sum +
							row.samples.reduce(
								(sum, sample) => sum + (sample.racingPaths ?? 0),
								0,
							),
						0,
					),
					samplerErrors: resources.flatMap((row) =>
						row.samples.filter((sample) => sample.error),
					),
					indexBuild: values[0].indexBuild ?? null,
				});
			}
}
await writeFile(
	join(root, "summary.json"),
	JSON.stringify({ audits, summaries }, null, 2) + "\n",
);
const number = (n, d = 2) => Number(n).toFixed(d),
	mib = (n) => number(n / 1048576);
const lines = [
	"# Row construction measurements",
	"",
	"Immutable storage kernel only: these are not full iniBase API comparisons. Equal encoded JSON bytes and integer keys; row kernels gzip pages, SQLite stores opaque BLOBs with WAL/FULL. Three rotated trials, fresh directories, warm/OS-cache-affected reads, no cache eviction. Bulk includes caller fixture encoding, disk index construction and durable publication. SQLite checkpoint/close is separate and retained in raw results. High entropy means deterministic SHA-256 hex text, not incompressible binary.",
	"",
	"The baseline is the previous immutable row kernel. Candidate adds batched disk ID construction and reusable compression contexts. One MiB cache/reservation/page-cache settings apply to the main matrix; 256 KiB settings apply to the minimum-budget matrix. These are accounting/cache settings, not RSS limits. The replacement public runtime, mutable transactions and migration are not implemented by these measurements.",
	"",
	"| Run | Dataset | Rows | Engine | Bulk ms | Read p50 ms | Read p95 ms | Allocated MiB | Peak RSS MiB | Accounted MiB | Sampled temporary MiB | CPU user ms | CPU system ms |",
	"|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
];
for (const s of summaries)
	lines.push(
		`| ${s.run} | ${s.profile} | ${s.rows} | ${s.engine} | ${number(s.bulkMs)} | ${number(s.p50, 4)} | ${number(s.p95, 4)} | ${mib(s.allocated)} | ${mib(s.peakRss)} | ${mib(s.peakAccounted)} | ${mib(s.peakTemporary)} | ${number(s.cpuUserMs, 0)} | ${number(s.cpuSystemMs, 0)} |`,
	);
lines.push(
	"",
	"Read quantiles pool 384 samples across three trials. p99 is omitted. RSS is the maximum of sampled worker RSS and the worker maxRSS counter; the kernels spawn no descendants. Runtime baseline, phase heap/external/ArrayBuffer values, full CPU/I/O counters, logical/allocated disk and temporary samples are retained. Temporary peaks are sampled, not exact high-water marks; files disappearing during sampling are counted as racingPaths. Zero Darwin filesystem counters do not establish zero physical I/O.",
	"",
	"## Buffered index I/O",
	"",
	"Candidate counters count logical requested bytes and buffered readExact/writeExact operations, not device I/O or necessarily individual syscalls. They exclude the primary/page-directory writes and separate spool creation. The new builder deliberately exchanges extra sequential I/O and temporary storage for fewer small random operations and promises.",
	"",
	"| Rows | Entries | Read requests | Write requests | Read MiB | Write MiB | Spool MiB | Partitions |",
	"|---:|---:|---:|---:|---:|---:|---:|---:|",
);
for (const s of summaries.filter(
	(row) =>
		row.run === "measured-row" &&
		row.engine === "rowpack" &&
		row.profile === "compact",
)) {
	const i = s.indexBuild;
	lines.push(
		`| ${s.rows} | ${i.entries} | ${i.readCalls} | ${i.writeCalls} | ${mib(i.readBytes)} | ${mib(i.writeBytes)} | ${mib(i.spoolBytes)} | ${i.partitions} |`,
	);
}
lines.push(
	"",
	"## Audit",
	"",
	...audits.map(
		(a) =>
			`- ${a.run}: ${a.verified}/${a.trials} verified; ${a.failures.length} failed trials.`,
	),
	`- Sampler errors: ${summaries.reduce((sum, row) => sum + row.samplerErrors.length, 0)}.`,
	"- Earlier baseline-row, after-row, encoder-row and paired-row directories are discovery/stage measurements, not pooled into the final tables. paired-row retains three temporary/startup sampling races before the final sampler fix.",
	"- Core artifact identities and benchmark source hashes are in each environment.json. Baseline/candidate source archives, test logs, allocation/codec diagnostics and the saved original working edits are retained.",
	"- No fsync or lock weakening. SIGKILL tests are process-crash qualification, not power-loss qualification.",
	"- Memory accounting still does not cover the whole existing public engine. The row kernel remains experimental, retains old generations, and lacks mutable transaction/compaction/reclamation support.",
	"",
);
await writeFile(join(root, "MEASUREMENTS.md"), lines.join("\n"));
console.log(
	JSON.stringify(
		audits.map(({ run, trials, verified, failures }) => ({
			run,
			trials,
			verified,
			failures,
		})),
		null,
		2,
	),
);
