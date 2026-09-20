// Durability & concurrency guarantees: write-ahead journal crash recovery,
// per-table writer lock (multi-process), stale-lock stealing and the absence
// of temp/journal/backup leftovers after any commit.
import { strict as assert } from "node:assert";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import Inibase from "../src/index.js";
import * as File from "../src/file.js";

const dbPath = "test-db-durability";

function removeDatabase() {
	if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
}

let db: Inibase;

const simpleSchema = [
	{ key: "name", type: "string", required: true },
	{ key: "workerId", type: "number", required: true },
];

const tableDir = (tableName: string) => join(dbPath, tableName);
const tmpDir = (tableName: string) => join(tableDir(tableName), ".tmp");
const journalPath = (tableName: string) => join(tmpDir(tableName), "journal.jsonl");
const lockPath = (tableName: string) => join(tmpDir(tableName), ".locked");
const backupDir = (tableName: string) => join(tmpDir(tableName), "backup");
const colFiles = (tableName: string) =>
	["id", "name", "workerId"].map((key) =>
		join(tableDir(tableName), `${key}.txt`),
	);

/** Entries left in `.tmp` after a commit (the empty backup dir is expected). */
const tmpLeftovers = async (tableName: string) =>
	(await readdir(tmpDir(tableName)).catch(() => [] as string[])).filter(
		(entry) => entry !== "backup",
	);

const paginationName = async (tableName: string) => {
	const names = (await readdir(tableDir(tableName))).filter((name) =>
		name.endsWith(".pagination"),
	);
	assert.equal(names.length, 1, "exactly one pagination file");
	return names[0];
};

/** Build the exact artifacts a crashed post() would leave behind. */
async function craftCrashTable(tableName: string, committed: boolean) {
	const paths = colFiles(tableName);
	// commitFiles parks originals under .tmp/backup/<txn>/; recovery is
	// path-agnostic but the simulation should match reality.
	const txn = "sim-crash";
	const backup = join(backupDir(tableName), txn);
	await mkdir(backup, { recursive: true });

	const row2 = { id: 2, name: "b", workerId: 2 };
	const contents: Record<string, string | number> = {
		"id.txt": File.encode(row2.id) as string | number,
		"name.txt": File.encode(row2.name) as string | number,
		"workerId.txt": File.encode(row2.workerId) as string | number,
	};

	const temps = await Promise.all(
		paths.map((path) =>
			File.append(path, contents[basename(path)] as string | number),
		),
	);

	const ops = temps.map(([tmp, live]) => ({
		live,
		backup: join(backup, basename(live)),
		tmp,
		existed: true,
	}));

	if (committed) {
		// Full swap for every column (matches the real writer after commit).
		for (const op of ops) {
			await rename(op.live, op.backup);
			await rename(op.tmp as string, op.live);
		}
	} else {
		// Partial swap: id + name are already replaced, workerId still sits as
		// a temp file in `.tmp` (crash mid-commit).
		for (const op of ops.slice(0, 2)) {
			await rename(op.live, op.backup);
			await rename(op.tmp as string, op.live);
		}
	}

	const pagination = {
		from: join(tableDir(tableName), "1-1.pagination"),
		to: join(tableDir(tableName), "2-2.pagination"),
	};

	const entries: object[] = [
		{ txn: "sim-crash", type: "begin", files: ops, pagination },
	];
	if (committed) entries.push({ txn: "sim-crash", type: "commit" });
	await writeFile(
		journalPath(tableName),
		entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
	);
}

await test("Initialize durability database", async () => {
	removeDatabase();
	mkdirSync(dbPath, { recursive: true });
	db = new Inibase(dbPath);
	assert.ok(db, "Inibase instance should be initialized");
});

await test("Crash without commit marker rolls the write back", async () => {
	const tableName = "t1";
	await db.createTable(tableName, simpleSchema);
	await db.post(tableName, { name: "a", workerId: 1 }, undefined, true);

	// Simulate a crash mid-post of the second row: journal has `begin` only.
	await craftCrashTable(tableName, false);

	// The next read runs recovery first and must see only the old row.
	const rows = (await db.get(tableName, undefined, {
		page: 1,
		perPage: -1,
	})) as any[];
	assert.equal(rows.length, 1, "partially committed row must be rolled back");
	assert.equal(rows[0].name, "a");
	assert.equal(rows[0].workerId, 1);
	assert.equal(
		await paginationName(tableName),
		"1-1.pagination",
		"pagination count must be restored",
	);
	assert.deepEqual(
		await tmpLeftovers(tableName),
		[],
		"journal/temps/backups must be cleaned up after rollback",
	);
});

await test("Crash with commit marker rolls the write forward", async () => {
	const tableName = "t2";
	await db.createTable(tableName, simpleSchema);
	await db.post(tableName, { name: "a", workerId: 1 }, undefined, true);

	// Simulate a crash after commit: journal has `begin` + `commit`, but the
	// pagination rename may not have completed yet.
	await craftCrashTable(tableName, true);

	const rows = (await db.get(tableName, undefined, {
		page: 1,
		perPage: -1,
	})) as any[];
	assert.equal(rows.length, 2, "committed write must survive");
	const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
	assert.equal(byName["a"]?.workerId, 1);
	assert.equal(byName["b"]?.workerId, 2);
	assert.equal(
		await paginationName(tableName),
		"2-2.pagination",
		"pagination rename must be completed on roll-forward",
	);
	assert.deepEqual(
		await tmpLeftovers(tableName),
		[],
		"journal/temps/backups must be cleaned up after roll-forward",
	);
});

await test("Stale lock from a dead process is stolen", async () => {
	const tableName = "t3";
	await db.createTable(tableName, simpleSchema);

	// Park a lock whose recorded owner PID is dead and whose mtime is old.
	const deadPid = 999_999_99;
	await writeFile(
		lockPath(tableName),
		JSON.stringify({
			pid: deadPid,
			host: hostname(),
			startedAt: Date.now() - 2 * 60_000,
		}),
	);
	await utimes(
		lockPath(tableName),
		new Date(Date.now() - 2 * 60_000),
		new Date(Date.now() - 2 * 60_000),
	);

	// A write must detect the dead owner and proceed rather than hang.
	await db.post(tableName, { name: "x", workerId: 9 }, undefined, true);
	const rows = (await db.get(tableName, undefined, {
		page: 1,
		perPage: -1,
	})) as any[];
	assert.equal(rows.length, 1);
	assert.equal(rows[0].name, "x");
	assert.ok(
		!(await File.isExists(lockPath(tableName))),
		"lock releases after the write",
	);
});

await test("Lock held by a live same-host process is never stolen", async () => {
	const tableName = "t5";
	await db.createTable(tableName, simpleSchema);
	const tmp = join(tableDir(tableName), ".tmp");

	// A separate process acquires and holds the lock for 3s.
	const holder = fork(
		fileURLToPath(new URL("./lock.holder.child.ts", import.meta.url)),
		[tmp, "3000"],
		{ execArgv: ["--import", "tsx"] },
	);
	await new Promise<void>((resolve, reject) => {
		holder.on("message", (message) => {
			if (message === "locked") resolve();
		});
		holder.on("error", reject);
	});

	// Age the lock file so the TTL steal check would fire... but the recorded
	// owner is still alive on this host, so the steal must be refused.
	const aged = new Date(Date.now() - 5 * 60_000);
	await utimes(lockPath(tableName), aged, aged);

	let acquiredWhileAlive = false;
	const contender = File.lock(tmp, undefined, 50).then(() => {
		acquiredWhileAlive = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 800));
	assert.equal(
		acquiredWhileAlive,
		false,
		"a live same-host owner's lock must not be stolen",
	);

	// Once the holder releases, the contender acquires and we clean up.
	await contender;
	await File.unlock(tmp);
	await new Promise<void>((resolve) =>
		setTimeout(() => {
			holder.kill();
			resolve();
		}, 100),
	);
});

await test("No temp/journal/backup leftovers after a DML cycle", async () => {
	const tableName = "t4";
	await db.createTable(tableName, simpleSchema);
	for (let i = 0; i < 5; i++)
		await db.post(
			tableName,
			{ name: `n${i}`, workerId: i },
			undefined,
			true,
		);
	assert.equal(
		await paginationName(tableName),
		"5-5.pagination",
		"pagination after 5 posts",
	);
	assert.deepEqual(
		await tmpLeftovers(tableName),
		[],
		"no leftovers after posts",
	);

	await db.put(tableName, { workerId: 100 }, 3);
	assert.deepEqual(
		await tmpLeftovers(tableName),
		[],
		"no leftovers after put",
	);

	await db.delete(tableName, 2);
	assert.equal(
		await paginationName(tableName),
		"5-4.pagination",
		"pagination after a delete",
	);

	const idLines = (await readFile(join(tableDir(tableName), "id.txt"), "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean);
	assert.equal(idLines.length, 4, "column line count matches pagination");
	assert.deepEqual(
		await tmpLeftovers(tableName),
		[],
		"no leftovers after delete",
	);
});

await test(
	"Table rename moves the lock with the directory and releases it there",
	{ timeout: 15_000 },
	async () => {
		const tableName = "t6";
		const renamed = "t6-renamed";
		await db.createTable(tableName, simpleSchema);
		await db.post(tableName, { name: "keep", workerId: 1 }, undefined, true);

		await db.updateTable(tableName, undefined, { name: renamed });

		// The renamed table must not be blocked by a stale live-owner lock in
		// its moved .tmp directory.
		await db.post(renamed, { name: "more", workerId: 2 }, undefined, true);
		const rows = (await db.get(renamed, undefined, {
			page: 1,
			perPage: -1,
		})) as any[];
		assert.equal(rows.length, 2, "writes to a renamed table succeed");
		assert.ok(
			!(await File.isExists(lockPath(renamed))),
			"no stale lock file left in the renamed table",
		);
	},
);

await test("Multi-process concurrent writers stay consistent", async () => {
	const workers = 4;
	const rowsPerWorker = 20;
	const expected = workers * rowsPerWorker;

	const children = Array.from({ length: workers }, (_, index) => {
		return new Promise<void>((resolveChild, reject) => {
			const child = fork(
				fileURLToPath(new URL("./writer.child.ts", import.meta.url)),
				[dbPath, String(index), String(rowsPerWorker)],
				{ execArgv: ["--import", "tsx"] },
			);
			let settled = false;
			child.on("message", () => {
				settled = true;
				resolveChild();
			});
			child.on("error", (error) => {
				if (!settled) reject(error);
			});
			child.on("exit", (code) => {
				if (!settled && code !== 0)
					reject(new Error(`writer child ${index} exited with ${code}`));
			});
		});
	});
	await Promise.all(children);

	const rows = (await db.get("jobs", undefined, {
		page: 1,
		perPage: -1,
	})) as any[];
	assert.equal(rows.length, expected, "all rows from every process present");

	const ids = rows.map((row) => Number(row.id)).sort((a, b) => a - b);
	assert.deepEqual(
		ids,
		Array.from({ length: expected }, (_, index) => index + 1),
		"ids must be the dense sequence 1..N (no lost or duplicated rows)",
	);
	for (const row of rows) {
		assert.equal(typeof row.name, "string", "row name column complete");
		assert.equal(
			typeof row.workerId,
			"number",
			"row workerId column complete",
		);
	}

	assert.deepEqual(
		await tmpLeftovers("jobs"),
		[],
		"no journal/temp/backup leftovers after concurrent writes",
	);
	// 80 distinct workers-written names: no interleaved/torn rows.
	const names = new Set(rows.map((row) => row.name));
	assert.equal(names.size, expected);
});

await test("Concurrent readers never observe torn rows while writers write", async () => {
	const tableName = "jobs";

	// Spawn a reader that loops whole-table reads and validates the invariant
	// rows == all-column line counts == pagination total on every read.
	const reader = fork(
		fileURLToPath(new URL("./reader.child.ts", import.meta.url)),
		[dbPath],
		{ execArgv: ["--import", "tsx"] },
	);

	// Writers run while the reader is sampling.
	const workers = 3;
	const rowsPerWorker = 10;
	const writerChildren = Array.from({ length: workers }, (_, index) => {
		return new Promise<void>((resolveChild, reject) => {
			const child = fork(
				fileURLToPath(new URL("./writer.child.ts", import.meta.url)),
				[dbPath, String(100 + index), String(rowsPerWorker)],
				{ execArgv: ["--import", "tsx"] },
			);
			let settled = false;
			child.on("message", () => {
				settled = true;
				resolveChild();
			});
			child.on("error", (error) => {
				if (!settled) reject(error);
			});
			child.on("exit", (code) => {
				if (!settled && code !== 0)
					reject(
						new Error(`reader-test writer child ${index} exited with ${code}`),
					);
			});
		});
	});
	await Promise.all(writerChildren);

	// Stop the reader and collect its verdict.
	reader.send("stop");
	const verdict = await new Promise<{ code: number; out: any }>(
		(resolve, reject) => {
			let out: any = null;
			reader.on("message", (message) => {
				out = message;
			});
			reader.on("exit", (code) => resolve({ code, out }));
			reader.on("error", reject);
		},
	);
	assert.equal(
		verdict.code,
		0,
		`reader observed torn state: ${JSON.stringify(verdict.out)}`,
	);
	assert.ok(
		(verdict.out?.iterations ?? 0) > 0,
		"reader actually sampled the table",
	);
});

await test("Cleanup durability database", async () => {
	removeDatabase();
});