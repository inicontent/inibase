import { strict as assert } from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { test } from "node:test";

import Inibase, { type Schema } from "../src/index.js";

// Test database directory (kept separate from the other suites)
const dbPath = "test-db-nested-sum";
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
 * orders / products fixtures mirroring the real-world "pieces sold per product"
 * use case:
 *   O1 shipped   items: [Alpha x2 (revenue 200, note "x"), Beta x1 (revenue 250)]
 *   O2 shipped   items: [Alpha x3 (revenue 300)]
 *   O3 cancelled items: [Alpha x5 (revenue 500, note "x")]
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
		required: false,
		children: [
			{ key: "product", type: "table", table: "products" },
			{ key: "quantity", type: "number" },
			{ key: "revenue", type: "number" },
			{ key: "note", type: "string" },
		],
	},
];

async function seedOrders() {
	const [alpha, beta] = (await seed("products", [
		{ name: "Alpha", price: 100 },
		{ name: "Beta", price: 250 },
	])) as Row[];
	await seed("orders", [
		{
			status: "shipped",
			items: [
				{ product: alpha.id, quantity: 2, revenue: 200, note: "x" },
				{ product: beta.id, quantity: 1, revenue: 250 },
			],
		},
		{
			status: "shipped",
			items: [{ product: alpha.id, quantity: 3, revenue: 300 }],
		},
		{
			status: "cancelled",
			items: [{ product: alpha.id, quantity: 5, revenue: 500, note: "x" }],
		},
	]);
	return { alpha, beta };
}

/**
 * The `rows` of this suite are labelled by their data, not by test order, so
 * each outer `test` builds the fixtures it needs and cleans up afterwards.
 */
await test("nested sum basics", async (t) => {
	initializeDatabase();
	await inibase.createTable("products", productsSchema);
	await inibase.createTable("orders", ordersSchema());
	const { alpha, beta } = await seedOrders();

	await t.test("all elements when no where is given", async () => {
		assert.equal(
			await inibase.sum("orders", "items.quantity", undefined, { nested: true }),
			11,
		);
		assert.equal(
			await inibase.sum("orders", "items.revenue", undefined, { nested: true }),
			1250,
		);
	});

	await t.test("bare element predicate resolves under the array root", async () => {
		assert.equal(
			await inibase.sum("orders", "items.quantity", { product: alpha.id }, { nested: true }),
			10,
		);
		assert.equal(
			await inibase.sum("orders", "items.quantity", { product: beta.id }, { nested: true }),
			1,
		);
	});

	await t.test("mixed-product order is not over-counted (element-wise zip)", async () => {
		// O1 holds both Alpha and Beta; Alpha may only count its own element.
		assert.equal(
			await inibase.sum("orders", "items.quantity", { product: alpha.id }, { nested: true }),
			10, // 2 (O1) + 3 (O2) + 5 (O3) — never the whole O1 row
		);
	});

	await t.test("dotted element predicate is equivalent", async () => {
		assert.equal(
			await inibase.sum("orders", "items.quantity", { "items.product": alpha.id }, { nested: true }),
			10,
		);
	});

	await t.test("no matching elements returns 0", async () => {
		assert.equal(
			await inibase.sum("orders", "items.quantity", { product: "ghost" }, { nested: true }),
			0,
		);
	});

	await t.test("operator predicates are supported", async () => {
		assert.equal(
			await inibase.sum("orders", "items.quantity", { quantity: ">1" }, { nested: true }),
			10, // 2 + 3 + 5
		);
		assert.equal(
			await inibase.sum("orders", "items.quantity", { quantity: "<3" }, { nested: true }),
			3, // 2 + 1
		);
	});

	await t.test("multiple element predicates AND together", async () => {
		assert.equal(
			await inibase.sum("orders", "items.revenue", { product: alpha.id, quantity: ">2" }, { nested: true }),
			800, // 300 + 500
		);
	});

	await t.test("row-level key narrows contributing rows", async () => {
		assert.equal(
			await inibase.sum("orders", "items.quantity", { status: "shipped" }, { nested: true }),
			6, // 2 + 1 + 3
		);
	});

	await t.test("row filter combines with element predicate", async () => {
		assert.equal(
			await inibase.sum("orders", "items.quantity", { product: alpha.id, status: "shipped" }, { nested: true }),
			5, // 2 + 3
		);
	});

	await t.test("and/or groups pass through as row-level filters", async () => {
		assert.equal(
			await inibase.sum("orders", "items.quantity", { product: alpha.id, and: { status: "shipped" } }, { nested: true }),
			5,
		);
		assert.equal(
			await inibase.sum("orders", "items.quantity", { or: { status: "shipped" } }, { nested: true }),
			6,
		);
	});

	await t.test("multi-column sum shares one predicate and returns a record", async () => {
		const got = (await inibase.sum(
			"orders",
			["items.quantity", "items.revenue"],
			{ product: alpha.id },
			{ nested: true },
		)) as Record<string, number>;
		assert.deepEqual(got, { "items.quantity": 10, "items.revenue": 1000 });
	});

	await t.test("flat sum is unchanged and still rejects dotted columns", async () => {
		assert.equal(await inibase.sum("products", "price"), 350);
		await assert.rejects(inibase.sum("orders", "items.quantity"), {
			name: "INVALID_NAME",
		});
	});
});

await test("nested sum validation errors", async (t) => {
	initializeDatabase();
	await inibase.createTable("products", productsSchema);
	await inibase.createTable("orders", ordersSchema());
	await seedOrders();

	const bad = (args: Parameters<Inibase["sum"]>, label: string) =>
		assert.rejects(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(inibase.sum as any)(...args),
			{ name: "INVALID_PARAMETERS" },
			label,
		);

	await t.test("column must be a dotted child path", async () => {
		await bad(["orders", "quantity", undefined, { nested: true }], "single segment");
	});

	await t.test("only one nesting level is supported", async () => {
		await bad(["orders", "items.a.b", undefined, { nested: true }], "two dots");
	});

	await t.test("columns must share the same array root", async () => {
		await bad(["orders", ["items.quantity", "zzz.quantity"], undefined, { nested: true }], "two roots");
	});

	await t.test("root must be an array-of-objects column", async () => {
		await bad(["products", "name.x", undefined, { nested: true }], "scalar root");
	});

	await t.test("summing a non-numeric child yields 0 (consistent with flat sum)", async () => {
		assert.equal(
			await inibase.sum("orders", "items.product", undefined, { nested: true }),
			0,
		);
	});

	await t.test("criteria key matching neither root nor a row column", async () => {
		await bad(["orders", "items.quantity", { ghost: 1 }, { nested: true }], "unknown key");
	});

	await t.test("object-valued element predicates are rejected", async () => {
		await bad(["orders", "items.quantity", { product: { name: "Alpha" } }, { nested: true }], "object value");
	});

	await t.test("[] / ![] operators are rejected on element predicates", async () => {
		await bad(["orders", "items.quantity", { quantity: "[]1,2" }, { nested: true }], "array op");
	});
});

await test("nested sum TABLE_EMPTY guard", async (t) => {
	initializeDatabase();
	await inibase.createTable("empty", [
		{ key: "items", type: "array", children: [{ key: "qty", type: "number" }] },
	]);
	await assert.rejects(inibase.sum("empty", "items.qty", undefined, { nested: true }), {
		name: "TABLE_EMPTY",
	});
});

await test("aggregates with where are not capped at the default page size", async (t) => {
	initializeDatabase();

	const tableName = "counts";
	await inibase.createTable(tableName, [
		{ key: "val", type: "number" },
		{ key: "grp", type: "string" },
	]);
	// 30 rows, all in group "a" — 2x the default page size of 15.
	await seed(
		tableName,
		Array.from({ length: 30 }, (_, i) => ({ val: i + 1, grp: "a" })),
	);

	await t.test("sum counts every matching row", async () => {
		assert.equal(await inibase.sum(tableName, "val", { grp: "a" }), 465); // 1..30
	});

	await t.test("avg / max / min count every matching row too", async () => {
		assert.equal(await inibase.avg(tableName, "val", { grp: "a" }), 15.5);
		assert.deepEqual(await inibase.max(tableName, "val", { grp: "a" }), { val: 30 });
		assert.deepEqual(await inibase.min(tableName, "val", { grp: "a" }), { val: 1 });
	});
});

await test("nested sum works with decodeID referenced tables", async (t) => {
	initializeDatabase();

	await inibase.createTable("products2", productsSchema, { decodeID: true });
	await inibase.createTable("orders2", [
		{
			key: "items",
			type: "array",
			children: [
				{ key: "product", type: "table", table: "products2" },
				{ key: "quantity", type: "number" },
			],
		},
	]);

	const [alpha, beta] = (await seed("products2", [
		{ name: "Alpha", price: 100 },
		{ name: "Beta", price: 250 },
	])) as Row[];
	await seed("orders2", [
		{
			items: [
				{ product: alpha.id, quantity: 4 },
				{ product: beta.id, quantity: 2 },
			],
		},
		{ items: [{ product: alpha.id, quantity: 1 }] },
	]);

	// decodeID products have numeric ids (1 and 2 here).
	assert.equal(
		await inibase.sum("orders2", "items.quantity", { product: 1 }, { nested: true }),
		5,
	);
	assert.equal(
		await inibase.sum("orders2", "items.quantity", { product: 2 }, { nested: true }),
		2,
	);
});

await test("nested sum works on compressed and cache-enabled tables", async (t) => {
	initializeDatabase();

	const tableName = "ordersC";
	await inibase.createTable("products", productsSchema);
	const [alpha] = (await seed("products", [{ name: "Alpha", price: 100 }])) as Row[];
	await inibase.createTable(
		tableName,
		[
			{
				key: "items",
				type: "array",
				children: [
					{ key: "product", type: "table", table: "products" },
					{ key: "quantity", type: "number" },
				],
			},
		],
		{ compression: true },
	);

	await seed(tableName, [
		{ items: [{ product: alpha.id, quantity: 3 }] },
		{ items: [{ product: alpha.id, quantity: 7 }] },
	]);

	await t.test("compressed table reads", async () => {
		assert.equal(
			await inibase.sum(tableName, "items.quantity", { product: alpha.id }, { nested: true }),
			10,
		);
	});

	await t.test("cache-enabled table reads", async () => {
		await inibase.updateTable(tableName, undefined, { cache: true });
		await seed(tableName, [{ items: [{ product: alpha.id, quantity: 1 }] }]);
		assert.equal(
			await inibase.sum(tableName, "items.quantity", { product: alpha.id }, { nested: true }),
			11,
		);
	});
});

await test("nested sum: element predicates ignore row-level column of the same name", async (t) => {
	initializeDatabase();
	// A table with BOTH a top-level `product` column and a nested `product` child:
	// under nested mode the key must resolve to the element predicate.
	await inibase.createTable("products", productsSchema);
	await inibase.createTable("special", [
		{ key: "product", type: "table", table: "products" }, // row-level link
		{
			key: "items",
			type: "array",
			children: [
				{ key: "product", type: "table", table: "products" },
				{ key: "quantity", type: "number" },
			],
		},
	]);
	const [alpha, beta] = (await seed("products", [
		{ name: "Alpha", price: 100 },
		{ name: "Beta", price: 250 },
	])) as Row[];
	await seed("special", [
		{
			product: alpha.id, // row-level link
			items: [
				{ product: alpha.id, quantity: 2 },
				{ product: beta.id, quantity: 8 },
			],
		},
	]);

	// Bare `product` resolves to items.product (element predicate), not the row link.
	assert.equal(
		await inibase.sum("special", "items.quantity", { product: alpha.id }, { nested: true }),
		2,
	);
	assert.equal(
		await inibase.sum("special", "items.quantity", { product: beta.id }, { nested: true }),
		8,
	);
});

await test("Cleanup nested sum database", removeDatabase);