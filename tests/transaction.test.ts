// Tier 3 transactions: multi-table begin/commit/rollback, staged DML
// (post/put/delete + cascade), crash recovery of the database journal, writer
// isolation across processes, and INIBASE_DURABILITY=none functional parity.
import { strict as assert } from "node:assert";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import {
	mkdir,
	readdir,
	rename,
	writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import Inibase from "../src/index.js";
import * as File from "../src/file.js";

const dbPath = "test-db-transaction";

function removeDatabase() {
	if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
}

let db: Inibase;

const userSchema = [{ key: "name", type: "string", required: true }];
const postSchema = [
	{ key: "title", type: "string", required: true },
	{ key: "author", type: "table", table: "user_t", required: true },
];

const tableDir = (tableName: string) => join(dbPath, tableName);
const dbTmp = () => join(dbPath, ".tmp");
const dbJournal = () => join(dbTmp(), "journal.jsonl");
const colFiles = (tableName: string) =>
	["id", "name"].map((key) => join(tableDir(tableName), `${key}.txt`));

const readAll = async (tableName: string) =>
	(((await db.get(tableName, undefined, { page: 1, perPage: -1 })) as
		| any[]
		| null) ?? []) as any[];

/** Entries left over in the db `.tmp` (the backup base dir is expected). */
const dbTmpLeftovers = async () =>
	(await readdir(dbTmp()).catch(() => [] as string[])).filter(
		(entry) => entry !== "backup",
	);

const dbBackupChildDirs = async () =>
	readdir(join(dbTmp(), "backup")).catch(() => [] as string[]);

/**
 * Build the artifacts a crash mid multi-table `commit` would leave: table A is
 * fully published (new live files + pagination rename + backups parked), table
 * B is journaled but untouched, and the database journal has no commit marker.
 */
async function craftUncommittedDbJournal() {
	const txn = "sim-txn";
	const backupDir = join(dbTmp(), "backup", txn);
	await mkdir(backupDir, { recursive: true });

	const row2 = { id: 2, name: "row2" };
	const contents: Record<string, string | number> = {
		"id.txt": File.encode(row2.id) as string | number,
		"name.txt": File.encode(row2.name) as string | number,
	};

	const opsA = [];
	const tempsA = await Promise.all(
		colFiles("ta").map((path) =>
			File.append(path, contents[basename(path)] as string | number),
		),
	);
	for (const [tmp, live] of tempsA) {
		opsA.push({
			live,
			backup: join(backupDir, `0-ta-${basename(live as string)}`),
			tmp,
			existed: true,
		});
		await rename(live as string, join(backupDir, `0-ta-${basename(live as string)}`));
		await rename(tmp as string, live as string);
	}

	const opsB = [];
	const tempsB = await Promise.all(
		colFiles("tb").map((path) =>
			File.append(path, contents[basename(path)] as string | number),
		),
	);
	for (const [tmp, live] of tempsB)
		opsB.push({
			live,
			backup: join(backupDir, `0-tb-${basename(live as string)}`),
			tmp,
			existed: true,
		});

	const paginationA = {
		from: join(tableDir("ta"), "1-1.pagination"),
		to: join(tableDir("ta"), "2-2.pagination"),
	};
	const paginationB = {
		from: join(tableDir("tb"), "1-1.pagination"),
		to: join(tableDir("tb"), "2-2.pagination"),
	};
	await rename(paginationA.from, paginationA.to);

	const entries: object[] = [
		{ txn, type: "begin", tables: ["ta", "tb"] },
		{ txn, type: "op", files: opsA, pagination: paginationA },
		{ txn, type: "op", files: opsB, pagination: paginationB },
	];
	await mkdir(dbTmp(), { recursive: true });
	await writeFile(
		dbJournal(),
		entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
	);
}

/** Same as above but both tables are fully published and the marker exists. */
async function craftCommittedDbJournal() {
	const txn = "sim-txn";
	const backupDir = join(dbTmp(), "backup", txn);
	await mkdir(backupDir, { recursive: true });

	const row2 = { id: 2, name: "row2" };
	const contents: Record<string, string | number> = {
		"id.txt": File.encode(row2.id) as string | number,
		"name.txt": File.encode(row2.name) as string | number,
	};

	const entriesFiles = [];
	for (const tableName of ["ta", "tb"]) {
		const ops = [];
		const temps = await Promise.all(
			colFiles(tableName).map((path) =>
				File.append(path, contents[basename(path)] as string | number),
			),
		);
		for (const [tmp, live] of temps) {
			ops.push({
				live,
				backup: join(backupDir, `${tableName}-${basename(live as string)}`),
				tmp,
				existed: true,
			});
			await rename(
				live as string,
				join(backupDir, `${tableName}-${basename(live as string)}`),
			);
			await rename(tmp as string, live as string);
		}
		const pagination = {
			from: join(tableDir(tableName), "1-1.pagination"),
			to: join(tableDir(tableName), "2-2.pagination"),
		};
		await rename(pagination.from, pagination.to);
		entriesFiles.push({ files: ops, pagination });
	}

	const entries: object[] = [
		{ txn, type: "begin", tables: ["ta", "tb"] },
		...entriesFiles.map(({ files, pagination }) => ({
			txn,
			type: "op",
			files,
			pagination,
		})),
		{ txn, type: "commit" },
	];
	await mkdir(dbTmp(), { recursive: true });
	await writeFile(
		dbJournal(),
		entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
	);
}

await test("Initialize transaction database", async () => {
	removeDatabase();
	mkdirSync(dbPath, { recursive: true });
	db = new Inibase(dbPath);
	await db.createTable("user_t", userSchema, { decodeID: true });
	await db.createTable("post_t", postSchema, { decodeID: true });
});

await test("begin + commit makes multi-table writes atomic", async () => {
	await db.begin(["user_t", "post_t"]);
	try {
		await db.post("user_t", { name: "ada" });
		await db.post("post_t", { title: "hello", author: { id: 1 } });

		// No read-your-writes yet: reads inside the txn observe committed state.
		assert.equal((await readAll("user_t")).length, 0, "staged write not visible");
		assert.equal((await readAll("post_t")).length, 0, "staged write not visible");
	} finally {
		await db.commit();
	}

	const users = await readAll("user_t");
	const posts = await readAll("post_t");
	assert.equal(users.length, 1);
	assert.equal(users[0].name, "ada");
	assert.equal(users[0].id, 1, "dense id assigned from staged state");
	assert.equal(posts.length, 1);
	assert.equal(posts[0].author?.id, 1);
	assert.deepEqual(await dbTmpLeftovers(), [], "db journal cleaned up");
});

await test("rollback discards staged writes and releases everything", async () => {
	await db.begin(["user_t", "post_t"]);
	try {
		const posted = (await db.post("user_t", { name: "grace" })) as
			| string
			| string[];
		assert.ok(posted, "staged post returns an id");
		await db.post("post_t", { title: "nope", author: { id: 2 } });
	} finally {
		await db.rollback();
	}

	assert.equal((await readAll("user_t")).length, 1, "only the old row remains");
	assert.equal((await readAll("user_t"))[0].name, "ada");
	assert.equal((await readAll("post_t")).length, 1, "only the old row remains");
	assert.deepEqual(await dbTmpLeftovers(), [], "no database leftovers");
	assert.deepEqual(
		await dbBackupChildDirs(),
		[],
		"no per-txn backup dirs left behind",
	);
	// Locks were released: a fresh transaction works immediately.
	await db.begin(["user_t"]);
	await db.post("user_t", { name: "alan" });
	await db.commit();
	assert.equal((await readAll("user_t")).length, 2);
});

await test("transaction API misuse is rejected", async () => {
	await assert.rejects(() => db.commit(), /INVALID_PARAMETERS/);
	await assert.rejects(() => db.rollback(), /INVALID_PARAMETERS/);

	await db.begin();
	try {
		await assert.rejects(() => db.begin(), /INVALID_PARAMETERS/);
		await assert.rejects(
			() => db.createTable("ddl_t", userSchema),
			/INVALID_PARAMETERS/,
			"DDL is not allowed inside a transaction",
		);
		await assert.rejects(
			() => db.updateTable("user_t", userSchema),
			/INVALID_PARAMETERS/,
		);
		await db.post("user_t", { name: "x" });
		await assert.rejects(
			() => db.post("user_t", { name: "y" }),
			/INVALID_PARAMETERS/,
			"only one mutation per table per transaction",
		);
	} finally {
		await db.rollback();
	}
});

await test("atomic cascade delete inside a transaction", async () => {
	// Seed a user + its post outside the txn.
	await db.post("user_t", { name: "george" });
	await db.post("post_t", { title: "george's post", author: { id: 3 } });
	assert.equal((await readAll("post_t")).length, 2);

	await db.begin(["user_t"]);
	try {
		await db.delete("user_t", 3);
		await db.commit();
	} finally {
		// Safety: never leave the txn open if the assertion above failed.
		await db.commit().catch(() => {});
		await db.rollback().catch(() => {});
	}

	assert.equal((await readAll("user_t")).length, 2, "george deleted");
	assert.equal(
		(await readAll("post_t")).length,
		1,
		"referencing post deleted atomically",
	);
});

await test("rollback keeps rows a cascade would have deleted", async () => {
	await db.begin(["user_t"]);
	try {
		await db.delete("user_t", 1); // ada
	} finally {
		await db.rollback();
	}

	assert.equal((await readAll("user_t")).length, 2, "ada still present");
	assert.equal(
		(await readAll("post_t")).length,
		1,
		"her post is untouched",
	);
});

await test("crash mid multi-table commit rolls every table back", async () => {
	// Fresh tables with one row each, matching the crafted journal.
	const fresh = new Inibase(dbPath);
	await fresh.createTable("ta", userSchema, { decodeID: true });
	await fresh.createTable("tb", userSchema, { decodeID: true });
	await fresh.post("ta", { name: "a1" });
	await fresh.post("tb", { name: "b1" });

	await craftUncommittedDbJournal();

	const recovered = new Inibase(dbPath);
	const ta = (await recovered.get("ta", undefined, {
		page: 1,
		perPage: -1,
	})) as any[];
	const tb = (await recovered.get("tb", undefined, {
		page: 1,
		perPage: -1,
	})) as any[];
	assert.equal(ta.length, 1, "rolled back to the original row");
	assert.equal(ta[0].name, "a1");
	assert.equal(tb.length, 1, "untouched table unchanged");
	assert.equal(tb[0].name, "b1");
	assert.ok(!existsSync(dbJournal()), "database journal removed");
	assert.deepEqual(
		await dbBackupChildDirs(),
		[],
		"recovery dropped the txn backup dir",
	);
});

await test("crash after the commit marker rolls every table forward", async () => {
	await craftCommittedDbJournal();

	const recovered = new Inibase(dbPath);
	const ta = (await recovered.get("ta", undefined, {
		page: 1,
		perPage: -1,
	})) as any[];
	const tb = (await recovered.get("tb", undefined, {
		page: 1,
		perPage: -1,
	})) as any[];
	assert.equal(ta.length, 2, "row2 kept after roll forward");
	assert.equal(ta[1].name, "row2");
	assert.equal(tb.length, 2);
	assert.equal(tb[1].name, "row2");
	assert.ok(!existsSync(dbJournal()), "database journal removed");
});

await test("a writer in another process blocks on a live transaction", async () => {
	const fresh = new Inibase(dbPath);
	await fresh.createTable("jobs", userSchema, { decodeID: true });

	await db.begin(["jobs"]);
	const writer = fork(
		fileURLToPath(new URL("./writer.child.ts", import.meta.url)),
		[dbPath, "7", "5"],
		{ execArgv: ["--import", "tsx"] },
	);

	const finishedEarly = false;
	const writerDone = new Promise<void>((resolve) => {
		writer.on("message", (message) => {
			if (message === "done") resolve();
		});
	});
	await new Promise((resolve) => setTimeout(resolve, 900));
	assert.equal(
		finishedEarly,
		false,
		"child must not finish while the txn holds the table lock",
	);

	await db.commit();
	await Promise.race([
		writerDone,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("writer never unblocked")), 15_000),
		),
	]);
	await new Promise((resolve) => setTimeout(resolve, 500));
	const rows = (await db.get("jobs", undefined, {
		page: 1,
		perPage: -1,
	})) as any[];
	assert.equal(rows.length, 5, "writer's rows landed after the commit");
});

await test("INIBASE_DURABILITY=none is functionally identical", async () => {
	const noneDb = "test-db-transaction-none";
	rmSync(noneDb, { recursive: true, force: true });
	mkdirSync(noneDb, { recursive: true });

	const child = fork(
		fileURLToPath(new URL("./none.mode.child.ts", import.meta.url)),
		[noneDb],
		{
			execArgv: ["--import", "tsx"],
			env: { ...process.env, INIBASE_DURABILITY: "none" },
		},
	);
	const report = await new Promise<any>((resolve, reject) => {
		child.on("message", (message) => resolve(JSON.parse(message)));
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code !== 0) reject(new Error(`none-mode child exited ${code}`));
		});
	});

	assert.deepEqual(report, {
		count1: 2,
		names1: ["a", "b"],
		count2: 3,
		names2: ["a", "b", "d"],
	});
	rmSync(noneDb, { recursive: true, force: true });
});

await test("computed link-hops reject transaction-staged dependency tables", async () => {
	// wallet_t.ownerName = owner.name is a link hop into user_t (ids: owner=1,
	// ownerName=2; user_t name=1)
	await db.createTable("wallet_t", [
		{ key: "owner", type: "table", table: "user_t" },
		{ key: "ownerName", type: "string", computed: "1.1" },
	]);
	const ownerId = await db.post("user_t", { name: "wallet-owner" });

	// outside a transaction the link resolves
	const outside = (await db.post("wallet_t", { owner: { id: ownerId } }, undefined, true)) as any;
	assert.equal(outside.ownerName, "wallet-owner");

	// a transaction touching only wallet_t may still link-read user_t
	await db.begin(["wallet_t"]);
	try {
		await db.post("wallet_t", { owner: { id: ownerId } });
	} finally {
		await db.commit();
	}
	assert.equal((await readAll("wallet_t")).length, 2);

	// a transaction pre-listing both tables cannot evaluate the link hop (the
	// dependency would be read from its pre-commit state)
	await db.begin(["user_t", "wallet_t"]);
	try {
		await assert.rejects(
			() => db.post("wallet_t", { owner: { id: ownerId } }),
			(error: any) => error?.name === "INVALID_PARAMETERS",
			"link hop into a staged dependency must be rejected",
		);
	} finally {
		await db.rollback();
	}
	assert.equal((await readAll("wallet_t")).length, 2, "rejected write staged nothing");
});

await test("Cleanup transaction database", async () => {
	removeDatabase();
});