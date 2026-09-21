import { strict as assert } from "node:assert";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import Inibase, { type Schema } from "../src/index.js";

// Test database directory (kept separate from the main test suite database)
const dbPath = "test-db-advanced";
let inibase: Inibase;

function removeDatabase() {
	if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
}

function initializeDatabase() {
	removeDatabase();
	inibase = new Inibase(dbPath);
}

type Row = Record<string, any> & { id?: string | number };

/** Convenience: post rows and return the full posted data (including ids). */
async function seed(
	tableName: string,
	rows: Record<string, unknown>[],
): Promise<Row[] | null> {
	return inibase.post(tableName, rows, undefined, true) as Promise<Row[]>;
}

await test("Date fields normalize ISO calendar dates to timestamps", async () => {
	initializeDatabase();

	await inibase.createTable("dated", [{ key: "scheduledAt", type: "date" }]);
	const expected = Date.UTC(2026, 9, 1);
	const posted = (await inibase.post(
		"dated",
		{ scheduledAt: "2026-10-01" },
		undefined,
		true,
	)) as Row;

	assert.equal(posted.scheduledAt, expected);
	const rows = (await inibase.get<Row>("dated")) as Row[];
	assert.equal(rows[0].scheduledAt, expected);
});

await test("Advanced Criteria Queries (comparison operators)", async (t) => {
	initializeDatabase();

	const tableName = "people";
	const schema: Schema = [
		{ key: "name", type: "string", required: true },
		{ key: "age", type: "number", required: true },
		{ key: "active", type: "boolean", required: true },
		{ key: "tags", type: "array", required: true, children: "string" },
	];
	await inibase.createTable(tableName, schema);
	await seed(tableName, [
		{ name: "Alice", age: 25, active: true, tags: ["admin", "read"] },
		{ name: "Bob", age: 18, active: false, tags: ["write"] },
		{ name: "Charlie", age: 40, active: true, tags: ["read", "write"] },
		{ name: "Dana", age: 17, active: false, tags: ["guest"] },
		{ name: "Evan", age: 60, active: true, tags: ["admin"] },
		{ name: "Fiona", age: 30, active: false, tags: ["read", "moderator"] },
	]);

	const names = async (rows: Row[] | null) => rows?.map((r) => r.name);

	await t.test("greater than (>)", async () => {
		const rows = await inibase.get<Row>(tableName, { age: ">30" });
		assert.deepEqual(await names(rows), ["Charlie", "Evan"]);
	});

	await t.test("less than (<)", async () => {
		const rows = await inibase.get<Row>(tableName, { age: "<20" });
		assert.deepEqual(await names(rows), ["Bob", "Dana"]);
	});

	await t.test("greater or equal (>=)", async () => {
		const rows = await inibase.get<Row>(tableName, { age: ">=30" });
		assert.deepEqual(await names(rows), ["Charlie", "Evan", "Fiona"]);
	});

	await t.test("less or equal (<=)", async () => {
		const rows = await inibase.get<Row>(tableName, { age: "<=25" });
		assert.deepEqual(await names(rows), ["Alice", "Bob", "Dana"]);
	});

	await t.test("not equal (!=)", async () => {
		const rows = await inibase.get<Row>(tableName, { age: "!=25" });
		assert.equal(rows?.length, 5, "All rows except Alice should match");
		assert.ok(rows?.every((r) => r.age !== 25));
	});

	await t.test("equality on native numbers and booleans", async () => {
		const byNumber = await inibase.get<Row>(tableName, { age: 17 });
		assert.deepEqual(await names(byNumber), ["Dana"]);

		const byBool = await inibase.get<Row>(tableName, { active: true });
		assert.deepEqual(await names(byBool), ["Alice", "Charlie", "Evan"]);
	});

	await t.test("array contains ([])", async () => {
		const rows = await inibase.get<Row>(tableName, { tags: "[]read" });
		assert.deepEqual(await names(rows), ["Alice", "Charlie", "Fiona"]);
	});

	await t.test("array contains any of multiple values ([]a,b)", async () => {
		const rows = await inibase.get<Row>(tableName, { tags: "[]read,write" });
		assert.deepEqual(await names(rows), ["Alice", "Bob", "Charlie", "Fiona"]);
	});

	await t.test("array does not contain (![])", async () => {
		// When the compared value is a plain string and the field is scalar,
		// "![]x" behaves like "not equal to any of the given values".
		const table = "scalar_not_in";
		await inibase.createTable(table, [
			{ key: "fruit", type: "string" },
			{ key: "rating", type: "number" },
		]);
		await seed(table, [
			{ fruit: "banana", rating: 3 },
			{ fruit: "apple", rating: 5 },
			{ fruit: "cherry", rating: 4 },
			{ fruit: "mango", rating: 2 },
		]);
		const rows = await inibase.get<Row>(table, { fruit: "![]cherry" });
		assert.deepEqual(rows?.map((r) => r.fruit), ["banana", "apple", "mango"]);
	});

	await t.test("wildcard match (*)", async () => {
		const containsI = await inibase.get<Row>(tableName, { name: "*%i%" });
		assert.deepEqual(await names(containsI), [
			"Alice",
			"Charlie",
			"Fiona",
		]);

		const startWithCha = await inibase.get<Row>(tableName, { name: "*Cha%" });
		assert.deepEqual(await names(startWithCha), ["Charlie"]);

		const caseInsensitive = await inibase.get<Row>(tableName, {
			name: "*%aLiCe%",
		});
		assert.deepEqual(await names(caseInsensitive), ["Alice"]);
	});

	await t.test("no match returns null", async () => {
		const rows = await inibase.get<Row>(tableName, { name: "Ghost" });
		assert.equal(rows, null);
	});

	await t.test("empty criteria object/array returns the full page", async () => {
		const byObj = await inibase.get<Row>(tableName, {});
		assert.equal(byObj?.length, 6);

		const byArr = await inibase.get<Row>(tableName, []);
		assert.equal(byArr?.length, 6);
	});
});

await test("Advanced Criteria Queries (and / or logic)", async (t) => {
	initializeDatabase();

	const tableName = "people_logic";
	const schema: Schema = [
		{ key: "name", type: "string", required: true },
		{ key: "age", type: "number", required: true },
		{ key: "active", type: "boolean", required: true },
		{ key: "tags", type: "array", required: true, children: "string" },
	];
	await inibase.createTable(tableName, schema);
	await seed(tableName, [
		{ name: "Alice", age: 25, active: true, tags: ["admin", "read"] },
		{ name: "Bob", age: 18, active: false, tags: ["write"] },
		{ name: "Charlie", age: 40, active: true, tags: ["read", "write"] },
		{ name: "Dana", age: 17, active: false, tags: ["guest"] },
		{ name: "Evan", age: 60, active: true, tags: ["admin"] },
		{ name: "Fiona", age: 30, active: false, tags: ["read", "moderator"] },
	]);

	const names = async (rows: Row[] | null) => rows?.map((r) => r.name);

	await t.test("implicit AND between multiple fields", async () => {
		const rows = await inibase.get<Row>(tableName, {
			tags: "[]read",
			active: false,
		});
		assert.deepEqual(await names(rows), ["Fiona"]);
	});

	await t.test("explicit and {} block", async () => {
		const rows = await inibase.get<Row>(tableName, {
			and: { age: ">20", active: true },
		});
		assert.deepEqual(await names(rows), ["Alice", "Charlie", "Evan"]);
	});

	await t.test("explicit or {} block", async () => {
		const rows = await inibase.get<Row>(tableName, {
			or: { age: "<18", name: "Fiona" },
		});
		assert.deepEqual(await names(rows), ["Dana", "Fiona"]);
	});

	await t.test("nested and[] array-rule on one field", async () => {
		const rows = await inibase.get<Row>(tableName, {
			age: { and: [">20", "<35"] },
		});
		assert.deepEqual(await names(rows), ["Alice", "Fiona"]);
	});

	await t.test("nested or[] array-rule on one field", async () => {
		const rows = await inibase.get<Row>(tableName, {
			age: { or: [">50", "<18"] },
		});
		assert.deepEqual(await names(rows), ["Dana", "Evan"]);
	});

	await t.test("combined and/or with multiple criteria", async () => {
		const rows = await inibase.get<Row>(tableName, {
			or: { age: ">50", name: "Fiona" },
			active: true,
		});
		// active must be true AND (age > 50 OR name Fiona)
		// Evan(60, active) matches; Fiona(30, active=false) rejected.
		assert.deepEqual(await names(rows), ["Evan"]);
	});
});

await test("Pagination, pageInfo and onlyOne", async (t) => {
	initializeDatabase();

	const tableName = "logs";
	await inibase.createTable(tableName, [{ key: "msg", type: "string" }]);
	await seed(tableName, [...Array(25)].map((_, i) => ({ msg: `log-${i}` })));

	await t.test("pages return the expected slices", async () => {
		const page1 = await inibase.get<Row>(tableName, undefined, {
			page: 1,
			perPage: 10,
		});
		assert.equal(page1?.length, 10);
		assert.equal(page1?.[0].msg, "log-0");

		const page2 = await inibase.get<Row>(tableName, undefined, {
			page: 2,
			perPage: 10,
		});
		assert.equal(page2?.length, 10);
		assert.equal(page2?.[0].msg, "log-10");

		const page3 = await inibase.get<Row>(tableName, undefined, {
			page: 3,
			perPage: 10,
		});
		assert.equal(page3?.length, 5);
		assert.equal(page3?.at(-1)?.msg, "log-24");
	});

	await t.test("shared pageInfo reflects the last query", async () => {
		await inibase.get<Row>(tableName, undefined, { page: 2, perPage: 10 });
		assert.equal(inibase.pageInfo[tableName].total, 25);
		assert.equal(inibase.pageInfo[tableName].totalPages, 3);
		assert.equal(inibase.pageInfo[tableName].page, 2);
	});

	await t.test("page beyond the last one returns null", async () => {
		const page = await inibase.get<Row>(tableName, undefined, {
			page: 4,
			perPage: 10,
		});
		assert.equal(page, null);
	});

	await t.test("perPage -1 returns every record", async () => {
		const all = await inibase.get<Row>(tableName, undefined, { perPage: -1 });
		assert.equal(all?.length, 25);
	});

	await t.test("onlyOne returns a single object (not an array)", async () => {
		const row = await inibase.get<Row>(
			tableName,
			{ msg: "log-7" },
			undefined,
			true,
		);
		assert.ok(row && !Array.isArray(row));
		assert.equal(row.msg, "log-7");
	});

	await t.test("onlyOne with no match returns null", async () => {
		const row = await inibase.get<Row>(tableName, { msg: "nope" }, undefined, true);
		assert.equal(row, null);
	});

	await t.test("criteria queries are paginated too", async () => {
		// 25 records -> levels 1..25
		const cursorTable = "cursor_logs";
		await inibase.createTable(cursorTable, [{ key: "level", type: "number" }]);
		await seed(cursorTable, [...Array(25)].map((_, i) => ({ level: i + 1 })));

		const firstPage = await inibase.get<Row>(
			cursorTable,
			{ level: ">10" },
			{ page: 1, perPage: 7 },
		);
		assert.equal(firstPage?.length, 7);
		assert.equal(firstPage?.[0].level, 11);

		const lastPage = await inibase.get<Row>(
			cursorTable,
			{ level: ">10" },
			{ page: 3, perPage: 7 },
		);
		assert.equal(lastPage?.length, 1);
		assert.equal(lastPage?.[0].level, 25);
		assert.equal(inibase.pageInfo[cursorTable].total, 15);
		assert.equal(inibase.pageInfo[cursorTable].totalPages, 3);
	});
});

await test("Sorting (string, array and object forms)", async (t) => {
	initializeDatabase();

	const tableName = "sorter";
	const schema: Schema = [
		{ key: "name", type: "string" },
		{ key: "age", type: "number" },
	];
	await inibase.createTable(tableName, schema);
	await seed(tableName, [
		{ name: "Zoe", age: 25 },
		{ name: "Alice", age: 25 },
		{ name: "Bob", age: 40 },
		{ name: "Charlie", age: 18 },
		{ name: "Dana", age: 40 },
	]);

	const order: (rows: Row[] | null) => Row[] = (rows) =>
		(rows ?? []).map((r) => ({ name: r.name, age: r.age }));

	await t.test("sort by a numeric column ascending (string form)", async () => {
		const rows = await inibase.get<Row>(tableName, undefined, {
			sort: "age",
			perPage: -1,
		});
		assert.deepEqual(order(rows), [
			{ name: "Charlie", age: 18 },
			{ name: "Zoe", age: 25 },
			{ name: "Alice", age: 25 },
			{ name: "Bob", age: 40 },
			{ name: "Dana", age: 40 },
		]);
	});

	await t.test("sort descending via object form", async () => {
		const rows = await inibase.get<Row>(tableName, undefined, {
			sort: { age: "desc" },
			perPage: -1,
		});
		const ages = rows?.map((r) => r.age);
		assert.deepEqual(ages, [40, 40, 25, 25, 18]);
	});

	await t.test("multi-column sort via array form", async () => {
		const rows = await inibase.get<Row>(tableName, undefined, {
			sort: ["age", "name"],
			perPage: -1,
		});
		assert.deepEqual(order(rows), [
			{ name: "Charlie", age: 18 },
			{ name: "Alice", age: 25 },
			{ name: "Zoe", age: 25 },
			{ name: "Bob", age: 40 },
			{ name: "Dana", age: 40 },
		]);
	});

	await t.test("mixed object form (number and string directives)", async () => {
		const rows = await inibase.get<Row>(tableName, undefined, {
			sort: { age: 1, name: "asc" },
			perPage: -1,
		});
		assert.deepEqual(order(rows), [
			{ name: "Charlie", age: 18 },
			{ name: "Alice", age: 25 },
			{ name: "Zoe", age: 25 },
			{ name: "Bob", age: 40 },
			{ name: "Dana", age: 40 },
		]);
	});

	await t.test("sort by a string column", async () => {
		const rows = await inibase.get<Row>(tableName, undefined, {
			sort: "name",
			perPage: -1,
		});
		assert.deepEqual(rows?.map((r) => r.name), [
			"Alice",
			"Bob",
			"Charlie",
			"Dana",
			"Zoe",
		]);
	});

	await t.test("sort combined with criteria", async () => {
		const rows = await inibase.get<Row>(
			tableName,
			{ age: ">20" },
			{ sort: "age", perPage: -1 },
		);
		assert.deepEqual(rows?.map((r) => r.name), ["Zoe", "Alice", "Bob", "Dana"]);
	});

	await t.test("sort by explicit id keeps insertion order", async () => {
		const rows = await inibase.get<Row>(tableName, undefined, {
			sort: "id",
			perPage: -1,
		});
		assert.deepEqual(rows?.map((r) => r.name), [
			"Zoe",
			"Alice",
			"Bob",
			"Charlie",
			"Dana",
		]);
	});
});

await test("Columns projection (include, exclude, dotted paths)", async (t) => {
	initializeDatabase();

	const tableName = "profiles";
	const schema: Schema = [
		{ key: "name", type: "string" },
		{ key: "age", type: "number" },
		{
			key: "address",
			type: "object",
			children: [
				{ key: "street", type: "string" },
				{ key: "city", type: "string" },
			],
		},
		{ key: "tags", type: "array", children: "string" },
	];
	await inibase.createTable(tableName, schema);
	await seed(tableName, [
		{
			name: "John",
			age: 30,
			address: { street: "Main", city: "Springfield" },
			tags: ["a", "b"],
		},
		{
			name: "Jane",
			age: 25,
			address: { street: "Elm", city: "Shelbyville" },
			tags: ["c"],
		},
	]);

	await t.test("include a single column keeps only it + id", async () => {
		const rows = await inibase.get<Row>(tableName, undefined, {
			columns: ["name"],
		});
		assert.deepEqual(Object.keys(rows?.[0]).sort(), ["id", "name"]);
		assert.equal(rows?.[0].name, "John");
	});

	await t.test("columns accepts a plain string too", async () => {
		const rows = await inibase.get<Row>(tableName, undefined, {
			columns: "name",
		});
		assert.deepEqual(Object.keys(rows?.[0]).sort(), ["id", "name"]);
	});

	await t.test("exclude a column with '!'", async () => {
		const rows = await inibase.get<Row>(tableName, undefined, {
			columns: ["!age"],
		});
		assert.ok(rows?.[0]);
		assert.ok(!("age" in rows[0]));
		assert.ok("name" in rows[0] && "address" in rows[0]);
	});

	await t.test("dotted column path deep-filters nested objects", async () => {
		const rows = await inibase.get<Row>(tableName, undefined, {
			columns: ["address.city"],
		});
		assert.deepEqual(rows?.[0].address, { city: "Springfield" });
	});

	await t.test("requesting the parent object returns all children", async () => {
		const rows = await inibase.get<Row>(tableName, undefined, {
			columns: ["address"],
		});
		assert.deepEqual(rows?.[0].address, {
			street: "Main",
			city: "Springfield",
		});
	});

	await t.test("array column projection", async () => {
		const rows = await inibase.get<Row>(tableName, undefined, {
			columns: ["tags"],
		});
		assert.deepEqual(rows?.[0].tags, ["a", "b"]);
	});
});

await test("decodeID config (numeric IDs end to end)", async (t) => {
	initializeDatabase();

	const tableName = "decoded";
	await inibase.createTable(tableName, [{ key: "name", type: "string" }], {
		decodeID: true,
	});
	await seed(tableName, [{ name: "A" }, { name: "B" }, { name: "C" }]);

	await t.test("ids are returned as numbers", async () => {
		const rows = await inibase.get<Row>(tableName);
		assert.deepEqual(rows?.map((r) => r.id), [1, 2, 3]);
	});

	await t.test("fetch by numeric id", async () => {
		const row = await inibase.get<Row>(tableName, 2);
		assert.equal(row?.name, "B");
	});

	await t.test("update by numeric id", async () => {
		await inibase.put(tableName, { name: "B2" }, 2);
		const row = await inibase.get<Row>(tableName, 2);
		assert.equal(row?.name, "B2");
	});

	await t.test("update returns updated data", async () => {
		const row = await inibase.put(tableName, { name: "B3" }, 2, undefined, true);
		assert.equal((row as Row)?.name, "B3");
	});

	await t.test("delete by numeric id", async () => {
		await inibase.delete(tableName, 3);
		const rows = await inibase.get<Row>(tableName);
		assert.deepEqual(rows?.map((r) => r.id), [1, 2]);
	});

	await t.test("delete of non-existent ids is a no-op (does not wipe table)", async () => {
		assert.equal(await inibase.delete(tableName, 99), false);
		assert.equal(await inibase.delete(tableName, [98, 99]), false);
		const rows = await inibase.get<Row>(tableName);
		assert.deepEqual(rows?.map((r) => r.id), [1, 2]);
	});

	await t.test("relation lookups embed the referenced numeric id", async () => {
		const users = "authors_decoded";
		const posts = "posts_decoded";
		await inibase.createTable(
			users,
			[{ key: "first_name", type: "string" }],
			{ decodeID: true },
		);
		await inibase.createTable(posts, [
			{ key: "title", type: "string" },
			{ key: "user", type: "table", table: users },
		]);
		const created = (await inibase.post(users, { first_name: "Karim" }, undefined, true)) as Row;
		await inibase.post(posts, { title: "Hello", user: { id: created.id } });
		const allPosts = (await inibase.get<Row>(posts, undefined, {
			perPage: -1,
		})) as Row[];
		assert.equal(allPosts[0].user.id, created.id);
	});
});

await test("Cache config keeps criteria results fresh after writes", async (t) => {
	initializeDatabase();

	const tableName = "cached";
	const schema: Schema = [
		{ key: "name", type: "string" },
		{ key: "age", type: "number" },
	];
	await inibase.createTable(tableName, schema, { cache: true });

	await t.test("criteria queries create cache files", async () => {
		await seed(tableName, [
			{ name: "A", age: 1 },
			{ name: "B", age: 2 },
		]);
		await inibase.get<Row>(tableName, { age: ">0" });
		await inibase.get<Row>(tableName, { age: ">0" });
		const cacheDir = join(dbPath, tableName, ".cache");
		const entries = readdirSync(cacheDir);
		assert.ok(entries.length > 0, "cache should contain criterion result files");
	});

	await t.test("post clears the cache and keeps reads fresh", async () => {
		await inibase.post(tableName, { name: "C", age: 3 });
		const rows = await inibase.get<Row>(tableName, { age: ">0" });
		assert.equal(rows?.length, 3, "cache must be invalidated after post");
		const cacheDir = join(dbPath, tableName, ".cache");
		const entries = readdirSync(cacheDir);
		assert.ok(entries.length > 0, "a fresh cache file is written on read");
	});

	await t.test("put clears the cache and returns fresh data", async () => {
		await inibase.put(tableName, { name: "B2" }, { name: "B" });
		const rows = await inibase.get<Row>(tableName, { age: ">0" });
		assert.equal(rows?.length, 3);
		assert.ok(rows?.some((r) => r.name === "B2"));
	});

	await t.test("delete clears the cache too", async () => {
		await inibase.delete(tableName, { name: "C" });
		const rows = await inibase.get<Row>(tableName, { age: ">0" });
		assert.equal(rows?.length, 2);
	});
});

await test("updateTable schema migration preserves data", async (t) => {
	initializeDatabase();

	const tableName = "legacy";
	await inibase.createTable(tableName, [
		{ key: "name", type: "string" },
		{ key: "age", type: "number" },
	]);
	await seed(tableName, [
		{ name: "One", age: 1 },
		{ name: "Two", age: 2 },
	]);

	/** Returns the persisted schema without the auto-managed virtual fields. */
	const userSchema = async () => {
		const full = (await inibase.getTableSchema(tableName)) as Schema;
		return full.filter((f) => !["id", "createdAt", "updatedAt"].includes(f.key));
	};

	await t.test("adding a field keeps existing rows intact", async () => {
		const current = await userSchema();
		await inibase.updateTable(tableName, [
			...current,
			{ key: "email", type: "string" },
		]);
		const rows = (await inibase.get<Row>(tableName)) as Row[];
		assert.deepEqual(
			rows.map((r) => ({ name: r.name, age: r.age })),
			[
				{ name: "One", age: 1 },
				{ name: "Two", age: 2 },
			],
			"existing columns must survive the migration",
		);
		// Existing rows have no value yet for the brand-new column
		assert.equal(rows[0].email, undefined);

		const inserted = (await inibase.post(tableName, { name: "Three", age: 3, email: "three@x.com" }, undefined, true)) as Row;
		assert.equal(inserted.email, "three@x.com");
	});

	await t.test("removing a field drops its column", async () => {
		const current = await userSchema();
		const withoutAge = current.filter((f) => f.key !== "age");
		await inibase.updateTable(tableName, withoutAge);
		const rows = (await inibase.get<Row>(tableName)) as Row[];
		assert.equal(rows.length, 3);
		assert.ok(rows.every((r) => !("age" in r)), "age column should be gone");
		assert.ok(rows.every((r) => r.name), "name column should remain");
	});

	await t.test("metadata APIs reflect the migrated schema", async () => {
		const meta = await inibase.getTable(tableName);
		const keys = meta?.schema?.map((f) => f.key);
		assert.ok(keys?.includes("name"));
		assert.ok(keys?.includes("email"));
		assert.ok(!keys?.includes("age"));
		assert.deepEqual(meta?.config, {
			compression: false,
			cache: false,
			prepend: false,
			decodeID: false,
		});
	});
});

await test("updateTable config toggles", async (t) => {
	initializeDatabase();

	const tableName = "toggle_table";
	await inibase.createTable(tableName, [{ key: "data", type: "string" }]);
	await seed(tableName, [{ data: "hello" }, { data: "world" }]);

	await t.test("decodeID can be enabled after creation", async () => {
		await inibase.updateTable(tableName, undefined, { decodeID: true });
		const rows = (await inibase.get<Row>(tableName)) as Row[];
		assert.deepEqual(rows?.map((r) => r.id), [1, 2]);
	});

	await t.test("decodeID can be disabled again", async () => {
		await inibase.updateTable(tableName, undefined, { decodeID: false });
		const rows = (await inibase.get<Row>(tableName)) as Row[];
		assert.ok(rows?.[0]?.id);
		assert.equal(typeof rows?.[0]?.id, "string");
		assert.equal((rows?.[0]?.id as string).length, 32);
	});

	await t.test("cache can be toggled on", async () => {
		await inibase.updateTable(tableName, undefined, { cache: true });
		await inibase.get<Row>(tableName, { data: "hello" });
		const cacheDir = join(dbPath, tableName, ".cache");
		assert.ok(readdirSync(cacheDir).length > 0);
	});
});

await test("Field types: password, json, date, format types", async (t) => {
	initializeDatabase();

	await t.test("password values are hashed and comparable", async () => {
		const tableName = "auth";
		await inibase.createTable(tableName, [
			{ key: "username", type: "string" },
			{ key: "pwd", type: "password" },
		]);
		await inibase.post(tableName, { username: "joe", pwd: "secret123" });

		const rows = (await inibase.get<Row>(tableName)) as Row[];
		assert.match(rows[0].pwd, /^[0-9a-f]{32}:[0-9a-f]{64}$/);

		const byPlain = await inibase.get<Row>(tableName, { pwd: "secret123" });
		assert.deepEqual(byPlain?.map((r) => r.username), ["joe"]);

		const wrong = await inibase.get<Row>(tableName, { pwd: "guess" });
		assert.equal(wrong, null);

		await inibase.put(tableName, { pwd: "newpass" }, { username: "joe" });
		const updated = await inibase.get<Row>(tableName, { pwd: "newpass" });
		assert.equal(updated?.length, 1);
	});

	await t.test("json values round-trip", async () => {
		const tableName = "jsontable";
		await inibase.createTable(tableName, [{ key: "data", type: "json" }]);
		await inibase.post(tableName, { data: [1, 2, 3] });
		const rows = (await inibase.get<Row>(tableName)) as Row[];
		assert.deepEqual(rows[0].data, [1, 2, 3]);

		await inibase.post(tableName, { data: { nested: { ok: true } } });
		const all = (await inibase.get<Row>(tableName, undefined, {
			perPage: -1,
		})) as Row[];
		const second = all.find((r) => Array.isArray(r.data) === false);
		assert.deepEqual(second.data, { nested: { ok: true } });
	});

	await t.test("email/url/ip/html fields accept valid input", async () => {
		const tableName = "typed";
		await inibase.createTable(tableName, [
			{ key: "email", type: "email" },
			{ key: "url", type: "url" },
			{ key: "ip", type: "ip" },
			{ key: "html", type: "html" },
		]);
		await inibase.post(tableName, {
			email: "a@b.com",
			url: "https://example.com",
			ip: "8.8.8.8",
			html: "<p>hi</p>",
		});
		const rows = (await inibase.get<Row>(tableName)) as Row[];
		assert.equal(rows[0].email, "a@b.com");
		assert.equal(rows[0].url, "https://example.com");
		assert.equal(rows[0].ip, "8.8.8.8");
	});

	await t.test("email/url/ip/html fields reject invalid input", async () => {
		const tableName = "typed2";
		await inibase.createTable(tableName, [
			{ key: "email", type: "email" },
			{ key: "url", type: "url" },
			{ key: "ip", type: "ip" },
			{ key: "html", type: "html" },
		]);
		await assert.rejects(
			inibase.post(tableName, {
				email: "not-an-email",
				url: "https://example.com",
				ip: "8.8.8.8",
				html: "<p>hi</p>",
			}),
			/INVALID_TYPE/,
		);
		await assert.rejects(
			inibase.post(tableName, {
				email: "a@b.com",
				url: "not-a-url",
				ip: "8.8.8.8",
				html: "<p>hi</p>",
			}),
			/INVALID_TYPE/,
		);
		await assert.rejects(
			inibase.post(tableName, {
				email: "a@b.com",
				url: "https://example.com",
				ip: "999.999.999.999",
				html: "<p>hi</p>",
			}),
			/INVALID_TYPE/,
		);
		await assert.rejects(
			inibase.post(tableName, {
				email: "a@b.com",
				url: "https://example.com",
				ip: "8.8.8.8",
				html: "plain text without tags",
			}),
			/INVALID_TYPE/,
		);
	});

	await t.test("default values are applied for missing optional fields", async () => {
		const tableName = "defaults";
		await inibase.createTable(tableName, [
			{ key: "a", type: "string" },
			{ key: "b", type: "number" },
			{ key: "c", type: "boolean" },
		]);
		await inibase.post(tableName, { a: "only" });
		const rows = (await inibase.get<Row>(tableName)) as Row[];
		assert.equal(rows[0].a, "only");
		assert.equal(rows[0].b, 0);
		assert.equal(rows[0].c, false);
	});
});

await test("Advanced relationships (criteria, joins, cascade)", async (t) => {
	initializeDatabase();

	const authors = "authors_rel";
	const posts = "posts_rel";
	await inibase.createTable(authors, [
		{ key: "first_name", type: "string" },
		{ key: "country", type: "string" },
	]);
	await inibase.createTable(posts, [
		{ key: "title", type: "string" },
		{ key: "author", type: "table", table: authors },
	]);

	const alice = (await inibase.post(authors, { first_name: "Alice", country: "USA" }, undefined, true)) as Row;
	const bob = (await inibase.post(authors, { first_name: "Bob", country: "MA" }, undefined, true)) as Row;
	await inibase.post(posts, [
		{ title: "P1", author: { id: alice.id } },
		{ title: "P2", author: { id: bob.id } },
		{ title: "P3", author: { id: alice.id } },
	]);

	await t.test("query posts through a related-table criterion", async () => {
		const rows = await inibase.get<Row>(posts, {
			author: { country: "USA" },
		});
		assert.deepEqual(rows?.map((r) => r.title), ["P1", "P3"]);
	});

	await t.test("or/and logic with relation criteria", async () => {
		const rows = await inibase.get<Row>(posts, {
			or: { author: { country: "MA" }, title: "P3" },
		});
		assert.deepEqual(rows?.map((r) => r.title), ["P2", "P3"]);
	});

	await t.test("related records are denormalized into the result", async () => {
		const rows = (await inibase.get<Row>(posts, { title: "P2" })) as Row[];
		assert.equal(rows[0].author.id, bob.id);
	});

	await t.test("cascade delete removes related rows", async () => {
		await inibase.delete(authors, { id: alice.id });
		const remaining = await inibase.get<Row>(posts, undefined, { perPage: -1 });
		assert.deepEqual(remaining?.map((r) => r.title), ["P2"]);
	});

	await t.test("cascade delete reaches nested related tables", async () => {
		const a2 = "authors_casc2";
		const p2 = "posts_casc2";
		const c2 = "comments_casc2";
		await inibase.createTable(a2, [
			{ key: "first_name", type: "string" },
			{ key: "country", type: "string" },
		]);
		await inibase.createTable(p2, [
			{ key: "title", type: "string" },
			{ key: "author", type: "table", table: a2 },
		]);
		await inibase.createTable(c2, [
			{ key: "text", type: "string" },
			{ key: "post", type: "table", table: p2 },
		]);

		const alice2 = (await inibase.post(a2, { first_name: "Alice", country: "USA" }, undefined, true)) as Row;
		const bob2 = (await inibase.post(a2, { first_name: "Bob", country: "MA" }, undefined, true)) as Row;
		const p1 = (await inibase.post(p2, { title: "P1", author: { id: alice2.id } }, undefined, true)) as Row;
		const p2row = (await inibase.post(p2, { title: "P2", author: { id: bob2.id } }, undefined, true)) as Row;
		await inibase.post(c2, [
			{ text: "C1", post: { id: p1.id } },
			{ text: "C2", post: { id: p1.id } },
			{ text: "C3", post: { id: p2row.id } },
		]);

		await inibase.delete(a2, { id: alice2.id });

		const restPosts = await inibase.get<Row>(p2, undefined, { perPage: -1 });
		assert.deepEqual(restPosts?.map((r) => r.title), ["P2"]);
		const restComments = await inibase.get<Row>(c2, undefined, { perPage: -1 });
		assert.deepEqual(restComments?.map((r) => r.text), ["C3"]);
	});

	await t.test("cascade delete follows criteria matching multiple rows", async () => {
		const a3 = "authors_casc3";
		const p3 = "posts_casc3";
		await inibase.createTable(a3, [
			{ key: "name", type: "string" },
			{ key: "country", type: "string" },
		]);
		await inibase.createTable(p3, [
			{ key: "title", type: "string" },
			{ key: "author", type: "table", table: a3 },
		]);
		const a = (await inibase.post(a3, { name: "PA", country: "US" }, undefined, true)) as Row;
		const b = (await inibase.post(a3, { name: "PB", country: "US" }, undefined, true)) as Row;
		const c = (await inibase.post(a3, { name: "PC", country: "FR" }, undefined, true)) as Row;
		await inibase.post(p3, [
			{ title: "X1", author: { id: a.id } },
			{ title: "X2", author: { id: b.id } },
			{ title: "X3", author: { id: c.id } },
		]);

		await inibase.delete(a3, { country: "US" });

		const rest = await inibase.get<Row>(p3, undefined, { perPage: -1 });
		assert.deepEqual(rest?.map((r) => r.title), ["X3"]);
	});

	await t.test("delete all rows cascades to related rows", async () => {
		const a4 = "authors_casc4";
		const p4 = "posts_casc4";
		await inibase.createTable(a4, [{ key: "name", type: "string" }]);
		await inibase.createTable(p4, [
			{ key: "title", type: "string" },
			{ key: "author", type: "table", table: a4 },
		]);
		const row = (await inibase.post(a4, { name: "A4" }, undefined, true)) as Row;
		await inibase.post(p4, { title: "Y1", author: { id: row.id } });

		assert.equal(await inibase.delete(a4), true);

		const restPosts = await inibase.get<Row>(p4, undefined, { perPage: -1 });
		assert.ok(!restPosts?.length);
	});
});

await test("Deeply nested array/object trees", async (t) => {
	initializeDatabase();

	const tableName = "deep_tree";
	const schema: Schema = [
		{
			key: "root",
			type: "object",
			children: [
				{ key: "title", type: "string" },
				{
					key: "branches",
					type: "array",
					children: [
						{
							key: "label",
							type: "string",
						},
						{
							key: "leaves",
							type: "array",
							children: [
								{ key: "color", type: "string" },
								{ key: "size", type: "number" },
							],
						},
					],
				},
			],
		},
	];
	await inibase.createTable(tableName, schema);
	await seed(tableName, [
		{
			root: {
				title: "Tree A",
				branches: [
					{
						label: "b1",
						leaves: [
							{ color: "red", size: 10 },
							{ color: "green", size: 5 },
						],
					},
					{
						label: "b2",
						leaves: [{ color: "blue", size: 20 }],
					},
				],
			},
		},
		{
			root: {
				title: "Tree B",
				branches: [
					{
						label: "b3",
						leaves: [{ color: "yellow", size: 100 }],
					},
				],
			},
		},
	]);

	await t.test("whole tree round-trips", async () => {
		const rows = (await inibase.get<Row>(tableName)) as Row[];
		assert.equal(rows.length, 2);
		assert.equal(rows[0].root.title, "Tree A");
		assert.equal(rows[0].root.branches.length, 2);
		assert.deepEqual(rows[0].root.branches[0].leaves, [
			{ color: "red", size: 10 },
			{ color: "green", size: 5 },
		]);
	});

	await t.test("dot-path criteria reaches array children", async () => {
		const rows = await inibase.get<Row>(tableName, { "root.title": "Tree B" });
		assert.deepEqual(rows?.map((r) => r.root.title), ["Tree B"]);

		const leaves = await inibase.get<Row>(tableName, {
			"root.branches.label": "b2",
		});
		assert.deepEqual(leaves?.map((r) => r.root.title), ["Tree A"]);
	});

	await t.test("update merges into nested tree data", async () => {
		await inibase.put(
			tableName,
			{
				root: {
					branches: [{ label: "b1", leaves: [{ size: 999 }] }],
				},
			},
			{ "root.title": "Tree A" },
		);
		const rows = (await inibase.get<Row>(tableName, { "root.title": "Tree A" })) as Row[];
		assert.equal(rows[0].root.branches[0].label, "b1");
		assert.equal(rows[0].root.branches[0].leaves[0].size, 999);
	});
});

await test("sum / avg / max / min with criteria and multiple columns", async (t) => {
	initializeDatabase();

	const tableName = "stats";
	await inibase.createTable(tableName, [
		{ key: "score", type: "number" },
		{ key: "level", type: "number" },
		{ key: "grp", type: "string" },
	]);
	await seed(tableName, [
		{ score: 10, level: 1, grp: "a" },
		{ score: 20, level: 2, grp: "a" },
		{ score: 30, level: 3, grp: "b" },
		{ score: 40, level: 4, grp: "b" },
	]);

	await t.test("sum of a single column is a number", async () => {
		assert.equal(await inibase.sum(tableName, "score"), 100);
	});

	await t.test("sum of multiple columns is a record", async () => {
		assert.deepEqual(await inibase.sum(tableName, ["score", "level"]), {
			score: 100,
			level: 10,
		});
	});

	await t.test("sum respects criteria", async () => {
		assert.equal(await inibase.sum(tableName, "score", { grp: "a" }), 30);
		assert.equal(await inibase.sum(tableName, "level", { grp: "b" }), 7);
	});

	await t.test("avg returns numbers and respects criteria", async () => {
		assert.equal(await inibase.avg(tableName, "score"), 25);
		assert.deepEqual(await inibase.avg(tableName, ["score", "level"]), {
			score: 25,
			level: 2.5,
		});
		assert.equal(await inibase.avg(tableName, "score", { grp: "a" }), 15);
	});

	await t.test("max/min return records even for one column", async () => {
		assert.deepEqual(await inibase.max(tableName, "score"), { score: 40 });
		assert.deepEqual(await inibase.min(tableName, "score"), { score: 10 });
	});

	await t.test("max/min with criteria", async () => {
		assert.deepEqual(await inibase.max(tableName, "score", { grp: "a" }), {
			score: 20,
		});
		assert.deepEqual(await inibase.min(tableName, "score", { grp: "b" }), {
			score: 30,
		});
	});
});

await test("Public validateData API", async (t) => {
	initializeDatabase();

	const schema: Schema = [
		{ key: "name", type: "string", required: true },
		{ key: "count", type: "number" },
		{
			key: "meta",
			type: "object",
			required: true,
			children: [{ key: "deep", type: "string", required: true }],
		},
	];

	await t.test("accepts valid data (single and array)", () => {
		assert.doesNotThrow(() =>
			inibase.validateData(
				{ name: "x", count: 1, meta: { deep: "ok" } },
				schema,
			),
		);
		assert.doesNotThrow(() =>
			inibase.validateData(
				[
					{ name: "x", count: 1, meta: { deep: "ok" } },
					{ name: "y", meta: { deep: "ok" } },
				],
				schema,
			),
		);
	});

	await t.test("rejects missing required fields", () => {
		assert.throws(
			() => inibase.validateData({ name: "x" }, schema),
			{ name: "FIELD_REQUIRED" },
		);
		assert.throws(
			() =>
				inibase.validateData(
					{ name: "x", count: 1, meta: {} },
					schema,
				),
			{ name: "FIELD_REQUIRED" },
		);
	});

	await t.test("rejects wrong types at any nesting depth", () => {
		assert.throws(
			() => inibase.validateData({ name: 123, meta: { deep: "ok" } }, schema),
			{ name: "INVALID_TYPE" },
		);
		assert.throws(
			() =>
				inibase.validateData(
					{ name: "x", meta: { deep: 456 } },
					schema,
				),
			{ name: "INVALID_TYPE" },
		);
	});

	await t.test("skipRequiredField bypasses required checks", () => {
		assert.doesNotThrow(() =>
			inibase.validateData({ count: 1 }, schema, true),
		);
	});
});

await test("Error handling coverage", async (t) => {
	initializeDatabase();

	await t.test("TABLE_EXISTS is thrown for duplicate tables", async () => {
		await inibase.createTable("dup", [{ key: "x", type: "string" }]);
		await assert.rejects(
			inibase.createTable("dup", [{ key: "x", type: "string" }]),
			{ name: "TABLE_EXISTS" },
		);
	});

	await t.test("TABLE_NOT_EXISTS for getTable on a missing table", async () => {
		await assert.rejects(inibase.getTable("ghost"), { name: "TABLE_NOT_EXISTS" });
	});

	await t.test("NO_SCHEMA for a table created without a schema", async () => {
		await inibase.createTable("noschema");
		await assert.rejects(inibase.get("noschema"), { name: "NO_SCHEMA" });
	});

	await t.test("TABLE_EMPTY for put/delete/sum/avg/max/min", async () => {
		await inibase.createTable("empty", [{ key: "x", type: "string" }]);
		await assert.rejects(inibase.put("empty", { x: "a" }), {
			name: "TABLE_EMPTY",
		});
		await assert.rejects(inibase.delete("empty", { x: "a" }), {
			name: "TABLE_EMPTY",
		});
		await assert.rejects(inibase.sum("empty", "x"), { name: "TABLE_EMPTY" });
		await assert.rejects(inibase.avg("empty", "x"), { name: "TABLE_EMPTY" });
		await assert.rejects(inibase.max("empty", "x"), { name: "TABLE_EMPTY" });
		await assert.rejects(inibase.min("empty", "x"), { name: "TABLE_EMPTY" });
	});

	await t.test("INVALID_ID when bulk put data lacks valid ids", async () => {
		await inibase.createTable("bulk_invalid", [{ key: "v", type: "string" }]);
		await seed("bulk_invalid", [{ v: "a" }, { v: "b" }]);
		await assert.rejects(
			inibase.put("bulk_invalid", [{ v: "x" }, { v: "y" }], undefined, undefined, true),
			{ name: "INVALID_ID" },
		);
	});
});

await test("Bulk operations (post/put/delete with arrays)", async (t) => {
	initializeDatabase();

	const tableName = "bulk";
	await inibase.createTable(tableName, [
		{ key: "name", type: "string" },
		{ key: "v", type: "number" },
	]);
	const ids = (await inibase.post(tableName, [
		{ name: "x1", v: 1 },
		{ name: "x2", v: 2 },
		{ name: "x3", v: 3 },
		{ name: "x4", v: 4 },
	])) as string[];

	await t.test("bulk post returns one id per record", () => {
		assert.equal(ids.length, 4);
		for (const id of ids) assert.equal(typeof id, "string");
	});

	await t.test("bulk put by id array with data array", async () => {
		await inibase.put(
			tableName,
			[
				{ id: ids[0], name: "x1b" },
				{ id: ids[3], name: "x4b" },
			],
			undefined,
			undefined,
			true,
		);
		const rows = (await inibase.get<Row>(tableName, undefined, {
			perPage: -1,
		})) as Row[];
		assert.deepEqual(rows.map((r) => r.name), ["x1b", "x2", "x3", "x4b"]);
	});

	await t.test("bulk delete by id array", async () => {
		await inibase.delete(tableName, [ids[1], ids[2]]);
		const rows = await inibase.get<Row>(tableName, undefined, { perPage: -1 });
		assert.deepEqual(rows?.map((r) => r.name), ["x1b", "x4b"]);
	});

	await t.test("put with no where updates every record", async () => {
		await inibase.put(tableName, { v: 99 });
		const rows = (await inibase.get<Row>(tableName, undefined, {
			perPage: -1,
		})) as Row[];
		assert.ok(rows.every((r) => r.v === 99));
	});

	await t.test("put with a criteria that matches nothing is a no-op", async () => {
		await inibase.put(tableName, { name: "zzz" }, { name: "missing" });
		const rows = (await inibase.get<Row>(tableName, undefined, {
			perPage: -1,
		})) as Row[];
		assert.ok(rows.every((r) => r.name !== "zzz"));
	});

	await t.test("row metadata timestamps are maintained", async () => {
		const single = (await inibase.post(tableName, { name: "fresh", v: 1 }, undefined, true)) as Row;
		assert.ok(typeof single.createdAt === "number");
		assert.equal(single.updatedAt, undefined);

		const updated = (await inibase.put(
			tableName,
			{ name: "fresh2" },
			{ name: "fresh" },
			undefined,
			true,
		)) as Row[];
		// put returns an array of rows; the updated row's timestamp is on [0]
		assert.ok(typeof updated?.[0]?.updatedAt === "number");
	});
});

await test("Decode resilience for `{`/`[`-leading string values", async (t) => {
	initializeDatabase();

	// Mirrors a production incident: a template page whose SEO title is a
	// `{{item.<column>}}` binding such as `{{item.username}} Page`. The stored
	// value *starts with* `{`, which inibase treats as "stringified" data. When
	// the text is not valid Inison, decoding used to throw `Expected ":" after
	// key` and break reads of the whole table. decode() now falls back to the
	// plain string for such unparseable values.
	const pagesTable = "pages_decode";
	const schema: Schema = [
		{ key: "slug", type: "string", required: true },
		{
			key: "seo",
			type: "object",
			children: [
				{ key: "title", type: "string" },
				{ key: "description", type: "string" },
			],
		},
		{ key: "content", type: "array", children: "string" },
	];
	await inibase.createTable(pagesTable, schema);
	await seed(pagesTable, [
		{ slug: "/", seo: { title: "HomePage" }, content: ["home"] },
		{ slug: "form", seo: { title: "formPage" }, content: ["form"] },
		{
			slug: "users/[id]",
			seo: {
				// Brace-leading, unparseable (the production case).
				title: "{{item.username}} Page",
				// Bracket-leading counterpart that also fails parsing.
				description: "[a,{b]",
			},
			content: ["the-template-block"],
		},
	]);

	await t.test("whole-table listing does not throw and returns every row", async () => {
		const rows = await inibase.get<Row>(pagesTable, undefined, { perPage: -1 });
		assert.equal(rows?.length, 3);
		assert.deepEqual(rows?.map((r) => r.slug), ["/", "form", "users/[id]"]);
	});

	await t.test("unparseable brace/bracket values read back verbatim", async () => {
		const rows = await inibase.get<Row>(
			pagesTable,
			{ slug: "users/[id]" },
			{ perPage: -1 },
		);
		const row = rows?.[0];
		assert.ok(row);
		assert.equal(row.seo?.title, "{{item.username}} Page");
		assert.equal(row.seo?.description, "[a,{b]");
	});

	await t.test("criteria lookups for unaffected rows still work", async () => {
		const rows = await inibase.get<Row>(pagesTable, { slug: "/" }, { perPage: -1 });
		assert.equal(rows?.[0]?.seo?.title, "HomePage");
	});

	await t.test("reading the row by id decodes safely", async () => {
		const all = await inibase.get<Row>(pagesTable, undefined, { perPage: -1 });
		const bad = all?.find((r) => r.slug === "users/[id]");
		assert.ok(bad);
		const byId = await inibase.get<Row>(pagesTable, { id: bad.id }, { perPage: -1 });
		assert.equal(byId?.[0]?.seo?.title, "{{item.username}} Page");
	});

	await t.test("update round-trips the literal binding", async () => {
		const updated = (await inibase.put(
			pagesTable,
			{ seo: { title: "{{item.username}} Page", description: "updated desc" } },
			{ slug: "users/[id]" },
			undefined,
			true,
		)) as Row[];
		assert.equal(updated?.[0]?.seo?.title, "{{item.username}} Page");
		assert.equal(updated?.[0]?.seo?.description, "updated desc");
	});

	await t.test("delete of the row with a bracket-bearing slug works", async () => {
		const rows = await inibase.get<Row>(pagesTable, undefined, { perPage: -1 });
		const bad = rows?.find((r) => r.slug === "users/[id]");
		assert.ok(bad);
		await inibase.delete(pagesTable, [bad.id]);
		const remaining = await inibase.get<Row>(pagesTable, undefined, { perPage: -1 });
		assert.equal(remaining?.length, 2);
	});

	await t.test("number/boolean/json/array columns decode normally with a bad string", async () => {
		const typed = "typed_decode";
		await inibase.createTable(typed, [
			{ key: "label", type: "string" },
			{ key: "count", type: "number" },
			{ key: "active", type: "boolean" },
			{ key: "tags", type: "array", children: "string" },
			{ key: "config", type: "json" },
		]);
		await seed(typed, [
			{
				label: "{{item.username}}",
				count: 42,
				active: true,
				tags: ["a", "b"],
				config: { table: "users", segments: {} },
			},
			// Brace tokens inside an array of strings round-trip untouched.
			{ label: "plain", tags: ["plain", "{{item.username}}"] },
		]);
		const rows = await inibase.get<Row>(typed, undefined, { perPage: -1 });
		assert.ok(rows);
		assert.equal(rows.length, 2);
		const r0 = rows[0];
		assert.equal(r0.label, "{{item.username}}");
		assert.equal(r0.count, 42);
		assert.equal(r0.active, true);
		assert.deepEqual(r0.tags, ["a", "b"]);
		assert.deepEqual(r0.config, { table: "users", segments: {} });
		assert.equal(rows[1].label, "plain");
		assert.deepEqual(rows[1].tags, ["plain", "{{item.username}}"]);
	});

	// Boundary: a bracket-leading string that IS valid Inison (autoCorrect can
	// close it) does not fail parsing, so no fallback applies — it decodes as
	// an array. Only genuinely unparseable values fall back to the string.
	await t.test("a parseable `[`-leading string decodes as an array", async () => {
		const tbl = "bracket_boundary";
		await inibase.createTable(tbl, [{ key: "text", type: "string" }]);
		await seed(tbl, [{ text: "[not a real array" }]);
		const rows = await inibase.get<Row>(tbl, undefined, { perPage: -1 });
		assert.deepEqual(rows?.[0]?.text, ["not a real array"]);
	});
});

await test("Computed fields (v1 id-only expression language)", async (t) => {
	initializeDatabase();

	/** Round-trips the persisted schema (ids + computed specs). */
	const userSchema = async (tableName: string) => {
		const full = (await inibase.getTableSchema(tableName)) as Schema;
		return full.filter((f) => !["id", "createdAt", "updatedAt"].includes(f.key));
	};

	await t.test("order totals: quantity x unit price and linked product price", async () => {
		await inibase.createTable("c_product", [
			{ key: "name", type: "string" },
			{ key: "price", type: "number" },
		]);
		await inibase.createTable("c_orders", [
			{ key: "customer", type: "string" },
			{ key: "status", type: "number" },
			{
				key: "items",
				type: "array",
				children: [
					{ key: "product", type: "table", table: "c_product" },
					{ key: "quantity", type: "number" },
					{ key: "unitPriceCents", type: "number" },
				],
			},
			// ids: customer=1, status=2, items=3, product=4, quantity=5,
			// unitPriceCents=6, totalCents=7, totalCentsLive=8
			{ key: "totalCents", type: "number", computed: "sum(5, 6)" },
			{ key: "totalCentsLive", type: "number", computed: "sum(5, 4.2)" },
		]);

		const p1 = (await inibase.post("c_product", { name: "widget", price: 199 }, undefined, true)) as Row;
		const p2 = (await inibase.post("c_product", { name: "gadget", price: 449 }, undefined, true)) as Row;
		const order = (await inibase.post(
			"c_orders",
			{
				customer: "acme",
				status: 1,
				items: [
					{ product: p1.id, quantity: 2, unitPriceCents: 250 },
					{ product: p2.id, quantity: 1, unitPriceCents: 100 },
				],
			},
			undefined,
			true,
		)) as Row;
		assert.equal(order.totalCents, 600, "2*250 + 1*100");
		assert.equal(order.totalCentsLive, 847, "2*199 + 1*449 via link hop");

		// stored computed columns survive a reload-as-read
		const fetched = (await inibase.get("c_orders", order.id)) as Row;
		assert.equal(fetched.totalCents, 600);
		assert.equal(fetched.totalCentsLive, 847);
	});

	await t.test("batched link hops: bulk posts share one read per distinct linked row", async () => {
		await inibase.createTable("b_product", [
			{ key: "name", type: "string" },
			{ key: "price", type: "number" },
		]);
		await inibase.createTable("b_orders", [
			{ key: "customer", type: "string" },
			{
				key: "items",
				type: "array",
				children: [
					{ key: "product", type: "table", table: "b_product" },
					{ key: "quantity", type: "number" },
				],
			},
			// ids: customer=1, items=2, product=3, quantity=4, total=5
			{ key: "total", type: "number", computed: "sum(4, 3.2)" },
		]);

		// Shared catalog: every order below links back to these few rows, so
		// the batched reader resolves each (table, column, id) once instead of
		// once per line item.
		const catalog = (await seed("b_product", [
			{ name: "p1", price: 100 },
			{ name: "p2", price: 300 },
			{ name: "p3", price: 500 },
		])) as Row[];
		const orderCount = 24;
		const row = (i: number) => ({
			customer: `c${i}`,
			items: [
				{ product: catalog[i % 3].id, quantity: 2 },
				{ product: catalog[(i + 1) % 3].id, quantity: 1 },
			],
		});
		const posted = (await inibase.post(
			"b_orders",
			[...Array(orderCount)].map((_, i) => row(i)),
			{ perPage: -1 },
			true,
		)) as Row[];
		assert.equal(posted.length, orderCount);
		for (let i = 0; i < posted.length; i++) {
			const a = catalog[i % 3].price as number;
			const b = catalog[(i + 1) % 3].price as number;
			assert.equal(posted[i].total, 2 * a + 1 * b, `row ${i} total via shared links`);
		}

		// Where-less put recomputes the whole batch through the same path.
		await inibase.put("b_orders", {
			items: [{ product: catalog[2].id, quantity: 5 }],
		});
		const reread = (await inibase.get<Row>("b_orders", undefined, {
			perPage: -1,
		})) as Row[];
		assert.equal(reread.length, orderCount);
		for (const r of reread)
			assert.equal(r.total, 5 * (catalog[2].price as number), "recomputed after where-less put");

		// A dangling link anywhere in a bulk post still rejects evaluation.
		await assert.rejects(
			() =>
				inibase.post(
					"b_orders",
					[
						{ customer: "ok", items: [{ product: catalog[0].id, quantity: 1 }] },
						{ customer: "dangling", items: [{ product: 42424242, quantity: 1 }] },
					],
					{ perPage: -1 },
					true,
				),
			(error: unknown) =>
				(error as Error).name === "COMPUTED_FIELD_DANGLING_LINK",
		);
	});

	await t.test("rename-proof: renaming a linked key does not retarget expressions", async () => {
		// rename c_product.price -> priceCents through a schema round-trip
		const productSchema = await userSchema("c_product");
		await inibase.updateTable(
			"c_product",
			productSchema.map((f) => (f.key === "price" ? { ...f, key: "priceCents" } : f)),
		);
		const order = (await inibase.get<Row>("c_orders")) as Row[];
		assert.deepEqual(
			order.map((r) => [r.totalCents, r.totalCentsLive]),
			[[600, 847]],
			"totals must be unchanged after the rename",
		);
	});

	await t.test("bulk post computes every row; put recomputes by id, criteria and no-where", async () => {
		await inibase.createTable("c_put", [
			{ key: "qty", type: "number" },
			{ key: "price", type: "number" },
			{ key: "total", type: "number", computed: "1, 2" },
		]);
		await seed("c_put", [
			{ qty: 1, price: 10 },
			{ qty: 2, price: 20 },
			{ qty: 3, price: 30 },
		]);
		const totals = (rows: Row[] | null) => rows?.map((r) => r.total);
		assert.deepEqual(totals(await inibase.get<Row>("c_put")), [10, 40, 90]);

		const first = (await inibase.get<Row>("c_put")) as Row[];
		await inibase.put("c_put", { qty: 7 }, first[0].id);
		assert.deepEqual(totals(await inibase.get<Row>("c_put")), [70, 40, 90]);

		await inibase.put("c_put", { qty: 9 }, { price: 30 });
		assert.deepEqual(totals(await inibase.get<Row>("c_put")), [70, 40, 270]);

		await inibase.put("c_put", { price: 100 });
		assert.deepEqual(totals(await inibase.get<Row>("c_put")), [700, 200, 900]);
	});

	await t.test("helpers: empty array sums to 0; avg over none is an arithmetic error", async () => {
		// ids: name=1, items=2, n=3, total=4, avg=5, count=6 — helpers reference
		// the child id (n=3), never the container (items=2)
		await inibase.createTable("c_agg", [
			{ key: "name", type: "string" },
			{ key: "items", type: "array", children: [{ key: "n", type: "number" }] },
			{ key: "total", type: "number", computed: "sum(3)" },
			{ key: "count", type: "number", computed: "count(3)" },
		]);
		const withItems = (await inibase.post(
			"c_agg",
			{ name: "x", items: [{ n: 4 }, { n: 6 }] },
			undefined,
			true,
		)) as Row;
		assert.equal(withItems.total, 10);
		assert.equal(withItems.count, 2);

		const empty = (await inibase.post("c_agg", { name: "y" }, undefined, true)) as Row;
		assert.equal(empty.total, 0, "sum over no values is 0");
		assert.equal(empty.count, 0);

		// avg over no values is an arithmetic error
		await inibase.createTable("c_agg2", [
			{ key: "items", type: "array", children: [{ key: "n", type: "number" }] },
			{ key: "avg", type: "number", computed: "avg(2)" },
		]);
		await assert.rejects(
			() => inibase.post("c_agg2", { items: [] }),
			(error: unknown) =>
				(error as Error).name === "COMPUTED_FIELD_ARITHMETIC",
		);
	});

	await t.test("links: missing link value stores empty, dangling link throws", async () => {
		await inibase.createTable("c_owner", [{ key: "name", type: "string" }]);
		await inibase.createTable("c_ledger", [
			{ key: "owner", type: "table", table: "c_owner" },
			{ key: "ownerName", type: "string", computed: "1.1" },
		]);

		// no owner: a single bare path may evaluate to null (stored empty)
		const bare = (await inibase.post("c_ledger", {}, undefined, true)) as Row;
		assert.ok(!("ownerName" in bare), "missing link value stays empty");

		// dangling link: owner points at a row that does not exist
		await assert.rejects(
			() => inibase.post("c_ledger", { owner: 99999 }),
			(error: unknown) =>
				(error as Error).name === "COMPUTED_FIELD_DANGLING_LINK",
		);

		// a live link resolves through the target table
		const owner = (await inibase.post("c_owner", { name: "aca" }, undefined, true)) as Row;
		const linked = (await inibase.post("c_ledger", { owner: { id: owner.id } }, undefined, true)) as Row;
		assert.equal(linked.ownerName, "aca");
	});

	await t.test("computed values cannot be set directly", async () => {
		await inibase.createTable("c_set", [
			{ key: "a", type: "number" },
			{ key: "s", type: "number", computed: "1" },
		]);
		// seed a valid row so where-less writes reach validation
		await inibase.post("c_set", { a: 5 });
		await assert.rejects(
			() => inibase.post("c_set", { a: 5, s: 99 }),
			(error: unknown) => (error as Error).name === "COMPUTED_FIELD_SETTABLE",
		);
		await assert.rejects(
			() => inibase.put("c_set", { s: 99 }),
			(error: unknown) => (error as Error).name === "COMPUTED_FIELD_SETTABLE",
		);
	});

	await t.test("DDL rejects syntax, conflicts, cycles and invalid targets", async () => {
		// syntax
		await assert.rejects(
			() => inibase.createTable("c_e", [{ key: "x", type: "number", computed: "1 ++" }]),
			(error: unknown) => (error as Error).name === "COMPUTED_FIELD_SYNTAX",
		);
		// conflicts with required / unique / regex
		for (const extra of [{ required: true }, { unique: true }, { regex: "^1$" }])
			await assert.rejects(
				() =>
					inibase.createTable("c_e2", [
						{ key: "x", type: "number", computed: "1", ...extra },
					]),
				(error: unknown) => (error as Error).name === "COMPUTED_FIELD_CONFLICT",
			);
		// cycles (mutual and self)
		await assert.rejects(
			() =>
				inibase.createTable("c_cyc", [
					{ key: "a", type: "number", computed: "2" },
					{ key: "b", type: "number", computed: "1" },
				]),
			(error: unknown) => (error as Error).name === "COMPUTED_FIELD_CYCLE",
		);
		await assert.rejects(
			() =>
				inibase.createTable("c_cyc2", [
					{ key: "a", type: "number", computed: "1" },
				]),
			(error: unknown) => (error as Error).name === "COMPUTED_FIELD_CYCLE",
		);
		// a bare path into array content is only legal inside a helper
		await assert.rejects(
			() =>
				inibase.createTable("c_arr", [
					{ key: "items", type: "array", children: [{ key: "n", type: "number" }] },
					{ key: "first", type: "number", computed: "2" },
				]),
			(error: unknown) => (error as Error).name === "COMPUTED_FIELD_INVALID_TARGET",
		);
	});

	await t.test("integer-only: a decimal written as a path fails at compile time", async () => {
		// `2.5` is a link hop (field 2, then field 5 of its target), never the
		// decimal 2.5, so this schema cannot express fractional literals.
		await assert.rejects(
			() =>
				inibase.createTable("c_dec", [
					{ key: "a", type: "number" },
					{ key: "b", type: "number" },
					{ key: "ratio", type: "number", computed: "2.5" },
				]),
			(error: unknown) => (error as Error).name === "COMPUTED_FIELD_INVALID_LINK",
		);
		// fractional results are reachable by division instead
		await inibase.createTable("c_div", [
			{ key: "z", type: "number", computed: "314 / 100" },
		]);
		const row = (await inibase.post("c_div", {}, undefined, true)) as Row;
		assert.equal(row.z, 3.14);
	});

	await t.test("precedence, parens and modulo", async () => {
		// ids: base=1, p1=2, p2=3, p3=4, x=5, y=6, w=7, d=8
		await inibase.createTable("c_prec", [
			{ key: "base", type: "number" },
			{ key: "p1", type: "number" },
			{ key: "p2", type: "number" },
			{ key: "p3", type: "number" },
			{ key: "x", type: "number", computed: "2 , 3 + 4" },
			{ key: "y", type: "number", computed: "2 , (3 + 4)" },
			{ key: "w", type: "number", computed: "97 % 10" },
			{ key: "d", type: "number", computed: "2 / 3" },
		]);
		const row = (await inibase.post("c_prec", { base: 1, p1: 2, p2: 3, p3: 4 }, undefined, true)) as Row;
		assert.equal(row.x, 10, "p1*p2 + p3");
		assert.equal(row.y, 14, "p1*(p2+p3)");
		assert.equal(row.w, 7);
		assert.equal(row.d, 2 / 3);
		// division by zero is an arithmetic error
		await assert.rejects(
			() => inibase.post("c_prec", { base: 1, p1: 5, p2: 0, p3: 1 }),
			(error: unknown) => (error as Error).name === "COMPUTED_FIELD_ARITHMETIC",
		);
	});

	await t.test("updateTable backfills added and changed computed fields", async () => {
		const tableName = "c_backfill";
		await inibase.createTable(tableName, [
			{ key: "qty", type: "number" },
			{ key: "price", type: "number" },
		]);
		await seed(tableName, [
			{ qty: 2, price: 3 },
			{ qty: 5, price: 4 },
		]);

		// add a computed field: existing rows get backfilled values
		await inibase.updateTable(tableName, [
			...(await userSchema(tableName)),
			{ key: "total", type: "number", computed: "1, 2" },
		]);
		let rows = (await inibase.get<Row>(tableName)) as Row[];
		assert.deepEqual(rows.map((r) => r.total), [6, 20], "backfilled totals");
		assert.deepEqual(rows.map((r) => r.qty), [2, 5], "existing columns survive");

		// changing the expression re-backfills
		await inibase.updateTable(tableName, [
			...(await userSchema(tableName)).map((f) =>
				f.key === "total" ? { ...f, computed: "1, 2, 2" } : f,
			),
		]);
		rows = (await inibase.get<Row>(tableName)) as Row[];
		assert.deepEqual(rows.map((r) => r.total), [18, 80], "re-backfilled totals");

		// posts after the migration keep computing
		const posted = (await inibase.post(tableName, { qty: 10, price: 2 }, undefined, true)) as Row;
		assert.equal(posted.total, 40);
	});

	await t.test("a failed backfill leaves the schema untouched", async () => {
		const tableName = "c_fail";
		await inibase.createTable(tableName, [{ key: "a", type: "number" }]);
		await seed(tableName, [{ a: 5 }]);
		const before = await userSchema(tableName);

		// `1, 2` = a * b but b has no backing column yet: backfill arithmetic error
		await assert.rejects(
			() =>
				inibase.updateTable(tableName, [
					...before,
					{ key: "b", type: "number" },
					{ key: "s", type: "number", computed: "1, 2" },
				]),
			(error: unknown) => (error as Error).name === "COMPUTED_FIELD_ARITHMETIC",
		);

		const after = await userSchema(tableName);
		assert.deepEqual(
			after.map((f) => f.key),
			["a"],
			"failed migration must not persist the computed field",
		);
		const rows = (await inibase.get<Row>(tableName)) as Row[];
		assert.equal(rows[0].a, 5, "row data survives the failed migration");
	});
});

await test("Cleanup Advanced Database", removeDatabase);