import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// The supervisor stays outside the group so it can retain evidence after OOM.
const divider = process.argv.indexOf("--");
const options = Object.fromEntries(
	process.argv.slice(2, divider < 0 ? undefined : divider).map((arg) => {
		const equals = arg.indexOf("=");
		return [arg.slice(2, equals), arg.slice(equals + 1)];
	}),
);
const command = divider < 0 ? [] : process.argv.slice(divider + 1);
const bytes = Number(options.bytes);
if (
	!options.output ||
	!Number.isSafeInteger(bytes) ||
	bytes < 1048576 ||
	!command.length
)
	throw new Error(
		"Usage: node memory-limit.mjs --bytes=67108864 --parent=/delegated/cgroup --output=/fresh/results -- command arguments...",
	);
const output = resolve(options.output);
await mkdir(output); // Never overwrite prior failures or samples.
const evidence = {
	version: 1,
	date: new Date().toISOString(),
	platform: process.platform,
	command,
	bytes,
	swapBytes: 0,
	qualified: false,
	status: "preflight",
	notes: [
		"The command and all descendants, including detached PostgreSQL servers, share one cgroup.",
		"The command's benchmark harness and charged filesystem cache count against memory.max.",
		"The supervisor is outside the limit. Existing host cache charges are not reset or globally evicted.",
		"Kernel memory.max can temporarily overshoot; this is not an exact RSS cap.",
	],
};
let group, child, terminationTimer;
const counters = async () => {
	const result = {};
	for (const name of [
		"memory.max",
		"memory.swap.max",
		"memory.oom.group",
		"memory.current",
		"memory.peak",
		"memory.events",
		"memory.stat",
		"memory.pressure",
		"cpu.stat",
		"io.stat",
		"cgroup.events",
	])
		result[name] = await readFile(join(group, name), "utf8").catch((error) => ({
			error: error.code,
		}));
	return result;
};
const onSignal = (signal) => {
	evidence.interrupted = signal;
	child?.kill(signal);
	// Give the benchmark time to stop its private server; then contain stragglers.
	terminationTimer ??= setTimeout(() => {
		if (group)
			writeFile(join(group, "cgroup.kill"), "1").catch((error) => {
				evidence.signalCleanupError = error.message;
			});
	}, 10000);
	terminationTimer.unref();
};
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));
try {
	if (process.platform !== "linux")
		throw new Error(
			"Hard-limit trials require Linux cgroup v2; no cache/RSS-watchdog fallback is accepted.",
		);
	if (!options.parent)
		throw new Error(
			"An explicitly delegated cgroup parent is required; the launcher does not modify host controller settings.",
		);
	const root = await realpath("/sys/fs/cgroup");
	const parent = await realpath(options.parent);
	if (parent !== root && !parent.startsWith(`${root}/`))
		throw new Error(
			"Parent must be inside the mounted /sys/fs/cgroup hierarchy.",
		);
	const controllers = await readFile(
		join(parent, "cgroup.subtree_control"),
		"utf8",
	);
	if (!controllers.split(/\s+/).includes("memory"))
		throw new Error("Delegated parent has not enabled its memory controller.");
	const candidate = join(parent, `inibase-qualification-${randomUUID()}`);
	await mkdir(candidate);
	group = candidate;
	evidence.cgroup = group;
	await writeFile(join(group, "memory.max"), String(bytes));
	await writeFile(join(group, "memory.swap.max"), "0");
	await writeFile(join(group, "memory.oom.group"), "1");
	// Require group cleanup support before starting any command.
	await writeFile(join(group, "cgroup.kill"), "1");
	evidence.before = await counters();
	if (
		evidence.before["memory.max"].trim() !== String(bytes) ||
		evidence.before["memory.swap.max"].trim() !== "0" ||
		evidence.before["memory.oom.group"].trim() !== "1"
	)
		throw new Error("Kernel did not retain requested limits.");
	// Positional arguments avoid interpolating paths/commands into shell code.
	child = spawn(
		"/bin/sh",
		[
			"-c",
			'printf "%s\\n" "$$" > "$1/cgroup.procs" || exit 125; shift; exec "$@"',
			"inibase-memory",
			group,
			...command,
		],
		{ stdio: "inherit" },
	);
	evidence.status = "running";
	evidence.exit = await new Promise((accept, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => accept({ code, signal }));
	});
	evidence.after = await counters();
	const events = Object.fromEntries(
		evidence.after["memory.events"]
			.trim()
			.split("\n")
			.map((line) => line.split(/\s+/)),
	);
	evidence.oomKills = Number(events.oom_kill ?? 0);
	evidence.status = evidence.oomKills ? "oom" : "exited";
	evidence.qualified =
		evidence.exit.code === 0 && !evidence.oomKills && !evidence.interrupted;
	process.exitCode = evidence.qualified ? 0 : 1;
} catch (error) {
	evidence.status = "unqualified";
	evidence.error = error.message;
	process.exitCode = 1;
} finally {
	clearTimeout(terminationTimer);
	if (group) {
		try {
			evidence.remainingPids = (
				await readFile(join(group, "cgroup.procs"), "utf8")
			).trim();
			if (evidence.remainingPids) {
				evidence.qualified = false;
				process.exitCode = 1;
				await writeFile(join(group, "cgroup.kill"), "1");
			}
			for (let attempt = 0; attempt < 100; attempt++) {
				if (
					/^populated 0$/m.test(
						await readFile(join(group, "cgroup.events"), "utf8"),
					)
				)
					break;
				await new Promise((accept) => setTimeout(accept, 50));
			}
			evidence.final = await counters();
			await rmdir(group);
			evidence.cleaned = true;
		} catch (error) {
			evidence.cleanupError = error.message;
			evidence.qualified = false;
			process.exitCode = 1;
		}
	}
	await writeFile(
		join(output, "memory-limit.json"),
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
}
