// Multi-process writer used by tests/durability.test.ts. Each child process
// opens its own Inibase instance on the shared database directory and appends
// a fixed number of rows, so writers genuinely race across processes.
import Inibase from "../src/index.js";

const dbPath = process.argv[2];
const workerId = Number(process.argv[3]);
const rows = Number(process.argv[4]);

const schema = [
	{ key: "name", type: "string", required: true },
	{ key: "workerId", type: "number", required: true },
];

const db = new Inibase(dbPath);

// Wait until the table exists (some sibling may create it first), then create
// it ourselves if nobody has yet. decodeID:true makes every row's id decode to
// its raw numeric form so tests can assert the dense id sequence 1..N.
while (!(await db.getTable("jobs").catch(() => null))) {
	try {
		await db.createTable("jobs", schema, { decodeID: true });
	} catch {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

for (let i = 0; i < rows; i++) {
	let posted = false;
	for (let attempt = 0; attempt < 100 && !posted; attempt++) {
		try {
			await db.post(
				"jobs",
				{ name: `w${workerId}-r${i}`, workerId },
				undefined,
				true,
			);
			posted = true;
		} catch {
			// Table may still be mid-creation; retry.
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	if (!posted) {
		process.exitCode = 1;
		process.send?.("failed");
		process.exit(1);
	}
}

process.send?.("done");
process.exit(0);