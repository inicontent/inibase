import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	appendFile,
	mkdtemp,
	open,
	readdir,
	readFile,
	rm,
	stat,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseResources } from "../src/resources.js";
import {
	type RowMutation,
	type RowSnapshot,
	RowStore,
} from "../src/rowstore.js";
import { decodeHeader } from "../src/seek.js";

async function* batch(mutations: RowMutation[]) {
	yield* mutations;
}
const collect = async (snapshot: RowSnapshot, id: number) => {
	const chunks: Buffer[] = [];
	for await (const chunk of snapshot.read(id)) chunks.push(chunk);
	return Buffer.concat(chunks);
};
const setup = async () => {
	const directory = await mkdtemp(join(tmpdir(), "inibase-rowstore-")),
		resources = new DatabaseResources(),
		store = new RowStore(directory, resources);
	await store.create();
	return {
		directory,
		resources,
		store,
		async close() {
			await resources.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
};
const child = (directory: string, mode: string, argument: string) => {
	const processChild = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			new URL("./rowstore.child.ts", import.meta.url).pathname,
			directory,
			mode,
			argument,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let stderr = "";
	processChild.stdout.resume();
	processChild.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	return new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
		stderr: string;
	}>((accept, reject) => {
		processChild.once("error", reject);
		processChild.once("exit", (code, signal) =>
			accept({ code, signal, stderr }),
		);
	});
};

test("mutable rows preserve sparse IDs, atomic batches, tombstones and old snapshots", async () => {
	const env = await setup();
	try {
		await env.store.commit(
			batch([
				{ id: 0, value: Buffer.from("zero") },
				{ id: Number.MAX_SAFE_INTEGER, value: Buffer.from("sparse") },
				{ id: 8, value: Buffer.from("old") },
			]),
		);
		const old = await env.store.snapshot();
		await env.store.commit(
			batch([
				{ id: 8, value: Buffer.from("new") },
				{ id: 0, value: null },
				{ id: 7, value: Buffer.alloc(0) },
				{ id: 900, value: null },
			]),
		);
		const next = await env.store.snapshot();
		assert.equal(old.rows, 3);
		assert.equal(next.rows, 3);
		assert.equal((await collect(old, 0)).toString(), "zero");
		assert.equal((await collect(old, 8)).toString(), "old");
		assert.equal((await collect(next, 8)).toString(), "new");
		assert.equal(
			(await collect(next, Number.MAX_SAFE_INTEGER)).toString(),
			"sparse",
		);
		assert.equal(await next.has(0), false);
		assert.equal(await next.has(900), false);
		assert.equal(await next.has(7), true);
		assert.equal((await collect(next, 7)).length, 0);
		await env.store.commit(
			batch([
				{ id: 0, value: Buffer.from("revived") },
				{ id: 8, value: null },
				{ id: 8, value: Buffer.from("twice") },
			]),
		);
		assert.equal((await env.store.snapshot()).rows, 4);
		assert.equal(
			(await collect(await env.store.snapshot(), 8)).toString(),
			"twice",
		);
		await assert.rejects(env.store.create(), /ROWSTORE_EXISTS/);
	} finally {
		await env.close();
	}
});

test("seeded random histories match an independent model after reopen", async () => {
	const env = await setup(),
		model = new Map<number, Buffer>();
	let seed = 42;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed;
	};
	try {
		for (let round = 0; round < 8; round++) {
			const changes: RowMutation[] = [];
			for (let index = 0; index < 128; index++) {
				const id = random() % 239,
					value =
						random() % 4 === 0
							? null
							: Buffer.from(`${round}:${index}:${random()}`);
				changes.push({ id, value });
				if (value === null) model.delete(id);
				else model.set(id, value);
			}
			await env.store.commit(batch(changes));
			const reopened = await new RowStore(
				env.directory,
				env.resources,
			).snapshot();
			assert.equal(reopened.rows, model.size);
			for (let id = 0; id < 239; id++) {
				assert.equal(await reopened.has(id), model.has(id));
				assert.deepEqual(
					await collect(reopened, id),
					model.get(id) ?? Buffer.alloc(0),
				);
			}
		}
	} finally {
		await env.close();
	}
});

test("large high-entropy values stream under a shared 256 KiB reservation", async () => {
	const prior = process.env.INIBASE_MEMORY_BYTES;
	process.env.INIBASE_MEMORY_BYTES = "262144";
	const env = await setup();
	if (prior === undefined) delete process.env.INIBASE_MEMORY_BYTES;
	else process.env.INIBASE_MEMORY_BYTES = prior;
	try {
		const expected = randomBytes(2 * 1024 * 1024 + 11);
		async function* input() {
			for (let offset = 0; offset < expected.length; offset += 7919)
				yield expected.subarray(offset, offset + 7919);
		}
		await env.store.commit(batch([{ id: 22, value: input() }]));
		assert.deepEqual(await collect(await env.store.snapshot(), 22), expected);
		assert.ok(env.resources.stats().peakAccountedBytes <= 262144);
		assert.equal(env.resources.stats().workingBytes, 0);
	} finally {
		await env.close();
	}
});

test("failed streamed batches remain invisible and their tails are repaired", async () => {
	const env = await setup();
	try {
		await env.store.commit(batch([{ id: 1, value: Buffer.from("old") }]));
		const before = await readFile(join(env.directory, "CURRENT.rowstore"));
		async function* broken() {
			yield { id: 1, value: randomBytes(100000) };
			yield { id: 2, value: Buffer.from("never") };
			throw new Error("injected-input-failure");
		}
		await assert.rejects(env.store.commit(broken()), /injected-input-failure/);
		assert.deepEqual(
			await readFile(join(env.directory, "CURRENT.rowstore")),
			before,
		);
		assert.equal(
			(await collect(await env.store.snapshot(), 1)).toString(),
			"old",
		);
		assert.equal(await (await env.store.snapshot()).has(2), false);
		const state = decodeHeader(before),
			file = join(env.directory, state.file);
		assert.ok((await stat(file)).size > state.end);
		await env.store.commit(batch([]));
		assert.equal((await stat(file)).size, state.end);
		await appendFile(file, Buffer.from("torn unpublished garbage"));
		await env.store.commit(batch([{ id: 2, value: Buffer.from("safe") }]));
		assert.equal(
			(await collect(await env.store.snapshot(), 2)).toString(),
			"safe",
		);
	} finally {
		await env.close();
	}
});

for (const phase of ["appended", "data-synced", "manifest-synced", "published"])
	test(`process death at ${phase} preserves an atomic published batch`, async () => {
		const env = await setup();
		try {
			await env.store.commit(
				batch([
					{ id: 1, value: Buffer.from("old") },
					{ id: 2, value: Buffer.from("retained") },
				]),
			);
			const exited = await child(env.directory, "crash", phase);
			assert.equal(exited.signal, "SIGKILL", exited.stderr);
			const snapshot = await env.store.snapshot(),
				published = phase === "published";
			assert.equal(
				(await collect(snapshot, 1)).toString(),
				published ? "new" : "old",
			);
			assert.equal(await snapshot.has(2), !published);
			assert.equal(await snapshot.has(3), published);
			assert.equal(snapshot.rows, 2);
			await env.store.commit(
				batch([{ id: 4, value: Buffer.from("after recovery") }]),
			);
			assert.equal((await env.store.snapshot()).rows, 3);
		} finally {
			await env.close();
		}
	});

test(
	"independent writers serialize without losing batches or changing retained snapshots",
	{ timeout: 30000 },
	async () => {
		const env = await setup();
		try {
			await env.store.commit(
				batch([{ id: 1, value: Buffer.from("original") }]),
			);
			const retained = await env.store.snapshot();
			const results = await Promise.all(
				[100, 1000, 10000].map((start) =>
					child(env.directory, "writer", String(start)),
				),
			);
			for (const result of results) assert.equal(result.code, 0, result.stderr);
			const snapshot = await env.store.snapshot();
			assert.equal(snapshot.rows, 97);
			for (const start of [100, 1000, 10000])
				for (let index = 0; index < 32; index++)
					assert.equal(
						(await collect(snapshot, start + index)).toString(),
						`writer:${start}:${index}`,
					);
			assert.equal(retained.rows, 1);
			assert.equal(await retained.has(100), false);
		} finally {
			await env.close();
		}
	},
);

test(
	"readers stay on the published snapshot while a writer pauses before publication",
	{ timeout: 15000 },
	async () => {
		const env = await setup();
		let writer: ReturnType<typeof spawn> | undefined;
		let finished: Promise<number | null> | undefined;
		try {
			await env.store.commit(
				batch([
					{ id: 1, value: Buffer.from("old") },
					{ id: 2, value: Buffer.from("retained") },
				]),
			);
			writer = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					new URL("./rowstore.child.ts", import.meta.url).pathname,
					env.directory,
					"pause",
					"manifest-synced",
				],
				{ stdio: ["ignore", "ignore", "inherit", "ipc"] },
			);
			const running = writer;
			finished = new Promise((accept, reject) => {
				running.once("error", reject);
				running.once("exit", (code) => accept(code));
			});
			await new Promise<void>((accept, reject) => {
				running.once("message", () => accept());
				running.once("exit", () =>
					reject(new Error("writer exited before pause")),
				);
			});
			for (let attempt = 0; attempt < 16; attempt++) {
				const snapshot = await env.store.snapshot();
				assert.equal(snapshot.rows, 2);
				assert.equal((await collect(snapshot, 1)).toString(), "old");
				assert.equal(await snapshot.has(2), true);
				assert.equal(await snapshot.has(3), false);
			}
			writer.send({ release: true });
			assert.equal(await finished, 0);
			const published = await env.store.snapshot();
			assert.equal((await collect(published, 1)).toString(), "new");
			assert.equal(await published.has(2), false);
			assert.equal(await published.has(3), true);
		} finally {
			writer?.kill("SIGKILL");
			await finished;
			await env.close();
		}
	},
);

test("failure at every publication barrier rejects instead of acknowledging", async () => {
	const env = await setup();
	try {
		for (const phase of [
			"appended",
			"data-synced",
			"manifest-synced",
			"published",
		]) {
			await env.store.commit(batch([{ id: 1, value: Buffer.from("old") }]));
			await assert.rejects(
				env.store.commit(
					batch([{ id: 1, value: Buffer.from("new") }]),
					(point) => {
						if (point === phase) throw new Error("injected-io-error");
					},
				),
				/injected-io-error/,
			);
			assert.equal(
				(await collect(await env.store.snapshot(), 1)).toString(),
				phase === "published" ? "new" : "old",
			);
		}
	} finally {
		await env.close();
	}
});

test("actual synchronization errors release locks and never return success", async () => {
	const env = await setup();
	try {
		const probe = await open(join(env.directory, "CURRENT.rowstore"), "r"),
			prototype = Object.getPrototypeOf(probe),
			original = prototype.sync;
		await probe.close();
		for (const failAt of [1, 2, 3, 4]) {
			await env.store.commit(batch([{ id: 1, value: Buffer.from("old") }]));
			let calls = 0;
			prototype.sync = async function () {
				if (++calls === failAt)
					throw Object.assign(new Error("injected-fsync-EIO"), { code: "EIO" });
				return original.call(this);
			};
			try {
				await assert.rejects(
					env.store.commit(batch([{ id: 1, value: Buffer.from("new") }])),
					{ code: "EIO" },
				);
			} finally {
				prototype.sync = original;
			}
			assert.equal(
				(await collect(await env.store.snapshot(), 1)).toString(),
				failAt === 4 ? "new" : "old",
			);
			assert.equal(
				(await readdir(join(env.directory, ".tmp"))).includes(".locked"),
				false,
			);
			await env.store.commit(
				batch([{ id: 2, value: Buffer.from("writer recovered") }]),
			);
		}
	} finally {
		await env.close();
	}
});

test(
	"many tables share working memory and fresh/pooled descriptor limits",
	{ timeout: 30000 },
	async () => {
		const oldMemory = process.env.INIBASE_MEMORY_BYTES,
			oldFiles = process.env.INIBASE_MAX_OPEN_FILES;
		process.env.INIBASE_MEMORY_BYTES = "262144";
		process.env.INIBASE_MAX_OPEN_FILES = "4";
		const resources = new DatabaseResources(),
			directory = await mkdtemp(join(tmpdir(), "inibase-rowstore-many-"));
		if (oldMemory === undefined) delete process.env.INIBASE_MEMORY_BYTES;
		else process.env.INIBASE_MEMORY_BYTES = oldMemory;
		if (oldFiles === undefined) delete process.env.INIBASE_MAX_OPEN_FILES;
		else process.env.INIBASE_MAX_OPEN_FILES = oldFiles;
		let maximum = 0;
		const timer = setInterval(() => {
			maximum = Math.max(maximum, resources.stats().openFiles);
		}, 1);
		try {
			const stores = Array.from(
				{ length: 24 },
				(_, index) =>
					new RowStore(join(directory, `table-${index}`), resources),
			);
			await Promise.all(stores.map((store) => store.create()));
			await Promise.all(
				stores.map((store, index) =>
					store.commit(
						batch([{ id: index, value: Buffer.from(`table-${index}`) }]),
					),
				),
			);
			await Promise.all(
				stores.map(async (store, index) =>
					assert.equal(
						(await collect(await store.snapshot(), index)).toString(),
						`table-${index}`,
					),
				),
			);
			assert.ok(maximum <= 4);
			assert.ok(resources.stats().peakAccountedBytes <= 262144);
			assert.equal(resources.stats().workingBytes, 0);
		} finally {
			clearInterval(timer);
			await resources.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("committed truncation and replacement fail closed", async () => {
	const env = await setup();
	try {
		await env.store.commit(batch([{ id: 1, value: Buffer.from("value") }]));
		const state = decodeHeader(
				await readFile(join(env.directory, "CURRENT.rowstore")),
			),
			file = join(env.directory, state.file),
			original = await readFile(file);
		await truncate(file, state.end - 1);
		await assert.rejects(env.store.snapshot(), /ROWSTORE_GENERATION/);
		await assert.rejects(env.store.commit(batch([])), /ROWSTORE_GENERATION/);
		await writeFile(file, original);
		const handle = await open(file, "r+");
		try {
			const byte = Buffer.from([original[state.root] ^ 1]);
			await handle.write(byte, 0, 1, state.root);
		} finally {
			await handle.close();
		}
		await assert.rejects((await env.store.snapshot()).has(1), /ROWSTORE_INDEX/);
		assert.equal(
			(await readdir(env.directory)).filter((name) => name.endsWith(".rows"))
				.length,
			1,
		);
	} finally {
		await env.close();
	}
});

test("compressed data corruption and invalid IDs do not produce successful reads", async () => {
	const env = await setup();
	try {
		await env.store.commit(
			batch([{ id: 1, value: Buffer.from("checked contents") }]),
		);
		for (const id of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
			await assert.rejects(
				env.store.commit(batch([{ id, value: Buffer.from("invalid") }])),
				/ROWSTORE_ID/,
			);
		const state = decodeHeader(
				await readFile(join(env.directory, "CURRENT.rowstore")),
			),
			file = await open(join(env.directory, state.file), "r+");
		try {
			await file.write(Buffer.from([0xff]), 0, 1, 256 + 16);
		} finally {
			await file.close();
		}
		await assert.rejects(collect(await env.store.snapshot(), 1));
	} finally {
		await env.close();
	}
});
