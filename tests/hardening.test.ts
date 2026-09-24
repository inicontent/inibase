import { strict as assert } from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import Inibase, { type Schema } from "../src/index.js";

// Regression suite for the inibase 3.2.0 hardening patches (Sep-2026 pteam
// write-concurrency incident). Ports the self-contained scenarios of
// scripts/hardening/test-hardening.mjs:
//   Test 2  - concurrency torture on a prepend table (writer mutex, unique
//             temp paths, no dup ids, columns stay line-aligned)
//   Test 1' - numeric where = id semantics (not line numbers), the incident
//             signature: ids > row count / non-dense ids must resolve by value
//   Test 4  - transactions (commit / rollback / in-txn put-by-numeric-id)
//   Test 5  - generic CRUD / criteria / sort / aggregates
// The live-pteam-clone test (Test 1) is not portable and is skipped.

const dbPath = "test-db-hardening";

function removeDatabase() {
	if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
}

const prepareDb = () => {
	removeDatabase();
	new Inibase(dbPath); // ensure schema-folder scaffolding is created once
};

const ASSET_LIKE_SCHEMA: Schema = [
	{ key: "name", type: "string", required: true },
	{ key: "folder", type: "string" },
	{ key: "size", type: "number" },
];

// ---------------------------------------------------------------------------
// file-level helpers (mirror test-hardening.mjs)
// ---------------------------------------------------------------------------
const lineCountOf = async (filePath: string) => {
	const raw = await readFile(filePath, "utf8");
	if (raw === "") return 0;
	return raw.split("\n").length - (raw.endsWith("\n") ? 1 : 0);
};

const paginationTotal = async (tablePath: string) => {
	const matches = [];
	for (const name of await readdir(tablePath))
		if (name.endsWith(".pagination")) matches.push(name);
	if (!matches.length) return { lastId: 0, total: 0 };
	const [lastId, total] = matches[0].replace(/\.pagination$/, "").split("-").map(Number);
	return { lastId, total };
};

/** Every column file must hold exactly `total` lines (no drifted/torn tails). */
const checkColumnsAligned = async (tablePath: string, total: number, label: string) => {
	const files = (await readdir(tablePath)).filter(
		(f) => f.endsWith(".txt") && !f.startsWith("."),
	);
	for (const f of files) {
		const n = await lineCountOf(join(tablePath, f));
		assert.equal(
			n,
			total,
			`${label}: column ${f} has ${n} lines but pagination total is ${total}`,
		);
	}
	return files;
};

const idList = async (tablePath: string) => {
	const raw = await readFile(join(tablePath, "id.txt"), "utf8");
	return raw.split("\n").filter(Boolean).map(Number);
};

// ---------------------------------------------------------------------------
// Test 2: concurrency torture (fresh prepend table, parallel writers)
// ---------------------------------------------------------------------------
await test("hardening: concurrent posts / renames / deletes stay aligned (torture)", async () => {
	prepareDb();
	const inibase = new Inibase("torture", dbPath);
	const tableName = "items";
	await inibase.createTable(tableName, structuredClone(ASSET_LIKE_SCHEMA), {
		prepend: true,
	});
	const tablePath = join(dbPath, "torture", "items");

	// wave 1: parallel single posts + parallel batch posts
	const postTasks: Promise<unknown>[] = [];
	for (let i = 0; i < 120; i++)
		postTasks.push(
			inibase.post(tableName, { name: `p-${i}`, folder: "w1", size: i }, { perPage: -1 }, true),
		);
	for (let b = 0; b < 4; b++)
		postTasks.push(
			inibase.post(
				tableName,
				Array.from({ length: 8 }, (_, k) => ({ name: `b${b}-${k}`, folder: "w1", size: b })),
				{ perPage: -1 },
				true,
			),
		);
	const postsRes = await Promise.allSettled(postTasks);
	const postFails = postsRes.filter((r) => r.status === "rejected");
	assert.equal(
		postFails.length,
		0,
		`${postFails.length} posts failed: ${postFails[0]?.reason?.message}`,
	);

	let { total } = await paginationTotal(tablePath);
	const expectedW1 = 120 + 4 * 8;
	assert.equal(total, expectedW1, `wave1 total ${total}, expected ${expectedW1}`);
	await checkColumnsAligned(tablePath, total, "wave1");

	const ids1 = await idList(tablePath);
	assert.equal(
		new Set(ids1).size,
		ids1.length,
		`duplicate ids after wave1 (${ids1.length - new Set(ids1).size} dups)`,
	);

	// wave 2: parallel renames by id + parallel posts
	const victims = ids1.slice(0, 60);
	const renamePlan = new Map(victims.map((id) => [id, `renamed-${id}`]));
	const wave2: Promise<unknown>[] = [];
	for (const [id, name] of renamePlan)
		wave2.push(inibase.put(tableName, { name }, id, { perPage: -1 }, false));
	for (let i = 0; i < 40; i++)
		wave2.push(
			inibase.post(tableName, { name: `w2-${i}`, folder: "w2", size: i }, { perPage: -1 }, false),
		);
	const w2Res = await Promise.allSettled(wave2);
	const w2Fails = w2Res.filter((r) => r.status === "rejected");
	assert.equal(
		w2Fails.length,
		0,
		`${w2Fails.length} wave2 ops failed: ${w2Fails[0]?.reason?.message}`,
	);

	total = (await paginationTotal(tablePath)).total;
	const expectedW2 = expectedW1 + 40;
	assert.equal(total, expectedW2, `wave2 total ${total}, expected ${expectedW2}`);
	await checkColumnsAligned(tablePath, total, "wave2");

	const ids2 = await idList(tablePath);
	assert.equal(new Set(ids2).size, ids2.length, "duplicate ids after wave2");

	// every renamed id must store the requested name on the right row; map by
	// POSITION in the current id column (rows/columns are line-aligned).
	const dump = (await inibase.get(tableName, undefined, { perPage: -1 })) as Record<
		string,
		any
	>[];
	const idsNow = await idList(tablePath);
	const byId = new Map(idsNow.map((id, i) => [id, dump[i]]));
	for (const [id, wanted] of renamePlan) {
		const row = byId.get(id);
		assert.ok(row, `renamed id ${id} missing`);
		assert.equal(
			String(row.name),
			wanted,
			`id ${id} name = ${JSON.stringify(row.name)}, expected ${JSON.stringify(wanted)}`,
		);
	}

	// wave 3: parallel deletes by id (only ids that still exist)
	const deletable = ids2.slice(0, 20);
	const w3Res = await Promise.allSettled(deletable.map((id) => inibase.delete(tableName, id)));
	const w3Fails = w3Res.filter((r) => r.status === "rejected");
	assert.equal(w3Fails.length, 0, `${w3Fails.length} wave3 deletes failed`);
	const removed = w3Res.filter((r) => r.status === "fulfilled" && r.value).length;
	total = (await paginationTotal(tablePath)).total;
	assert.equal(
		total,
		ids2.length - removed,
		`wave3 total ${total}, expected ${ids2.length - removed} (${removed} removed)`,
	);
	await checkColumnsAligned(tablePath, total, "wave3");
	const ids3 = await idList(tablePath);
	assert.equal(new Set(ids3).size, ids3.length, "duplicate ids after wave3");
});

// ---------------------------------------------------------------------------
// Test 1': numeric where = id (not line number) — the incident signature
// ---------------------------------------------------------------------------
await test("hardening: numeric where resolves by stored id, never by line number", async () => {
	prepareDb();
	const inibase = new Inibase("idsem", dbPath);
	const tableName = "assets";
	await inibase.createTable(tableName, structuredClone(ASSET_LIKE_SCHEMA), {
		prepend: true,
	});
	const tablePath = join(dbPath, "idsem", tableName);

	// Seed rows; on a prepend table the newest row lives at line 1, so stored
	// ids are (1) dense at first and (2) NOT equal to line numbers afterwards.
	await inibase.post(tableName, { name: "r1", folder: "f", size: 1 });
	await inibase.post(tableName, { name: "r2", folder: "f", size: 2 });
	await inibase.post(tableName, { name: "r3", folder: "f", size: 3 });
	await inibase.post(tableName, { name: "r4", folder: "f", size: 4 });

	// Delete a middle id: ids now read [4,3,1] (prepend layout) — id 2 is
	// gone, so the largest stored id (4) exceeds the row count (3). Under the
	// old line-number semantics, get(4)/put(4)/delete(4) targeted line 4
	// (nonexistent -> null / padded a line / no-op'd): the incident signature.
	const didDel = await inibase.delete(tableName, 2);
	assert.equal(didDel, true, "delete by numeric id");
	let { total } = await paginationTotal(tablePath);
	assert.equal(total, 3, "rows after middle delete");
	await checkColumnsAligned(tablePath, total, "post-delete");

	// get by the LARGEST stored id must return the row whose STORED id
	// equals it (lookup by value, not by position).
	const rawIds = await idList(tablePath);
	const numId = Math.max(...rawIds);
	assert.equal(numId, 4, "largest stored id");
	const lineOf = rawIds.indexOf(numId) + 1;
	assert.ok(lineOf <= total, "largest id is within the row count (prepend line 1..3)");

	const got = (await inibase.get(tableName, numId, { perPage: -1 })) as Record<string, any>;
	assert.ok(got, `get(${numId}) returned nothing`);
	assert.equal(String(got.name), "r4", `get(${numId}) must return the id=4 row, got ${got.name}`);

	// rename by NUMERIC id: right row, no padding, row count unchanged
	const marker = `harden-${process.pid}-${Date.now()}`;
	await inibase.put(tableName, { name: marker }, numId);
	total = (await paginationTotal(tablePath)).total;
	assert.equal(total, 3, `rename must not change row count (${total})`);
	assert.equal(
		await lineCountOf(join(tablePath, "name.txt")),
		3,
		"rename must not pad the column file",
	);
	const refreshed = (await inibase.get(tableName, numId, { perPage: -1 })) as Record<
		string,
		any
	>;
	assert.equal(String(refreshed.name), marker, "renamed id reads back on the right row");

	// delete by NUMERIC id: rows drop by one and every column stays aligned
	const didDel2 = await inibase.delete(tableName, numId);
	assert.equal(didDel2, true, "delete by largest numeric id");
	total = (await paginationTotal(tablePath)).total;
	assert.equal(total, 2, `rows after delete(${numId})`);
	await checkColumnsAligned(tablePath, total, "post-id-delete");
	const after = await idList(tablePath);
	assert.ok(!after.includes(numId), "deleted id must be gone from id.txt");
});

// ---------------------------------------------------------------------------
// Test 4: transactions
// ---------------------------------------------------------------------------
await test("hardening: transactions commit / rollback / in-txn put-by-numeric-id", async () => {
	prepareDb();
	const inibase = new Inibase("txn", dbPath);
	await inibase.createTable("a", structuredClone(ASSET_LIKE_SCHEMA), { prepend: true });
	await inibase.createTable("b", structuredClone(ASSET_LIKE_SCHEMA), { prepend: false });

	await inibase.begin(["a", "b"]);
	await inibase.post("a", { name: "t1-a" });
	await inibase.post("b", { name: "t1-b" });
	await inibase.commit();
	let a = await inibase.get("a", undefined, { perPage: -1 });
	let b = await inibase.get("b", undefined, { perPage: -1 });
	assert.ok(a && a.length === 1 && b && b.length === 1, "commit left 1/1 rows");

	await inibase.begin(["a", "b"]);
	await inibase.post("a", { name: "t2-a" });
	await inibase.post("b", { name: "t2-b" });
	await inibase.rollback();
	a = await inibase.get("a", undefined, { perPage: -1 });
	b = await inibase.get("b", undefined, { perPage: -1 });
	assert.ok(a && a.length === 1 && b && b.length === 1, "rollback left 1/1 rows");

	// one staged op PER TABLE per txn by design: post to "a" + put by
	// numeric id to "b" in one txn, commit, verify both.
	await inibase.begin(["a", "b"]);
	await inibase.post("a", { name: "t3-a" });
	await inibase.put("b", { name: "b1-renamed" }, 1);
	await inibase.commit();
	const ra = (await inibase.get("a", 2)) as Record<string, any>;
	assert.equal(ra?.name, "t3-a", "txn post readback");
	const rb = (await inibase.get("b", 1)) as Record<string, any>;
	assert.equal(rb?.name, "b1-renamed", "txn put-by-numeric-id readback");
	b = await inibase.get("b", undefined, { perPage: -1 });
	assert.ok(b && b.length === 1, "txn put must not add rows");
});

// ---------------------------------------------------------------------------
// Test 5: generic CRUD / criteria / sort / aggregates
// ---------------------------------------------------------------------------
await test("hardening: generic CRUD, criteria, sort, aggregates", async () => {
	prepareDb();
	const inibase = new Inibase("crud", dbPath);
	await inibase.createTable("t", structuredClone(ASSET_LIKE_SCHEMA), { prepend: true });
	await inibase.post(
		"t",
		[
			{ name: "alpha", folder: "x", size: 1 },
			{ name: "beta", folder: "x", size: 2 },
			{ name: "gamma", folder: "y", size: 10 },
		],
		{ perPage: -1 },
	);
	let all = (await inibase.get("t", undefined, { perPage: -1 })) as Record<string, any>[];
	assert.equal(all.length, 3, "seed rows");

	const byFolder = (await inibase.get("t", { folder: "x" }, { perPage: -1 })) as Record<
		string,
		any
	>[];
	assert.equal(byFolder.length, 2, "criteria x rows");

	const sorted = (await inibase.get("t", undefined, { perPage: -1, sort: { size: "DESC" } })) as Record<
		string,
		any
	>[];
	assert.equal(String(sorted[0].size), "10", "sort DESC first size");

	assert.equal(Number(await inibase.sum("t", "size")), 13, "sum(size)");
	assert.equal(Number(await inibase.avg("t", "size")), 13 / 3, "avg(size)");

	await inibase.put("t", { folder: "z" });
	all = (await inibase.get("t", undefined, { perPage: -1 })) as Record<string, any>[];
	assert.ok(all.every((r) => r.folder === "z"), "where-less put rewrote every row");

	await inibase.put("t", { name: "hunted" }, { folder: "z", size: 2 });
	const hunted = (await inibase.get("t", { name: "hunted" }, { perPage: -1 })) as Record<
		string,
		any
	>[];
	assert.ok(hunted.length === 1 && Number(hunted[0].size) === 2, "criteria put mismatch");

	// delete an ARRAY OF ENCODED ids
	all = (await inibase.get("t", undefined, { perPage: -1 })) as Record<string, any>[];
	assert.equal(all.length, 3, "pre-delete rows");
	const hexIds = all.slice(0, 2).map((r) => r.id as string);
	assert.equal(await inibase.delete("t", hexIds), true, "hex array delete");
	let left = (await inibase.get("t", undefined, { perPage: -1 })) as Record<string, any>[];
	assert.equal(left.length, 1, "hex array delete left 1 row");

	// delete the final row by ARRAY OF NUMERIC ids (numeric where = id)
	const rawIds = (await readFile(join(dbPath, "crud", "t", "id.txt"), "utf8"))
		.split("\n")
		.filter(Boolean)
		.map(Number);
	assert.equal(await inibase.delete("t", rawIds), true, "numeric array delete");
	left = (await inibase.get("t", undefined, { perPage: -1 })) as Record<string, any>[];
	assert.ok(!left || left.length === 0, "numeric array delete emptied the table");
});

await test("Cleanup hardening database", () => {
	removeDatabase();
});