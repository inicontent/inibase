import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { observeEqualityScan } from "../src/automatic.js";
import Inibase from "../src/index.js";
import { DatabaseResources, resourcesFor } from "../src/resources.js";

test("automatic builders coordinate with readers and writers in other processes", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-automatic-process-"));
	const db = new Inibase("db", root);
	try {
		await db.createTable(
			"records",
			[
				{ key: "slug", type: "string", unique: true },
				{ key: "value", type: "number" },
			],
			{ compression: true, decodeID: true },
		);
		await db.post(
			"records",
			Array.from({ length: 1000 }, (_, i) => ({ slug: `item-${i}`, value: i })),
		);
		const run = (mode: string) =>
			new Promise<void>((resolve, reject) => {
				const child = spawn(
					process.execPath,
					[
						"--import",
						"tsx",
						new URL("./automatic.process.child.ts", import.meta.url).pathname,
						root,
						mode,
					],
					{ stdio: ["ignore", "pipe", "pipe"] },
				);
				let stderr = "";
				child.stderr.on("data", (chunk) => {
					stderr += chunk;
				});
				child.stdout.resume();
				child.on("error", reject);
				child.on("exit", (code, signal) =>
					code === 0
						? resolve()
						: reject(new Error(`${mode}: ${code}/${signal}: ${stderr}`)),
				);
			});
		const results = await Promise.allSettled([
			run("reader"),
			run("writer"),
			run("reader"),
		]);
		for (const result of results)
			if (result.status === "rejected") throw result.reason;
		const values = await db.get("records", undefined, { perPage: -1 });
		assert.equal(values?.length, 1012);
		for (let i = 0; i < 12; i++)
			assert.equal((await db.get("records", i + 1))?.value, i === 0 ? 0 : -i);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("automatic build limits leave authoritative data unchanged", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-automatic-limit-"));
	const db = new Inibase("db", root);
	try {
		await db.createTable("records", [{ key: "slug", type: "string" }], {
			compression: true,
			decodeID: true,
		});
		const rows = Array.from({ length: 128 }, (_, i) => ({
			slug: i === 0 ? "x".repeat(70000) : slug(i),
		}));
		await db.post("records", rows);
		const path = join(root, "db/records");
		const original = await readFile(join(path, "slug.txt.gz"));
		const originalTemporaryNames = (await readdir(join(path, ".tmp"))).sort();
		// Drive the policy with scan-cost evidence; the production builder still
		// performs all eligibility, locking, size and bounded-cell checks.
		const resources = resourcesFor(join(root, "db"));
		for (let i = 0; i < 16; i++)
			observeEqualityScan(resources, path, "slug", 5, () =>
				(db as any).buildAutomaticIndex("records", "slug"),
			);
		await resources.drainMaintenance();
		assert.equal(resources.stats().maintenanceErrors, 1);
		assert.match(
			resources.stats().maintenanceLastError!,
			/AUTOMATIC_BUILD_BUDGET/,
		);
		assert.deepEqual(await readFile(join(path, "slug.txt.gz")), original);
		assert.ok(!(await readdir(path)).includes(".seek.config"));
		assert.deepEqual(
			(await readdir(join(path, ".tmp"))).sort(),
			originalTemporaryNames,
		);
		assert.equal((await db.get("records", 1))?.slug, rows[0].slug);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});

const slug = (i: number) =>
	createHash("sha256").update(`record-${i}`).digest("hex");

test("small memory budgets retain the scan fallback", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-automatic-small-"));
	const previous = process.env.INIBASE_MEMORY_BYTES;
	process.env.INIBASE_MEMORY_BYTES = "262144";
	const db = new Inibase("db", root);
	if (previous === undefined) delete process.env.INIBASE_MEMORY_BYTES;
	else process.env.INIBASE_MEMORY_BYTES = previous;
	try {
		await db.createTable("records", [{ key: "slug", type: "string" }], {
			compression: true,
			decodeID: true,
		});
		await db.post(
			"records",
			Array.from({ length: 128 }, (_, i) => ({ slug: slug(i) })),
		);
		await (db as any).buildAutomaticIndex("records", "slug");
		assert.ok(
			!(await readdir(join(root, "db/records"))).includes(".seek.config"),
		);
		assert.equal(
			(await db.get("records", { slug: slug(127) }))?.[0].slug,
			slug(127),
		);
		assert.equal(db.memoryUsage().limitBytes, 262144);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("the public options stay at four while repeated lookups learn a disk index", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-automatic-"));
	const db = new Inibase("db", root);
	try {
		await db.createTable(
			"records",
			[
				{ key: "slug", type: "string", unique: true },
				{ key: "value", type: "number" },
			],
			{ decodeID: true, compression: true, cache: false, prepend: false },
		);
		await db.post(
			"records",
			Array.from({ length: 1000 }, (_, i) => ({ slug: slug(i), value: i })),
		);
		assert.deepEqual(
			Object.keys((await db.getTable("records"))!.config).sort(),
			["cache", "compression", "decodeID", "prepend"],
		);
		for (let i = 0; i < 128; i++) {
			const rows = await db.get("records", { slug: slug(i) });
			assert.equal(rows?.[0].value, i);
			if (db.memoryUsage().maintenanceActive)
				await resourcesFor(join(root, "db")).drainMaintenance();
			if (db.memoryUsage().maintenanceRuns) break;
		}
		assert.equal(
			db.memoryUsage().maintenanceErrors,
			0,
			db.memoryUsage().maintenanceLastError,
		);
		const config = JSON.parse(
			await readFile(join(root, "db/records/.seek.config"), "utf8"),
		);
		assert.ok(config.indexes.includes("slug"));
		await db.put("records", { slug: "changed" }, 1);
		assert.equal((await db.get("records", { slug: "changed" }))?.[0].value, 0);
		assert.equal(await db.get("records", { slug: slug(0) }), null);
		await assert.rejects(() => db.put("records", { slug: "changed" }, 2));
		await db.delete("records", 1);
		assert.equal(await db.get("records", { slug: "changed" }), null);
		await db.begin();
		await db.put("records", { value: 777 }, 2);
		await db.commit();
		assert.equal((await db.get("records", 2))?.value, 777);
		assert.ok(
			db.memoryUsage().peakAccountedBytes <= db.memoryUsage().limitBytes,
		);
		assert.deepEqual(
			Object.keys((await db.getTable("records"))!.config).sort(),
			["cache", "compression", "decodeID", "prepend"],
		);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("working reservations share the cache cap and maintenance has no queue", async () => {
	const resources = new DatabaseResources();
	try {
		resources.set("cached", Buffer.alloc(1024), resources.limit - 1024);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		assert.equal(
			resources.tryMaintenance(() =>
				resources.withWorking(resources.limit, async () => {
					await gate;
				}),
			),
			true,
		);
		assert.equal(
			resources.tryMaintenance(async () => {
				throw new Error("must not queue");
			}),
			false,
		);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(resources.stats().workingBytes, resources.limit);
		assert.equal(resources.stats().cacheBytes, 0);
		resources.set("cannot-cache", {}, 1);
		assert.equal(resources.stats().cacheBytes, 0);
		release();
		await resources.drainMaintenance();
		assert.equal(resources.stats().workingBytes, 0);
		assert.equal(resources.stats().maintenanceRuns, 1);
		await assert.rejects(
			resources.withWorking(resources.limit + 1, async () => {}),
			/MEMORY_RESERVATION/,
		);
		// Hundreds of tables/columns cannot grow an unbounded learning Map.
		for (let i = 0; i < 50000; i++)
			observeEqualityScan(resources, `table-${i}`, "key", 1, async () => {});
		assert.ok(resources.stats().cacheBytes <= resources.limit);
	} finally {
		await resources.close();
	}
});
