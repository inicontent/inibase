// Run the existing durability measurement's full mode, respecting the task's fsync constraint.
import { fork } from "node:child_process";
import { resolve } from "node:path";
const path = resolve(process.argv[2] ?? "benchmark/durability.measure.ts");
const child = fork(path, ["full"], {
	execArgv: ["--import", "tsx"],
	env: { ...process.env, INIBASE_DURABILITY: "full" },
	stdio: ["ignore", "inherit", "inherit", "ipc"],
});
let received = false;
child.on("message", (result) => {
	received = true;
	console.log(JSON.stringify({ path, durability: "full", result }, null, 2));
});
child.on("error", (error) => {
	console.error(error);
	process.exitCode = 1;
});
child.on("exit", (code, signal) => {
	if (code !== 0 || !received) {
		console.error(JSON.stringify({ code, signal, received }));
		process.exitCode = 1;
	}
});
