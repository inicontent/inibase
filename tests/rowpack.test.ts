import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseResources } from "../src/resources.js";
import { rowBucket } from "../src/row-index.js";
import { buildRowPack, type PackedRow, RowPack } from "../src/rowpack.js";

for (const phase of [
	"index-spooled",
	"index-partitioned",
	"files-synced",
	"manifest-synced",
	"published",
])
	test(`row pages reopen after process death at ${phase}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "inibase-rowpack-kill-"));
		const resources = new DatabaseResources();
		try {
			await buildRowPack(
				directory,
				stream([{ id: 0, bytes: Buffer.from("old generation") }]),
				1,
				true,
				resources,
			);
			const child = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					new URL("./rowpack.crash.child.ts", import.meta.url).pathname,
					directory,
					phase,
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			let stderr = "";
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			const exit = await new Promise<{
				code: number | null;
				signal: NodeJS.Signals | null;
			}>((resolve, reject) => {
				child.on("error", reject);
				child.on("exit", (code, signal) => resolve({ code, signal }));
			});
			assert.equal(exit.signal, "SIGKILL", stderr);
			assert.equal(
				(await collect(await RowPack.open(directory, resources), 0)).toString(),
				phase === "published" ? "new generation" : "old generation",
			);
			// The next writer must reclaim the dead process's lock without losing CURRENT.
			await buildRowPack(
				directory,
				stream([{ id: 0, bytes: Buffer.from("recovered") }]),
				1,
				true,
				resources,
			);
			assert.equal(
				(await collect(await RowPack.open(directory, resources), 0)).toString(),
				"recovered",
			);
		} finally {
			await resources.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

async function* stream(rows: PackedRow[]) {
	yield* rows;
}
const collect = async (pack: RowPack, id: number) => {
	const chunks: Buffer[] = [];
	for await (const chunk of pack.read(id)) chunks.push(chunk);
	return Buffer.concat(chunks);
};

test("partitioned ID builds preserve sparse keys, collision chains and wraparound", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "inibase-rowpack-partitions-"),
	);
	const resources = new DatabaseResources();
	try {
		let base = 0;
		while (rowBucket(base, 8192) !== 8191) base++;
		const id = (i: number) => (i < 20 ? base + i * 8192 : 2 ** 40 + i * 104729);
		async function* records() {
			for (let i = 0; i < 4096; i++) {
				const seq = (i * 7919) % 4096;
				if (seq < 3000)
					yield { id: id(seq), bytes: Buffer.from(`record-${seq}`) };
			}
		}
		await buildRowPack(directory, records(), 3000, true, resources);
		const pack = await RowPack.open(directory, resources);
		for (const i of [
			...Array.from({ length: 20 }, (_, i) => i),
			40,
			1023,
			2048,
			2999,
		])
			assert.equal((await collect(pack, id(i))).toString(), `record-${i}`);
		assert.equal((await collect(pack, 2 ** 45)).length, 0);
		assert.deepEqual(await readdir(join(directory, ".tmp")), []);
		assert.ok(resources.stats().peakAccountedBytes <= resources.limit);
	} finally {
		await resources.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a truncated or corrupted private spool cannot publish missing IDs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "inibase-rowpack-spool-"));
	const resources = new DatabaseResources();
	try {
		const records = [{ id: 0, bytes: Buffer.from("old") }];
		await buildRowPack(directory, stream(records), 1, true, resources);
		const original = await readFile(join(directory, "CURRENT.rowpack"));
		for (const corruption of ["truncate", "checksum"]) {
			await assert.rejects(
				buildRowPack(
					directory,
					stream(records),
					1,
					true,
					resources,
					async (phase) => {
						if (phase !== "index-spooled") return;
						const name = (await readdir(join(directory, ".tmp"))).find((name) =>
							name.startsWith("rowpack-"),
						);
						assert.ok(name);
						const spool = join(directory, ".tmp", name, "ids");
						if (corruption === "truncate") await truncate(spool, 0);
						else {
							const bytes = await readFile(spool);
							bytes[8] ^= 0x80;
							await writeFile(spool, bytes);
						}
					},
				),
				/ROWPACK_(SPOOL_SIZE|SLOT_CHECKSUM)/,
			);
			assert.deepEqual(
				await readFile(join(directory, "CURRENT.rowpack")),
				original,
			);
			assert.deepEqual(await readdir(join(directory, ".tmp")), []);
		}
	} finally {
		await resources.close();
		await rm(directory, { recursive: true, force: true });
	}
});

for (const compression of [true, false])
	test(`row pages: sparse IDs, oversized values, snapshots and failed publication (${compression})`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "inibase-rowpack-"));
		const resources = new DatabaseResources();
		try {
			const rows = [
				{ id: 0, bytes: Buffer.from("first") },
				{ id: 2 ** 40 + 1, bytes: randomBytes(150000) },
				{ id: 91, bytes: Buffer.from("é🌍".repeat(16000)) },
			];
			await buildRowPack(
				directory,
				stream(rows),
				rows.length,
				compression,
				resources,
			);
			const old = await RowPack.open(directory, resources);
			for (const row of rows)
				assert.deepEqual(await collect(old, row.id), row.bytes);
			assert.equal((await collect(old, 123456)).length, 0);
			const original = await readFile(join(directory, "CURRENT.rowpack"));
			for (const phase of [
				"index-spooled",
				"files-synced",
				"manifest-synced",
			] as const) {
				await assert.rejects(
					buildRowPack(
						directory,
						stream(rows),
						rows.length,
						compression,
						resources,
						(point) => {
							if (point === phase) throw new Error("injected");
						},
					),
					/injected/,
				);
				assert.deepEqual(
					await readFile(join(directory, "CURRENT.rowpack")),
					original,
				);
			}
			await assert.rejects(
				buildRowPack(
					directory,
					stream([rows[0], rows[0]]),
					2,
					compression,
					resources,
				),
				/DUPLICATE/,
			);
			await assert.rejects(
				buildRowPack(directory, stream(rows), 4, compression, resources),
				/ROW_COUNT/,
			);
			await buildRowPack(
				directory,
				stream([{ id: 0, bytes: Buffer.from("replacement") }]),
				1,
				compression,
				resources,
			);
			assert.equal(
				(await collect(await RowPack.open(directory, resources), 0)).toString(),
				"replacement",
			);
			assert.equal((await collect(old, 0)).toString(), "first");
			assert.ok(resources.stats().peakAccountedBytes <= resources.limit);
			assert.equal(
				(await readdir(directory)).filter((name) => name.endsWith(".rows"))
					.length,
				2,
			);
		} finally {
			await resources.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

for (const suffix of ["rows", "pages", "ids"])
	test(`row pages fail closed on corrupt ${suffix}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "inibase-rowpack-corrupt-"));
		const resources = new DatabaseResources();
		try {
			await buildRowPack(
				directory,
				stream([{ id: 0, bytes: randomBytes(70000) }]),
				1,
				true,
				resources,
			);
			const path = join(
				directory,
				(await readdir(directory)).find((name) => name.endsWith(`.${suffix}`))!,
			);
			const bytes = await readFile(path);
			bytes[256] ^= 0x80;
			await writeFile(path, bytes);
			const pack = await RowPack.open(directory, resources);
			await assert.rejects(collect(pack, 0));
		} finally {
			await resources.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
