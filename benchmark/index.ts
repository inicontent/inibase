import { Console } from "node:console";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isExists } from "../src/file";
import Inibase, { type Schema, type TableConfig } from "../src/index";

const garbageCollection = async () => {
	if (typeof Bun === "undefined") {
		if (global.gc) global.gc();
	} else {
		(await import("bun")).gc(true);
	}
};

const currentUsedMemory = async () => {
	if (typeof Bun === "undefined") return process.memoryUsage().heapUsed;

	return (await import("bun:jsc")).heapSize();
};

const logger = new Console({
	stdout: process.stdout,
	stderr: process.stderr,
});

const db = new Inibase("test");

// Shared schema used across all benchmark tables
const userSchema: Schema = [
	{ key: "username", type: "string", required: true },
	{ key: "password", type: "password", required: true },
	{ key: "email", type: "email", required: true },
];

// Each entry describes a table variant to benchmark.
// `suffix` is appended to operation names in the results table.
const benchmarkTables: {
	table: string;
	config?: TableConfig;
	suffix: string;
}[] = [
	{ table: "user", suffix: "" },
	{ table: "user_prepend", config: { prepend: true }, suffix: " (prepend)" },
	{
		table: "user_compression",
		config: { compression: true },
		suffix: " (compression)",
	},
	{
		table: "user_decodeid",
		config: { decodeID: true },
		suffix: " (decode id)",
	},
];

// Re-create a table from scratch so every measurement runs against a
// deterministic empty state (ids restart at 1). This setup work is never part
// of the measured time.
const recreateTable = async (tableName: string, config?: TableConfig) => {
	await rm(join("test", tableName), { recursive: true, force: true });
	await db.createTable(tableName, userSchema, config);
};

// Bulk-seed `size` rows into a table (setup only, not measured).
const seedRows = (size: number) =>
	[...Array(size)].map((_, i) => ({
		username: `username_${i + 1}`,
		email: `email_${i + 1}@test.com`,
		password: `password_${i + 1}`,
	}));

// Helper function to measure time and memory usage
const measurePerformance = async (
	operation: "bulk" | "single",
	method: "POST" | "GET" | "PUT" | "DELETE",
	size: number,
	table: string,
) => {
	await garbageCollection();
	const startMemory = await currentUsedMemory();
	const startTime = Date.now();
	if (operation === "bulk") await bulkOperation(method, size, table);
	else await singleOperation(method, size, table);
	const endTime = Date.now();
	const endMemory = await currentUsedMemory();

	const timeTaken = `${endTime - startTime} ms`;
	const memoryUsed = `${((endMemory - startMemory) / (1024 * 1024)).toFixed(2)} mb`;

	return `${timeTaken} (${memoryUsed})`;
};

const bulkOperation = async (
	method: "POST" | "GET" | "PUT" | "DELETE",
	size: number,
	table: string,
) => {
	switch (method) {
		case "POST":
			await db.post(
				table,
				[...Array(size)].map((_, i) => ({
					username: `username_${i + 1}`,
					email: `email_${i + 1}@test.com`,
					password: `password_${i + 1}`,
				})),
			);
			break;
		case "GET":
			await db.get(
				table,
				[...Array(size)].map((_, i) => i + 1),
			);
			break;
		case "PUT":
			await db.put(
				table,
				{ username: "edited_username" },
				[...Array(size)].map((_, i) => i + 1),
			);
			break;
		case "DELETE":
			await db.delete(
				table,
				[...Array(size)].map((_, i) => i + 1),
			);
			break;
	}
};

// Function to measure a single database operation's time and memory
const singleOperation = async (
	operation: "POST" | "GET" | "PUT" | "DELETE",
	size: number,
	table: string,
) => {
	switch (operation) {
		case "POST":
			for (let i = 0; i < size; i++) {
				await db.post(table, {
					username: `username_${i + 1}`,
					email: `email_${i + 1}@test.com`,
					password: `password_${i + 1}`,
				});
			}
			break;
		case "GET":
			for (let i = 0; i < size; i++) {
				await db.get(table, i + 1);
			}
			break;
		case "PUT":
			for (let i = 0; i < size; i++) {
				await db.put(table, { username: "edited_username" }, i + 1);
			}
			break;
		case "DELETE":
			for (let i = 0; i < size; i++) {
				await db.delete(table, i + 1);
			}
			break;
	}
};

const results: Record<
	string,
	Record<string, Record<string | number, string>>
> = {};

// Delete test folder
if (await isExists("test")) await rm("test", { recursive: true });

// Create every table used in the benchmark
for (const { table: tableName, config } of benchmarkTables) {
	await db.createTable(tableName, userSchema, config);
}

// Capture arguments passed after "benchmark" (e.g., "--single" or "-s")
const argsFromCLI = process.argv.slice(2);

// Detect `--single` or `-s` flag
const hasSingleFlag =
	argsFromCLI.includes("--single") || argsFromCLI.includes("-s");

logger.group(
	`${hasSingleFlag ? "Single" : "Bulk"}${typeof Bun === "undefined" ? ":Node" : ":Bun"}`,
);

const operations = ["POST", "GET", "PUT", "DELETE"] as const;
const sizes = [10, 100, 1000];

// Initialize the results structure for each table variant / operation
for (const { table: tableName } of benchmarkTables) {
	results[tableName] = {};
	for (const operation of operations) {
		results[tableName][operation] = {};
	}
}

// For each table variant, operation and size, measure the performance
for (const { table: tableName, config } of benchmarkTables) {
	for (const operation of operations) {
		for (const size of sizes) {
			// Reset to a fresh table and, for reads/updates/deletes, seed it
			// with exactly `size` rows (ids 1..size). This keeps every
			// measurement valid and comparable across table configs (e.g.
			// decodeID tables delete by id, so stale ids would otherwise make
			// later rounds no-ops or even wipe the table).
			await recreateTable(tableName, config);
			if (operation !== "POST") await db.post(tableName, seedRows(size));

			results[tableName][operation][size] = await measurePerformance(
				hasSingleFlag ? "single" : "bulk",
				operation,
				size,
				tableName,
			);
		}
	}
}

// Display one dedicated table per variant (default, prepend, compression, decode id)
for (const { table: tableName, suffix } of benchmarkTables) {
	logger.group(`Table ${tableName}${suffix}`);
	logger.table(results[tableName]);
	logger.groupEnd();
}

// Delete the test folder the benchmark created, so it leaves no artifacts behind
await rm("test", { recursive: true, force: true });
