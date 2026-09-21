#!/usr/bin/env node
// Durability cost benchmark: compares the engine's write path under the two
// INIBASE_DURABILITY modes. `full` (default) fsyncs the temp column file +
// write-ahead journal (begin/commit) and the affected directories for every
// mutation — the honest, crash-atomic cost of DML. `none` keeps the journal
// protocol (process-crash safe, recovery identical) but skips every fsync:
// power-loss durability is lost, latency drops substantially.
//
// The durability knob is read at module load, so each mode runs in its own
// child process (benchmark/durability.measure.ts) whose results are reported
// side by side.
//
// Run: pnpm benchmark:durability
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const work = fileURLToPath(new URL("./durability.measure.ts", import.meta.url));

const measure = (mode: string) =>
	new Promise<Record<string, string>>((resolve, reject) => {
		const child = fork(work, [mode], {
			execArgv: ["--import", "tsx"],
			env: { ...process.env, INIBASE_DURABILITY: mode },
		});
		child.on("message", (message) =>
			resolve(message as Record<string, string>),
		);
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code !== 0)
				reject(new Error(`durability.measure (${mode}) exited ${code}`));
		});
	});

console.log("inibase durability benchmark — INIBASE_DURABILITY=full vs none\n");
console.log(
	"  full: temp file + journal (begin/commit) + directory fsyncs per op\n",
	"  none: same journal protocol, every fsync skipped (process-crash safe,\n",
	"        NOT power-loss durable)\n",
);
console.log(
	"mode  POST single      POST bulk        GET all       PUT by id      DELETE by id",
);
console.log(
	"----  --------------   --------------   -----------   -----------    -----------",
);

const full = await measure("full");
const none = await measure("none");

const row = (label: string, m: Record<string, string>) =>
	`${label.padEnd(5)} ${m.postSingle.padStart(8)}   ${m.postBulk.padStart(
		10,
	)}   ${m.getAll.padStart(8)}   ${m.put.padStart(8)}    ${m.del.padStart(8)}`;

console.log(row("full", full));
console.log(row("none", none));

console.log(
	"\nms/op unless noted (POST bulk/GET are totals). The delta is the fsync\n",
	"cost: `full` is the crash-atomic cost, `none` the same protocol without\n",
	"durability against power loss.",
);
