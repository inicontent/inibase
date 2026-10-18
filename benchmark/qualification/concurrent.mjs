// Separate concurrent reader/writer workload, version 2. Full durability throughout.
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
Object.assign(process.env, {
	INIBASE_DURABILITY: "full",
	INIBASE_MEMORY_BYTES: "16777216",
	INIBASE_MAX_OPEN_FILES: "32",
	INIBASE_MAX_OVERLAY_RECORDS: "128",
	INIBASE_MAX_LOG_BYTES: "8388608",
	INIBASE_PREPEND: "false",
	INIBASE_CACHE: "false",
	INIBASE_SECRET: "11".repeat(32),
});
const hash = (value) =>
	createHash("sha256").update(String(value)).digest("hex");
const footprint = async (directory) => {
	const totals = { logical: 0, allocated: 0 };
	for (const item of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, item.name);
		if (item.isDirectory()) {
			const sub = await footprint(path);
			totals.logical += sub.logical;
			totals.allocated += sub.allocated;
		} else {
			const info = await stat(path);
			totals.logical += info.size;
			totals.allocated += info.blocks * 512;
		}
	}
	return totals;
};
const initial = (seq) => ({
	seq,
	key: hash(`seed:${seq}`),
	score: seq,
	body: "CMS content. ".repeat(32).trim(),
});
const changedKey = (seq) => hash(`changed:${seq}`);
const settings = {
	compression: true,
	decodeID: true,
	cache: false,
	log: true,
	seekable: true,
	tombstones: true,
	indexes: ["seq", "key"],
};
async function connect(options, setup = false) {
	const isSql = options.engine === "sqlite";
	let db, sql, statements;
	if (isSql) {
		const { DatabaseSync } = await import("node:sqlite");
		sql = new DatabaseSync(join(options.directory, "db.sqlite"));
		sql.exec(
			"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=10000; PRAGMA cache_size=-16384;",
		);
		if (setup)
			sql.exec(
				"CREATE TABLE records(seq INTEGER PRIMARY KEY,key TEXT NOT NULL,score INTEGER NOT NULL,body TEXT NOT NULL); CREATE INDEX records_key ON records(key);",
			);
		statements = {
			get: sql.prepare("SELECT * FROM records WHERE seq=?"),
			key: sql.prepare("SELECT * FROM records WHERE key=?"),
			update: sql.prepare("UPDATE records SET key=?,score=? WHERE seq=?"),
			remove: sql.prepare("DELETE FROM records WHERE seq=?"),
		};
	} else {
		const Engine = (
			await import(
				pathToFileURL(
					options.engine === "baseline-indexed"
						? options.baseline
						: options.optimized,
				)
			)
		).default;
		db = new Engine("db", options.directory);
		if (setup)
			await db.createTable(
				"records",
				[
					{ key: "seq", type: "number" },
					{ key: "key", type: "string" },
					{ key: "score", type: "number" },
					{ key: "body", type: "string" },
				],
				settings,
			);
	}
	return {
		seed: async (values) => {
			if (isSql) {
				const insert = sql.prepare("INSERT INTO records VALUES (?,?,?,?)");
				sql.exec("BEGIN");
				try {
					for (const v of values) insert.run(v.seq, v.key, v.score, v.body);
					sql.exec("COMMIT");
				} catch (e) {
					sql.exec("ROLLBACK");
					throw e;
				}
			} else await db.post("records", values);
		},
		get: async (seq) =>
			isSql
				? statements.get.get(seq)
				: (await db.get("records", { seq }, { perPage: -1 }))?.[0],
		key: async (key) =>
			isSql
				? statements.key.get(key)
				: (await db.get("records", { key }, { perPage: -1 }))?.[0],
		update: async (seq) =>
			isSql
				? statements.update.run(changedKey(seq), -seq, seq)
				: db.put("records", { key: changedKey(seq), score: -seq }, { seq }),
		remove: async (seq) =>
			isSql ? statements.remove.run(seq) : db.delete("records", { seq }),
		compact: async () =>
			isSql
				? sql.exec("PRAGMA wal_checkpoint(TRUNCATE)")
				: db.compact("records"),
		all: async () =>
			isSql
				? sql.prepare("SELECT * FROM records").all()
				: await db.get("records", undefined, { perPage: -1 }),
		memory: () => db?.memoryUsage?.() ?? null,
		close: async () => (isSql ? sql.close() : db.close()),
	};
}
if (process.argv[2] === "--worker") {
	const options = JSON.parse(process.argv[3]);
	const baselineRss = process.memoryUsage().rss;
	let stopped = false;
	process.on("message", (m) => {
		if (m === "stop") stopped = true;
	});
	let db;
	const result = {
		role: options.role,
		worker: options.worker,
		latency: [],
		operations: 0,
		baselineRss,
	};
	try {
		db = await connect(options);
		const start = new Promise((resolve) =>
			process.on("message", (m) => {
				if (m === "start") resolve();
			}),
		);
		process.send({ ready: true });
		await start;
		const time = performance.now();
		if (options.role === "reader") {
			while (!stopped) {
				const seq = 1 + ((result.operations * 7919 + 42) % options.rows),
					t = performance.now(),
					value = await db.get(seq);
				if (result.latency.length < options.readSamples)
					result.latency.push(performance.now() - t);
				if (value) {
					assert.equal(value.seq, seq);
					assert.equal(value.body, initial(seq).body);
					assert.ok(value.score === seq || value.score === -seq);
					assert.equal(
						value.key,
						value.score < 0 ? changedKey(seq) : initial(seq).key,
					);
				} else
					assert.ok(seq <= options.writers * options.writes && seq % 8 === 0);
				result.operations++;
				await new Promise((done) => setImmediate(done));
			}
		} else {
			result.counts = { updates: 0, reads: 0, deletes: 0, compactions: 0 };
			for (let index = 0; index < options.writes; index++) {
				const seq = 1 + options.worker * options.writes + index,
					t = performance.now();
				await db.update(seq);
				result.counts.updates++;
				assert.equal((await db.key(changedKey(seq))).score, -seq);
				result.counts.reads++;
				if ((index + 1) % 8 === 0) {
					await db.remove(seq);
					result.counts.deletes++;
					assert.equal((await db.key(changedKey(seq))) ?? null, null);
					result.counts.reads++;
				}
				if ((index + 1) % 32 === 0) {
					await db.compact();
					result.counts.compactions++;
				}
				result.latency.push(performance.now() - t);
				result.operations++;
			}
		}
		result.elapsedMs = performance.now() - time;
		result.engineMemory = db.memory();
		await db.close();
		db = null;
		result.usage = process.resourceUsage();
		result.verified = true;
		process.send({ result });
	} catch (error) {
		result.verified = false;
		result.error = { message: error.message, stack: error.stack };
		process.send?.({ result });
		process.exitCode = 1;
	} finally {
		await db?.close().catch(() => {});
		process.disconnect?.();
	}
} else {
	const args = Object.fromEntries(
		process.argv.slice(2).map((x) => {
			const index = x.indexOf("=");
			return [x.slice(2, index), x.slice(index + 1)];
		}),
	);
	assert.ok(
		args.baseline && args.optimized && args.output,
		"Explicit local engines and fresh --output required",
	);
	const output = resolve(args.output);
	await mkdir(output);
	await mkdir(".work", { recursive: true });
	const base = {
		baseline: resolve(args.baseline),
		optimized: resolve(args.optimized),
		rows: Number(args.rows ?? 1000),
		writes: Number(args.writes ?? 64),
		writers: 3,
		readSamples: 2048,
	};
	assert.ok(
		Number.isSafeInteger(base.rows) &&
			Number.isSafeInteger(base.writes) &&
			base.writes > 0 &&
			base.writes % 8 === 0 &&
			base.rows >= base.writes * base.writers,
	);
	const engines = ["baseline-indexed", "indexed", "sqlite"],
		repeats = Number(args.repeats ?? 3),
		results = [];
	assert.ok(Number.isSafeInteger(repeats) && repeats > 0);
	const identity = async (path) => {
		const directory = resolve(path, ".."),
			hashes = {};
		for (const name of (await readdir(directory)).sort())
			if (name.endsWith(".js"))
				hashes[name] = hash(await readFile(join(directory, name)));
		return { path, hashes };
	};
	const environment = {
		workloadVersion: 2,
		node: process.versions,
		date: new Date().toISOString(),
		config: base,
		baseline: await identity(base.baseline),
		optimized: await identity(base.optimized),
		toolHash: hash(await readFile(fileURLToPath(import.meta.url))),
		notes: [
			"Three writers and one reader start at an IPC barrier. Each writer owns disjoint rows.",
			"Writer-cycle latency includes update, verification reads, every eighth delete and every 32nd compaction.",
			"Readers sample the first 2048 lookups; counts include every read. OS cache is not evicted.",
			"Full durability: iniBase full, SQLite WAL/FULL, 16 MiB configured caches, 512 MiB V8 heap cap (not RSS cap).",
		],
	};
	await writeFile(
		join(output, "environment.json"),
		JSON.stringify(environment, null, 2),
	);
	for (let repeat = 0; repeat < repeats; repeat++)
		for (const engine of engines
			.slice(repeat % 3)
			.concat(engines.slice(0, repeat % 3))) {
			const directory = await mkdtemp(resolve(".work", "concurrent-")),
				options = { ...base, directory, engine };
			const row = {
				engine,
				repeat: repeat + 1,
				directory,
				workers: [],
				samples: [],
			};
			console.log(`Running ${engine} ${repeat + 1}`);
			let participants = [],
				timer,
				busy = false;
			const watchdog = setTimeout(() => {
				for (const p of participants) p.child.kill("SIGTERM");
			}, 120000);
			try {
				const setup = await connect(options, true);
				for (let first = 1; first <= base.rows; first += 1000)
					await setup.seed(
						Array.from(
							{ length: Math.min(1000, base.rows - first + 1) },
							(_, i) => initial(first + i),
						),
					);
				await setup.close();
				const launch = (role, worker) => {
					const child = fork(
						fileURLToPath(import.meta.url),
						["--worker", JSON.stringify({ ...options, role, worker })],
						{
							execArgv: ["--max-old-space-size=512"],
							stdio: ["ignore", "pipe", "pipe", "ipc"],
						},
					);
					let stderr = "",
						result,
						announced = false;
					child.stderr.on("data", (value) => {
						stderr += value;
					});
					const ready = new Promise((resolve, reject) => {
						child.on("message", (message) => {
							if (message.ready) {
								announced = true;
								resolve();
							}
							if (message.result) result = message.result;
						});
						child.on("error", reject);
						child.on("exit", (code) => {
							if (!announced)
								reject(
									new Error(`Worker exited before ready ${code}: ${stderr}`),
								);
						});
					});
					const done = new Promise((resolve, reject) => {
						child.on("error", reject);
						child.on("exit", (code, signal) =>
							resolve({ code, signal, stderr, ...result }),
						);
					});
					return { child, ready, done };
				};
				const reader = launch("reader", 0),
					writers = Array.from({ length: 3 }, (_, i) => launch("writer", i));
				participants = [reader, ...writers];
				await Promise.all(participants.map((x) => x.ready));
				const sample = async () => {
					if (busy) return;
					busy = true;
					try {
						const ps = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], {
							encoding: "utf8",
						})
							.trim()
							.split("\n")
							.map((x) => x.trim().split(/\s+/).map(Number));
						const ids = new Set(participants.map((x) => x.child.pid));
						for (let pass = 0; pass < 8; pass++)
							for (const [pid, ppid] of ps) if (ids.has(ppid)) ids.add(pid);
						row.samples.push({
							time: Date.now(),
							processTreeRss: ps.reduce(
								(n, [pid, , rss]) => n + (ids.has(pid) ? rss * 1024 : 0),
								0,
							),
						});
					} catch (e) {
						row.samples.push({ time: Date.now(), error: e.message });
					} finally {
						busy = false;
					}
				};
				await sample();
				timer = setInterval(sample, 100);
				const start = performance.now();
				for (const p of participants) p.child.send("start");
				row.workers = await Promise.all(writers.map((x) => x.done));
				reader.child.send("stop");
				row.workers.push(await reader.done);
				row.elapsedMs = performance.now() - start;
				for (const worker of row.workers)
					assert.ok(
						worker.verified && worker.code === 0,
						JSON.stringify(worker),
					);
				const check = await connect(options),
					values = await check.all();
				let expected = base.rows;
				for (let seq = 8; seq <= base.writers * base.writes; seq += 8)
					expected--;
				assert.equal(values.length, expected);
				for (const value of values) {
					const changed = value.seq <= base.writers * base.writes;
					assert.equal(value.score, changed ? -value.seq : value.seq);
					assert.equal(
						value.key,
						changed ? changedKey(value.seq) : initial(value.seq).key,
					);
					assert.ok(!changed || value.seq % 8 !== 0);
					assert.equal(value.body, initial(value.seq).body);
				}
				row.memory = check.memory();
				await check.close();
				row.disk = await footprint(directory);
				row.verified = true;
			} catch (error) {
				row.verified = false;
				row.error = { message: error.message, stack: error.stack };
				for (const p of participants) p.child.kill("SIGTERM");
				process.exitCode = 1;
			} finally {
				clearTimeout(watchdog);
				clearInterval(timer);
				while (busy) await new Promise((done) => setImmediate(done));
			}
			await writeFile(
				join(output, `${engine}-${repeat + 1}.json`),
				JSON.stringify(row, null, 2),
			);
			results.push(row);
			await writeFile(
				join(output, "results.json"),
				JSON.stringify({ environment, results }, null, 2),
			);
			if (row.verified) await rm(directory, { recursive: true, force: true });
			console.log(row.verified ? "Verified" : "FAILED");
		}
}
