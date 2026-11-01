// Separate instrumented diagnostic. Never loaded by comparison trials.
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = Object.fromEntries(
	process.argv.slice(2).map((v) => v.replace(/^--/, "").split("=")),
);
const instrumentation = await import("./local-profile.mjs");
const { adapter } = await import("./postgres/adapter.mjs");
const directory = await mkdtemp("/private/tmp/inibase-public-profile-");
const db = await adapter({
	engine: "inibase",
	directory,
	modulePath: resolve(args.module),
	budget: 16777216,
});
const key = (n) =>
	createHash("sha256").update(`random-key:${n}:seed-42`).digest("hex");
const result = {
	modulePath: resolve(args.module),
	runtime: process.versions,
	notes:
		"Instrumented diagnostic, not included in comparison timings; async counter time includes waiting",
	samples: [],
};
try {
	await db.open();
	await db.create("records");
	for (let first = 1; first <= 100000; first += 1000)
		await db.insert(
			"records",
			Array.from({ length: 1000 }, (_, i) => {
				const seq = first + i;
				return {
					seq,
					key: key(seq),
					title: `Article ${seq}`,
					category: `category-${seq % 20}`,
					body: `Item ${seq}`,
					score: seq % 10000,
				};
			}),
		);
	await db.index();
	const snap = () => JSON.parse(JSON.stringify(instrumentation.snapshot()));
	for (let i = 0; i < 5; i++) {
		const before = snap(),
			start = performance.now(),
			cpu = process.cpuUsage();
		await db.update(key(50000 + i), 1234 + i);
		const after = snap(),
			counters = {};
		for (const [name, values] of Object.entries(after.totals)) {
			const old = before.totals[name] ?? {
				calls: 0,
				milliseconds: 0,
				bytes: 0,
			};
			const diff = Object.fromEntries(
				Object.keys(values).map((k) => [k, values[k] - old[k]]),
			);
			if (diff.calls) counters[name] = diff;
		}
		result.samples.push({
			ms: performance.now() - start,
			cpu: process.cpuUsage(cpu),
			counters,
		});
	}
	result.instrumentation = snap();
	result.memory = await db.info();
} finally {
	await db.close();
	await rm(directory, { recursive: true, force: true });
}
await writeFile(resolve(args.output), `${JSON.stringify(result, null, 2)}\n`);
