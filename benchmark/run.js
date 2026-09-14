#!/usr/bin/env node

// Check if Bun is present
const isBun = typeof Bun !== "undefined";

const spawn = async (command) => {
	if (isBun) {
		const proc = Bun.spawn(command);
		console.log(await new Response(proc.stdout).text());
		await proc.exited;
	} else {
		// Forward stdout/stderr and propagate the real exit code so a failed
		// benchmark (e.g. an uncaught error) isn't silently reported as success.
		const { spawnSync } = await import("node:child_process");
		// npm prints `npm warn Unknown env config ...` for stray npm_config_*
		// variables exported by the user's shell (e.g. leaked from an npmrc or
		// other tooling). Strip them from the child's environment so the `npx`
		// invocation doesn't reject them and pollute the benchmark output with
		// warnings.
		const cleanedEnv = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (
				key !== "npm_config_npm_globalconfig" &&
				key !== "npm_config_verify_deps_before_run" &&
				key !== "npm_config__jsr_registry"
			)
				cleanedEnv[key] = value;
		}
		const result = spawnSync(command[0], command.slice(1), {
			env: cleanedEnv,
		});
		if (result.stdout) process.stdout.write(result.stdout.toString());
		if (result.stderr) process.stderr.write(result.stderr.toString());
		process.exit(result.status ?? 1);
	}
};

// Set up the default benchmark file path
const benchmarkFile = "./benchmark/index";

// Define the command based on the environment
const command = isBun
	? ["bun", benchmarkFile, ...process.argv.slice(2)] // Bun args
	: [
			"npx",
			"tsx",
			"--expose-gc",
			benchmarkFile,
			"--",
			...process.argv.slice(2),
		]; // Node.js args

// Execute the appropriate command
await spawn(command);
export {};
