import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2]);
const output = [];
for (const scenario of ["concurrent", "recovery"]) {
	const directory = join(
		root,
		scenario === "recovery" ? (process.argv[3] ?? "recovery") : scenario,
	);
	const failures = JSON.parse(
		await readFile(join(directory, "failures.json"), "utf8"),
	);
	const trials = [];
	for (const name of await readdir(directory)) {
		if (
			!/^(inibase|sqlite|postgres)-.*-\d+\.json$/.test(name) ||
			name.endsWith(".resources.json")
		)
			continue;
		const trial = JSON.parse(await readFile(join(directory, name), "utf8"));
		const resources = JSON.parse(
			await readFile(
				join(directory, name.replace(/\.json$/, ".resources.json")),
				"utf8",
			),
		);
		if (scenario === "concurrent") {
			trial.writers = [];
			for (let i = 0; i < 3; i++)
				trial.writers.push(
					JSON.parse(
						await readFile(join(directory, `${name}.writer${i}.json`), "utf8"),
					),
				);
		}
		trials.push({ trial, resources });
	}
	const percentile = (input, p) =>
		input.length
			? [...input].sort((a, b) => a - b)[Math.ceil(input.length * p) - 1]
			: null;
	const summary = ["inibase", "sqlite", "postgres"].map((engine) => {
		const group = trials.filter(({ trial }) => trial.options.engine === engine);
		const samples = group.flatMap(
			({ trial }) => trial.writers?.flatMap((writer) => writer.samples) ?? [],
		);
		return {
			engine,
			trials: group.length,
			verified: group.filter(
				({ trial, resources }) =>
					trial.verified && resources.status?.code === 0,
			).length,
			elapsedMs: group.map(({ trial }) => trial.elapsedMs ?? trial.reopenMs),
			firstVerifiedReadMs: group.map(
				({ trial }) => trial.firstVerifiedReadMs ?? null,
			),
			completeVerificationMs: group.map(
				({ trial }) => trial.completeVerificationMs ?? null,
			),
			writerCycleSamples: samples.length,
			writerCycleP50: percentile(samples, 0.5),
			writerCycleP95: samples.length >= 20 ? percentile(samples, 0.95) : null,
			writerCyclesPerSecond:
				scenario === "concurrent"
					? group.map(
							({ trial }) =>
								(3 * trial.options.writes * 1000) / trial.elapsedMs,
						)
					: null,
			readerReads: group.map(({ trial }) => trial.reader?.reads ?? null),
			acknowledgedCommitsChecked:
				scenario === "recovery"
					? group.map(({ trial }) => trial.acknowledgements.length)
					: null,
			postgresCrashRestartMs: group.map(
				({ trial }) => trial.serverCrashRestartMs ?? null,
			),
			peakSampledTreeRss: Math.max(
				0,
				...group.flatMap(({ resources }) =>
					resources.samples.map((sample) => sample.rss),
				),
			),
			operationErrors: group.flatMap(({ trial }) => trial.errors),
			samplerErrors: group.flatMap(({ resources }) => resources.errors),
		};
	});
	output.push({ scenario, failures, summary });
}
await writeFile(
	join(root, "SCENARIOS.json"),
	`${JSON.stringify(output, null, 2)}\n`,
);
console.log(
	output.map(({ scenario, failures, summary }) => ({
		scenario,
		failures,
		engines: summary.map(({ engine, trials, verified }) => ({
			engine,
			trials,
			verified,
		})),
	})),
);
