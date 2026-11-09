import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "results/local-optimization/comparison");
const data = JSON.parse(await readFile(join(root, "results.json"), "utf8"));
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2; };
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(p * sorted.length) - 1]; };
const groups = new Map();
for (const result of data.results) {
	const key = `${result.profile}|${result.rows}|${result.engine}`;
	if (!groups.has(key)) groups.set(key, []);
	groups.get(key).push(result);
}
const summaries = [];
for (const [key, results] of groups) {
	const [profile, size, engine] = key.split("|");
	const summary = { profile, rows: Number(size), engine, trials: results.length,
		timings: Object.fromEntries(Object.keys(results[0].timings).map((key) => [key, median(results.map((value) => value.timings[key]))])),
		latency: {}, storage: {}, peakTreeRss: 0, peakLogicalFootprint: 0, peakTemporaryLogical: 0, peakTemporaryAllocated: 0,
		peakAccountedCache: Math.max(...results.map((result) => result.peakAccountedCacheBytes ?? 0)) };
	for (const name of Object.keys(results[0].latency)) {
		const samples = results.flatMap((result) => result.latency[name]);
		summary.latency[name] = { count: samples.length, p50: percentile(samples, .5), p95: percentile(samples, .95),
			p99: samples.length >= 1000 ? percentile(samples, .99) : null };
	}
	for (const name of ["afterInsert", "stored", "empty"])
		summary.storage[name] = Object.fromEntries(["logical", "allocated", "files"].map((key) => [key, median(results.map((result) => result[name][key]))]));
	for (const result of results) {
		summary.peakTreeRss = Math.max(summary.peakTreeRss, (result.endUsage?.maxRSS ?? 0) * 1024);
		const id = `${result.engine}-${result.profile}-${result.rows}-${result.options.repeat}`;
		const resource = JSON.parse(await readFile(join(root, `${id}.resources.json`), "utf8"));
		for (const sample of resource.resourceSamples) {
			summary.peakTreeRss = Math.max(summary.peakTreeRss, sample.processTreeRss ?? 0);
			summary.peakLogicalFootprint = Math.max(summary.peakLogicalFootprint, sample.logicalDisk ?? 0);
			summary.peakTemporaryLogical = Math.max(summary.peakTemporaryLogical, sample.temporaryLogical ?? 0);
			summary.peakTemporaryAllocated = Math.max(summary.peakTemporaryAllocated, sample.temporaryAllocated ?? 0);
		}
	}
	summaries.push(summary);
}
await writeFile(join(root, "summary.json"), JSON.stringify({ metadata: data.metadata, summaries, failures: data.failures }, null, 2) + "\n");
const number = (n, digits = 2) => Number(n).toFixed(digits);
const lines = ["# Local engine comparison", "", `Verified trials: ${data.results.length}. Failed trials: ${data.failures.length}.`, "",
	"Medians of trial totals; lookup quantiles pool raw per-operation samples. p99 is omitted below 1,000 samples.",
	"Durability: iniBase full; SQLite WAL/FULL. OS filesystem cache is not evicted. RSS and peak disk are sampled, not hard limits.", "",
	"| Dataset | Rows | Engine | Bulk rows/s | Full ms | Projection ms | Key p50 ms | Key p95 ms | Update p50 ms | Delete p50 ms | Mixed ms | Allocated MiB | Observed peak RSS MiB |",
	"|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
for (const s of summaries) lines.push(`| ${s.profile} | ${s.rows} | ${s.engine} | ${number(s.rows / s.timings.bulkInsert * 1000, 0)} | ${number(s.timings.fullRead)} | ${number(s.timings.projection)} | ${number(s.latency.randomKey.p50, 3)} | ${number(s.latency.randomKey.p95, 3)} | ${number(s.latency.individualDurableUpdates.p50, 3)} | ${number(s.latency.individualDurableDeletes.p50, 3)} | ${number(s.timings.mixedIncludingRepeatedCompaction)} | ${number(s.storage.stored.allocated / 1048576)} | ${number(s.peakTreeRss / 1048576)} |`);
lines.push("", "## Scope and limitations", "", "- `baseline-indexed`: frozen starting working tree, with identical indexes, seekable blocks and tombstones to the candidate.",
	"- `optimized`: gzip/log plus seekable columns and tombstones, no application-key index; key queries are still filtering.",
	"- `indexed`: same candidate with seq/key disk indexes; SQLite has its seq primary key and key index.",
	"- Full results are deliberately materialized. RSS includes runtime, caller results and verification; cache accounting is separate and is not a total-working-memory guarantee.",
	"- All files are counted, including the 32-row individual-insert fixture, indexes, logs and scratch files present at each snapshot.",
	"- Mixed timing includes all configured explicit compactions/checkpoints plus any automatic maintenance. SQLite checkpoints, not VACUUMs, in this additional workload.",
	"- Per-operation latencies exclude correctness assertions; total wall/verification timings and fixture-generation costs are retained separately.",
	"- Observed peak RSS is the maximum of sampled process-tree RSS and the worker maxRSS counter; it remains a lower bound for short-lived child-process peaks.",
	"- Sampled peak database footprint is not an exact peak temporary-space measurement. Read/write amplification is not fully instrumented.",
	"- Process-crash qualification is separate from this benchmark and is not power-loss qualification.",
	"- Historical workloads/results were not rewritten. See ../../../qualification/README.md for reproduction and remaining requirements.", "");
await writeFile(join(root, "REPORT.md"), lines.join("\n"));
console.log(`Wrote ${root}/REPORT.md`);
