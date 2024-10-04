#!/usr/bin/env node

// Capture arguments passed after "benchmark" (e.g., "--single" or "-s")
const argsFromCLI = process.argv.slice(2);

// Detect `--single` or `-s` flag
const hasSingleFlag =
	argsFromCLI.includes("--single") || argsFromCLI.includes("-s");

// Check if Bun is present
const isBun = typeof Bun !== "undefined";

const spawn = async (command) => {
	if (isBun) {
		const proc = (await import("bun")).spawn(command);
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
const benchmarkFile = hasSingleFlag ? "./benchmark/single" : "./benchmark/bulk";

// Define the command based on the environment
const command = isBun
	? ["bun", benchmarkFile] // Bun args
	: ["npx", "tsx", "--expose-gc", benchmarkFile]; // Node.js args

// Execute the appropriate command
await spawn(command);
export {};
