// Additional workloads; the historical runner and fixture are unchanged.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const options = JSON.parse(process.argv[2]);
const instrumentation = options.instrument ? await import("./local-profile.mjs") : null;
const { engine, directory, profile, rows: n, baseline, optimized } = options;
await mkdir(directory, { recursive: true });
const fields = ["seq", "key", "title", "category", "body", "score"];
const key = (seq) => createHash("sha256").update(`random-key:${seq}:seed-42`).digest("hex");
const row = (seq) => ({ seq, key: key(seq), title: `Article ${seq}`, category: `category-${seq % 20}`,
	body: profile === "cms" ? `<article>${"Reusable multilingual content block. ".repeat(32)}${seq}</article>`
		: profile === "mixed" ? Array.from({ length: 20 }, (_, j) => createHash("sha256").update(`seed-42:${seq}:${j}`).digest("hex")).join("")
		: `Item ${seq}`, score: seq % 10000 });
const app = (value) => fields.map((field) => value[field]);
const result = { workloadVersion: options.publicOptions ? 5 : 4, engine, profile, rows: n, options, timings: {}, latency: {}, phases: [], phaseCpu: {}, phaseIO: {},
	config: { durability: "full", cacheCondition: "OS-cache-affected; reopen does not evict OS cache", engineBudgetBytes: Number(process.env.INIBASE_MEMORY_BYTES) },
	runtimeBaselineRss: process.memoryUsage().rss, startUsage: process.resourceUsage(), operationErrors: [] };
const phase = (name) => { result.phases.push({ name, time: Date.now(), rss: process.memoryUsage().rss, engineMemory: db?.memoryUsage?.() ?? null }); process.send?.({ phase: name }); };
const timed = async (name, callback) => {
	phase(name);
	const start = performance.now();
	const cpu = process.cpuUsage(), usage = process.resourceUsage();
	const value = await callback();
	result.timings[name] = performance.now() - start;
	result.phaseCpu[name] = process.cpuUsage(cpu);
	const after = process.resourceUsage();
	result.phaseIO[name] = { fsRead: after.fsRead - usage.fsRead, fsWrite: after.fsWrite - usage.fsWrite };
	result.phases.push({ name: name + ":end", time: Date.now(), rss: process.memoryUsage().rss, engineMemory: db?.memoryUsage?.() ?? null });
	return value;
};
const samples = async (name, keys, operation, validate) => {
	const values = [];
	let verificationMs = 0;
	await timed(name, async () => {
		for (const key of keys) {
			const start = performance.now(); const value = await operation(key); values.push(performance.now() - start);
			if (validate) { const start = performance.now(); validate(value, key); verificationMs += performance.now() - start; }
		}
	});
	result.timings[name + "Wall"] = result.timings[name];
	result.timings[name] = values.reduce((sum, value) => sum + value, 0);
	result.timings[name + "Verification"] = verificationMs;
	result.latency[name] = values;
};
const footprint = async (root) => {
	let logical = 0, allocated = 0, files = 0;
	for (const item of await readdir(root, { withFileTypes: true })) {
		const path = join(root, item.name);
		if (item.isDirectory()) { const sub = await footprint(path); logical += sub.logical; allocated += sub.allocated; files += sub.files; }
		else { const info = await stat(path).catch(() => null); if (info) { logical += info.size; allocated += info.blocks * 512; files++; } }
	}
	return { logical, allocated, files };
};
let db, sql, Engine, statements;
const isSql = engine === "sqlite";
const isBaseline = engine === "baseline";
const baselineArtifact = isBaseline || engine === "baseline-indexed";
const indexed = engine === "indexed" || engine === "baseline-indexed";
const modulePath = baselineArtifact ? baseline : optimized;
const open = async () => {
	if (isSql) {
		const { DatabaseSync } = await import("node:sqlite");
		sql = new DatabaseSync(join(directory, "db.sqlite"));
		sql.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-16384; CREATE TABLE IF NOT EXISTS records (seq INTEGER PRIMARY KEY, key TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL, body TEXT NOT NULL, score INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS records_key ON records(key)");
		statements = { point: sql.prepare("SELECT * FROM records WHERE key=?"), update: sql.prepare("UPDATE records SET score=? WHERE key=?"),
			remove: sql.prepare("DELETE FROM records WHERE key=?"), insert: sql.prepare("INSERT INTO records VALUES (?,?,?,?,?,?)") };
		result.artifact = { runtime: process.versions.node, sqlite: process.versions.sqlite };
		result.config.sqlite = Object.fromEntries(["journal_mode", "synchronous", "fullfsync", "page_size", "cache_size", "mmap_size", "wal_autocheckpoint", "temp_store"]
			.map((name) => [name, sql.prepare(`PRAGMA ${name}`).get()]));
	} else {
		Engine ??= (await import(pathToFileURL(modulePath))).default;
		db = new Engine("db", directory);
		if (!(await db.getTable("records").catch((error) => { if (error.name === "TABLE_NOT_EXISTS") return null; throw error; })))
			await db.createTable("records", fields.map((field) => ({ key: field, type: ["seq", "score"].includes(field) ? "number" : "string", required: true })),
				{ compression: true, decodeID: true, cache: false, ...(options.publicOptions ? {} : { log: true }),
					...(!options.publicOptions && !isBaseline ? { seekable: true, indexes: indexed ? ["seq", "key"] : [], tombstones: true, blockBytes: options.blockBytes ?? 131072 } : {}) });
		result.artifact = { modulePath, sha256: createHash("sha256").update(await readFile(modulePath)).digest("hex") };
	}
};
const close = async () => { if (isSql) sql.close(); else await db.close?.(); };
const point = async (seq) => isSql ? statements.point.get(key(seq))
	: (await db.get("records", { key: key(seq) }, { perPage: -1 }))?.[0];
const update = async (seq, score) => isSql ? statements.update.run(score, key(seq))
	: db.put("records", { score }, { key: key(seq) });
const remove = async (seq) => isSql ? statements.remove.run(key(seq)) : db.delete("records", { key: key(seq) });
const compact = async () => isSql ? sql.exec("PRAGMA wal_checkpoint(TRUNCATE)") : db.compact("records");
const all = async (columns = fields) => isSql ? sql.prepare(`SELECT ${columns.join(",")} FROM records`).all()
	: await db.get("records", undefined, { perPage: -1, columns: [...columns] }) ?? [];
const verifyRows = (actual, expected) => {
	actual.sort((a, b) => Number(a.seq) - Number(b.seq));
	assert.equal(actual.length, expected);
	const h = createHash("sha256"), wanted = createHash("sha256");
	for (let i = 0; i < actual.length; i++) { h.update(JSON.stringify(app(actual[i]))); wanted.update(JSON.stringify(app(row(i + 1)))); }
	assert.equal(h.digest("hex"), wanted.digest("hex"));
};
try {
	await open();
	result.empty = await footprint(directory);
	let fixtureMs = 0;
	await timed("bulkInsert", async () => {
		for (let first = 1; first <= n; first += 1000) {
			const fixtureStart = performance.now();
			const values = Array.from({ length: Math.min(1000, n - first + 1) }, (_, i) => row(first + i));
			fixtureMs += performance.now() - fixtureStart;
			if (isSql) {
				sql.exec("BEGIN");
				try { for (const value of values) statements.insert.run(...app(value)); sql.exec("COMMIT"); }
				catch (error) { sql.exec("ROLLBACK"); throw error; }
			} else await db.post("records", values);
		}
	});
	result.timings.bulkInsertWall = result.timings.bulkInsert;
	result.timings.bulkInsert -= fixtureMs;
	result.timings.fixtureGeneration = fixtureMs;
	await compact();
	result.afterInsert = await footprint(directory);
	await close();
	await timed("reopen", open);
	let full = await timed("fullRead", () => all());
	phase("verifyFullRead");
	verifyRows(full, n); full = null;
	await timed("warmFullRead", async () => { const values = await all(); assert.equal(values.length, n); });
	await timed("projection", async () => { const values = await all(["seq", "category"]); assert.equal(values.length, n); for (const value of values) assert.equal(value.category, `category-${value.seq % 20}`); });
	const count = options.samples ?? 64;
	const random = Array.from({ length: count }, (_, i) => 1 + ((i * 7919 + 42) % n));
	const check = (value, seq) => assert.deepEqual(app(value), app(row(seq)));
	await samples("randomKey", random, point, check);
	if (options.publicOptions) {
        // Drain only in this labeled benchmark phase; normal get() does not wait.
        if (!isSql) {
          const { resourcesFor } = await import(pathToFileURL(join(modulePath, "..", "resources.js")));
          await timed("automaticBuildDrain", () => resourcesFor(join(directory, "db")).drainMaintenance?.() ?? Promise.resolve());
          result.automatic = db.memoryUsage?.();
          result.learnedConfig = await readFile(join(directory, "db/records/.seek.config"), "utf8").catch(() => null);
        }
        await samples("afterTrainingKey", random, point, check);
    }
    await samples("sequentialKey", Array.from({ length: Math.min(count, n) }, (_, i) => i + 1), point, check);
	await samples("hotKey", Array.from({ length: count }, () => random[0]), point, check);
	await samples("missingKey", random.map((seq) => seq + n), point, (value) => assert.equal(value ?? null, null));
	await timed("nonIndexedFilter", async () => {
		const values = isSql ? sql.prepare("SELECT * FROM records WHERE category=?").all("category-3")
			: await db.get("records", { category: "category-3" }, { perPage: -1 });
		assert.equal(values.length, Math.floor((n + 17) / 20));
	});
	// A separate fixture keeps original query keys and hashes unchanged. All
	// engines store the same additional rows, and their files are counted.
	if (isSql) sql.exec("CREATE TABLE individual_records (seq INTEGER PRIMARY KEY, key TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL, body TEXT NOT NULL, score INTEGER NOT NULL); CREATE INDEX individual_records_key ON individual_records(key)");
	else await db.createTable("individual_records", fields.map((field) => ({ key: field, type: ["seq", "score"].includes(field) ? "number" : "string", required: true })),
		{ compression: true, decodeID: true, cache: false, ...(options.publicOptions ? {} : { log: true }),
			...(!options.publicOptions && !isBaseline ? { seekable: true, indexes: indexed ? ["seq", "key"] : [], tombstones: true, blockBytes: options.blockBytes ?? 131072 } : {}) });
	const individualInsert = isSql ? sql.prepare("INSERT INTO individual_records VALUES (?,?,?,?,?,?)") : null;
	await samples("individualDurableInserts", Array.from({ length: options.writes ?? 32 }, (_, i) => row(n + i + 1)),
		async (value) => isSql ? individualInsert.run(...app(value)) : db.post("individual_records", value));
	const changed = new Map(), deleted = new Set();
	const writes = Math.min(options.writes ?? 32, n);
	await samples("individualDurableUpdates", random.slice(0, writes), async (seq) => { await update(seq, -seq); changed.set(seq, -seq); });
	const pending = Math.min(options.pending ?? 1024, Math.floor(n / 4));
	const pendingIds = Array.from({ length: pending }, (_, i) => i + 1);
	await timed("bulkPendingUpdates", async () => {
		if (isSql) {
			sql.exec("BEGIN");
			try { for (const seq of pendingIds) statements.update.run(-2, key(seq)); sql.exec("COMMIT"); }
			catch (error) { sql.exec("ROLLBACK"); throw error; }
		} else await db.put("records", { score: -2 }, pendingIds);
		for (const seq of pendingIds) changed.set(seq, -2);
	});
	const pendingKeys = random.map((seq, index) => index % 2 ? seq : pendingIds[index % pendingIds.length]);
	await samples("pendingUpdateReads", pendingKeys, point, (value, seq) => assert.equal(value.score, changed.get(seq) ?? row(seq).score));
	await samples("individualDurableDeletes", random.slice(0, Math.min(8, writes)), async (seq) => { await remove(seq); deleted.add(seq); });
	const pendingDeletes = pendingIds.slice(0, Math.floor(pending / 4));
	await timed("bulkPendingDeletes", async () => {
		if (isSql) {
			sql.exec("BEGIN");
			try { const statement = sql.prepare("DELETE FROM records WHERE seq=?"); for (const seq of pendingDeletes) statement.run(seq); sql.exec("COMMIT"); }
			catch (error) { sql.exec("ROLLBACK"); throw error; }
		} else await db.delete("records", pendingDeletes);
		for (const seq of pendingDeletes) deleted.add(seq);
	});
	result.pendingCounts = { updates: pending, deletes: pendingDeletes.length };
	await samples("pendingDeleteReads", pendingKeys, point, (value, seq) => {
		if (deleted.has(seq)) assert.equal(value ?? null, null);
		else assert.equal(value.score, changed.get(seq) ?? row(seq).score);
	});
	await timed("mixedIncludingRepeatedCompaction", async () => {
		result.mixedOperations = { updates: 0, reads: 0, deletes: 0, compactions: 0 };
		for (let round = 0; round < (options.mixedRounds ?? 3); round++) {
			for (let j = 0; j < Math.min(options.mixedWrites ?? 16, n); j++) {
				const seq = 1 + ((round * 101 + j * 73 + 17) % n);
				if (deleted.has(seq)) continue;
				const score = -10000 - round * 100 - j;
				await update(seq, score); changed.set(seq, score); result.mixedOperations.updates++;
				assert.equal((await point(seq)).score, score); result.mixedOperations.reads++;
				if (options.mixedDeletesEvery && (j + 1) % options.mixedDeletesEvery === 0) {
				 await remove(seq); deleted.add(seq); result.mixedOperations.deletes++;
				 assert.equal((await point(seq)) ?? null, null); result.mixedOperations.reads++;
				}
			}
			await timed(`mixedCompaction${round + 1}`, compact); result.mixedOperations.compactions++;
		}
	});
	await close();
	await timed("recoveryReopen", open);
	await timed("verifyAfterChurn", async () => {
		const values = await all(); assert.equal(values.length, n - deleted.size);
		for (const value of values) { assert.ok(!deleted.has(value.seq)); const expected = row(value.seq); expected.score = changed.get(value.seq) ?? expected.score; assert.deepEqual(app(value), app(expected)); }
	});
	result.engineMemory = !isSql ? db.memoryUsage?.() ?? null : null;
	result.peakAccountedCacheBytes = Math.max(0, ...result.phases.map((phase) => phase.engineMemory?.peakCacheBytes ?? 0));
	await compact(); await close();
	result.stored = await footprint(directory);
	result.endUsage = process.resourceUsage(); result.verified = true;
	result.instrumentation = instrumentation?.snapshot() ?? null;
} catch (error) {
	result.verified = false;
	result.operationErrors.push({ message: error.message, stack: error.stack });
	try { await close(); } catch {}
	process.exitCode = 1;
} finally {
	result.instrumentation = instrumentation?.snapshot() ?? null;
	result.endedAt = Date.now();
	await writeFile(options.destination, JSON.stringify(result, null, 2) + "\n");
	process.send?.({ done: true });
}
