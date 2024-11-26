import { isExists } from "../src/file";
import Inibase from "../src/index";
import { rm } from "node:fs/promises";
import { Console } from "node:console";

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

// Helper function to measure time and memory usage
const measurePerformance = async (
	operation: "bulk" | "single",
	method: "POST" | "GET" | "PUT" | "DELETE",
	size: number,
) => {
	await garbageCollection();
	const startMemory = await currentUsedMemory();
	const startTime = Date.now();
	if (operation === "bulk") await bulkOperation(method, size);
	else await singleOperation(method, 10);
	const endTime = Date.now();
	const endMemory = await currentUsedMemory();

	const timeTaken = `${endTime - startTime} ms`;
	const memoryUsed = `${((endMemory - startMemory) / (1024 * 1024)).toFixed(2)} mb`;

	return { [`${method}${size}`]: `${timeTaken} (${memoryUsed})` };
};

const bulkOperation = async (
	method: "POST" | "GET" | "PUT" | "DELETE",
	size: number,
) => {
	switch (method) {
		case "POST":
			await db.post(
				"user",
				[...Array(size)].map((_, i) => ({
					username: `username_${i + 1}`,
					email: `email_${i + 1}@test.com`,
					password: `password_${i + 1}`,
				})),
			);
			break;
		case "GET":
			await db.get(
				"user",
				[...Array(size)].map((_, i) => i + 1),
			);
			break;
		case "PUT":
			await db.put(
				"user",
				{ username: "edited_username" },
				[...Array(size)].map((_, i) => i + 1),
			);
			break;
		case "DELETE":
			await db.delete(
				"user",
				[...Array(size)].map((_, i) => i + 1),
			);
			break;
	}
};

// Function to measure a single database operation's time and memory
const singleOperation = async (
	operation: "POST" | "GET" | "PUT" | "DELETE",
	size: number,
) => {
	switch (operation) {
		case "POST":
			for (let i = 0; i < size; i++) {
				await db.post("user", {
					username: `username_${i + 1}`,
					email: `email_${i + 1}@test.com`,
					password: `password_${i + 1}`,
				});
			}
			break;
		case "GET":
			for (let i = 0; i < size; i++) {
				await db.get("user", i + 1);
			}
			break;
		case "PUT":
			for (let i = 0; i < size; i++) {
				await db.put("user", { username: "edited_username" }, i + 1);
			}
			break;
		case "DELETE":
			for (let i = 0; i < size; i++) {
				await db.delete("user", i + 1);
			}
			break;
	}
};

const table: Record<string, Record<string | number, string | number>> = {};

// Delete test folder
if (await isExists("test")) await rm("test", { recursive: true });

await db.createTable("user", [
	{ key: "username", type: "string", required: true },
	{ key: "password", type: "password", required: true },
	{ key: "email", type: "email", required: true },
]);

// Capture arguments passed after "benchmark" (e.g., "--single" or "-s")
const argsFromCLI = process.argv.slice(2);

// Detect `--single` or `-s` flag
const hasSingleFlag =
	argsFromCLI.includes("--single") || argsFromCLI.includes("-s");

logger.group(
	`${hasSingleFlag ? "Single" : "Bulk"}${typeof Bun === "undefined" ? ":Node" : ":Bun"}`,
);

// Initialize table
const operations = ["POST", "GET", "PUT", "DELETE"] as const;
const sizes = [10, 100, 1000];

// Initialize the table structure for each operation
for (const operation of operations) table[operation] = {}; // Initialize the row for this operation

// For each operation and size, we measure the performance
for (const operation of operations) {
	for (const size of sizes) {
		const performance = await measurePerformance(
			hasSingleFlag ? "single" : "bulk",
			operation,
			size,
		);
		// Ensure that the performance result is assigned correctly
		table[operation][size] = performance[`${operation}${size}`];
	}
}

// Remove the "METHOD" key from the table to avoid the last column
const tableWithoutMethod = Object.fromEntries(
	Object.entries(table).map(([operation, values]) => {
		const { METHOD, ...rest } = values; // Remove METHOD key
		return [operation, rest];
	}),
);

// Display the table without the "METHOD" column and empty first cell in the first row
logger.table(tableWithoutMethod);
logger.groupEnd();
