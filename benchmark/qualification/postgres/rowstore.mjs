// Mutable BYTEA/BLOB kernel comparison. Not public iniBase API qualification.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const options = JSON.parse(process.argv[2]);
const {
	engine,
	rows: count,
	profile,
	budget,
	directory,
	samples,
	writes,
} = options;
const result = {
	workloadVersion: "mutable-row-kernel-1",
	options,
	runtime: process.versions,
	runtimeBaselineRss: process.memoryUsage().rss,
	verified: false,
	timings: {},
	latency: {},
	phases: [],
	errors: [],
	commitTraces: [],
};
const row = (id, changed = false) =>
	Buffer.from(
		JSON.stringify({
			id,
			key: createHash("sha256").update(`key:${id}:42`).digest("hex"),
			title: `Article ${id}`,
			category: `category-${id % 20}`,
			body:
				profile === "cms"
					? `<article>${"Reusable multilingual content block. ".repeat(32)}${id}</article>`
					: profile === "entropy"
						? Array.from({ length: 20 }, (_, index) =>
								createHash("sha256")
									.update(`seed-42:${id}:${index}`)
									.digest("hex"),
							).join("")
						: `Item ${id}`,
			score: changed ? -id : id % 10000,
		}),
	);
const collect = async (input) => {
	const parts = [];
	for await (const part of input) parts.push(part);
	return Buffer.concat(parts);
};
async function* changes(values) {
	for (const [id, value] of values) yield { id, value };
}
let db,
	resources,
	store,
	traceCommit = false;
const openDatabase = async (create = false) => {
	if (engine === "inibase") {
		const root = dirname(options.modulePath);
		const { DatabaseResources } = await import(
			pathToFileURL(join(root, "resources.js"))
		);
		const { RowStore } = await import(pathToFileURL(join(root, "rowstore.js")));
		resources = new DatabaseResources();
		store = new RowStore(join(directory, "rows"), resources);
		if (create) await store.create(true);
	} else if (engine === "sqlite") {
		const { DatabaseSync } = await import("node:sqlite");
		db = new DatabaseSync(join(directory, "db.sqlite"));
		db.exec(
			`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-${Math.floor(budget / 1024)}`,
		);
		if (options.flush === "write-through")
			db.exec("PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON");
		result.settings = Object.fromEntries(
			[
				"synchronous",
				"journal_mode",
				"fullfsync",
				"checkpoint_fullfsync",
				"cache_size",
			].map((name) => [
				name,
				Object.values(db.prepare(`PRAGMA ${name}`).get())[0],
			]),
		);
		if (create)
			db.exec(
				"CREATE TABLE records (id INTEGER PRIMARY KEY, value BLOB NOT NULL)",
			);
	} else {
		db = new pg.Client({
			host: options.socket,
			port: 55432,
			user: "benchmark",
			database: "postgres",
		});
		await db.connect();
		if (create) {
			await db.query(
				"CREATE TABLE records (id BIGINT PRIMARY KEY, value BYTEA NOT NULL)",
			);
			result.settings = (
				await db.query(
					"SELECT name, setting FROM pg_settings WHERE name IN ('fsync','synchronous_commit','full_page_writes','wal_sync_method','shared_buffers','work_mem')",
				)
			).rows;
		}
	}
};
const close = async () => {
	if (engine === "inibase") await resources.close();
	else if (engine === "sqlite") db.close();
	else await db.end();
};
const commit = async (values) => {
	if (engine === "inibase") {
		const trace = [],
			started = performance.now();
		await store.commit(
			changes(values),
			traceCommit
				? (phase) => {
						trace.push({ phase, ms: performance.now() - started });
					}
				: undefined,
		);
		if (traceCommit)
			result.commitTraces.push({
				trace,
				completedMs: performance.now() - started,
			});
		return;
	}
	if (engine === "sqlite") {
		const put = db.prepare(
				"INSERT INTO records VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
			),
			remove = db.prepare("DELETE FROM records WHERE id=?");
		db.exec("BEGIN");
		try {
			for (const [id, value] of values)
				if (value === null) remove.run(id);
				else put.run(id, value);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
		return;
	}
	// One SQL statement/implicit commit for every homogeneous insert/update batch.
	if (values.every(([, value]) => value !== null)) {
		const parameters = values.flat();
		await db.query(
			`INSERT INTO records VALUES ${values.map((_, index) => `($${index * 2 + 1},$${index * 2 + 2})`).join(",")} ON CONFLICT(id) DO UPDATE SET value=excluded.value`,
			parameters,
		);
	} else if (values.every(([, value]) => value === null)) {
		await db.query("DELETE FROM records WHERE id = ANY($1::bigint[])", [
			values.map(([id]) => id),
		]);
	} else {
		await db.query("BEGIN");
		try {
			for (const value of values) await commit([value]);
			await db.query("COMMIT");
		} catch (error) {
			await db.query("ROLLBACK");
			throw error;
		}
	}
};
const point = async (id) => {
	if (engine === "inibase") return collect((await store.snapshot()).read(id));
	if (engine === "sqlite")
		return Buffer.from(
			db.prepare("SELECT value FROM records WHERE id=?").get(id)?.value ?? [],
		);
	return (
		(await db.query("SELECT value FROM records WHERE id=$1", [id])).rows[0]
			?.value ?? Buffer.alloc(0)
	);
};
const snapshot = (name) => {
	result.phases.push({
		name,
		processMemory: process.memoryUsage(),
		memory: resources?.stats() ?? null,
	});
	process.send?.({ phase: name });
};
const timed = async (name, fn) => {
	snapshot(name);
	const start = performance.now(),
		cpu = process.cpuUsage();
	await fn();
	result.timings[name] = {
		ms: performance.now() - start,
		cpu: process.cpuUsage(cpu),
	};
	snapshot(`${name}:end`);
};
const sampled = async (name, ids, fn) => {
	const raw = [];
	await timed(name, async () => {
		for (const id of ids) {
			const start = performance.now();
			await fn(id);
			raw.push(performance.now() - start);
		}
	});
	result.latency[name] = raw;
};
const random = Array.from(
	{ length: samples },
	(_, index) => 1 + ((index * 7919 + 42) % count),
);
const changed = new Set(),
	deleted = new Set(); // Small caller-side verification oracle.
try {
	await timed("create", () => openDatabase(true));
	await timed("bulkInsert", async () => {
		for (let first = 1; first <= count; first += 1000)
			await commit(
				Array.from(
					{ length: Math.min(1000, count - first + 1) },
					(_, index) => [first + index, row(first + index)],
				),
			);
	});
	await sampled("randomID", random, async (id) =>
		assert.deepEqual(await point(id), row(id)),
	);
	await sampled(
		"sequentialID",
		Array.from({ length: samples }, (_, index) => 1 + (index % count)),
		async (id) => assert.deepEqual(await point(id), row(id)),
	);
	await sampled(
		"hotID",
		random.map(() => random[0]),
		async (id) => assert.deepEqual(await point(id), row(id)),
	);
	await sampled(
		"missingID",
		random.map((id) => id + count),
		async (id) => assert.equal((await point(id)).length, 0),
	);
	traceCommit = true;
	await sampled(
		"durableInsert",
		Array.from({ length: writes }, (_, index) => count + index + 1),
		async (id) => {
			await commit([[id, row(id)]]);
			assert.deepEqual(await point(id), row(id));
		},
	);
	await sampled("durableUpdate", random.slice(0, writes), async (id) => {
		await commit([[id, row(id, true)]]);
		changed.add(id);
		assert.deepEqual(await point(id), row(id, true));
	});
	await sampled("durableDelete", random.slice(0, writes), async (id) => {
		await commit([[id, null]]);
		deleted.add(id);
		assert.equal((await point(id)).length, 0);
	});
	traceCommit = false;
	await timed("reopen", async () => {
		await close();
		await openDatabase();
	});
	await timed("verifyEveryID", async () => {
		// A streaming oracle, without a whole-dataset result or key map.
		for (let id = 1; id <= count + writes; id++)
			assert.deepEqual(
				await point(id),
				deleted.has(id) ? Buffer.alloc(0) : row(id, changed.has(id)),
			);
	});
	result.verified = true;
} catch (error) {
	result.errors.push({ message: error.message, stack: error.stack });
	process.exitCode = 1;
} finally {
	try {
		await close();
	} catch (error) {
		result.errors.push({ close: error.message });
		process.exitCode = 1;
	}
	result.usageEnd = process.resourceUsage();
	await writeFile(options.destination, `${JSON.stringify(result, null, 2)}\n`);
}
