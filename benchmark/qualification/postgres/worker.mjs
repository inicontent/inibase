import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { adapter, values } from "./adapter.mjs";

const options = JSON.parse(process.argv[2]);
const { rows: count, profile, samples: sampleCount, writes } = options;
await mkdir(options.directory, { recursive: true });
const key = (id) =>
	createHash("sha256").update(`random-key:${id}:seed-42`).digest("hex");
const row = (seq) => ({
	seq,
	key: key(seq),
	title: `Article ${seq}`,
	category: `category-${seq % 20}`,
	body:
		profile === "cms"
			? `<article>${"Reusable multilingual content block. ".repeat(32)}${seq}</article>`
			: profile === "entropy"
				? Array.from({ length: 20 }, (_, j) =>
						createHash("sha256").update(`seed-42:${seq}:${j}`).digest("hex"),
					).join("")
				: `Item ${seq}`,
	score: seq % 10000,
});
const result = {
	workloadVersion: 1,
	options,
	runtime: process.versions,
	runtimeBaselineRss: process.memoryUsage().rss,
	timings: {},
	latency: {},
	phases: [],
	errors: [],
	verified: false,
	usageStart: process.resourceUsage(),
};
const db = await adapter(options);
const snapshot = async (name) => {
	const memory = options.engine === "inibase" ? (await db.info()).memory : null;
	result.phases.push({
		name,
		time: Date.now(),
		memory,
		processMemory: process.memoryUsage(),
	});
	process.send?.({ phase: name });
};
const timed = async (name, fn) => {
	await snapshot(name);
	const start = performance.now(),
		cpu = process.cpuUsage();
	const value = await fn();
	result.timings[name] = {
		ms: performance.now() - start,
		cpu: process.cpuUsage(cpu),
	};
	await snapshot(`${name}:end`);
	return value;
};
const samples = async (name, ids, fn, verify) => {
	const raw = [];
	await timed(name, async () => {
		for (const id of ids) {
			const start = performance.now();
			const value = await fn(id);
			raw.push(performance.now() - start);
			if (verify) await verify(value, id);
		}
	});
	result.latency[name] = raw;
};
const changed = new Map(),
	deleted = new Set(); // bounded benchmark oracle, not engine state
const check = (value, id) => {
	if (deleted.has(id)) return assert.equal(value ?? null, null);
	const expected = row(id);
	expected.score = changed.get(id) ?? expected.score;
	assert.deepEqual(value ? values(value) : value, values(expected));
};
try {
	await timed("open", () => db.open());
	await timed("create", () => db.create("records"));
	await timed("bulkInsert", async () => {
		for (let first = 1; first <= count; first += 1000) {
			const rows = Array.from(
				{ length: Math.min(1000, count - first + 1) },
				(_, i) => row(first + i),
			);
			await db.insert("records", rows);
		}
	});
	// Explicitly labeled indexing phase for all engines. This is not automatic-tuning evidence.
	await timed("explicitIndexBuild", () => db.index());
	await timed("initialMaintenance", () => db.maintain());
	result.afterInsert = await db.info();
	await db.close();
	await timed("reopen", () => db.open());
	const random = Array.from(
		{ length: sampleCount },
		(_, i) => 1 + ((i * 7919 + 42) % count),
	);
	await samples("randomIndexedKey", random, (id) => db.point(key(id)), check);
	await samples(
		"sequentialIndexedKey",
		Array.from({ length: sampleCount }, (_, i) => 1 + (i % count)),
		(id) => db.point(key(id)),
		check,
	);
	await samples(
		"hotIndexedKey",
		random.map(() => random[0]),
		(id) => db.point(key(id)),
		check,
	);
	await samples(
		"missingIndexedKey",
		random.map((id) => id + count),
		(id) => db.point(key(id)),
		(value) => assert.equal(value ?? null, null),
	);
	let full = await timed("fullRead", () => db.all());
	assert.equal(full.length, count);
	full.sort((a, b) => a.seq - b.seq);
	for (let i = 0; i < full.length; i++) {
		assert.equal(full[i].seq, i + 1);
		check(full[i], i + 1);
	}
	full = null;
	let projection = await timed("projection", () => db.all(["seq", "category"]));
	assert.equal(projection.length, count);
	for (const value of projection)
		assert.equal(value.category, row(value.seq).category);
	projection = null;
	let filtered = await timed("nonIndexedFilter", () => db.filter("category-3"));
	assert.equal(filtered.length, Math.floor((count + 17) / 20));
	for (const value of filtered) check(value, value.seq);
	filtered = null;
	await db.create("individual_records");
	await samples(
		"individualDurableInsert",
		Array.from({ length: writes }, (_, i) => count + i + 1),
		(id) => db.insert("individual_records", [row(id)]),
	);
	await samples(
		"individualDurableUpdate",
		random.slice(0, writes),
		async (id) => {
			await db.update(key(id), -id);
			changed.set(id, -id);
		},
	);
	await samples("afterUpdateRead", random, (id) => db.point(key(id)), check);
	await samples(
		"individualDurableDelete",
		random.slice(0, Math.min(writes, 8)),
		async (id) => {
			await db.remove(key(id));
			deleted.add(id);
		},
	);
	await samples("afterDeleteRead", random, (id) => db.point(key(id)), check);
	const rollbackId = random.find((id) => !deleted.has(id)) ?? 1;
	const rollbackError = new Error("intentional benchmark rollback");
	await timed("transactionRollback", async () => {
		await assert.rejects(
			db.transaction(async () => {
				await db.update(key(rollbackId), -999999);
				throw rollbackError;
			}),
			(error) => error === rollbackError,
		);
		check(await db.point(key(rollbackId)), rollbackId);
	});
	await timed("mixedIncludingMaintenance", async () => {
		result.mixedOperations = {
			updates: 0,
			reads: 0,
			deletes: 0,
			maintenance: 0,
		};
		for (let round = 0; round < options.mixedRounds; round++) {
			for (let step = 0; step < writes; step++) {
				const id = 1 + ((round * 3571 + step * 97 + 113) % count);
				if (deleted.has(id)) continue;
				await db.update(key(id), -10000 - round * writes - step);
				result.mixedOperations.updates++;
				changed.set(id, -10000 - round * writes - step);
				check(await db.point(key(id)), id);
				result.mixedOperations.reads++;
				if (step % 4 === 3) {
					await db.remove(key(id));
					result.mixedOperations.deletes++;
					deleted.add(id);
					check(await db.point(key(id)), id);
					result.mixedOperations.reads++;
				}
			}
			await timed(`maintenance${round + 1}`, () => db.maintain());
			result.mixedOperations.maintenance++;
		}
	});
	await db.close();
	await timed("finalReopen", () => db.open());
	const final = await db.all();
	assert.equal(final.length, count - deleted.size);
	final.sort((a, b) => a.seq - b.seq);
	for (let i = 0; i < final.length; i++) {
		assert.ok(final[i].seq >= 1 && final[i].seq <= count);
		if (i) assert.ok(final[i].seq > final[i - 1].seq);
		check(final[i], final[i].seq);
	}
	result.final = await db.info();
	await timed("finalMaintenance", () => db.maintain());
	await timed("close", () => db.close());
	result.verified = true;
} catch (error) {
	result.errors.push({ message: error.message, stack: error.stack });
	process.exitCode = 1;
	try {
		await db.close();
	} catch (closeError) {
		result.errors.push({ message: closeError.message });
	}
} finally {
	result.usageEnd = process.resourceUsage();
	await writeFile(options.destination, `${JSON.stringify(result, null, 2)}\n`);
}
