#!/usr/bin/env node

// Check if Bun is present
const isBun = typeof Bun !== "undefined";

const spawn = async (command) => {
	if (isBun) {
		const proc = Bun.spawn(command);
		console.log(await new Response(proc.stdout).text());
		await proc.exited;
	} else
		console.log(
			(await import("node:child_process"))
				.spawnSync(command[0], command.slice(1))
				.stdout.toString(),
		);
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
