// Run sequentially: measurements, immutable layout experiment, then profiling.
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";

const args = Object.fromEntries(
	process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")),
);
if (!args.baseline || !args.output)
	throw new Error(
		"--baseline=/frozen/dist/index.js and --output=/fresh/root are required",
	);
const root = resolve(args.output),
	optimized = resolve(args.optimized ?? "dist/index.js");
mkdirSync(root, { recursive: true });
const common = [
	`--baseline=${resolve(args.baseline)}`,
	`--optimized=${optimized}`,
	`--baselineCommit=${args.baselineCommit ?? "unspecified"}`,
	`--optimizedCommit=${args.optimizedCommit ?? "unspecified"}`,
	"--engines=baseline,optimized,sqlite",
	"--publicOptions=true",
	"--writes=2",
	"--pending=8",
	"--mixedRounds=2",
	"--mixedWrites=2",
];
const jobs = [
	[
		"measured-public",
		"local-run.mjs",
		[
			...common,
			"--rows=1000,10000,100000",
			"--profiles=compact,cms,mixed",
			"--repeats=3",
			"--samples=16",
		],
	],
	[
		"row-kernel",
		"rowpack.mjs",
		[
			`--dist=${resolve(optimized, "..")}`,
			"--rows=1000,10000,100000",
			"--profiles=compact,cms,entropy",
			"--repeats=3",
		],
	],
	[
		"profile",
		"local-run.mjs",
		[
			...common,
			"--rows=1000",
			"--profiles=compact",
			"--repeats=1",
			"--samples=32",
			"--instrument=true",
		],
	],
];
for (const [name, script, options] of jobs) {
	console.log(`Starting ${name}`);
	const log = openSync(join(root, `${name}.log`), "wx");
	let result;
	try {
		result = spawnSync(
			process.execPath,
			[
				new URL(script, import.meta.url).pathname,
				...options,
				`--output=${join(root, name)}`,
			],
			{ stdio: ["ignore", log, log] },
		);
	} finally {
		closeSync(log);
	}
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`${name} failed: ${result.status}/${result.signal}; inspect its retained log/results`,
		);
	console.log(`Completed ${name}`);
}
