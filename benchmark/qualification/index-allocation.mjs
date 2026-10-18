// Diagnostic allocation counts, not ordinary latency measurements.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [artifact, destination] = process.argv.slice(2);
const { default: Engine } = await import(pathToFileURL(artifact));
const root = await mkdtemp(join(tmpdir(), "inibase-index-alloc-"));
const db = new Engine("db", root);
const result = {
	artifact,
	rows: 100000,
	allocations: [],
	bytes: 0,
	runtime: process.versions,
};
try {
	await db.createTable("records", [{ key: "key", type: "string" }], {
		compression: true,
		decodeID: true,
		cache: false,
	});
	for (let first = 0; first < 100000; first += 1000)
		await db.post(
			"records",
			Array.from({ length: 1000 }, (_, i) => ({ key: `key-${first + i}` })),
		);
	const allocate = Buffer.alloc;
	Buffer.alloc = function (size, ...args) {
		if (size >= 262144) {
			result.bytes += size;
			result.allocations.push(size);
		}
		return allocate(size, ...args);
	};
	const start = performance.now();
	try {
		await db.optimize("records", { indexes: ["key"] });
	} finally {
		Buffer.alloc = allocate;
	}
	result.optimizeMs = performance.now() - start;
	assert.equal(
		(await db.get("records", { key: "key-99999" }))?.[0].key,
		"key-99999",
	);
	result.verified = true;
} catch (error) {
	result.verified = false;
	result.error = { message: error.message, stack: error.stack };
	process.exitCode = 1;
} finally {
	await db.close();
	await rm(root, { recursive: true, force: true });
	await writeFile(destination, JSON.stringify(result, null, 2) + "\n");
}
