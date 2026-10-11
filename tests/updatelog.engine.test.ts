// End-to-end coverage for the format-2 update log: incremental `put`, merged
// reads (by id, criteria, sort, where-less), delete/post interleaving,
// uniqueness against the merged view, and the loud DDL/transaction guards.
import { strict as assert } from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import Inibase, { type Schema } from "../src/index.js";

const dbPath = "test-db-updatelog-engine";

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

test("put by id is proportional: base column is untouched until compaction", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(5));

	await db.put("records", { score: 100 }, 1);

	const row = (await db.get("records", 1)) as any;
	assert.equal(row.score, 100, "merged read reflects the logged put");
	assert.equal(row.username, "user1");

	// The base column still holds the stale value: the put only appended a
	// frame to updates.log.
	const baseLines = (
		await readFile(join(dbPath, "records", "score.txt"), "utf8")
	)
		.trimEnd()
		.split("\n");
	assert.equal(Number(baseLines[0]), 10, "base column is not rewritten");

	// Other rows are unaffected.
	const rows = (await db.get("records", undefined, { perPage: -1 })) as any[];
	assert.equal(rows.length, 5);
	assert.deepEqual(
		rows.map((r) => r.score),
		[100, 20, 30, 40, 50],
	);
	rmSync(dbPath, { recursive: true, force: true });
});

test("criteria put resolves against the merged view", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(5));

	// Criteria on an untouched column.
	await db.put("records", { score: 0 }, { seq: 3 });
	const three = (await db.get("records", 3)) as any;
	assert.equal(three.score, 0);

	// A second put whose *criteria column* was overlaid by the first put: it
	// must see score=0 and match, not the stale base value.
	await db.put("records", { username: "matched" }, { score: 0 });
	const matched = (await db.get("records", 3)) as any;
	assert.equal(matched.username, "matched");

	// No match -> undefined, nothing written.
	const before = await readFile(join(dbPath, "records", "updates.log"));
	const result = await db.put("records", { score: 999 }, { seq: 12345 });
	assert.equal(result, undefined);
	const after = await readFile(join(dbPath, "records", "updates.log"));
	assert.deepEqual(after, before, "a no-match criteria put appends nothing");
	rmSync(dbPath, { recursive: true, force: true });
});

test("criteria get reflects overlaid values", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(5));

	await db.put("records", { score: 777 }, 2);
	const found = (await db.get("records", { score: 777 })) as any[];
	assert.equal(found.length, 1);
	assert.equal(found[0].seq, 2);

	// The old value no longer matches.
	const old = await db.get("records", { score: 20 });
	assert.equal(old, null);
	rmSync(dbPath, { recursive: true, force: true });
});

test("where-less put updates every row", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(4));

	await db.put("records", { username: "everyone" });
	const rows = (await db.get("records", undefined, { perPage: -1 })) as any[];
	assert.deepEqual(
		rows.map((r) => r.username),
		["everyone", "everyone", "everyone", "everyone"],
	);
	rmSync(dbPath, { recursive: true, force: true });
});

test("sort and pagination read the merged overlay", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(4));

	await db.put("records", { score: 1000 }, 1); // now the highest
	const sorted = (await db.get("records", undefined, {
		sort: { score: -1 },
		perPage: -1,
	})) as any[];
	assert.deepEqual(
		sorted.map((r) => r.score),
		[1000, 40, 30, 20],
	);

	const page = (await db.get("records", undefined, {
		sort: { score: -1 },
		perPage: 2,
	})) as any[];
	assert.deepEqual(
		page.map((r) => r.score),
		[1000, 40],
	);
	rmSync(dbPath, { recursive: true, force: true });
});

test("columns projection only applies requested overlaid columns", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(3));
	await db.put("records", { score: 55, username: "projected" }, 1);

	const row = (await db.get("records", 1, { columns: ["score"] })) as any;
	assert.equal(row.score, 55);
	assert.equal(row.username, undefined);
	assert.ok(row.id !== undefined);
	rmSync(dbPath, { recursive: true, force: true });
});

test("post and delete interleave correctly with the overlay", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(3));
	await db.put("records", { score: 999 }, 2);

	// New rows append to the base and are not shadowed.
	const newId = await db.post("records", {
		username: "fresh",
		score: 5,
		seq: 100,
	});
	const fresh = (await db.get("records", newId)) as any;
	assert.equal(fresh.score, 5);

	// Deleting an overlaid row removes it entirely.
	await db.delete("records", 2);
	assert.equal(await db.get("records", 2), null);
	const remaining = (await db.get("records", undefined, {
		perPage: -1,
	})) as any[];
	assert.equal(remaining.length, 3);
	assert.ok(!remaining.some((r) => r.score === 999));

	// Deleting the rest keeps the table readable.
	await db.delete("records");
	assert.equal(await db.get("records"), null);
	rmSync(dbPath, { recursive: true, force: true });
});

test("uniqueness is enforced against un-compacted puts", async () => {
	const db = freshDb();
	const uniqueSchema: Schema = [
		{ key: "name", type: "string", required: true, unique: true },
		{ key: "score", type: "number", required: true },
	];
	await db.createTable("unique_records", uniqueSchema, {
		log: true,
		decodeID: true,
	});
	await db.post("unique_records", [
		{ name: "alpha", score: 1 },
		{ name: "beta", score: 2 },
	]);

	// Rename row 1 to a fresh value through the log.
	await db.put("unique_records", { name: "gamma" }, 1);
	assert.equal(((await db.get("unique_records", 1)) as any).name, "gamma");

	// "alpha" is now free (only in the base), so it can be reused.
	await db.put("unique_records", { name: "alpha" }, 2);
	assert.equal(((await db.get("unique_records", 2)) as any).name, "alpha");

	// "gamma" is taken by an overlaid row: the base file still says "alpha",
	// so the check must consult the overlay to reject.
	await assert.rejects(
		() => db.put("unique_records", { name: "gamma" }, 2),
		(error: any) => error?.name === "FIELD_UNIQUE",
	);
	rmSync(dbPath, { recursive: true, force: true });
});

test("transactions and schema DDL on a log table fail loudly", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(2));

	await db.begin();
	await assert.rejects(
		() => db.put("records", { score: 1 }, 1),
		(error: any) => error?.name === "MAINTENANCE_REQUIRED",
	);
	await assert.rejects(
		() => db.delete("records", 1),
		(error: any) => error?.name === "MAINTENANCE_REQUIRED",
	);
	await db.rollback();

	await assert.rejects(
		() => db.updateTable("records", schema),
		(error: any) => error?.name === "MAINTENANCE_REQUIRED",
	);

	// A non-simple schema cannot opt into the log at creation time.
	await assert.rejects(
		() =>
			db.createTable(
				"bad_log",
				[{ key: "payload", type: "object", children: [] } as any],
				{ log: true },
			),
		(error: any) => error?.name === "UNSUPPORTED_FORMAT",
	);
	rmSync(dbPath, { recursive: true, force: true });
});

test("aggregates read the merged overlay", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(4)); // scores 10,20,30,40

	await db.put("records", { score: 100 }, 1);
	await db.put("records", { score: 5 }, 2);

	// Merged scores: 100, 5, 30, 40 -> sum 175, avg 43.75, min 5, max 100.
	// `min`/`max` return the record even for a single column (engine quirk), so
	// normalise both shapes.
	const metric = (value: number | Record<string, number>) =>
		typeof value === "number" ? value : Object.values(value)[0];
	assert.equal(await db.sum("records", "score"), 175);
	assert.equal(await db.avg("records", "score"), 43.75);
	assert.equal(metric(await db.min("records", "score")), 5);
	assert.equal(metric(await db.max("records", "score")), 100);

	// Criteria-scoped aggregate also sees the overlay.
	assert.equal(await db.sum("records", "score", { score: 5 }), 5);
	rmSync(dbPath, { recursive: true, force: true });
});

test("json, password and date fields round-trip through the log", async () => {
	const db = freshDb();
	const typedSchema: Schema = [
		{ key: "name", type: "string", required: true },
		{ key: "payload", type: "json", required: true },
		{ key: "secret", type: "password", required: true },
		{ key: "when", type: "date", required: true },
	];
	await db.createTable("typed", typedSchema, { log: true, decodeID: true });
	await db.post("typed", [
		{
			name: "a",
			payload: { x: 1, list: [1, 2] },
			secret: "hunter2",
			when: new Date("2020-01-01T00:00:00Z"),
		},
		{
			name: "b",
			payload: { x: 9 },
			secret: "swordfish",
			when: new Date("2021-01-01T00:00:00Z"),
		},
	]);

	await db.put("typed", { payload: { x: 2, list: [3] } }, 1);

	const row = (await db.get("typed", 1)) as any;
	assert.deepEqual(row.payload, { x: 2, list: [3] });
	assert.equal(row.name, "a");
	assert.equal(typeof row.secret, "string");
	assert.equal(typeof row.when, "number");

	// The untouched row keeps decoding its original json/password/date.
	const other = (await db.get("typed", 2)) as any;
	assert.deepEqual(other.payload, { x: 9 });
	assert.equal(other.name, "b");
	rmSync(dbPath, { recursive: true, force: true });
});

test("legacy tables are unaffected by the log machinery", async () => {
	const db = freshDb();
	await db.createTable("legacy", schema, { decodeID: true });
	await db.post("legacy", seed(3));
	await db.put("legacy", { score: 42 }, 1);

	const row = (await db.get("legacy", 1)) as any;
	assert.equal(row.score, 42);
	// Legacy table has no .format marker and no updates.log.
	assert.ok(!existsSync(join(dbPath, "legacy", ".format")));
	assert.ok(!existsSync(join(dbPath, "legacy", "updates.log")));
	rmSync(dbPath, { recursive: true, force: true });
});

test("the format marker carries the compatibility contract", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true });
	const marker = JSON.parse(
		await readFile(join(dbPath, "records", ".format"), "utf8"),
	);
	assert.equal(marker.engine, "inibase");
	assert.equal(marker.format, 2);
	assert.equal(marker.minReader, "3.8.0");
	assert.equal(marker.detector, "3.7.1");
	assert.equal(marker.layout, "append");
	assert.equal(marker.log, true);
	assert.equal(marker.baseGen, 0);
	rmSync(dbPath, { recursive: true, force: true });
});

test("a fresh instance rebuilds the overlay from disk", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(3));
	await db.put("records", { score: 321 }, 2);
	await db.put("records", { seq: 999 }, { score: 321 });

	// A brand-new instance shares no in-process state: it must replay
	// updates.log to serve the same merged rows.
	const reopened = new Inibase(dbPath);
	const row = (await reopened.get("records", 2)) as any;
	assert.equal(row.score, 321);
	assert.equal(row.seq, 999);
	rmSync(dbPath, { recursive: true, force: true });
});

test("a torn tail is ignored on read and repaired by the next write", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(3));
	await db.put("records", { score: 111 }, 1);

	// Simulate a crash mid-append: three stray bytes after the last frame.
	await appendFile(
		join(dbPath, "records", "updates.log"),
		Buffer.from([1, 2, 3]),
	);

	// Readers ignore the incomplete tail.
	assert.equal(((await db.get("records", 1)) as any).score, 111);

	// The next writer truncates it and appends cleanly.
	await db.put("records", { score: 222 }, 2);
	assert.equal(((await db.get("records", 2)) as any).score, 222);
	assert.equal(((await db.get("records", 1)) as any).score, 111);

	const raw = await readFile(join(dbPath, "records", "updates.log"));
	assert.equal(raw[raw.length - 1], 0x0a, "log ends on a frame boundary");
	rmSync(dbPath, { recursive: true, force: true });
});

test("put returns updated data only when asked", async () => {
	const db = freshDb();
	await db.createTable("records", schema, { log: true, decodeID: true });
	await db.post("records", seed(3));

	assert.equal(await db.put("records", { score: 5 }, 1), undefined);

	const single = (await db.put(
		"records",
		{ score: 6 },
		1,
		undefined,
		true,
	)) as any;
	assert.equal(single.score, 6);

	const many = (await db.put(
		"records",
		{ score: 7 },
		[1, 2],
		undefined,
		true,
	)) as any[];
	assert.equal(many.length, 2);
	assert.deepEqual(
		many.map((r) => r.score),
		[7, 7],
	);

	// An id that does not exist mutates nothing and returns undefined, even
	// with returnUpdatedData set.
	const before = await readFile(join(dbPath, "records", "updates.log"));
	assert.equal(
		await db.put("records", { score: 8 }, 424242, undefined, true),
		undefined,
	);
	assert.deepEqual(
		await readFile(join(dbPath, "records", "updates.log")),
		before,
	);
	rmSync(dbPath, { recursive: true, force: true });
});
