#!/usr/bin/env node
// Computed-fields benchmark: measures the write-time cost of evaluating
// computed fields (helpers sum/avg/min/max/count plus arithmetic) against
// the same table shape without them.
//
// Both tables run in the same process and durability mode (full fsync +
// journal is the default), so the plain-vs-computed delta isolates the
// expression-evaluation cost. Reads are included to show that computed
// values are stored in real column files and cost nothing extra to read.
//
// Run: pnpm benchmark:computed
import { strict as assert } from "node:assert";
import { rmSync } from "node:fs";

import Inibase, { type Schema } from "../src/index.js";

type Row = Record<string, any> & { id?: string | number };

const dbPath = "test-db-bench-computed";
rmSync(dbPath, { recursive: true, force: true });
const db = new Inibase(dbPath);

// Field ids follow createTable order (id=0 is the automatic key):
// name=1, items=2, qty=3, price=4, itemTotal=5, avgPrice=6, minPrice=7,
// maxPrice=8, lineCount=9, grandTotal=10.
const computedSchema: Schema = [
	{ key: "name", type: "string" },
	{
		key: "items",
		type: "array",
		children: [
			{ key: "qty", type: "number" },
			{ key: "price", type: "number" },
		],
	},
	{ key: "itemTotal", type: "number", computed: "sum(3 * 4)" },
	{ key: "avgPrice", type: "number", computed: "avg(4)" },
	{ key: "minPrice", type: "number", computed: "min(4)" },
	{ key: "maxPrice", type: "number", computed: "max(4)" },
	{ key: "lineCount", type: "number", computed: "count(3)" },
	// arithmetic over a computed dependency: itemTotal × (314 / 100)
	{ key: "grandTotal", type: "number", computed: "5 * 314 / 100" },
] satisfies Schema;

const plainSchema: Schema = [
	{ key: "name", type: "string" },
	{
		key: "items",
		type: "array",
		children: [
			{ key: "qty", type: "number" },
			{ key: "price", type: "number" },
		],
	},
] satisfies Schema;

await db.createTable("computed", computedSchema);
await db.createTable("plain", plainSchema);

const row = (i: number) => ({
	name: `order_${i}`,
	items: [
		{ qty: (i % 5) + 1, price: ((i % 7) + 3) * 100 },
		{ qty: 2, price: 199 },
		{ qty: 1, price: 449 },
	],
});

const rows = (size: number) => [...Array(size)].map((_, i) => row(i));

const ms = async (fn: () => Promise<unknown>) => {
	const start = process.hrtime.bigint();
	await fn();
	return Number(process.hrtime.bigint() - start) / 1e6;
};

// --- sanity probe: the helpers evaluate to the expected values -------------
const probe = (await db.post("computed", row(0), undefined, true)) as Row;
assert.equal(probe.itemTotal, 1 * 300 + 2 * 199 + 1 * 449, "sum(3 * 4)");
assert.equal(probe.avgPrice, Math.round((300 + 199 + 449) / 3), "avg(4)");
assert.equal(probe.minPrice, 199, "min(4)");
assert.equal(probe.maxPrice, 449, "max(4)");
assert.equal(probe.lineCount, 3, "count(3)");
assert.ok(
	Math.abs(probe.grandTotal - probe.itemTotal * 3.14) < 1e-9,
	"5 * 314 / 100",
);

const sizes = [10, 100, 1000];
const singleN = 100;
// Fsync + journal dominate single-shot timings, so each write measure is the
// min of `reps` rounds on identical data (strips GC/fsync jitter).
const reps = 3;

type RowMeasure = { plain: number; computed: number };
const bulkPost: Partial<Record<number, RowMeasure>> = {};
const putRecompute: Partial<Record<number, RowMeasure>> = {};
const postHeap: Partial<Record<number, RowMeasure>> = {};

// --- bulk POST: write + evaluate every computed field -----------------------
for (const size of sizes) {
	const timeSlot = { plain: Infinity, computed: Infinity };
	const heapSlot = { plain: 0, computed: 0 };
	for (let rep = 0; rep < reps; rep++) {
		for (const table of ["plain", "computed"] as const) {
			const before = process.memoryUsage().heapUsed;
			const t0 = process.hrtime.bigint();
			await db.post(table, rows(size));
			const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
			const heap = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
			// Min time / max transient heap across the reps.
			timeSlot[table] = Math.min(timeSlot[table], tookMs);
			heapSlot[table] = Math.max(heapSlot[table], heap);
		}
	}
	bulkPost[size] = timeSlot;
	postHeap[size] = heapSlot;
}

// --- single POST: mean ms/op over singleN rows -------------------------------
let plainTotal = 0;
let computedTotal = 0;
for (let i = 0; i < singleN; i++) {
	plainTotal += await ms(() => db.post("plain", row(i)));
	computedTotal += await ms(() => db.post("computed", row(i)));
}
const singlePost: RowMeasure = {
	plain: plainTotal / singleN,
	computed: computedTotal / singleN,
};

// --- PUT: recompute the computed columns for `size` seeded rows -------------
// Each round seeds a dedicated pair of tables so ids are always 1..size.
for (const size of sizes) {
	await db.createTable(`put_plain_${size}`, plainSchema);
	await db.createTable(`put_computed_${size}`, computedSchema);
	await db.post(`put_plain_${size}`, rows(size));
	await db.post(`put_computed_${size}`, rows(size));
	const ids = [...Array(size)].map((_, i) => i + 1);
	putRecompute[size] = { plain: Infinity, computed: Infinity };
	for (let rep = 0; rep < reps; rep++) {
		putRecompute[size].plain = Math.min(
			putRecompute[size].plain,
			await ms(() => db.put(`put_plain_${size}`, { name: "x" }, ids)),
		);
		putRecompute[size].computed = Math.min(
			putRecompute[size].computed,
			await ms(() => db.put(`put_computed_${size}`, { name: "x" }, ids)),
		);
	}
}

// --- GET all: reads hit the stored columns, so both should match -------------
let plainRead = 0;
let computedRead = 0;
for (let i = 0; i < 10; i++) {
	plainRead += await ms(() => db.get("plain", undefined, { perPage: -1 }));
	computedRead += await ms(() =>
		db.get("computed", undefined, { perPage: -1 }),
	);
}
const getAll: RowMeasure = {
	plain: plainRead / 10,
	computed: computedRead / 10,
};

// --- link-heavy: shared product catalog, per-item link hops ----------------
// The README totalCentsLive shape, bulked: every order's line items point
// back into a small shared catalog. Without batched link-hop reads each item
// costs a full row-level read of the linked table; with them each distinct
// (table, column, id) triple resolves once per post, so a 1000-order batch
// (2000 line items) resolves <= catalogSize prices instead of 2000 reads.
await db.createTable("lk_product", [
	{ key: "name", type: "string" },
	{ key: "price", type: "number" },
]);
await db.createTable("lk_orders", [
	{ key: "customer", type: "string" },
	{ key: "status", type: "number" },
	{
		key: "items",
		type: "array",
		children: [
			{ key: "product", type: "table", table: "lk_product" },
			{ key: "quantity", type: "number" },
			{ key: "unitPriceCents", type: "number" },
		],
	},
	// ids: customer=1, status=2, items=3, product=4, quantity=5,
	// unitPriceCents=6, totalCents=7, totalCentsLive=8
	{ key: "totalCents", type: "number", computed: "sum(5 * 6)" },
	{ key: "totalCentsLive", type: "number", computed: "sum(5 * 4.2)" },
]);
const catalogSize = 20;
const catalog = (await db.post(
	"lk_product",
	[...Array(catalogSize)].map((_, i) => ({
		name: `product_${i}`,
		price: ((i % 7) + 3) * 100,
	})),
	undefined,
	true,
)) as Row[];
const linkOrder = (i: number) => ({
	customer: `customer_${i}`,
	status: i % 2,
	items: [
		{
			product: catalog[i % catalogSize].id,
			quantity: (i % 5) + 1,
			unitPriceCents: 250,
		},
		{
			product: catalog[(i * 7 + 3) % catalogSize].id,
			quantity: 2,
			unitPriceCents: 199,
		},
	],
});
// sanity probe: the linked totals match the README example math
const linkProbe = (await db.post(
	"lk_orders",
	linkOrder(0),
	undefined,
	true,
)) as Row;
{
	const [a, b] = linkOrder(0).items;
	const prodA = catalog.find((p) => p.id === a.product) as Row;
	const prodB = catalog.find((p) => p.id === b.product) as Row;
	assert.equal(
		linkProbe.totalCents,
		(a.quantity as number) * (a.unitPriceCents as number) +
			(b.quantity as number) * (b.unitPriceCents as number),
		"sum(5 * 6)",
	);
	assert.equal(
		linkProbe.totalCentsLive,
		(a.quantity as number) * (prodA.price as number) +
			(b.quantity as number) * (prodB.price as number),
		"sum(5 * 4.2) via link hops",
	);
}
const linkPost: Partial<Record<number, number>> = {};
for (const size of sizes) {
	linkPost[size] = Infinity;
	for (let rep = 0; rep < reps; rep++)
		linkPost[size] = Math.min(
			linkPost[size],
			await ms(() =>
				db.post(
					"lk_orders",
					[...Array(size)].map((_, i) => linkOrder(i)),
					{ perPage: -1 },
				),
			),
		);
}

const fmt = (m: RowMeasure) =>
	`${m.plain.toFixed(2)} / ${m.computed.toFixed(2)}`;

console.log(
	"inibase computed-fields benchmark (fsync + journal on: numbers are engine",
);
console.log(
	"costs; the plain-vs-computed delta is the pure expression-evaluation cost)\n",
);
console.log(
	"rows   POST bulk                POST single            PUT recompute",
);
console.log(
	"       plain / computed ms      plain / computed       plain / computed",
);
console.log(
	"----   --------------------     --------------------   --------------------",
);
for (const size of sizes) {
	console.log(
		`${String(size).padEnd(5)} ${fmt(bulkPost[size]).padEnd(
			24,
		)} ${fmt(singlePost).padEnd(22)} ${fmt(putRecompute[size])}`,
	);
}
console.log(
	`\nGET all after POST rounds (${sizes.reduce((a, b) => a + b, 0)} rows): ${fmt(getAll)} ms (reads hit stored columns; no compute)`,
);
console.log("\nPOST bulk transient heap, max of 3 reps (plain / computed):");
for (const size of sizes) {
	const m = postHeap[size] as RowMeasure;
	console.log(
		`  ${String(size).padEnd(5)} ${m.plain.toFixed(2)} / ${m.computed.toFixed(
			2,
		)} mb`,
	);
}

console.log("\n--- link-heavy: shared catalog, per-item link hops ---\n");
console.log(`POST bulk of ${sizes.join("/")} orders (${2 * sizes[sizes.length - 1]} line items max, ${catalogSize}-row product catalog):`);
for (const size of sizes)
	console.log(`  ${String(size).padEnd(5)} ${linkPost[size]?.toFixed(2)} ms`);
console.log(
	"  (each batch resolves <= catalogSize distinct linked rows; without batching every line item reads its product row)",
);

// README-ready markdown block (paste under "### Computed fields")
console.log("\n--- README markdown ---\n");
console.log(
	"| rows | POST bulk (plain / computed) | POST single (plain / computed) | PUT recompute (plain / computed) |",
);
console.log(
	"|------|------------------------------|--------------------------------|----------------------------------|",
);
for (const size of sizes) {
	console.log(
		`| ${size} | ${fmt(bulkPost[size])} ms | ${fmt(singlePost)} ms | ${fmt(putRecompute[size])} ms |`,
	);
}

rmSync(dbPath, { recursive: true, force: true });
