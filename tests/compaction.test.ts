// Phase 3: compaction. Materializes the overlay onto base columns, resets the
// log, bumps baseGen atomically (crash-safe via the existing journal), and keeps
// reads/fresh instances/backpressure correct before and after.
import { strict as assert } from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { test } from "node:test";
import * as File from "../src/file.js";
import Inibase, { type Schema } from "../src/index.js";
import { Journal, type JournalFileOp } from "../src/journal.js";

const dbPath = "test-db-updatelog-compact";

const schema: Schema = [
	{ key: "username", type: "string", required: true },
	{ key: "score", type: "number", required: true },
	{ key: "seq", type: "number", required: true },
];

function freshDb() {
	if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
	return new Inibase(dbPath);
}

const seed = (count: number) =>
	Array.from({ length: count }, (_, index) => ({
		username: `user${index + 1}`,
		score: (index + 1) * 10,
		seq: index + 1,
	}));

const baseScoreAt = async (id: number) =>
	Number(
		(await readFile(join(dbPath, "records", "score.txt"), "utf8"))
			.trimEnd()
			.split("\n")[id - 1],
	);

test("compact folds the overlay into base and resets the log", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(5));

	await db.put("records", { score: 100 }, 1);
	await db.put("records", { score: 200 }, 2);
	await db.put("records", { score: 999 }, 3);

	// Base still stale before compaction.
	assert.equal(await baseScoreAt(1), 10);
	const logBefore = await readFile(join(dbPath, "records", "updates.log"));
	assert.ok(logBefore.length > 0);

	// Capture the merged updatedAt/createdAt before compaction: the overlayed
	// `updatedAt` must materialize into the base byte-for-byte identically.
	const before = (await db.get("records", 1)) as any;

	const newGen = await db.compact("records");
	assert.notEqual(newGen, null);

	// Base now carries the merged values.
	assert.equal(await baseScoreAt(1), 100);
	assert.equal(await baseScoreAt(2), 200);
	assert.equal(await baseScoreAt(3), 999);
	assert.equal(await baseScoreAt(4), 40);
	assert.equal(await baseScoreAt(5), 50);

	// The merged row is unchanged by compaction (including the overlayed
	// `updatedAt`, which materializes into the base column identically).
	const after = (await db.get("records", 1)) as any;
	assert.deepEqual(after, before);
	assert.equal(typeof after.updatedAt, "number");

	// Log reset, marker bumped.
	assert.equal(
		(await readFile(join(dbPath, "records", "updates.log"))).length,
		0,
	);
	const marker = JSON.parse(
		await readFile(join(dbPath, "records", ".format"), "utf8"),
	);
	assert.equal(marker.baseGen, newGen);

	// Reads still correct after compaction (overlay empty, base merged).
	const rows = (await db.get("records", undefined, { perPage: -1 })) as any[];
	assert.deepEqual(
		rows.map((r) => r.score),
		[100, 200, 999, 40, 50],
	);

	// The journaled commit leaves no staging/backup leftovers behind. As in
	// the durability suite, an empty root `.tmp/backup` dir is expected.
	const leftovers = (
		await readdir(join(dbPath, "records", ".tmp")).catch(() => [] as string[])
	).filter((entry) => entry !== "backup");
	assert.deepEqual(leftovers, []);
	rmSync(dbPath, { recursive: true, force: true });
});

test("puts after compaction keep working and reads stay merged", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(5));

	await db.put("records", { score: 100 }, 1);
	await db.compact("records");
	// Post-compaction put goes through the log again. An overlay that only
	// touches `score` for a subset of rows leaves `seq` resolvable from base.
	await db.put("records", { score: 55 }, 1);
	await db.put("records", { score: 7 }, { seq: 2 });

	assert.equal(((await db.get("records", 1)) as any).score, 55);
	assert.equal(((await db.get("records", 2)) as any).score, 7);
	assert.equal(((await db.get("records", 3)) as any).score, 30);

	// Base has the pre-compaction values; the new puts only live in the log.
	assert.equal(await baseScoreAt(1), 100);
	assert.equal(await baseScoreAt(2), 20);
	assert.equal(await baseScoreAt(3), 30);
	rmSync(dbPath, { recursive: true, force: true });
});

test("a fresh instance reads a compacted table without replaying old frames", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(3));
	await db.put("records", { score: 300 }, 1);
	await db.compact("records");
	await db.put("records", { score: 400 }, 1);

	const reopened = new Inibase(dbPath);
	assert.equal(((await reopened.get("records", 1)) as any).score, 400);
	assert.equal(((await reopened.get("records", 2)) as any).score, 20);

	// The reopened writer appends with the new generation.
	await reopened.put("records", { score: 500 }, 1);
	assert.equal(((await reopened.get("records", 1)) as any).score, 500);
	rmSync(dbPath, { recursive: true, force: true });
});

test("a second open instance revalidates the marker after another compacts", async () => {
	const writer = freshDb();
	await writer.createTable("records", schema, { log: true, decodeID: true });
	await writer.post("records", seed(5));

	// The reader caches the format (baseGen) and an empty overlay up front.
	const reader = new Inibase(dbPath);
	assert.equal(((await reader.get("records", 1)) as any).score, 10);

	// Writer: put + compact (+ a post-compaction put), all while the reader's
	// cached marker+overlay are stale. A reader that failed to revalidate would
	// scan the log at the old baseGen and either return stale values or (once a
	// post-compaction frame appears) misread a generation gap as corruption.
	await writer.put("records", { score: 100 }, 1);
	await writer.compact("records");
	await writer.put("records", { score: 55 }, 1);

	assert.equal(((await reader.get("records", 1)) as any).score, 55);
	assert.equal(((await reader.get("records", 2)) as any).score, 20);
	assert.equal(((await reader.get("records", 3)) as any).score, 30);

	// Agrregate scans on the stale instance also see the merged view.
	assert.equal(await reader.sum("records", "score"), 195);
	rmSync(dbPath, { recursive: true, force: true });
});

test("crash mid-compaction rolls back atomically", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(3));
	await db.put("records", { score: 100 }, 1); // one pending, acknowledged frame

	const tablePath = join(dbPath, "records");
	const lives = [
		join(tablePath, "score.txt"),
		join(tablePath, "updatedAt.txt"),
		join(tablePath, "updates.log"),
		join(tablePath, ".format"),
	];
	const pristine = await Promise.all(lives.map((p) => readFile(p)));

	// Reconstruct the exact footprint of a compaction that crashed right after
	// its journal `begin` entry became durable: every live file parked in the
	// per-txn backup dir, every replacement temp fully written, and exactly one
	// swap (score.txt) already published when the process died.
	const txn = "crash-sim";
	const backupDir = join(tablePath, ".tmp", "backup", txn);
	await mkdir(backupDir, { recursive: true });
	const ops: JournalFileOp[] = [];
	for (const live of lives) {
		const backup = join(backupDir, basename(live));
		const tmp = join(tablePath, ".tmp", `${basename(live)}.${txn}`);
		await rename(live, backup);
		await writeFile(tmp, "torn-cell");
		ops.push({ live, backup, tmp, existed: true });
	}
	await rename(ops[0].tmp, ops[0].live);

	const journal = new Journal(tablePath, txn);
	await journal.begin(ops, null);
	await journal.dispose();
	// No `commit` marker was written: the crash is in flight.

	// The next writer-lock acquisition runs crash recovery (rollback), which
	// must restore every live file exactly as it was.
	await File.lock(join(tablePath, ".tmp"));
	await File.unlock(join(tablePath, ".tmp"));

	for (let i = 0; i < lives.length; i++)
		assert.deepEqual(
			await readFile(lives[i]),
			pristine[i],
			`rollback restored ${basename(lives[i])}`,
		);
	assert.ok(!existsSync(join(tablePath, ".tmp", "journal.jsonl")));

	// The acknowledged put survives in the restored log and merges over base.
	const reopened = new Inibase(dbPath);
	assert.equal(((await reopened.get("records", 1)) as any).score, 100);
	assert.equal(((await reopened.get("records", 2)) as any).score, 20);

	// Writing after recovery works and the log stays consistent.
	await reopened.put("records", { score: 150 }, 2);
	assert.equal(((await reopened.get("records", 2)) as any).score, 150);
	rmSync(dbPath, { recursive: true, force: true });
});

test("compaction works from a fresh, cold instance", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(3));
	await db.put("records", { score: 100 }, 1);

	// A brand-new instance has never loaded this table into its config cache.
	const cold = new Inibase(dbPath);
	const newGen = await cold.compact("records");
	assert.notEqual(newGen, null);
	assert.equal(await baseScoreAt(1), 100);
	assert.equal(await baseScoreAt(2), 20);
	assert.equal(((await cold.get("records", 1)) as any).score, 100);
	rmSync(dbPath, { recursive: true, force: true });
});

test("compaction on a legacy table and an empty log are no-ops", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { decodeID: true });
	await db.post("records", seed(3));
	assert.equal(await db.compact("records"), null);

	await db.createTable("log", schema, { log: true, decodeID: true });
	await db.post("log", seed(3));
	// Log exists (created empty at DDL) but holds no frames: nothing to fold.
	assert.equal(await db.compact("log"), null);
	assert.equal((await readFile(join(dbPath, "log", "updates.log"))).length, 0);
	rmSync(dbPath, { recursive: true, force: true });
});

test("compaction is neutral for criteria and aggregates", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(5));
	await db.put("records", { score: 100 }, 1);
	await db.put("records", { score: 5 }, 2);

	// 100 + 5 + 30 + 40 + 50
	assert.equal(await db.sum("records", "score"), 225);

	await db.compact("records");

	assert.equal(await db.sum("records", "score"), 225);
	assert.equal(((await db.get("records", 1)) as any).score, 100);

	// Criteria filters resolve against the merged base after compaction.
	const matches = await db.get("records", { score: 5 });
	assert.equal((matches as any[]).length, 1);
	assert.equal(((matches as any[])[0] as any).username, "user2");
	rmSync(dbPath, { recursive: true, force: true });
});

test("backpressure compacts before the log grows unbounded", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(20));

	// With a cap of 1 row, every put after the first must first fold the
	// previous frame into the base, keeping the overlay bounded.
	process.env.INIBASE_MAX_OVERLAY_RECORDS = "1";
	try {
		await db.put("records", { score: 111 }, 1);
		// First put: nothing to fold, base untouched.
		assert.equal(await baseScoreAt(1), 10);

		await db.put("records", { score: 112 }, 1);
		// Compacting this put folded the first put into the base.
		assert.equal(await baseScoreAt(1), 111);
		assert.equal(((await db.get("records", 1)) as any).score, 112);

		await db.put("records", { score: 113 }, 1);
		assert.equal(await baseScoreAt(1), 112);
		assert.equal(((await db.get("records", 1)) as any).score, 113);
	} finally {
		delete process.env.INIBASE_MAX_OVERLAY_RECORDS;
	}
	rmSync(dbPath, { recursive: true, force: true });
});

test("delete folds the log before rewriting base", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(5));
	await db.put("records", { score: 111 }, 1);
	await db.put("records", { score: 222 }, 2);

	await db.delete("records", [1, 2]);

	const rows = (await db.get("records", undefined, { perPage: -1 })) as any[];
	assert.equal(rows.length, 3);
	assert.deepEqual(
		rows.map((r) => r.score),
		[30, 40, 50],
	);
	// The log was folded first, so no stale frame can resurrect a deleted row.
	assert.equal(
		(await readFile(join(dbPath, "records", "updates.log"))).length,
		0,
	);
	rmSync(dbPath, { recursive: true, force: true });
});
