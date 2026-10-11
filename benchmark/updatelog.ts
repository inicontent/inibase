// Gate B (3.8): the *populated-overlay* read budget for format-2 log tables.
// `pnpm benchmark` reports the log table against the legacy baseline with an
// empty overlay; this script additionally populates the overlay with updates
// and re-measures reads, reporting the delta as the budget the release accepts.
// Write cost is reported too, since log puts are the reason the overlay exists.
import { Console } from "node:console";
import { rm } from "node:fs/promises";
import { isExists } from "../src/file";
import Inibase, { type Schema } from "../src/index";

const logger = new Console({
	stdout: process.stdout,
	stderr: process.stderr,
});

const SIZE = 1000;
const dbPath = "test-bench-log";
const db = new Inibase(dbPath);

const schema: Schema = [
	{ key: "username", type: "string", required: true },
	{ key: "email", type: "email", required: true },
];

const seed = () =>
	[...Array(SIZE)].map((_, i) => ({
		username: `username_${i + 1}`,
		email: `email_${i + 1}@test.com`,
	}));

const measure = async (fn: () => Promise<void>): Promise<number> => {
	if (global.gc) global.gc();
	const start = Date.now();
	await fn();
	return Date.now() - start;
};

if (await isExists(dbPath)) await rm(dbPath, { recursive: true, force: true });
await db.createTable("records", schema, { log: true, decodeID: true });
await db.post("records", seed());

// Baseline: reads against an empty overlay.
const emptyGet = await measure(async () => {
	for (let i = 0; i < SIZE; i++) await db.get("records", i + 1);
});

// Populate the overlay without touching the base (a single bulk put).
const logPut = await measure(async () => {
	await db.put(
		"records",
		{ username: "edited" },
		[...Array(SIZE)].map((_, i) => i + 1),
	);
});

// Reads now merge SIZE overlay entries over base for every access.
const populatedGet = await measure(async () => {
	for (let i = 0; i < SIZE; i++) await db.get("records", i + 1);
});

// After compaction the overlay is folded; reads fall back to ~empty cost.
const compact = await measure(async () => {
	await db.compact("records");
});
const postCompactGet = await measure(async () => {
	for (let i = 0; i < SIZE; i++) await db.get("records", i + 1);
});

logger.group("Gate B: populated-overlay budget (log table, size 1000)");
logger.table({
	"GET empty overlay (baseline)": { ms: emptyGet },
	"PUT populate overlay": { ms: logPut },
	"GET populated overlay": { ms: populatedGet },
	"GET after compact": { ms: postCompactGet },
	"compact (1000 rows)": { ms: compact },
});
logger.groupEnd();

// The reported budget is the populated-overlay GET delta over baseline.
const deltaPct = ((populatedGet - emptyGet) / Math.max(emptyGet, 1)) * 100;
logger.log(
	`populated-overlay GET vs empty-overlay GET: +${deltaPct.toFixed(0)}% (${emptyGet} ms -> ${populatedGet} ms)`,
);

await rm(dbPath, { recursive: true, force: true });
