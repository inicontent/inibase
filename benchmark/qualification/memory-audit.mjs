import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";

const source = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
await mkdir(output);
const raw = await readFile(join(source, "summary.json"));
const data = JSON.parse(raw);
const limits = spawnSync(
	"/bin/bash",
	["-c", "set -e\nulimit -m 32768\nulimit -m"],
	{ encoding: "utf8" },
);
const inventory = spawnSync(
	"/bin/sh",
	[
		"-c",
		'for executable in docker podman limactl colima container; do command -v "$executable" || :; done',
	],
	{ encoding: "utf8" },
);
const evidence = {
	version: 1,
	date: new Date().toISOString(),
	platform: process.platform,
	os: os.release(),
	runtime: process.versions,
	source,
	sourceSummarySha256: createHash("sha256").update(raw).digest("hex"),
	trials: data.audit,
	cacheAllowanceBytes: data.metadata.budget,
	hardLimitTrialsExecuted: 0,
	rssLimitProbe: {
		code: limits.status,
		signal: limits.signal,
		stdout: limits.stdout,
		stderr: limits.stderr,
	},
	containerExecutableInventory: {
		code: inventory.status,
		stdout: inventory.stdout,
		stderr: inventory.stderr,
	},
	groups: data.summaries.map((group) => ({
		engine: group.engine,
		profile: group.profile,
		rows: group.rows,
		trials: group.trials,
		peakWorkerRssBytes: group.peakWorkerRss,
		peakSampledTreeRssBytes: group.peakSampledTreeRss,
		peakAccountedBytes: group.peakAccountedBytes,
		// Exceeding an RSS threshold is not an OOM prediction under reclaim.
		observedWorkerPeakAboveMiB: [64, 128, 256].filter(
			(mib) => group.peakWorkerRss > mib * 1048576,
		),
	})),
};
await writeFile(
	join(output, "audit.json"),
	`${JSON.stringify(evidence, null, 2)}\n`,
);
const mib = (bytes) => (bytes / 1048576).toFixed(2);
const lines = [
	"# Total-memory comparison: local qualification status",
	"",
	"No hard-total-memory benchmark has been qualified on this host. The local resident-memory-limit attempt and container executable inventory are retained in audit.json. The previous 81 verified trials had 16 MiB cache allowances, not total-memory limits. No new engine speed or constrained-memory result is claimed here.",
	"",
	"Observed maxima across three existing trials at 100,000 records (MiB):",
	"",
	"| Dataset | Engine | Worker peak RSS | Sampled server/client RSS sum | Engine accounting peak |",
	"|---|---|---:|---:|---:|",
];
for (const group of evidence.groups.filter((item) => item.rows === 100000))
	lines.push(
		`| ${group.profile} | ${group.engine} | ${mib(group.peakWorkerRssBytes)} | ${mib(group.peakSampledTreeRssBytes)} | ${group.engine === "inibase" ? mib(group.peakAccountedBytes) : "not instrumented"} |`,
	);
lines.push(
	"",
	"RSS includes the Node runtime, common PostgreSQL-driver harness, caller-requested materialized results and verification. PostgreSQL RSS sums double-count shared mappings; they are not physical-memory totals. Sampling can miss peaks. Engine accounting is incomplete and is not RSS. These observations neither establish which engine fits a hard limit nor predict how reclaim would change speed or memory. Do not subtract a runtime baseline and label the remainder engine memory.",
	"",
	"The Linux launcher in benchmark/qualification/memory-limit.mjs uses a fresh delegated cgroup per command, memory.max, memory.swap.max=0 and group OOM handling. It captures kernel memory/CPU/I/O counters and cleans descendants, including detached PostgreSQL processes. It refuses unsupported hosts rather than substituting a heap/cache setting. Its Linux execution and OOM containment remain unqualified on this Mac.",
	"",
	"Reproduce this audit from the repository root:",
	"",
	"```sh",
	`node benchmark/qualification/memory-audit.mjs ${source} /private/tmp/inibase-memory-audit-fresh`,
	"```",
	"",
	"The current public iniBase engine has no demonstrated total-memory advantage. SQLite remains the performance reference to beat; compact compressed files remain iniBase's demonstrated advantage in these particular configurations. Memory pressure cannot be assumed to reverse the measured speed ranking.",
	"",
);
await writeFile(join(output, "REPORT.md"), lines.join("\n"));
console.log(
	JSON.stringify({
		output,
		hardLimitTrialsExecuted: 0,
		sourceTrials: data.audit.trials,
	}),
);
