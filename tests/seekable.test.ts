import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import Inibase from "../src/index.js";
import { lookupLines } from "../src/key-index.js";
import { readSeekable } from "../src/seek.js";

const schema = [
	{ key: "key", type: "string" as const, required: true },
	{ key: "body", type: "string" as const },
	{ key: "score", type: "number" as const },
];

for (const blockBytes of [65536, 131072, 262144]) {
	test(`seekable gzip ${blockBytes}: random keys, oversized UTF-8 cells and misses`, async () => {
		const root = await mkdtemp(join(tmpdir(), "inibase-seek-"));
		const db = new Inibase("db", root);
		try {
			await db.createTable("records", schema, {
				compression: true,
				decodeID: true,
				seekable: true,
				indexes: ["key"],
				blockBytes,
			});
			const rows = Array.from({ length: 300 }, (_, i) => ({
				key: randomBytes(16).toString("hex"),
				body:
					i === 173
						? "مرحبا😀\n\\".repeat(100000)
						: `${i}:${randomBytes(600).toString("base64")}`,
				score: i,
			}));
			await db.post("records", rows);
			const path = join(root, "db/records/body.txt.gz");
			for (const i of [299, 173, 0, 121, 174]) {
				const value = await db.get("records", { key: rows[i].key });
				assert.equal((value as any[])?.[0]?.body, rows[i].body);
				assert.equal(
					((await db.get("records", i + 1)) as any)?.body,
					rows[i].body,
				);
			}
			assert.equal(await db.get("records", { key: "missing" }), null);
			assert.equal(await db.get("records", 99999), null);
			assert.deepEqual(
				await lookupLines(join(root, "db/records/id.txt.gz"), ["174"]),
				[174],
			);
			const selected = await readSeekable(path, [174]);
			assert.equal(selected?.size, 1);
			// The primary data is still a standards-compliant multi-member gzip.
			assert.equal(
				gunzipSync(await readFile(path))
					.toString()
					.split("\n").length,
				301,
			);
			assert.ok(db.memoryUsage().cacheBytes <= db.memoryUsage().limitBytes);
		} finally {
			await db.close();
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("journaled migration, populated overlays, key changes, deletes, compaction and reopen", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-seek-"));
	const db = new Inibase("db", root);
	try {
		await db.createTable("records", schema, {
			compression: true,
			decodeID: true,
			log: true,
		});
		await db.post(
			"records",
			Array.from({ length: 100 }, (_, i) => ({
				key: `key-${i}`,
				body: `body-${i}`,
				score: i,
			})),
		);
		await db.put("records", { key: "new-key", score: 1000 }, 50);
		await db.optimize("records", { indexes: ["key", "score"] });
		assert.equal(
			((await db.get("records", { key: "new-key" })) as any[])[0].id,
			50,
		);
		assert.equal(await db.get("records", { key: "key-49" }), null);
		await db.put("records", { key: "second-key" }, 50);
		assert.equal(await db.get("records", { key: "new-key" }), null);
		assert.equal(
			((await db.get("records", { key: "second-key" })) as any[])[0].id,
			50,
		);
		await db.compact("records");
		assert.equal(
			((await db.get("records", { score: 1000 })) as any[])[0].key,
			"second-key",
		);
		await db.delete("records", 49);
		assert.equal(
			((await db.get("records", { key: "second-key" })) as any[])[0].id,
			50,
		);
		assert.equal(await db.get("records", { key: "key-48" }), null);
		await db.close();
		const reopened = new Inibase("db", root);
		try {
			assert.equal(
				((await reopened.get("records", 50)) as any).key,
				"second-key",
			);
		} finally {
			await reopened.close();
		}
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("stale directories and indexes fall back instead of serving stale data", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-seek-"));
	const db = new Inibase("db", root);
	try {
		await db.createTable("records", schema, {
			decodeID: true,
			seekable: true,
			indexes: ["key"],
		});
		await db.post("records", [{ key: "old", body: "hello", score: 1 }]);
		const path = join(root, "db/records/key.txt");
		const before = await stat(path);
		await writeFile(path, "new\n");
		assert.notEqual((await stat(path)).mtimeMs, before.mtimeMs);
		assert.equal(await lookupLines(path, ["old"]), null);
		assert.equal(await readSeekable(path, [1]), null);
		assert.equal(
			((await db.get("records", { key: "new" })) as any[])[0].key,
			"new",
		);
		assert.equal(await db.get("records", { key: "old" }), null);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("seekable legacy tables retain transactions, prepend and nested fields", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-seek-"));
	const db = new Inibase("db", root);
	try {
		await db.createTable(
			"records",
			[
				...schema,
				{
					key: "meta",
					type: "object",
					children: [{ key: "name", type: "string" }],
				},
			],
			{
				compression: true,
				decodeID: true,
				prepend: true,
				seekable: true,
				indexes: ["key"],
			},
		);
		await db.post("records", {
			key: "one",
			body: "a",
			score: 1,
			meta: { name: "nested" },
		});
		await db.begin(["records"]);
		await db.post("records", {
			key: "two",
			body: "b",
			score: 2,
			meta: { name: "other" },
		});
		await db.rollback();
		assert.equal(await db.get("records", { key: "two" }), null);
		await db.begin(["records"]);
		await db.post("records", {
			key: "two",
			body: "b",
			score: 2,
			meta: { name: "other" },
		});
		await db.commit();
		assert.equal(((await db.get("records", 1)) as any).meta.name, "nested");
		assert.equal(
			((await db.get("records", { key: "two" })) as any[])[0].meta.name,
			"other",
		);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
