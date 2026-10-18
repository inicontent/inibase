import { execFile, execFileSync, fork } from "node:child_process";
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
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const command = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
	process.argv.slice(2).map((value) => value.replace(/^--/, "").split("=")),
);
const output = resolve(args.output ?? "benchmark/results/postgres-comparison");
await mkdir(output); // fail rather than overwrite prior evidence
const binaryDirectory = resolve(
	args.pgBin ?? "/opt/homebrew/opt/postgresql@18/bin",
);
const modulePath = resolve(args.module ?? "dist/index.js");
const budget = Number(args.budget ?? 16777216);
const flush = args.flush ?? "platform-default";
if (!["platform-default", "write-through"].includes(flush))
	throw new Error(`Unknown flush policy: ${flush}`);
const scenario = args.scenario ?? "standard";
if (!["standard", "concurrent", "recovery", "rowstore"].includes(scenario))
	throw new Error(`Unknown scenario: ${scenario}`);
const workerName = scenario === "standard" ? "worker.mjs" : `${scenario}.mjs`;
await mkdir(resolve(".work"), { recursive: true });
const engines = (args.engines ?? "inibase,sqlite,postgres").split(",");
const failures = [];
const hashes = {};
for (const name of (await readdir(dirname(modulePath))).sort())
	if (name.endsWith(".js"))
		hashes[name] = createHash("sha256")
			.update(await readFile(join(dirname(modulePath), name)))
			.digest("hex");
const tools = {};
for (const name of [
	"run.mjs",
	"worker.mjs",
	"adapter.mjs",
	"concurrent.mjs",
	"recovery.mjs",
	"rowstore.mjs",
	"package.json",
	"package-lock.json",
])
	tools[name] = createHash("sha256")
		.update(await readFile(join(here, name)))
		.digest("hex");
const metadata = {
	version: 1,
	date: new Date().toISOString(),
	options: args,
	budget,
	flush,
	runtime: process.versions,
	platform: process.platform,
	os: os.release(),
	cpu: os.cpus()[0].model,
	ram: os.totalmem(),
	postgres: execFileSync(join(binaryDirectory, "postgres"), ["--version"], {
		encoding: "utf8",
	}).trim(),
	hashes,
	tools,
	modulePath,
	binaryDirectory,
	cache: "OS cache is not evicted; reopen is not cold disk",
	memory:
		"Cache allowances are not total memory limits. PostgreSQL RSS sums double-count shared mappings. V8 heap cap is not an RSS limit.",
	flushPolicy:
		flush === "write-through"
			? "SQLite fullfsync/checkpoint_fullfsync ON; PostgreSQL fsync_writethrough on Darwin, fsync elsewhere; iniBase retains Node FileHandle.sync. Actual hardware power loss not qualified."
			: "Historical platform defaults: SQLite fullfsync OFF, PostgreSQL default WAL method, Node libuv platform sync. On Darwin these do not request equal drive-cache flushing.",
	transport:
		"PostgreSQL persistent Unix-domain connection; embedded engines direct calls. Connection setup reported separately.",
};
// Prove sampling works before creating any cluster.
execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time="], { encoding: "utf8" });
await writeFile(
	join(output, "environment.json"),
	`${JSON.stringify(metadata, null, 2)}\n`,
);
const disk = async (directory, temporary = false) => {
	const result = {
		logical: 0,
		allocated: 0,
		temporaryLogical: 0,
		racingPaths: 0,
	};
	const files = await readdir(directory, { withFileTypes: true }).catch(
		(error) => {
			if (error.code !== "ENOENT") throw error;
			result.racingPaths++;
			return [];
		},
	);
	for (const item of files) {
		const path = join(directory, item.name);
		if (item.isDirectory()) {
			const child = await disk(
				path,
				temporary || item.name === ".tmp" || item.name === "pgsql_tmp",
			);
			for (const key of Object.keys(result)) result[key] += child[key];
		} else {
			const info = await stat(path).catch((error) => {
				if (error.code !== "ENOENT") throw error;
				result.racingPaths++;
				return null;
			});
			if (!info) continue;
			result.logical += info.size;
			result.allocated += info.blocks * 512;
			if (temporary) result.temporaryLogical += info.size;
		}
	}
	return result;
};
const processTree = (roots) => {
	const all = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time="], {
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.map((line) => {
			const [pid, ppid, rss, cpu] = line.trim().split(/\s+/);
			return {
				pid: Number(pid),
				ppid: Number(ppid),
				rss: Number(rss) * 1024,
				cpu,
			};
		});
	const members = new Set(roots);
	for (let changed = true; changed; ) {
		changed = false;
		for (const item of all)
			if (members.has(item.ppid) && !members.has(item.pid)) {
				members.add(item.pid);
				changed = true;
			}
	}
	const processes = all.filter((item) => members.has(item.pid));
	return { rss: processes.reduce((sum, item) => sum + item.rss, 0), processes };
};
let interrupted = false,
	activeChild;
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, () => {
		interrupted = true;
		activeChild?.kill(signal);
	});
outer: for (const rows of (args.rows ?? "1000,10000,100000")
	.split(",")
	.map(Number))
	for (const profile of (args.profiles ?? "compact,cms,entropy").split(","))
		for (let repeat = 0; repeat < Number(args.repeats ?? 3); repeat++) {
			const order = engines
				.slice(repeat % engines.length)
				.concat(engines.slice(0, repeat % engines.length));
			for (const engine of order) {
				if (interrupted) break outer;
				const id = `${engine}-${profile}-${rows}-${repeat + 1}`;
				console.log(id);
				const directory = await mkdtemp(resolve(".work", "postgres-compare-"));
				let socket,
					serverPid,
					serverStarted = false,
					child,
					timer,
					busy = false,
					phase = "startup";
				const resources = { samples: [], errors: [], setup: {}, status: null };
				try {
					if (engine === "postgres") {
						socket = await mkdtemp("/private/tmp/inibase-pg-");
						const start = performance.now();
						const initialized = await command(join(binaryDirectory, "initdb"), [
							"-D",
							join(directory, "cluster"),
							"-U",
							"benchmark",
							"--auth-local=trust",
							"--auth-host=reject",
							"--encoding=UTF8",
							"--locale=C",
							"--data-checksums",
						]);
						resources.setup.initdb = {
							ms: performance.now() - start,
							...initialized,
						};
						await writeFile(
							join(directory, "cluster/postgresql.auto.conf"),
							`${[
								"listen_addresses = ''",
								`unix_socket_directories = '${socket}'`,
								"unix_socket_permissions = 0700",
								"port = 55432",
								"fsync = on",
								"synchronous_commit = on",
								"full_page_writes = on",
								...(flush === "write-through"
									? [
											`wal_sync_method = '${process.platform === "darwin" ? "fsync_writethrough" : "fsync"}'`,
										]
									: []),
								"autovacuum = on",
								`shared_buffers = '${Math.floor(budget / 1024)}kB'`,
								"work_mem = '1MB'",
								"temp_buffers = '1MB'",
								"maintenance_work_mem = '16MB'",
								"max_connections = 12",
								"max_worker_processes = 4",
								"max_parallel_workers = 2",
								"track_io_timing = on",
								"logging_collector = off",
							].join("\n")}\n`,
						);
						const startServer = performance.now();
						// A failed/timed-out pg_ctl can still have started the server.
						// Always attempt shutdown from this point, including that case.
						serverStarted = true;
						await command(join(binaryDirectory, "pg_ctl"), [
							"-D",
							join(directory, "cluster"),
							"-l",
							join(directory, "server.log"),
							"-w",
							"start",
						]);
						serverPid = Number(
							(
								await readFile(
									join(directory, "cluster/postmaster.pid"),
									"utf8",
								)
							).split("\n")[0],
						);
						resources.setup.serverStartMs = performance.now() - startServer;
						resources.setup.emptyDisk = await disk(directory);
						resources.setup.emptyProcesses = processTree([serverPid]);
					}
					child = fork(
						join(here, workerName),
						[
							JSON.stringify({
								engine,
								directory,
								modulePath,
								socket,
								budget,
								flush,
								binaryDirectory,
								rows,
								profile,
								repeat,
								samples: Number(args.samples ?? 32),
								writes: Number(args.writes ?? 8),
								mixedRounds: Number(args.mixedRounds ?? 3),
								destination: join(output, `${id}.json`),
							}),
						],
						{
							stdio: ["ignore", "pipe", "pipe", "ipc"],
							execArgv: ["--max-old-space-size=512"],
							env: {
								...process.env,
								INIBASE_MEMORY_BYTES: String(budget),
								INIBASE_DURABILITY: "full",
								INIBASE_SECRET: "1234567890abcdef".repeat(4),
							},
						},
					);
					activeChild = child;
					let stderr = "";
					child.stdout.resume();
					child.stderr.on("data", (bytes) => {
						stderr += bytes;
					});
					child.on("message", (message) => {
						if (message.phase) phase = message.phase;
						if (message.serverPid) serverPid = message.serverPid;
					});
					timer = setInterval(async () => {
						if (busy) return;
						busy = true;
						try {
							resources.samples.push({
								time: Date.now(),
								phase,
								...processTree([child.pid, ...(serverPid ? [serverPid] : [])]),
								disk: await disk(directory),
							});
						} catch (error) {
							resources.errors.push({ phase, message: error.message });
						} finally {
							busy = false;
						}
					}, 200);
					resources.status = await new Promise((resolve, reject) => {
						child.on("exit", (code, signal) => resolve({ code, signal }));
						child.on("error", reject);
					});
					resources.stderr = stderr;
					clearInterval(timer);
					while (busy) await new Promise((resolve) => setImmediate(resolve));
					resources.finalDiskBeforeStop = await disk(directory);
					if (serverPid)
						resources.serverFinalProcesses = processTree([serverPid]);
					if (resources.status.code !== 0)
						failures.push({ id, status: resources.status, stderr });
				} catch (error) {
					resources.errors.push({
						phase,
						message: error.message,
						stack: error.stack,
					});
					failures.push({ id, error: error.message });
				} finally {
					clearInterval(timer);
					while (busy) await new Promise((resolve) => setImmediate(resolve));
					if (serverStarted) {
						try {
							const start = performance.now();
							await command(join(binaryDirectory, "pg_ctl"), [
								"-D",
								join(directory, "cluster"),
								"-w",
								"-m",
								"fast",
								"stop",
							]);
							resources.serverStopMs = performance.now() - start;
						} catch (error) {
							failures.push({ id, stopError: error.message });
						}
					}
					if (engine === "postgres")
						resources.serverLog = await readFile(
							join(directory, "server.log"),
							"utf8",
						).catch(() => "");
					resources.finalDisk = await disk(directory);
					await writeFile(
						join(output, `${id}.resources.json`),
						`${JSON.stringify(resources, null, 2)}\n`,
					);
					if (socket) await rm(socket, { recursive: true, force: true });
					if (
						resources.status?.code === 0 &&
						!failures.some((failure) => failure.id === id)
					)
						await rm(directory, { recursive: true, force: true });
					activeChild = null;
					await writeFile(
						join(output, "failures.json"),
						`${JSON.stringify(failures, null, 2)}\n`,
					);
				}
			}
		}
if (failures.length || interrupted) process.exitCode = 1;
