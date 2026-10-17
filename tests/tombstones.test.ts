import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Inibase from "../src/index.js";

const schema = [
	{ key: "key", type: "string" as const, unique: true },
	{ key: "score", type: "number" as const },
];

test("logged deletes leave primary data untouched, and all reads respect tombstones", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-tombstone-"));
	const db = new Inibase("db", root);
	try {
		await db.createTable("records", schema, {
			compression: true,
			log: true,
			tombstones: true,
			decodeID: true,
			seekable: true,
			indexes: ["key"],
		});
		await db.post(
			"records",
			Array.from({ length: 50 }, (_, i) => ({
				key: `key-${i + 1}`,
				score: i + 1,
			})),
		);
		await db.put("records", { score: 1000 }, 20);
		const path = join(root, "db/records/score.txt.gz");
		const before = await stat(path);
		const bytes = await readFile(path);
		await db.delete("records", [1, 3, 20, 49]);
		assert.equal((await stat(path)).ino, before.ino);
		assert.deepEqual(await readFile(path), bytes);
		assert.equal(await db.get("records", 20), null);
		assert.equal(await db.get("records", { key: "key-20" }), null);
		assert.equal(await db.delete("records", 20), false);
		assert.deepEqual(
			((await db.get("records", undefined, { perPage: 3 })) as any[]).map(
				(r) => r.id,
			),
			[2, 4, 5],
		);
		assert.equal(db.pageInfo.records.total, 46);
		assert.deepEqual(
			(
				(await db.get("records", undefined, { page: 2, perPage: 3 })) as any[]
			).map((r) => r.id),
			[6, 7, 8],
		);
		assert.equal(await db.sum("records", "score"), 1275 - 1 - 3 - 20 - 49);
		await db.post("records", { key: "key-20", score: 100 });
		assert.equal(
			((await db.get("records", { key: "key-20" })) as any[])[0].id,
			51,
		);
		await db.put("records", { score: 9 });
		assert.equal(await db.get("records", 20), null);
		assert.equal(
			((await db.get("records", undefined, { perPage: -1 })) as any[]).length,
			47,
		);
		await db.compact("records");
		assert.equal(
			(await readFile(join(root, "db/records/updates.log"))).length,
			0,
		);
		assert.equal(((await db.get("records", 51)) as any).score, 9);
		await db.close();
		const reopened = new Inibase("db", root);
		try {
			assert.equal(await reopened.get("records", 20), null);
			assert.equal(
				((await reopened.get("records", { key: "key-20" })) as any[])[0].id,
				51,
			);
			assert.equal(await reopened.sum("records", "score"), 47 * 9);
		} finally {
			await reopened.close();
		}
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("explicit format migration with populated overlay is visible to already-open readers", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-tombstone-"));
	const writer = new Inibase("db", root),
		reader = new Inibase("db", root);
	try {
		await writer.createTable("records", schema, { log: true, decodeID: true });
		await writer.post("records", [
			{ key: "a", score: 1 },
			{ key: "b", score: 2 },
		]);
		await writer.put("records", { score: 7 }, 2);
		assert.equal(((await reader.get("records", 2)) as any).score, 7);
		await writer.enableTombstones("records");
		await writer.delete("records", 1);
		assert.equal(await reader.get("records", 1), null);
		assert.equal(await reader.sum("records", "score"), 7);
		const marker = JSON.parse(
			await readFile(join(root, "db/records/.format"), "utf8"),
		);
		assert.equal(marker.format, 3);
		assert.equal(marker.minReader, "3.9.0");
		await writer.compact("records");
		assert.equal(((await reader.get("records", 2)) as any).score, 7);
	} finally {
		await writer.close();
		await reader.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("repeated deletion compaction retains non-dense stable IDs and last-ID allocation", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-tombstone-"));
	const db = new Inibase("db", root);
	try {
		await db.createTable("records", schema, {
			log: true,
			tombstones: true,
			decodeID: true,
			seekable: true,
			indexes: ["key"],
		});
		await db.post(
			"records",
			Array.from({ length: 30 }, (_, i) => ({
				key: `key-${i + 1}`,
				score: i + 1,
			})),
		);
		for (let i = 1; i <= 10; i++) {
			await db.delete("records", i * 2);
			await db.compact("records");
			assert.equal(await db.get("records", i * 2), null);
			assert.equal(((await db.get("records", 29)) as any).key, "key-29");
		}
		assert.equal(await db.post("records", { key: "new", score: 99 }), 31);
		assert.equal(
			((await db.get("records", undefined, { perPage: -1 })) as any[]).length,
			21,
		);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
