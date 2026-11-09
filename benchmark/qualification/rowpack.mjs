// Immutable storage-kernel experiment, NOT the public iniBase DML engine.
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(
	process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")),
);
const footprint = async (root, temporary = false) => {
	let logical = 0,
		allocated = 0,
		temporaryLogical = 0,
		temporaryAllocated = 0,
		racingPaths = 0;
	const entries = await readdir(root, { withFileTypes: true }).catch(
		(error) => {
			if (error.code !== "ENOENT") throw error;
			racingPaths++;
			return [];
		},
	);
	for (const item of entries) {
		const path = join(root, item.name);
		if (item.isDirectory()) {
			const child = await footprint(path, temporary || item.name === ".tmp");
			logical += child.logical;
			allocated += child.allocated;
			temporaryLogical += child.temporaryLogical;
			temporaryAllocated += child.temporaryAllocated;
			racingPaths += child.racingPaths;
		} else {
			const value = await stat(path).catch((error) => {
				if (error.code !== "ENOENT") throw error;
				return null;
			});
			if (!value) {
				racingPaths++;
				continue;
			}
			logical += value.size;
			allocated += value.blocks * 512;
			if (temporary) {
				temporaryLogical += value.size;
				temporaryAllocated += value.blocks * 512;
			}
		}
	}
	return {
		logical,
		allocated,
		temporaryLogical,
		temporaryAllocated,
		racingPaths,
	};
};
const identity = async (directory) => {
	const hashes = {};
	for (const name of (await readdir(directory)).sort())
		if (name.endsWith(".js"))
			hashes[name] = createHash("sha256")
				.update(await readFile(join(directory, name)))
				.digest("hex");
	return {
		directory,
		hashes,
		treeSha256: createHash("sha256")
			.update(JSON.stringify(hashes))
			.digest("hex"),
	};
};
if (args.child) {
	const config = JSON.parse(args.child),
		{ engine, rows, profile, directory, moduleDirectory, destination } = config;
	await mkdir(directory, { recursive: true });
	const result = {
		config,
		runtime: process.versions,
		measurementVersion: 2,
		phases: [],
		latency: [],
		timings: {},
		runtimeRss: process.memoryUsage().rss,
		startUsage: process.resourceUsage(),
		errors: [],
	};
	const row = (id) =>
		Buffer.from(
			JSON.stringify({
				id,
				key: createHash("sha256").update(`row-${id}`).digest("hex"),
				body:
					profile === "cms"
						? "Reusable multilingual CMS content. ".repeat(40)
						: profile === "entropy"
							? Array.from({ length: 20 }, (_, j) =>
									createHash("sha256").update(`${id}:${j}`).digest("hex"),
								).join("")
							: `Record ${id}`,
			}),
		);
	const timed = async (name, fn) => {
		result.phases.push({
			name: name + ":start",
			time: Date.now(),
			memory: process.memoryUsage(),
		});
		process.send?.({ phase: name });
		const cpu = process.cpuUsage();
		const start = performance.now();
		const value = await fn();
		result.timings[name] = performance.now() - start;
		result.phases.push({
			name: name + ":end",
			time: Date.now(),
			memory: process.memoryUsage(),
			cpu: process.cpuUsage(cpu),
		});
		return value;
	};
	let sql, resources;
	try {
		let point;
		if (engine !== "sqlite") {
			const { DatabaseResources } = await import(
				pathToFileURL(join(moduleDirectory, "resources.js"))
			);
			const { buildRowPack, RowPack } = await import(
				pathToFileURL(join(moduleDirectory, "rowpack.js"))
			);
			resources = new DatabaseResources();
			async function* input() {
				for (let id = 0; id < rows; id++) yield { id, bytes: row(id) };
			}
			await timed("bulkIncludingEncoding", () =>
				buildRowPack(
					directory,
					input(),
					rows,
					true,
					resources,
					(phase, details) => {
						result.phases.push({
							name: phase,
							time: Date.now(),
							memory: process.memoryUsage(),
						});
						if (details) result.indexBuild = details;
					},
				),
			);
			const pack = await timed("open", () =>
				RowPack.open(directory, resources),
			);
			point = async (id) => {
				const chunks = [];
				for await (const chunk of pack.read(id)) chunks.push(chunk);
				return Buffer.concat(chunks);
			};
		} else {
			const { DatabaseSync } = await import("node:sqlite");
			sql = new DatabaseSync(join(directory, "db.sqlite"));
			sql.exec(
				`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-${Math.floor(Number(process.env.INIBASE_MEMORY_BYTES ?? 1048576) / 1024)}; CREATE TABLE records(id INTEGER PRIMARY KEY, value BLOB NOT NULL)`,
			);
			const insert = sql.prepare("INSERT INTO records VALUES (?,?)");
			await timed("bulkIncludingEncoding", async () => {
				sql.exec("BEGIN");
				try {
					for (let id = 0; id < rows; id++) insert.run(id, row(id));
					sql.exec("COMMIT");
				} catch (e) {
					sql.exec("ROLLBACK");
					throw e;
				}
			});
			const select = sql.prepare("SELECT value FROM records WHERE id=?");
			point = async (id) => Buffer.from(select.get(id)?.value ?? []);
		}
		await timed("randomReads", async () => {
			for (let i = 0; i < 128; i++) {
				const id = (i * 7919 + 42) % rows,
					start = performance.now();
				const value = await point(id);
				result.latency.push(performance.now() - start);
				assert.deepEqual(value, row(id));
			}
		});
		await timed("missingReads", async () => {
			for (let i = 0; i < 16; i++)
				assert.equal((await point(rows + i)).length, 0);
		});
		result.memory = resources?.stats();
		result.beforeCloseDisk = await footprint(directory);
		if (sql) {
			await timed("checkpoint", async () =>
				sql.exec("PRAGMA wal_checkpoint(TRUNCATE)"),
			);
			sql.close();
			sql = undefined;
		}
		await resources?.close();
		result.stored = await footprint(directory);
		result.endUsage = process.resourceUsage();
		result.verified = true;
	} catch (error) {
		result.errors.push({ message: error.message, stack: error.stack });
		result.verified = false;
		sql?.close();
		await resources?.close();
		process.exitCode = 1;
	}
	await writeFile(destination, JSON.stringify(result, null, 2) + "\n");
} else {
	const output = resolve(args.output ?? "benchmark/results/rowpack"),
		moduleDirectory = resolve(args.dist ?? "dist");
	await mkdir(output);
	const budgetBytes = Number(args.budget ?? 1048576);
	if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 262144)
		throw new Error("INVALID_BUDGET");
	const metadata = {
		experiment:
			"immutable row-byte kernel; no public schema, validation, DML, log, secondary keys or compaction",
		date: new Date().toISOString(),
		runtime: process.versions,
		os: os.release(),
		cpu: os.cpus()[0].model,
		cores: os.cpus().length,
		ram: os.totalmem(),
		artifact: await identity(moduleDirectory),
		baselineArtifact: args.baseline
			? await identity(resolve(args.baseline))
			: null,
		measurementVersion: 2,
		budgetBytes,
		toolSha256: createHash("sha256")
			.update(await readFile(new URL(import.meta.url)))
			.digest("hex"),
		cache: "OS-cache-affected; no eviction",
		notes: [
			"Same caller-encoded JSON bytes and integer primary keys for both kernels; whole-dataset bulk transaction, FULL sync/WAL for SQLite.",
			"Bulk includes generation/encoding. Rowpack builds checksummed disk index and compressed pages; SQLite stores opaque uncompressed BLOBs.",
			"SQLite close/checkpoint reported separately. Rowpack immutable generations have no reclamation or mutation API.",
			"128 random samples support p50/p95, p99 is descriptive only. maxRSS is process peak; no descendant processes are launched by either kernel.",
		],
	};
	await writeFile(
		join(output, "environment.json"),
		JSON.stringify(metadata, null, 2) + "\n",
	);
	const failures = [];
	for (const rows of (args.rows ?? "1000,10000,100000").split(",").map(Number))
		for (const profile of (args.profiles ?? "compact,cms,entropy").split(","))
			for (let repeat = 0; repeat < Number(args.repeats ?? 3); repeat++)
				for (const engine of (() => {
					const engines = args.baseline
						? ["baseline", "rowpack", "sqlite"]
						: ["rowpack", "sqlite"];
					return engines
						.slice(repeat % engines.length)
						.concat(engines.slice(0, repeat % engines.length));
				})()) {
					const id = `${engine}-${profile}-${rows}-${repeat + 1}`,
						directory = resolve(".work", `rowpack-${id}-${Date.now()}`),
						destination = join(output, `${id}.json`);
					console.log(id);
					const child = fork(
						new URL(import.meta.url),
						[
							`--child=${JSON.stringify({ engine, profile, rows, repeat, directory, moduleDirectory: engine === "baseline" ? resolve(args.baseline) : moduleDirectory, destination })}`,
						],
						{
							stdio: ["ignore", "pipe", "pipe", "ipc"],
							env: {
								...process.env,
								INIBASE_MEMORY_BYTES: String(budgetBytes),
								INIBASE_DURABILITY: "full",
							},
							execArgv: ["--max-old-space-size=256"],
						},
					);
					let stderr = "";
					child.stderr.on("data", (chunk) => {
						stderr += chunk;
					});
					child.stdout.resume();
					const samples = [];
					let busy = false;
					const timer = setInterval(async () => {
						if (busy) return;
						busy = true;
						try {
							const rss =
								Number(
									execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)], {
										encoding: "utf8",
									}).trim(),
								) * 1024;
							samples.push({
								time: Date.now(),
								rss,
								...(await footprint(directory)),
							});
						} catch (error) {
							samples.push({ time: Date.now(), error: error.message });
						} finally {
							busy = false;
						}
					}, 100);
					const status = await new Promise((done) =>
						child.on("exit", (code, signal) => done({ code, signal })),
					);
					clearInterval(timer);
					while (busy) await new Promise((resolve) => setImmediate(resolve));
					await writeFile(
						join(output, `${id}.resources.json`),
						JSON.stringify({ status, stderr, samples }, null, 2) + "\n",
					);
					if (status.code === 0)
						await rm(directory, { recursive: true, force: true });
					else failures.push({ id, status, stderr });
					await writeFile(
						join(output, "failures.json"),
						JSON.stringify(failures, null, 2) + "\n",
					);
				}
	if (failures.length) process.exitCode = 1;
}
