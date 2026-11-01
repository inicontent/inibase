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
async function fixture(
	fn: (db: Inibase, path: string) => Promise<void>,
	prepend = false,
) {
	const root = await mkdtemp(join(tmpdir(), "inibase-auto-delta-")),
		db = new Inibase("db", root);
	try {
		await db.createTable("records", schema, {
			compression: true,
			decodeID: true,
			cache: true,
			prepend,
		});
		await db.post(
			"records",
			Array.from({ length: 300 }, (_, i) => ({
				key: `key-${i + 1}`,
				score: i + 1,
			})),
		);
		await db.optimize("records", { indexes: ["key"] });
		await fn(db, join(root, "db/records"));
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
}

test("automatic point writes/deletes keep base columns untouched and merge indexed keys, metadata and uniqueness", () =>
	fixture(async (db, path) => {
		const base = await readFile(join(path, "score.txt.gz")),
			before = await stat(join(path, "score.txt.gz"));
		await db.put("records", { score: 900, key: "updated" }, { key: "key-200" });
		const returned: any = await db.put(
			"records",
			{ score: 901 },
			{ key: "updated" },
			undefined,
			true,
		);
		assert.ok(Array.isArray(returned));
		assert.equal(returned[0].score, 901);
		assert.equal(typeof returned[0].updatedAt, "number");
		assert.equal(await db.get("records", { key: "key-200" }), null);
		await assert.rejects(db.post("records", { key: "updated", score: 0 }));
		await db.delete("records", [1, 3, 200, 299]);
		assert.equal(await db.get("records", 200), null);
		assert.equal(await db.get("records", { key: "updated" }), null);
		assert.deepEqual(await readFile(join(path, "score.txt.gz")), base);
		assert.equal((await stat(join(path, "score.txt.gz"))).ino, before.ino);
		assert.equal(
			JSON.parse(await readFile(join(path, ".format"), "utf8")).automatic,
			true,
		);
		assert.deepEqual(
			((await db.get("records", undefined, { perPage: 3 })) as any[]).map(
				(r) => r.id,
			),
			[2, 4, 5],
		);
		assert.equal(db.pageInfo.records.total, 296);
		assert.equal(await db.sum("records", "score"), 45150 - 1 - 3 - 200 - 299);
		assert.equal(await db.post("records", { key: "updated", score: 2 }), 301);
		assert.equal(((await db.get("records", 301)) as any).key, "updated");
		await db.compact("records");
		assert.equal((await readFile(join(path, "updates.log"))).length, 0);
		assert.equal(((await db.get("records", 301)) as any).score, 2);
		assert.equal(await db.get("records", 200), null);
	}));

test("transactions transparently fold prior deltas and retain commit/rollback behavior", () =>
	fixture(async (db) => {
		await db.put("records", { score: 500 }, 10);
		await db.delete("records", [1, 3]);
		await db.transaction(["records"], async () => {
			await db.put("records", { score: 1000 }, 10);
		});
		assert.equal(((await db.get("records", 10)) as any).score, 1000);
		assert.equal(await db.get("records", 1), null);
		await db.put("records", { score: 2000 }, 11);
		await assert.rejects(
			db.transaction(async () => {
				await db.delete("records", 11);
				throw Error("abort");
			}),
			/abort/,
		);
		assert.equal(((await db.get("records", 11)) as any).score, 2000);
		await db.transaction(async () => {
			await db.post("records", { key: "new", score: 99 });
		});
		assert.equal(((await db.get("records", 301)) as any).key, "new");
	}));

test("schema changes, prepend, broad updates and oversized values preserve supported fallbacks", () =>
	fixture(async (db, path) => {
		await db.put("records", { score: 10 }, 10);
		await db.delete("records", [1, 3]);
		await db.put(
			"records",
			{ score: 7 },
			Array.from({ length: 298 }, (_, i) => i + 2).filter((n) => n !== 3),
		);
		assert.equal(((await db.get("records", 299)) as any).score, 7);
		assert.equal(await db.get("records", 1), null);
		await db.put("records", { key: "x".repeat(1024 * 1024) }, 299);
		assert.equal(
			((await db.get("records", 299)) as any).key.length,
			1024 * 1024,
		);
		await db.put("records", { score: 8 }, 300);
		await db.updateTable("records", [
			...((await db.getTableSchema("records")) ?? []),
			{ key: "extra", type: "string" },
		]);
		assert.equal(((await db.get("records", 300)) as any).score, 8);
		await db.updateTable("records", undefined, { prepend: true });
		await db.put("records", { score: 9 }, 300);
		assert.equal(((await db.get("records", 300)) as any).score, 9);
		assert.notEqual(
			JSON.parse(await readFile(join(path, ".format"), "utf8")).log,
			true,
		);
		await db.delete("records");
		assert.equal(await db.get("records"), null);
	}));

test("prepend tables retain existing behavior without automatic append layout", () =>
	fixture(async (db) => {
		await db.put("records", { score: 77 }, 7);
		await db.delete("records", 9);
		assert.equal(((await db.get("records", 7)) as any).score, 77);
		assert.equal(await db.get("records", 9), null);
	}, true));

async function child(
	root: string,
	mode: string,
	argument = "",
	env: NodeJS.ProcessEnv = {},
) {
	const { fork } = await import("node:child_process");
	const proc = fork(
		new URL("./automatic-deltas.child.ts", import.meta.url),
		[root, mode, argument],
		{
			execArgv: ["--import", "tsx"],
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			env: { ...process.env, ...env },
		},
	);
	let error = "";
	proc.stderr?.on("data", (chunk) => {
		error += chunk;
	});
	const done = new Promise<void>((resolve, reject) => {
		proc.once("error", reject);
		proc.once("exit", (code, signal) =>
			code === 0 || signal === "SIGKILL"
				? resolve()
				: reject(Error(`${code}/${signal}: ${error}`)),
		);
	});
	const messages: any[] = [];
	proc.on("message", (message) => messages.push(message));
	return { proc, done, messages };
}

test("multiple processes see activation, concurrent deltas/deletes, compaction and reopen", () =>
	fixture(async (db, path) => {
		const root = join(path, "../..");
		const a = await child(root, "writer", "0"),
			b = await child(root, "writer", "1");
		for (let i = 0; i < 24; i++)
			assert.equal(((await db.get("records", 250)) as any).score, 250);
		await Promise.all([a.done, b.done]);
		for (let w = 0; w < 2; w++)
			for (let i = 0; i < 8; i++) {
				assert.equal(
					((await db.get("records", 10 + w * 10 + i)) as any).score,
					w * 100 + i + 1000,
				);
				assert.equal(await db.get("records", 100 + w * 10 + i), null);
			}
		const compact = await child(root, "compact", "", {
			INIBASE_MAX_OVERLAY_RECORDS: "8",
		});
		await compact.done;
		assert.equal(((await db.get("records", 33)) as any).score, 2023);
		const reopened = new Inibase("db", root);
		try {
			assert.equal(((await reopened.get("records", 10)) as any).score, 2000);
			assert.equal(await reopened.get("records", 100), null);
		} finally {
			await reopened.close();
		}
	}));

for (const point of ["marker", "append", "sync"])
	test(
		`process crash during automatic ${point} recovers a consistent table`,
		{ timeout: 15000 },
		() =>
			fixture(async (db, path) => {
				const run = await child(join(path, "../.."), "crash", point);
				try {
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(
							() => reject(Error("child did not pause")),
							10000,
						);
						run.proc.on("message", (m: any) => {
							if (m.paused === point) {
								clearTimeout(timer);
								resolve();
							}
						});
						run.done.catch(reject);
					});
					run.proc.kill("SIGKILL");
					await run.done;
					const row = (await db.get("records", 10)) as any;
					if (point === "marker") assert.equal(row.score, 10);
					else assert.ok(row.score === 10 || row.score === 900);
					if (point === "sync") assert.equal(row.score, 900);
					assert.equal(((await db.get("records", 11)) as any).score, 11);
					await db.put("records", { score: 901 }, 10);
					await db.delete("records", 11);
					assert.equal(((await db.get("records", 10)) as any).score, 901);
					assert.equal(await db.get("records", 11), null);
				} finally {
					run.proc.kill("SIGKILL");
					await run.done;
				}
			}),
	);

test("automatic append synchronization errors are rejected and subsequent writes recover", () =>
	fixture(async (db, path) => {
		await db.put("records", { score: 500 }, 12);
		const run = await child(join(path, "../.."), "failure");
		await run.done;
		assert.equal(((await db.get("records", 12)) as any).score, 500);
		assert.equal(((await db.get("records", 11)) as any).score, 777);
		await db.put("records", { score: 901 }, 10);
		assert.equal(((await db.get("records", 10)) as any).score, 901);
	}));

test(
	"process crash partway through compaction preserves acknowledged updates and tombstones",
	{ timeout: 15000 },
	() =>
		fixture(async (db, path) => {
			await db.put("records", { score: 500 }, 10);
			await db.delete("records", 11);
			const run = await child(join(path, "../.."), "compact-crash");
			try {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(
						() => reject(Error("compaction did not pause")),
						10000,
					);
					run.proc.on("message", (m: any) => {
						if (m.paused === "compaction") {
							clearTimeout(timer);
							resolve();
						}
					});
					run.done.catch(reject);
				});
				run.proc.kill("SIGKILL");
				await run.done;
				assert.equal(((await db.get("records", 10)) as any).score, 500);
				assert.equal(await db.get("records", 11), null);
				await db.compact("records");
				assert.equal(((await db.get("records", 10)) as any).score, 500);
				assert.equal(await db.get("records", 11), null);
			} finally {
				run.proc.kill("SIGKILL");
				await run.done;
			}
		}),
);

test(
	"automatic delta reservations and overlay handles share a small database allowance across tables",
	{ timeout: 15000 },
	() =>
		fixture(async (_db, path) => {
			const run = await child(join(path, "../.."), "memory", "", {
				INIBASE_MEMORY_BYTES: "262144",
				INIBASE_MAX_OPEN_FILES: "4",
			});
			await run.done;
			const stats = run.messages.find(
				(message) => message.statistics,
			)?.statistics;
			assert.ok(stats);
			assert.ok(stats.peakAccountedBytes <= 262144);
			assert.ok(stats.openFiles <= 4);
		}),
);

test("metadata supplied to a point update retains the existing base-write semantics", () =>
	fixture(async (db) => {
		await db.put("records", { score: 500 }, 10);
		const before = (await db.get("records", 10)) as any,
			createdAt = before.createdAt + 123;
		await db.put("records", { createdAt, score: 501 }, 10);
		const row = (await db.get("records", 10)) as any;
		assert.equal(row.createdAt, createdAt);
		assert.equal(row.score, 501);
	}));

test("successive small column updates fold before a merged overlay row exceeds its allowance", () =>
	fixture(async (db, path) => {
		const fields = Array.from({ length: 4 }, (_, i) => ({
			key: `field_${i}`,
			type: "string" as const,
		}));
		await db.createTable("wide", fields, { compression: true, decodeID: true });
		await db.post(
			"wide",
			Array.from({ length: 128 }, () =>
				Object.fromEntries(fields.map((f) => [f.key, ""])),
			),
		);
		for (const field of fields)
			await db.put("wide", { [field.key]: "x".repeat(6000) }, 64);
		const row = (await db.get("wide", 64)) as any;
		for (const field of fields) assert.equal(row[field.key], "x".repeat(6000));
		const format = JSON.parse(
			await readFile(join(path, "../wide/.format"), "utf8"),
		);
		assert.ok(format.baseGen >= 2);
	}));

test("sorted reads fold automatic deltas and retain indexed stable-ID selection after deletes", () =>
	fixture(async (db, path) => {
		await db.put("records", { score: 900 }, 200);
		await db.delete("records", [1, 3]);
		const rows = (await db.get("records", undefined, {
			sort: { score: "DESC" },
			perPage: 3,
		})) as any[];
		assert.deepEqual(
			rows.map((row) => row.id),
			[200, 300, 299],
		);
		assert.equal((await readFile(join(path, "updates.log"))).length, 0);
		await db.put("records", { score: 901 }, 200);
		const updated = (await db.put(
			"records",
			{ score: 902 },
			200,
			{ sort: { score: "DESC" } },
			true,
		)) as any;
		assert.equal(updated.id, 200);
		assert.equal(updated.score, 902);
	}));

test("automatic deltas retain encrypted public IDs across deletion, compaction and reopen", () =>
	fixture(async (db, path) => {
		await db.createTable("encoded", schema, { compression: true });
		const ids = (await db.post(
			"encoded",
			Array.from({ length: 128 }, (_, i) => ({
				key: `encoded-${i}`,
				score: i,
			})),
		)) as string[];
		assert.equal(typeof ids[63], "string");
		await db.put("encoded", { score: 500 }, ids[63]);
		assert.equal(((await db.get("encoded", ids[63])) as any).id, ids[63]);
		await db.delete("encoded", ids[64]);
		assert.equal(await db.get("encoded", ids[64]), null);
		await db.compact("encoded");
		assert.equal(((await db.get("encoded", ids[63])) as any).score, 500);
		const reopened = new Inibase("db", join(path, "../.."));
		try {
			assert.equal(
				((await reopened.get("encoded", ids[63])) as any).id,
				ids[63],
			);
			assert.equal(await reopened.get("encoded", ids[64]), null);
		} finally {
			await reopened.close();
		}
	}));

test("query caches are invalidated by log generations even when compaction preserves row count", () =>
	fixture(async (db) => {
		assert.equal(
			((await db.get("records", { key: "key-10" })) as any[])[0].id,
			10,
		);
		await db.put("records", { key: "renamed" }, 10);
		await db.compact("records");
		assert.equal(await db.get("records", { key: "key-10" }), null);
		assert.equal(
			((await db.get("records", { key: "renamed" })) as any[])[0].id,
			10,
		);
		await db.put("records", { key: "again" }, 10);
		await db.compact("records");
		assert.equal(await db.get("records", { key: "renamed" }), null);
		assert.equal(
			((await db.get("records", { key: "again" })) as any[])[0].id,
			10,
		);
	}));
