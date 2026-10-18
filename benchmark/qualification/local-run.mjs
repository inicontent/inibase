import { fork, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import os from "node:os";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
if (!args.baseline || !args.optimized) throw new Error("Explicit --baseline=/path/dist/index.js and --optimized=/path/dist/index.js are required");
// Memory evidence is required unless explicitly opting into a limited diagnostic run.
try { execFileSync("ps", ["-o", "rss=", "-p", String(process.pid)], {stdio: "pipe"}); }
catch (error) { if (args.allowMissingSampler !== "true") throw new Error("Process sampler unavailable; rerun with process-inspection permission or explicitly use --allowMissingSampler=true", {cause: error}); }
const output = resolve(args.output ?? "results/local-optimization/comparison");
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Refuse to overwrite raw evidence from an earlier run.
const engines = (args.engines ?? "baseline-indexed,indexed,sqlite").split(",");
const sizes = (args.rows ?? "1000,10000,100000").split(",").map(Number);
const profiles = (args.profiles ?? "compact,cms,mixed").split(",");
const repeats = Number(args.repeats ?? 3);
if (sizes.some((n) => !Number.isSafeInteger(n) || n < 32) || !Number.isSafeInteger(repeats) || repeats < 1 ||
	engines.some((engine) => !["baseline", "baseline-indexed", "optimized", "indexed", "sqlite"].includes(engine)) ||
	profiles.some((profile) => !["compact", "cms", "mixed"].includes(profile))) throw new Error("Invalid workload configuration");
const identity = async (modulePath) => {
	const directory = resolve(modulePath, "..");
	const hashes = {};
	for (const name of (await readdir(directory)).sort()) {
		if (!name.endsWith(".js")) continue;
		hashes[name] = createHash("sha256").update(await readFile(join(directory, name))).digest("hex");
	}
	return { modulePath: resolve(modulePath), hashes, treeSha256: createHash("sha256").update(JSON.stringify(hashes)).digest("hex") };
};
const metadata = { workloadVersion: args.publicOptions === "true" ? 5 : 4, date: new Date().toISOString(), node: process.versions, os: os.release(),
	platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, cores: os.cpus().length, ram: os.totalmem(),
	baseline: { ...await identity(args.baseline), sourceCommit: args.baselineCommit ?? null },
	optimized: { ...await identity(args.optimized), sourceCommit: args.optimizedCommit ?? null }, sizes, engines, profiles, repeats,
	seed: 42, budgetBytes: Number(args.budget ?? 16777216), samples: Number(args.samples ?? 128),
	publicOptions: args.publicOptions === "true",
	notes: ["Dataset generation is batch bounded; explicit full-read results are caller materializations.",
		"RSS is sampled across the worker process tree every 100 ms; sampling can miss short-lived peaks.",
		"Darwin reports maxRSS and CPU/IO counters through process.resourceUsage; unavailable IO counters are retained as zero.",
		"No OS-cache eviction or power-loss qualification. Heap limits are not RSS limits.",
		"Lookup latency samples exclude correctness verification; bulk timing excludes separately recorded deterministic fixture generation.",
		"Mixed workload includes all configured compactions/checkpoints in elapsed time; defaults are three rounds."] };
await writeFile(join(output, "environment.json"), JSON.stringify(metadata, null, 2) + "\n");
const disk = async (directory, category = "primary") => {
 const totals = { logical: 0, allocated: 0, temporaryLogical: 0, temporaryAllocated: 0, scratchLogical: 0 };
 for (const item of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
  const path = join(directory, item.name);
  const kind = item.name === ".tmp" ? "temporary" : item.name === ".cache" ? "scratch" : category;
  if (item.isDirectory()) {
   const child = await disk(path, kind);
   for (const key of Object.keys(totals)) totals[key] += child[key];
  } else {
   const info = await stat(path).catch(() => null); if (!info) continue;
   totals.logical += info.size; totals.allocated += info.blocks * 512;
   if (kind === "temporary") { totals.temporaryLogical += info.size; totals.temporaryAllocated += info.blocks * 512; }
   if (kind === "scratch") totals.scratchLogical += info.size;
  }
 }
 return totals;
};
const mixedOptions = { mixedRounds: Number(args.mixedRounds ?? 3), mixedWrites: Number(args.mixedWrites ?? 16), mixedDeletesEvery: Number(args.mixedDeletesEvery ?? 0) };
for (const [key, value] of Object.entries(mixedOptions))
 if (!Number.isSafeInteger(value) || value < (key === "mixedDeletesEvery" ? 0 : 1)) throw new Error(`Invalid ${key}`);
metadata.mixed = mixedOptions;
metadata.tooling = {};
for (const name of ["local-run.mjs", "local-worker.mjs", "local-profile.mjs", "local-report.mjs"])
 metadata.tooling[name] = createHash("sha256").update(await readFile(new URL(name, import.meta.url))).digest("hex");
await writeFile(join(output, "environment.json"), JSON.stringify(metadata, null, 2) + "\n");
const results = [], failures = [];
for (const rows of sizes) for (const profile of profiles) for (let repeat = 0; repeat < repeats; repeat++) {
	const order = engines.slice(repeat % engines.length).concat(engines.slice(0, repeat % engines.length));
	for (const engine of order) {
		const id = `${engine}-${profile}-${rows}-${repeat + 1}`;
		const destination = join(output, `${id}.json`);
		const directory = resolve(".work/local-comparison", id + "-" + Date.now());
		console.log(`Running ${id}`);
		const options = { engine, profile, rows, directory, destination, repeat: repeat + 1,
			baseline: resolve(args.baseline), optimized: resolve(args.optimized), samples: metadata.samples,
			writes: Number(args.writes ?? 32), blockBytes: Number(args.blockBytes ?? 131072), instrument: args.instrument === "true", publicOptions: args.publicOptions === "true" };
		options.pending = Number(args.pending ?? 1024);
		Object.assign(options, mixedOptions);
		const child = fork(new URL("./local-worker.mjs", import.meta.url), [JSON.stringify(options)], {
			stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: ["--max-old-space-size=" + (args.heapMiB ?? 512),
				...(args.instrument === "true" ? ["--cpu-prof", "--cpu-prof-dir=" + output, "--cpu-prof-name=" + id + ".cpuprofile"] : [])],
			env: { ...process.env, INIBASE_SECRET: "11".repeat(32), INIBASE_DURABILITY: "full", INIBASE_CACHE: "false",
				INIBASE_PREPEND: "false", INIBASE_MEMORY_BYTES: String(metadata.budgetBytes), INIBASE_MAX_OPEN_FILES: "32",
				INIBASE_MAX_OVERLAY_RECORDS: "128", INIBASE_MAX_LOG_BYTES: "8388608" },
		});
		let stdout = "", stderr = "", busy = false, phase = "startup";
		child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
		child.on("message", (message) => { if (message.phase) phase = message.phase; });
		const resourceSamples = [];
		const sample = async () => {
			if (busy) return; busy = true;
			try {
				const processes = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" }).trim().split("\n")
					.map((line) => line.trim().split(/\s+/).map(Number));
				const descendants = new Set([child.pid]);
				for (let pass = 0; pass < 8; pass++) for (const [pid, parent] of processes) if (descendants.has(parent)) descendants.add(pid);
				const rss = processes.reduce((sum, [pid, , rss]) => sum + (descendants.has(pid) ? rss * 1024 : 0), 0);
				const footprint = await disk(directory);
				resourceSamples.push({ time: Date.now(), phase, processTreeRss: rss, logicalDisk: footprint.logical, ...footprint });
			} catch (error) { resourceSamples.push({ time: Date.now(), error: error.message }); }
			finally { busy = false; }
		};
		const timer = setInterval(sample, 100);
		const timeout = setTimeout(() => child.kill("SIGTERM"), Number(args.timeoutMs ?? 600000));
		const status = await new Promise((done) => child.on("exit", (code, signal) => done({ code, signal })));
		clearInterval(timer); clearTimeout(timeout);
		while (busy) await new Promise((done) => setImmediate(done));
		await writeFile(join(output, `${id}.resources.json`), JSON.stringify({ status, stdout, stderr, resourceSamples }, null, 2) + "\n");
		let value;
		try { value = JSON.parse(await readFile(destination, "utf8")); } catch {}
		if (status.code === 0 && value?.verified) { results.push(value); console.log(`Verified ${id}`); }
		else { failures.push({ id, status, errors: value?.operationErrors, stderr }); console.error(`FAILED ${id}: ${stderr}`); }
		if (status.code === 0 && value?.verified) await rm(directory, { recursive: true, force: true });
		// Failed databases remain available for forensic reproduction.
		await writeFile(join(output, "results.json"), JSON.stringify({ metadata, results, failures }, null, 2) + "\n");
	}
}
if (failures.length) process.exitCode = 1;
