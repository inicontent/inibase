import { strict as assert } from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { test } from "node:test";

import Inibase, { type Schema } from "../src/index.js";

// Test database directory (kept separate from the other suites)
const dbPath = "test-db-child-computed";
let inibase: Inibase;

function removeDatabase() {
	if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
}

function initializeDatabase() {
	removeDatabase();
	inibase = new Inibase(dbPath);
}

type Row = Record<string, unknown> & { id?: string | number };

/** Convenience: post rows and return the full posted data (including ids). */
async function seed(
	tableName: string,
	rows: Record<string, unknown>[],
): Promise<Row[] | null> {
	return inibase.post(tableName, rows, undefined, true) as Promise<Row[]>;
}

/**
 * Element computed fields ("computed children" of an array-of-objects
 * column): evaluated once per element at write time and backfilled by
 * updateTable. Each test builds its own fixtures on a fresh database, and ids
 * are assigned in schema order after createTable.
 *
 *   products: name=1, price=2
 *   orders:   status=1, items=2 [ product=3, quantity=4, lineTotal=5 ],
 *             totalCents=6 (computed "sum(lineTotal)")
 *
 * lineTotal = quantity × product.price  =>  "4 * 3.2"
 */
const productsSchema: Schema = [
	{ key: "name", type: "string" },
	{ key: "price", type: "number" },
];

const ordersSchema = (): Schema => [
	{ key: "status", type: "string" },
	{
		key: "items",
		type: "array",
		children: [
			{ key: "product", type: "table", table: "products" },
			{ key: "quantity", type: "number" },
			{ key: "lineTotal", type: "number", computed: "4 * 3.2" },
		],
	},
	{ key: "totalCents", type: "number", computed: "sum(5)" },
];

async function fixtureOrders() {
	await inibase.createTable("products", productsSchema);
	await inibase.createTable("orders", ordersSchema());
	const [alpha, beta] = (await seed("products", [
		{ name: "Alpha", price: 100 },
		{ name: "Beta", price: 250 },
	])) as Row[];
	// O1: Alpha x2 (200) + Beta x1 (250) — mixed product order
	// O2: Alpha x3 (300)
	const [o1, o2] = (await seed("orders", [
		{
			status: "shipped",
			items: [
				{ product: alpha.id, quantity: 2 },
				{ product: beta.id, quantity: 1 },
			],
		},
		{ status: "shipped", items: [{ product: alpha.id, quantity: 3 }] },
	])) as Row[];
	return { alpha, beta, o1, o2 };
}

await test("element computed fields are evaluated per element at write time", async () => {
	initializeDatabase();
	const { o1, o2 } = await fixtureOrders();

	// lineTotal is derived element-wise (mixed-product order must not mix rows)
	assert.deepEqual(
		(o1.items as Row[]).map((item) => item.lineTotal),
		[200, 250],
		"per-element line totals (O1)",
	);
	assert.deepEqual(
		(o2.items as Row[]).map((item) => item.lineTotal),
		[300],
		"per-element line totals (O2)",
	);
	assert.equal(o1.totalCents, 450, "top-level computed sums the child values");
	assert.equal(o2.totalCents, 300);
});

await test("nested sum aggregates a computed child per product", async () => {
	initializeDatabase();
	const { alpha, beta } = await fixtureOrders();

	assert.equal(
		await inibase.sum("orders", "items.lineTotal", { product: alpha.id }, { nested: true }),
		500,
		"revenue per product (Alpha)",
	);
	assert.equal(
		await inibase.sum("orders", "items.lineTotal", { product: beta.id }, { nested: true }),
		250,
		"revenue per product (Beta)",
	);
	assert.equal(
		await inibase.sum("orders", "items.lineTotal", undefined, { nested: true }),
		750,
		"revenue across all rows",
	);
	assert.equal(
		await inibase.sum("orders", "items.quantity", { product: alpha.id }, { nested: true }),
		5,
		"pieces sold per product (Alpha)",
	);
});

await test("a missing operand in one element writes 0, never aborts or skips", async () => {
	initializeDatabase();
	const { alpha } = await fixtureOrders();
	// Third element has no quantity: lineTotal = 0 × price = 0 — the write
	// must not abort, and the nested sum must still count it.
	const row = (await seed("orders", [
		{
			status: "shipped",
			items: [
				{ product: alpha.id, quantity: 2 },
				{ product: alpha.id },
			],
		},
	])) as Row[];

	const items = row[0].items as Row[];
	assert.deepEqual(
		items.map((i) => i.lineTotal),
		[200, 0],
		"missing quantity element yields 0, not null",
	);
	assert.equal(row[0].totalCents, 200, "0 slot is included in the sum");
	assert.deepEqual(
		items.map((i) => i.product),
		[items[0].product, items[1].product],
		"linked product values survive the element write",
	);
});

await test("computed children are not user-settable", async () => {
	initializeDatabase();
	const { alpha } = await fixtureOrders();
	await assert.rejects(
		() =>
			inibase.post("orders", {
				status: "shipped",
				items: [{ product: alpha.id, quantity: 2, lineTotal: 42 }],
			}),
		(error: unknown) => (error as Error).name === "COMPUTED_FIELD_SETTABLE",
	);
	// ... and on updateTable re-derivations the payload cannot inject the value
	await assert.rejects(
		() =>
			inibase.put("orders", {
				items: [{ product: alpha.id, quantity: 2, lineTotal: 42 }],
			}),
		(error: unknown) => (error as Error).name === "COMPUTED_FIELD_SETTABLE",
	);
});

await test("put re-evaluates child computeds (by id and whole-table)", async () => {
	initializeDatabase();
	const { alpha, o1 } = await fixtureOrders();
	const rows = (await inibase.get("orders", undefined, { perPage: -1 })) as Row[];
	const o2 = rows.find((r) => r.id !== o1.id) as Row;

	// put by id: only that row is re-derived
	await inibase.put("orders", { items: [{ product: alpha.id, quantity: 9 }] }, { id: o2.id });
	const afterPut = (await inibase.get("orders", undefined, { perPage: -1 })) as Row[];
	const updated = afterPut.find((r) => r.id === o2.id) as Row;
	assert.deepEqual(
		(updated.items as Row[]).map((i) => i.lineTotal),
		[900],
		"put-by-id recomputes child totals",
	);
	// reader re-resolves table children to linked objects, not raw ids
	const o2Item = (updated.items as Row[])[0];
	assert.equal((o2Item.product as Row).id, alpha.id);

	// whole-table put: every row is re-derived, existing rows otherwise intact
	await inibase.put("orders", { status: "re-shipped" });
	const afterAll = (await inibase.get("orders", undefined, { perPage: -1 })) as Row[];
	assert.equal(afterAll.length, 2);
	for (const r of afterAll) {
		assert.equal(r.status, "re-shipped");
		assert.deepEqual(
			(r.items as Row[]).map((i) => i.lineTotal),
			r.id === o1.id ? [200, 250] : [900],
			"whole-table put recomputes every child total",
		);
		if (r.id === o1.id) assert.equal(r.totalCents, 450);
	}
});

await test("updateTable backfills an added child computed into existing rows", async () => {
	initializeDatabase();
	const tableName = "c_backfill_items";
	await inibase.createTable("products", productsSchema);
	await inibase.createTable(tableName, [
		{ key: "qty", type: "number" },
		{
			key: "items",
			type: "array",
			children: [
				{ key: "product", type: "table", table: "products" },
				{ key: "amount", type: "number" },
			],
		},
	]);
	const [alpha, beta] = (await seed("products", [
		{ name: "Alpha5", price: 100 },
		{ name: "Beta5", price: 250 },
	])) as Row[];
	await seed(tableName, [
		{ qty: 2, items: [{ product: alpha.id, amount: 2 }] },
		{
			qty: 3,
			items: [
				{ product: alpha.id, amount: 1 },
				{ product: beta.id, amount: 3 },
			],
		},
	]);

	// subtotal = amount × product.price. Table ids: qty=1, items=2,
	// product=3, amount=4 -> subtotal=5, expression "4 * 3.2"
	const current = (await inibase.getTableSchema(tableName)) as Schema;
	await inibase.updateTable(
		tableName,
		current.map((field) =>
			field.key === "items"
				? {
						...field,
						children: [
							...(field.children as Schema),
							{ key: "subtotal", type: "number", computed: "4 * 3.2" },
						],
					}
				: field,
		),
	);

	const rows = (await inibase.get(tableName, undefined, { perPage: -1 })) as Row[];
	const row1 = rows.find((r) => r.qty === 2) as Row;
	const row2 = rows.find((r) => r.qty === 3) as Row;
	assert.deepEqual(
		(row1.items as Row[]).map((i) => i.subtotal),
		[200],
		"backfilled element values (row 1)",
	);
	assert.deepEqual(
		(row2.items as Row[]).map((i) => i.subtotal),
		[100, 750],
		"backfilled element values (row 2)",
	);
	assert.equal(row1.qty, 2, "existing columns survive the migration");

	// the new child feeds the nested sum directly
	assert.equal(
		await inibase.sum(tableName, "items.subtotal", undefined, { nested: true }),
		1050,
	);
});

await test("updateTable re-backfills a changed child computed", async () => {
	initializeDatabase();
	const tableName = "c_rebackfill";
	// ids: items=1, a=2, b=3, s=4
	await inibase.createTable(tableName, [
		{
			key: "items",
			type: "array",
			children: [
				{ key: "a", type: "number" },
				{ key: "b", type: "number" },
				{ key: "s", type: "number", computed: "2 + 3" },
			],
		},
	]);
	await seed(tableName, [
		{ items: [{ a: 2, b: 3 }] },
		{ items: [{ a: 5, b: 4 }] },
	]);

	const changeTo = async (expr: string) => {
		const current = (await inibase.getTableSchema(tableName)) as Schema;
		await inibase.updateTable(
			tableName,
			current.map((field) =>
				field.key === "items"
					? {
							...field,
							children: (field.children as Schema).map((child) =>
								child.key === "s" ? { ...child, computed: expr } : child,
							),
						}
					: field,
			),
		);
	};

	// s = a + b
	await changeTo("2 + 3");
	let rows = (await inibase.get(tableName, undefined, { perPage: -1 })) as Row[];
	assert.deepEqual(
		rows.map((r) => (r.items as Row[])[0].s),
		[5, 9],
		"expression change re-backfills existing elements",
	);

	// s = a * b
	await changeTo("2 * 3");
	rows = (await inibase.get(tableName, undefined, { perPage: -1 })) as Row[];
	assert.deepEqual(
		rows.map((r) => (r.items as Row[])[0].s),
		[6, 20],
		"second expression change re-backfills again",
	);

	// and posts after the migration keep evaluating
	const posted = (await seed(tableName, [{ items: [{ a: 10, b: 2 }] }])) as Row[];
	assert.equal((posted[0].items as Row[])[0].s, 20);
});

await test("schema validation rejects malformed child computeds", async () => {
	initializeDatabase();
	await inibase.createTable("products", productsSchema);
	let tableIndex = 0;
	const rejectsInvalid = async (schema: Schema) => {
		const name = `c_bad_${tableIndex++}`;
		// a failed createTable leaves the table directory behind, so every
		// attempt gets a unique name
		return assert.rejects(
			() => inibase.createTable(name, schema),
			(error: unknown) => (error as Error).name === "COMPUTED_FIELD_INVALID_TARGET",
		);
	};

	// must be numeric (summable)
	await rejectsInvalid([
		{
			key: "items",
			type: "array",
			children: [{ key: "x", type: "string", computed: "1" }],
		},
	]);

	// may not reference a top-level field (must be a sibling of the array root)
	await rejectsInvalid([
		{ key: "top", type: "number" },
		{
			key: "items",
			type: "array",
			children: [{ key: "x", type: "number", computed: "1" }],
		},
	]);

	// may not use helpers
	await rejectsInvalid([
		{
			key: "items",
			type: "array",
			children: [{ key: "x", type: "number", computed: "sum(1)" }],
		},
	]);

	// may not reference a sibling of a *different* array root
	await rejectsInvalid([
		{
			key: "arrA",
			type: "array",
			children: [{ key: "pa", type: "number" }],
		},
		{
			key: "arrB",
			type: "array",
			children: [
				{ key: "pb", type: "number" },
				{ key: "cb", type: "number", computed: "1" },
			],
		},
	]);

	// an expression referencing an unknown linked-field id fails cleanly
	// (bare unrecognized ints are numeric literals, so use a link hop)
	await assert.rejects(
		() =>
			inibase.createTable(`c_bad_${tableIndex++}`, [
				{
					key: "items",
					type: "array",
					children: [
						{ key: "link", type: "table", table: "products" },
						{ key: "x", type: "number", computed: "2.99" },
					],
				},
			]),
		(error: unknown) => (error as Error).name === "COMPUTED_FIELD_UNKNOWN_FIELD",
	);
});

await test("child computeds evaluate inside transactions", async () => {
	initializeDatabase();
	const tableName = "c_txn";
	// ids: items=1, a=2, b=3, sub=4  (sub = a × b = "2 * 3")
	await inibase.createTable(tableName, [
		{
			key: "items",
			type: "array",
			children: [
				{ key: "a", type: "number" },
				{ key: "b", type: "number" },
				{ key: "sub", type: "number", computed: "2 * 3" },
			],
		},
	]);

	await inibase.begin([tableName]);
	await seed(tableName, [
		{ items: [{ a: 2, b: 3 }] },
		{ items: [{ a: 3, b: 4 }] },
	]);
	await inibase.commit();

	// staged writes evaluated the child on commit
	let rows = (await inibase.get(tableName, undefined, { perPage: -1 })) as Row[];
	assert.deepEqual(
		rows.map((r) => (r.items as Row[])[0].sub),
		[6, 12],
		"committed child computeds",
	);

	// rollback never publishes the derived values
	await inibase.begin([tableName]);
	await inibase.post(tableName, { items: [{ a: 5, b: 6 }] });
	await inibase.rollback();
	rows = (await inibase.get(tableName, undefined, { perPage: -1 })) as Row[];
	assert.equal(rows.length, 2, "rolled-back row is gone");
	assert.equal(
		await inibase.sum(tableName, "items.sub", undefined, { nested: true }),
		18,
		"nested sum over committed data only",
	);
});

await test("Cleanup computed-child database", removeDatabase);