import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as File from "../src/file.js";
import Inibase from "../src/index.js";
import { lookupLines } from "../src/key-index.js";
import { DatabaseResources } from "../src/resources.js";

test("a shared cache and reusable descriptors stay bounded across many tables", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-memory-"));
	process.env.INIBASE_MEMORY_BYTES = "1048576";
	process.env.INIBASE_MAX_OPEN_FILES = "4";
	const db = new Inibase("db", root);
	try {
		for (let i = 0; i < 18; i++) {
			await db.createTable(`table_${i}`, [{ key: "value", type: "string" }], {
				log: true,
				decodeID: true,
			});
			await db.post(`table_${i}`, { value: "original" });
			await db.put(`table_${i}`, { value: "x".repeat(65536) }, 1);
			assert.ok(db.memoryUsage().cacheBytes <= 1048576);
			assert.ok(db.memoryUsage().openFiles <= 4);
		}
		for (let i = 17; i >= 0; i--)
			assert.equal(
				((await db.get(`table_${i}`, 1)) as any).value.length,
				65536,
			);
		assert.ok(db.memoryUsage().peakCacheBytes <= 1048576);
		await db.close();
		assert.equal(db.memoryUsage().openFiles, 0);
	} finally {
		await db.close();
		delete process.env.INIBASE_MEMORY_BYTES;
		delete process.env.INIBASE_MAX_OPEN_FILES;
		await rm(root, { recursive: true, force: true });
	}
});

test("key indexes reject corruption, and damaged format markers fail closed", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-index-crash-"));
	const db = new Inibase("db", root);
	try {
		await db.createTable("records", [{ key: "key", type: "string" }], {
			log: true,
			decodeID: true,
			seekable: true,
			indexes: ["key"],
		});
		await db.post("records", [{ key: "a" }, { key: "b" }]);
		const path = join(root, "db/records/key.txt");
		const index = await open(`${path}.lookup`, "r+");
		try {
			const header = Buffer.alloc(4);
			await index.read(header, 0, 4, 0);
			header[0] ^= 1;
			await index.write(header, 0, 4, 0);
		} finally {
			await index.close();
		}
		await assert.rejects(lookupLines(path, ["a"]), /SEEK_HEADER/);
		await writeFile(join(root, "db/records/.format"), "{broken");
		await assert.rejects(
			() => db.get("records", 1),
			(error: any) => error.name === "UNSUPPORTED_FORMAT",
		);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("unique checks exclude only target rows, detect duplicates, and reuse deleted keys", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-unique-"));
	const db = new Inibase("db", root);
	try {
		await db.createTable(
			"records",
			[{ key: "key", type: "string", unique: true }],
			{
				decodeID: true,
				log: true,
				tombstones: true,
				seekable: true,
				indexes: ["key"],
			},
		);
		await db.post("records", [{ key: "a" }, { key: "b" }]);
		await db.put("records", { key: "a" }, 1);
		await assert.rejects(
			() => db.put("records", { key: "a" }, 2),
			(error: any) => error.name === "FIELD_UNIQUE",
		);
		await assert.rejects(
			() => db.post("records", [{ key: "c" }, { key: "c" }]),
			(error: any) => error.name === "FIELD_UNIQUE",
		);
		await db.delete("records", 1);
		await db.put("records", { key: "a" }, 2);
		assert.equal(((await db.get("records", { key: "a" })) as any[])[0].id, 2);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("failed regular-file synchronization is never reported as success", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-sync-"));
	try {
		await assert.rejects(
			() => File.syncFile(join(root, "missing")),
			(error: any) => error.code === "ENOENT",
		);
		await assert.rejects(
			() => File.syncDir(join(root, "missing")),
			(error: any) => error.code === "ENOENT",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("resource eviction closes handles rather than relying on GC", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-handles-"));
	const resources = new DatabaseResources();
	try {
		for (let i = 0; i < 100; i++) {
			const path = join(root, `file-${i}`);
			await writeFile(path, String(i));
			await resources.file(path, async (handle) =>
				assert.equal((await handle.readFile()).toString(), String(i)),
			);
			assert.ok(resources.stats().openFiles <= resources.handleLimit);
		}
		await resources.close();
		assert.equal(resources.stats().openFiles, 0);
		assert.equal((await readFile(join(root, "file-99"))).toString(), "99");
	} finally {
		await resources.close();
		await rm(root, { recursive: true, force: true });
	}
});
