#!/usr/bin/env node
// Measurement body for benchmark/durability.ts (run once per durability mode
// in its own process, because the knob is read at module load). Reports the
// same workload as the pre-durability benchmark so the deltas are comparable.
import { rmSync } from "node:fs";
import { join } from "node:path";

import Inibase from "../src/index.js";

const mode = process.argv[2] ?? "full";
const dbPath = `test-db-bench-durability-${mode}`;
rmSync(dbPath, { recursive: true, force: true });

const schema = [
	{ key: "username", type: "string", required: true },
	{ key: "email", type: "string", required: true },
	{ key: "age", type: "number", required: true },
];

const db = new Inibase(dbPath);
await db.createTable("users", schema);

const ms = async (fn: () => Promise<unknown>) => {
	const start = process.hrtime.bigint();
	await fn();
	return Number(process.hrtime.bigint() - start) / 1e6;
};

const N = 100;

// --- single-row posts (per-row journal + fsync) ------------------------------
let total = 0;
for (let i = 0; i < N; i++)
	total += await ms(() =>
		db.post("users", { username: `u${i}`, email: `u${i}@x.io`, age: i }),
	);
const postSingle = `${(total / N).toFixed(2)} ms/op`;

// --- bulk posts (one journaled commit for the whole batch) -------------------
const batch = Array.from({ length: N }, (_, i) => ({
	username: `b${i}`,
	email: `b${i}@x.io`,
	age: i,
}));
const bulkMs = await ms(() => db.post("users", batch));
const postBulk = `${bulkMs.toFixed(2)} ms/batch`;

// --- get / put / delete -------------------------------------------------------
const getAll = `${(await ms(() => db.get("users", undefined, { perPage: -1 }))).toFixed(2)} ms`;

const put = `${(await ms(() => db.put("users", { age: 99 }, 1))).toFixed(2)} ms/op`;

let delTotal = 0;
for (let i = N; i < N * 2; i++) {
	// delete by id resolves to line numbers first, then a journaled commit.
	delTotal += await ms(() => db.delete("users", i));
}
const del = `${(delTotal / N).toFixed(2)} ms/op`;

process.send?.({ postSingle, postBulk, getAll, put, del });
await new Promise((resolve) => setTimeout(resolve, 250)); // let the message flush
rmSync(dbPath, { recursive: true, force: true });
process.exit(0);