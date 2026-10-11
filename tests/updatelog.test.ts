// Update-log unit tests: frame round-trip, generation ordering, torn-tail
// repair, mid-log corruption detection, frame splitting, and the streaming
// scanner. These cover the commit/recovery rules of plan §2 before any
// engine wiring.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
	buildFrames,
	encodeFrame,
	type ScanResult,
	scanFrames,
	type UpdateFrame,
	UpdateLog,
	UpdateLogFrameTooLargeError,
	type UpdateRecord,
	updateLogExists,
} from "../src/updatelog.js";

const tableDir = "test-db-updatelog";
const logPath = join(tableDir, "updates.log");

const record = (
	id: number,
	cols: Record<string, unknown> = { name: `n${id}` },
): UpdateRecord => ({ id, cols, updatedAt: 1_700_000_000_000 + id });

const frame = (gen: number, ids: number[]): UpdateFrame => ({
	gen,
	records: ids.map((id) => record(id)),
});

function freshTable() {
	if (existsSync(tableDir)) rmSync(tableDir, { recursive: true, force: true });
	mkdirSync(tableDir, { recursive: true });
}

const expectReject = async (
	promise: Promise<unknown>,
	name: string,
): Promise<void> => {
	await assert.rejects(promise, (error: Error) => error.name === name);
};

test("encode/scan round-trips frames with contiguous generations", () => {
	const first = frame(5, [1, 2]);
	const second = frame(6, [3]);
	const buffer = Buffer.concat([encodeFrame(first), encodeFrame(second)]);

	const result = scanFrames(buffer, 5);
	assert.equal(result.frameCount, 2);
	assert.equal(result.tornTail, false);
	assert.equal(result.lastGen, 6);
	assert.equal(result.committedBytes, buffer.length);
});

test("scanFrames rejects a generation that is out of order", () => {
	const buffer = encodeFrame(frame(7, [1]));
	assert.throws(
		() => scanFrames(buffer, 5),
		(error: Error) => error.name === "UPDATE_LOG_CORRUPT",
	);
});

test("a partial trailing frame is a torn tail, and repair truncates it", async () => {
	freshTable();
	const log = new UpdateLog(tableDir);
	await log.append(frame(1, [1]));
	await log.append(frame(2, [2]));

	const complete = await readFile(logPath);
	// Simulate a crash mid-append: keep two whole frames plus a partial third.
	await writeFile(
		logPath,
		Buffer.concat([complete, encodeFrame(frame(3, [3])).subarray(0, 6)]),
	);

	const scanned = await log.scan(1);
	assert.equal(scanned.frameCount, 2);
	assert.equal(scanned.tornTail, true);
	assert.equal(scanned.committedBytes, complete.length);

	const repaired = await log.repairTail(1);
	assert.equal(repaired.tornTail, true);
	assert.equal((await readFile(logPath)).length, complete.length);

	// The next append lands at the repaired boundary and gen continues.
	const lastGen = await log.appendBatch([record(3)], repaired.lastGen + 1);
	assert.equal(lastGen, 3);
	const after = await log.scan(1);
	assert.equal(after.tornTail, false);
	assert.equal(after.frameCount, 3);
	assert.equal(after.lastGen, 3);
	await log.dispose();
});

test("a checksum failure at end-of-file is a torn tail, not corruption", () => {
	const encoded = encodeFrame(frame(1, [1]));
	encoded[encoded.length - 1] ^= 0xff; // flip the last payload byte
	const result = scanFrames(encoded, 1);
	assert.equal(result.frameCount, 0);
	assert.equal(result.tornTail, true);
	assert.equal(result.committedBytes, 0);
});

test("a checksum failure followed by a valid frame is corruption", () => {
	const damaged = encodeFrame(frame(1, [1]));
	damaged[damaged.length - 1] ^= 0xff;
	const buffer = Buffer.concat([damaged, encodeFrame(frame(2, [2]))]);
	assert.throws(
		() => scanFrames(buffer, 1),
		(error: Error) => error.name === "UPDATE_LOG_CORRUPT",
	);
});

test("streaming scan detects mid-log corruption too", async () => {
	freshTable();
	const damaged = encodeFrame(frame(1, [1]));
	damaged[damaged.length - 1] ^= 0xff;
	await writeFile(
		logPath,
		Buffer.concat([damaged, encodeFrame(frame(2, [2]))]),
	);
	const log = new UpdateLog(tableDir);
	await expectReject(log.scan(1), "UPDATE_LOG_CORRUPT");
	await log.dispose();
});

test("streaming scan ignores an implausible oversized length", async () => {
	freshTable();
	const encoded = encodeFrame(frame(1, [1]));
	encoded.writeUInt32LE(0xffffffff, 0);
	await writeFile(logPath, encoded);
	const log = new UpdateLog(tableDir);
	await expectReject(log.scan(1), "UPDATE_LOG_CORRUPT");
	await log.dispose();
});

test("buildFrames splits a batch under the cap and assigns sequential gens", () => {
	const records = Array.from({ length: 40 }, (_, index) => record(index + 1));
	const cap = encodeFrame(
		frame(1, [record(1, { blob: "x".repeat(400) })]),
	).length;
	const frames = buildFrames(records, 10, cap);
	assert.ok(frames.length > 1, "expected the batch to be split");
	assert.equal(frames[0].gen, 10);
	for (let index = 1; index < frames.length; index++)
		assert.equal(frames[index].gen, frames[index - 1].gen + 1);
	assert.equal(
		frames.reduce((total, current) => total + current.records.length, 0),
		records.length,
	);
	for (const current of frames)
		assert.ok(
			encodeFrame(current).length <= cap,
			"every frame stays within the cap",
		);
});

test("a single oversized record is rejected, not silently dropped", () => {
	const huge = record(1, { blob: "x".repeat(4096) });
	assert.throws(
		() => buildFrames([huge], 1, 256),
		(error: Error) => error.name === "UPDATE_LOG_FRAME_TOO_LARGE",
	);
	assert.ok(new UpdateLogFrameTooLargeError("p", 1, 0) instanceof Error);
});

test("appendBatch is durable and reopenable; scan streams every frame", async () => {
	freshTable();
	const log = new UpdateLog(tableDir);
	const lastGen = await log.appendBatch([record(1), record(2)], 1);
	assert.equal(lastGen, 1);
	await log.appendBatch([record(3)], 2);
	await log.dispose();

	const reopened = new UpdateLog(tableDir);
	const seen: number[] = [];
	const result = await reopened.scan(1, undefined, (current) => {
		for (const rec of current.records) seen.push(Number(rec.id));
	});
	assert.deepEqual(seen, [1, 2, 3]);
	assert.equal(result.frameCount, 2);
	assert.equal(result.lastGen, 2);
	assert.ok(await updateLogExists(tableDir));
	await reopened.dispose();
});

test("scan of a missing log yields an empty committed state", async () => {
	freshTable();
	const log = new UpdateLog(tableDir);
	const result: ScanResult = await log.scan(42);
	assert.equal(result.frameCount, 0);
	assert.equal(result.tornTail, false);
	assert.equal(result.lastGen, 41);
	assert.equal(result.committedBytes, 0);
	assert.equal(await updateLogExists(tableDir), false);
	await log.dispose();
});
