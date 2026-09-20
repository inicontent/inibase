// Concurrent reader used by tests/durability.test.ts. While writer children
// mutate the "jobs" table, this process loops whole-table reads and asserts the
// engine invariant "pagination total == every column line count == returned
// rows length" plus row completeness and id uniqueness. Any violation is
// reported to the parent and the child exits non-zero, so a torn/lost read
// fails the suite. The parent stops the loop with a "stop" message.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import Inibase from "../src/index.js";

const dbPath = process.argv[2];
const db = new Inibase(dbPath);

// Wait until the writers have created the table.
while (!(await db.getTable("jobs").catch(() => null)))
	await new Promise((resolve) => setTimeout(resolve, 10));

let reportedError: string | null = null;
let iterations = 0;
const startedAt = Date.now();

const countLines = async (file: string): Promise<number> => {
	const content = await readFile(file, "utf8");
	return content.split("\n").filter((line) => line.length > 0).length;
};

process.on("message", (message) => {
	if (message === "stop") {
		process.send?.({ iterations, error: reportedError });
		process.exit(reportedError ? 1 : 0);
	}
});

while (Date.now() - startedAt < 30_000) {
	iterations++;

	let rows: any[] | null = null;
	try {
		rows = (await db.get("jobs", undefined, {
			page: 1,
			perPage: -1,
		})) as any[];
	} catch (error) {
		reportedError ??= `read threw: ${String(error)}`;
		await new Promise((resolve) => setTimeout(resolve, 10));
		continue;
	}
	if (!rows) {
		await new Promise((resolve) => setTimeout(resolve, 5));
		continue;
	}

	const tableDir = join(dbPath, "jobs");
	const idLines = await countLines(join(tableDir, "id.txt"));
	const nameLines = await countLines(join(tableDir, "name.txt"));
	const workerLines = await countLines(join(tableDir, "workerId.txt"));

	// Invariant: pagination total == every column line count == rows returned.
	if (
		!(
			rows.length === idLines &&
			idLines === nameLines &&
			nameLines === workerLines
		)
	) {
		reportedError ??=
			`torn read: rows=${rows.length} idLines=${idLines} ` +
			`nameLines=${nameLines} workerLines=${workerLines}`;
	}

	// Invariant: every returned row is complete (no torn column cell).
	if (
		!rows.every(
			(row) =>
				typeof row.id === "number" &&
				typeof row.name === "string" &&
				typeof row.workerId === "number",
		)
	)
		reportedError ??= "incomplete row in read";

	// Invariant: no duplicates inside a single read (lost/duplicated rows).
	const seen = new Set<number>();
	for (const row of rows) {
		const id = Number(row.id);
		if (seen.has(id)) {
			reportedError ??= `duplicate id ${id} in a single read`;
			break;
		}
		seen.add(id);
	}

	await new Promise((resolve) => setTimeout(resolve, 2));
}

// Parent never stopped us (e.g. it crashed): report and exit.
process.send?.({ iterations, error: reportedError ?? "reader timed out" });
process.exit(reportedError ? 1 : 0);