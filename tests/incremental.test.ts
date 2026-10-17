import assert from "node:assert/strict";
import {
	mkdtemp,
	readFile,
	rename,
	rm,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TableOverlay } from "../src/overlay.js";
import { buildFrames, encodeFrame, UpdateLog } from "../src/updatelog.js";

const record = (id: number, value = id) => ({
	id,
	cols: { value },
	updatedAt: value,
});

test("incremental replay consumes each appended frame once, including writer refresh", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-incremental-"));
	try {
		const log = new UpdateLog(root);
		const overlay = new TableOverlay(root, 0);
		for (let gen = 1; gen <= 30; gen++) {
			await log.append({ gen, records: [record(gen)] });
			await overlay.refreshForWrite();
			await overlay.refresh();
		}
		assert.equal(overlay.size, 30);
		assert.equal(overlay.replayStats.frames, 30);
		assert.equal(overlay.replayStats.rebuilds, 1);
		assert.equal(overlay.replayStats.bytes, (await readFile(log.path)).length);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("replacement, same-size rewrite, truncation and torn tail invalidate replay state", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-incremental-"));
	try {
		const log = new UpdateLog(root);
		const overlay = new TableOverlay(root, 0);
		const frame = (value: number) =>
			encodeFrame({ gen: 1, records: [record(1, value)] });
		await writeFile(log.path, frame(1));
		await overlay.refresh();
		await writeFile(log.path, frame(2));
		await overlay.refresh();
		assert.equal((await overlay.get(1))?.cols.value, 2);
		await writeFile(`${log.path}.new`, frame(3));
		await rename(`${log.path}.new`, log.path);
		await overlay.refresh();
		assert.equal((await overlay.get(1))?.cols.value, 3);
		await truncate(log.path, 0);
		await overlay.refreshForWrite();
		assert.equal(overlay.size, 0);
		await writeFile(
			log.path,
			Buffer.concat([frame(4), Buffer.from([1, 2, 3])]),
		);
		await overlay.refresh();
		assert.equal((await overlay.get(1))?.cols.value, 4);
		await overlay.refreshForWrite();
		assert.deepEqual(await readFile(log.path), frame(4));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("concurrent refreshes never clear a view another refresh is rebuilding", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-incremental-"));
	try {
		const log = new UpdateLog(root);
		await log.append({
			gen: 1,
			records: Array.from({ length: 1000 }, (_, i) => record(i)),
		});
		const overlay = new TableOverlay(root, 0);
		await Promise.all(Array.from({ length: 20 }, () => overlay.refresh()));
		assert.equal(overlay.size, 1000);
		assert.equal(overlay.replayStats.frames, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("frame building is byte-exact across unicode and generation-width boundaries", () => {
	const records = Array.from({ length: 100 }, (_, i) => ({
		...record(i),
		cols: { value: "مرحبا😀".repeat(4) },
	}));
	const frames = buildFrames(records, 9, 512);
	assert.ok(frames.length > 2);
	assert.deepEqual(
		frames.flatMap((f) => f.records),
		records,
	);
	for (const frame of frames) assert.ok(encodeFrame(frame).length <= 512);
});
