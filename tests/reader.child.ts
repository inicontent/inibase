// Concurrent reader used by tests/durability.test.ts. While writer children
// mutate the "jobs" table, this process loops whole-table reads and asserts the
// engine invariant "pagination total == every column line count == returned
// rows length" plus row completeness and id uniqueness. Any violation is
// reported to the parent and the child exits non-zero, so a torn/lost read
// fails the suite. The parent stops the loop with a "stop" message.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as File from "../src/file.js";
import Inibase from "../src/index.js";

const dbPath = process.argv[2];
const db = new Inibase(dbPath);

// Wait until the writers have created the table.
while (!(await db.getTable("jobs").catch(() => null)))
	await new Promise((resolve) => setTimeout(resolve, 10));

let reportedError: string | null = null;
let iterations = 0;
let stopping = false;
const startedAt = Date.now();

const countLines = async (file: string): Promise<number> => {
	const content = await readFile(file, "utf8");
	return content.split("\n").filter((line) => line.length > 0).length;
};

process.on("message", (message) => {
	if (message === "stop") {
		stopping = true;
	}
});

while (!stopping && Date.now() - startedAt < 30_000) {
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

	// The get() above MUST remain outside our snapshot lock: its row-completeness
	// and uniqueness assertions below exercise the engine's own reader locking.
	// Independent later readFile() calls cannot be compared to that snapshot:
	// another valid commit can occur between any two awaits (observed on Linux
	// as 97/97/97/98). Compare physical files/pagination in one coherent snapshot,
	// not several different generations. No assertion is skipped or retried.
	const tableDir = join(dbPath, "jobs");
	await File.runWithLockStore(async () => {
		const tmp = join(tableDir, ".tmp");
		await File.lock(tmp);
		try {
			const snapshot = await db.get("jobs", undefined, {
				page: 1,
				perPage: -1,
			});
			const [idLines, nameLines, workerLines, names] = await Promise.all([
				countLines(join(tableDir, "id.txt")),
				countLines(join(tableDir, "name.txt")),
				countLines(join(tableDir, "workerId.txt")),
				readdir(tableDir),
			]);
			const pagination = names.find((name) => name.endsWith(".pagination"));
			const total = Number(pagination?.match(/^\d+-(\d+)\.pagination$/)?.[1]);
			if (
				!(
					snapshot?.length === idLines &&
					idLines === nameLines &&
					nameLines === workerLines &&
					total === idLines
				)
			)
				reportedError ??= `torn snapshot: rows=${snapshot?.length} idLines=${idLines} nameLines=${nameLines} workerLines=${workerLines} total=${total}`;
		} finally {
			await File.unlock(tmp);
		}
	});

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
reportedError ??= stopping ? null : "reader timed out";
process.send?.({ iterations, error: reportedError });
process.exit(reportedError ? 1 : 0);
