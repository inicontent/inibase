import assert from "node:assert/strict";
import { mkdtemp, open, readdir, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DiskOverlay } from "../src/disk-overlay.js";
import { DatabaseResources } from "../src/resources.js";

test("overlay enumeration reads each current sparse ID once after churn and eviction", async () => {
	const root = await mkdtemp(join(tmpdir(), "overlay-churn-test-"));
	const resources = new DatabaseResources();
	const overlay = new DiskOverlay(root, resources);
	try {
		const ids = [0, 1, 512, 100000000];
		for (let round = 0; round < 8; round++)
			for (const id of ids)
				await overlay.set(id, {
					cols: { value: `round-${round}` },
					...(id === 512 ? { deleted: true } : {}),
				});
		// Obsolete scratch payloads are not authoritative and must not be decoded.
		const values = await open(`${overlay.prefix}.values`, "r+");
		await values.write(Buffer.from("!"), 0, 1, 4);
		await values.close();
		resources.dropPrefix(overlay.prefix);
		const seen = new Map();
		for await (const [id, value] of overlay.entries())
			seen.set(Number(id), value);
		assert.deepEqual([...seen.keys()], ids);
		for (const id of ids) assert.equal(seen.get(id).cols.value, "round-7");
		assert.equal(seen.get(512).deleted, true);
		assert.equal(overlay.size, ids.length);
		// Ensure the cached directory page follows subsequent positional writes.
		await overlay.set(1, { cols: { value: "changed" } });
		resources.delete(`${overlay.prefix}:row:1`);
		assert.equal((await overlay.get(1))?.cols.value, "changed");
		await overlay.clear();
		assert.deepEqual(await readdir(join(root, ".cache")), []);
		await overlay.set(42, { cols: { value: "new generation" } });
		const reset = [];
		for await (const entry of overlay.entries()) reset.push(entry);
		assert.equal(reset.length, 1);
		assert.equal(reset[0][0], "42");
	} finally {
		await overlay.clear();
		await resources.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("truncated dense overlay directory fails closed", async () => {
	const root = await mkdtemp(join(tmpdir(), "overlay-truncated-test-"));
	const resources = new DatabaseResources();
	const overlay = new DiskOverlay(root, resources);
	try {
		await overlay.set(1, { cols: { value: "a" } });
		await truncate(`${overlay.prefix}.keys`, 7);
		await assert.rejects(async () => {
			for await (const entry of overlay.entries()) void entry;
		}, /OVERLAY_CACHE_TRUNCATED/);
	} finally {
		await overlay.clear();
		await resources.close();
		await rm(root, { recursive: true, force: true });
	}
});
