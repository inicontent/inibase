// Unit tests for the computed-fields expression language (expression.ts).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	buildFieldIndex,
	type ComputedFieldMeta,
	collectFieldDeps,
	type FieldRef,
	flattenRecord,
	parseExpression,
	type ResolveContext,
	resolveExpression,
	resolveFramePath,
	topoSortComputedFields,
} from "../src/expression.js";
import type { ErrorLang, Schema } from "../src/index.js";

const EN: ErrorLang = "en";

const syntax = (
	fn: () => unknown,
	fieldKey = "x",
): { name: string; message: string } => {
	try {
		fn();
	} catch (error) {
		assert.equal(
			(error as Error).name,
			"COMPUTED_FIELD_SYNTAX",
			`expected a syntax error on '${fieldKey}'`,
		);
		return {
			name: (error as Error).name,
			message: (error as Error).message,
		};
	}
	assert.fail(`expected COMPUTED_FIELD_SYNTAX for '${fieldKey}'`);
};

const ctxFor = (
	schema: Schema,
	links: Record<string, Schema> = {},
): ResolveContext => {
	const index = buildFieldIndex(schema);
	const cache = new Map<string, Map<number, FieldRef>>();
	return {
		language: EN,
		ownKey: "f",
		index,
		getTableIndex: async (target) => {
			let cached = cache.get(target);
			if (!cached && links[target]) {
				cached = buildFieldIndex(links[target]);
				cache.set(target, cached);
			}
			return cached;
		},
	};
};

await test("parseExpression: precedence and associativity", async () => {
	// mul/div/mod bind tighter than add/sub
	assert.deepEqual(parseExpression("1 + 2 , 3"), {
		kind: "bin",
		op: "add",
		left: { kind: "num", value: 1 },
		right: {
			kind: "bin",
			op: "mul",
			left: { kind: "num", value: 2 },
			right: { kind: "num", value: 3 },
		},
	});
	// left-associative chains
	assert.deepEqual(parseExpression("10 - 3 - 2"), {
		kind: "bin",
		op: "sub",
		left: {
			kind: "bin",
			op: "sub",
			left: { kind: "num", value: 10 },
			right: { kind: "num", value: 3 },
		},
		right: { kind: "num", value: 2 },
	});
	// parens override precedence
	assert.deepEqual(parseExpression("2 , (3 + 4)"), {
		kind: "bin",
		op: "mul",
		left: { kind: "num", value: 2 },
		right: {
			kind: "bin",
			op: "add",
			left: { kind: "num", value: 3 },
			right: { kind: "num", value: 4 },
		},
	});
	// `/` and `%` bind at the same level as `,`
	assert.deepEqual(parseExpression("314 / 100"), {
		kind: "bin",
		op: "div",
		left: { kind: "num", value: 314 },
		right: { kind: "num", value: 100 },
	});
	assert.deepEqual(parseExpression("10 % 3"), {
		kind: "bin",
		op: "mod",
		left: { kind: "num", value: 10 },
		right: { kind: "num", value: 3 },
	});
});

await test("parseExpression: paths and helpers", async () => {
	// `.` is the path separator: 3.4 is a link hop, never a decimal
	assert.deepEqual(parseExpression("3.4"), { kind: "path", ids: [3, 4] });
	assert.deepEqual(parseExpression("3.4.5"), { kind: "path", ids: [3, 4, 5] });
	assert.deepEqual(parseExpression("4"), { kind: "num", value: 4 });
	// helper argument is a full expression
	assert.deepEqual(parseExpression("sum(5 , 4.2)"), {
		kind: "fn",
		name: "sum",
		arg: {
			kind: "bin",
			op: "mul",
			left: { kind: "num", value: 5 },
			right: { kind: "path", ids: [4, 2] },
		},
	});
	// every helper name is recognized
	for (const name of ["sum", "count", "avg", "min", "max"])
		assert.equal(parseExpression(`${name}(2)`).kind, "fn");
	// whitespace is insignificant
	assert.deepEqual(parseExpression("\t1  +\n 2 \r\n"), {
		kind: "bin",
		op: "add",
		left: { kind: "num", value: 1 },
		right: { kind: "num", value: 2 },
	});
});

await test("parseExpression: integer-only (no decimal literals)", async () => {
	// 3.14 parses as a two-segment path, so fractional literals must be
	// written via division (314 / 100).
	const parsed = parseExpression("3.14");
	assert.deepEqual(parsed, { kind: "path", ids: [3, 14] });
});

await test("parseExpression: syntax errors", async () => {
	syntax(() => parseExpression(""));
	syntax(() => parseExpression("1 ++"));
	syntax(() => parseExpression("1 +"));
	syntax(() => parseExpression("+ 1"));
	syntax(() => parseExpression("1 ."));
	syntax(() => parseExpression("1."));
	syntax(() => parseExpression("()"));
	syntax(() => parseExpression("(1"));
	syntax(() => parseExpression("1)"));
	syntax(() => parseExpression("sum(1"));
	syntax(() => parseExpression("sum()"));
	syntax(() => parseExpression("1 2"));
	syntax(() => parseExpression("foo(1)"));
	syntax(() => parseExpression("a"));
	syntax(() => parseExpression("1 ! 2"));
	syntax(() => parseExpression("-1"));
});

await test("parseExpression: caps input length and nesting depth", async () => {
	const long = `sum(${"1+".repeat(300)}1)`;
	syntax(() => parseExpression(long));
	syntax(() => parseExpression(`${"(".repeat(70)}1${")".repeat(70)}`));
});

await test("buildFieldIndex: flat, nested and virtual ids", async () => {
	const schema: Schema = [
		{ id: 0, key: "id", type: "id" },
		{ id: 1, key: "name", type: "string" },
		{
			id: 2,
			key: "items",
			type: "array",
			children: [
				{ id: 3, key: "product", type: "table", table: "catalog" },
				{ id: 4, key: "quantity", type: "number" },
			],
		},
		{ id: -1, key: "createdAt", type: "date" },
	];
	const index = buildFieldIndex(schema);

	assert.equal(index.size, 6);
	assert.equal(index.get(1)?.key, "name");
	assert.equal(index.get(4)?.key, "items.quantity");
	// container fields are indexed (so unknown/container ids are caught) ...
	assert.ok(index.get(2));
	// ... and children know their array ancestor
	assert.deepEqual(index.get(3)?.arrayAncestor, { id: 2, key: "items" });
	assert.equal(index.get(3)?.nestedInArrayOfArrays, false);
	assert.equal(index.get(1)?.arrayAncestor, null);

	// arrays nested inside arrays are flagged
	const nested: Schema = [
		{
			id: 1,
			key: "groups",
			type: "array",
			children: [
				{
					id: 2,
					key: "members",
					type: "array",
					children: [{ id: 3, key: "score", type: "number" }],
				},
			],
		},
	];
	const nestedIndex = buildFieldIndex(nested);
	assert.equal(nestedIndex.get(3)?.nestedInArrayOfArrays, true);
});

await test("resolveExpression: locative ids and literal fallback", async () => {
	const schema: Schema = [
		{ id: 1, key: "a", type: "number" },
		{ id: 2, key: "b", type: "number" },
		{ id: 3, key: "c", type: "number" },
	];
	const ctx = ctxFor(schema);

	// a bare integer that matches a field id becomes that field
	const a = await resolveExpression(parseExpression("2"), ctx);
	assert.deepEqual(a.ast, { kind: "path", ids: [2], arrayFieldId: null });
	assert.deepEqual([...a.deps], [2]);

	// a bare integer that matches no field id is an integer literal
	const big = await resolveExpression(parseExpression("314"), ctx);
	assert.deepEqual(big.ast, { kind: "num", value: 314 });
	assert.equal(big.deps.size, 0);

	// arithmetic deps are the union of path roots
	const bin = await resolveExpression(parseExpression("1 , 314 + 2"), ctx);
	assert.deepEqual(bin.deps, new Set([1, 2]));
});

await test("resolveExpression: helpers resolve the array ancestor", async () => {
	const schema: Schema = [
		{ id: 1, key: "customer", type: "string" },
		{
			id: 2,
			key: "items",
			type: "array",
			children: [
				{ id: 3, key: "price", type: "number" },
				{ id: 4, key: "quantity", type: "number" },
			],
		},
		{ id: 5, key: "total", type: "number" },
	];
	const ctx = ctxFor(schema);

	const sum = await resolveExpression(parseExpression("sum(4 , 3)"), ctx);
	assert.deepEqual(sum.ast, {
		kind: "fn",
		name: "sum",
		arrayFieldId: 2,
		arg: {
			kind: "bin",
			op: "mul",
			left: { kind: "path", ids: [4], arrayFieldId: 2 },
			right: { kind: "path", ids: [3], arrayFieldId: 2 },
		},
	});
	assert.deepEqual(sum.deps, new Set([4, 3]));
});

await test("resolveExpression: links resolve into the target table", async () => {
	const orders: Schema = [
		{ id: 1, key: "customer", type: "string" },
		{
			id: 2,
			key: "items",
			type: "array",
			children: [
				{ id: 3, key: "product", type: "table", table: "catalog" },
				{ id: 4, key: "quantity", type: "number" },
			],
		},
		{ id: 5, key: "total", type: "number" },
	];
	const catalog: Schema = [
		{ id: 1, key: "name", type: "string" },
		{ id: 2, key: "price", type: "number" },
	];
	const ctx = ctxFor(orders, { catalog });

	const hop = await resolveExpression(parseExpression("sum(4 , 3.2)"), ctx);
	assert.deepEqual(hop.ast, {
		kind: "fn",
		name: "sum",
		arrayFieldId: 2,
		arg: {
			kind: "bin",
			op: "mul",
			left: { kind: "path", ids: [4], arrayFieldId: 2 },
			right: { kind: "path", ids: [3, 2], arrayFieldId: 2 },
		},
	});
	assert.deepEqual(hop.deps, new Set([4, 3]));

	// top-level link hops (a top-level `table` field is not array content)
	const ownerSchema: Schema = [
		{ id: 1, key: "owner", type: "table", table: "catalog" },
		{ id: 2, key: "ownerName", type: "string" },
	];
	const ownerCtx = ctxFor(ownerSchema, { catalog });

	const ok = await resolveExpression(parseExpression("1.2"), ownerCtx);
	assert.deepEqual(ok.ast, { kind: "path", ids: [1, 2], arrayFieldId: null });
	assert.deepEqual(ok.deps, new Set([1]));

	// the hop must land on a field that exists in the target table
	await assert.rejects(
		resolveExpression(parseExpression("1.9"), ownerCtx),
		(error: unknown) =>
			(error as Error).name === "COMPUTED_FIELD_UNKNOWN_FIELD",
	);
	// the hop source must be a table link
	await assert.rejects(
		resolveExpression(parseExpression("2.1"), ownerCtx),
		(error: unknown) => (error as Error).name === "COMPUTED_FIELD_INVALID_LINK",
	);
	// the hop target table must exist
	await assert.rejects(
		resolveExpression(parseExpression("1.2"), ctxFor(ownerSchema)),
		(error: unknown) => (error as Error).name === "TABLE_NOT_EXISTS",
	);
});

await test("resolveExpression: rejected shapes", async () => {
	const schema: Schema = [
		{ id: 1, key: "customer", type: "string" },
		{
			id: 2,
			key: "items",
			type: "array",
			children: [
				{ id: 3, key: "price", type: "number" },
				{ id: 4, key: "quantity", type: "number" },
			],
		},
	];
	const ctx = ctxFor(schema);

	// unknown field ids surface through paths (bare ints are literals)
	await assert.rejects(
		resolveExpression(parseExpression("9.1"), ctx),
		(error: unknown) =>
			(error as Error).name === "COMPUTED_FIELD_UNKNOWN_FIELD",
	);
	// a container (array-of-objects) can't be referenced directly
	await assert.rejects(
		resolveExpression(parseExpression("2"), ctx),
		(error: unknown) =>
			(error as Error).name === "COMPUTED_FIELD_INVALID_TARGET",
	);
	// a bare path to array content is only reachable inside a helper
	await assert.rejects(
		resolveExpression(parseExpression("3"), ctx),
		(error: unknown) =>
			(error as Error).name === "COMPUTED_FIELD_INVALID_TARGET",
	);
	// a helper must reference the exact same array (no bare positives)
	await assert.rejects(
		resolveExpression(parseExpression("sum(3 , 1)"), ctx),
		(error: unknown) =>
			(error as Error).name === "COMPUTED_FIELD_INVALID_TARGET",
	);
	// a helper needs at least one path (no pure-literal arguments)
	await assert.rejects(
		resolveExpression(parseExpression("sum(5)"), ctx),
		(error: unknown) =>
			(error as Error).name === "COMPUTED_FIELD_INVALID_TARGET",
	);
	// helpers cannot be nested
	await assert.rejects(
		resolveExpression(parseExpression("sum(sum(4))"), ctx),
		(error: unknown) =>
			(error as Error).name === "COMPUTED_FIELD_INVALID_TARGET",
	);

	// an array of arrays can't be aggregated
	const nested: Schema = [
		{ id: 1, key: "customer", type: "string" },
		{
			id: 2,
			key: "groups",
			type: "array",
			children: [
				{
					id: 3,
					key: "members",
					type: "array",
					children: [{ id: 4, key: "score", type: "number" }],
				},
			],
		},
	];
	await assert.rejects(
		resolveExpression(parseExpression("sum(4)"), ctxFor(nested)),
		(error: unknown) =>
			(error as Error).name === "COMPUTED_FIELD_INVALID_TARGET",
	);
});

await test("topoSortComputedFields: orders dependencies first", async () => {
	const meta = (
		id: number,
		key: string,
		deps: number[],
	): ComputedFieldMeta => ({
		id,
		key,
		deps: new Set(deps),
	});
	const fields = [
		meta(1, "a", [2]),
		meta(2, "b", [3]),
		meta(3, "c", []),
		meta(4, "d", []),
	];
	const ordered = topoSortComputedFields(fields, EN).map((f) => f.key);
	// c must precede b, b must precede a; d is independent
	assert.ok(ordered.indexOf("c") < ordered.indexOf("b"));
	assert.ok(ordered.indexOf("b") < ordered.indexOf("a"));
	assert.equal(new Set(ordered).size, 4);
});

await test("topoSortComputedFields: cycles are rejected", async () => {
	const meta = (
		id: number,
		key: string,
		deps: number[],
	): ComputedFieldMeta => ({
		id,
		key,
		deps: new Set(deps),
	});
	// mutual cycle
	assert.throws(
		() => topoSortComputedFields([meta(1, "a", [2]), meta(2, "b", [1])], EN),
		(error: unknown) =>
			(error as Error).name === "COMPUTED_FIELD_CYCLE" &&
			((error as Error).message.includes("a") ||
				(error as Error).message.includes("b")),
	);
	// self-reference is also a cycle
	assert.throws(
		() => topoSortComputedFields([meta(1, "a", [1])], EN),
		(error: unknown) =>
			(error as Error).name === "COMPUTED_FIELD_CYCLE" &&
			(error as Error).message.includes("a"),
	);
});

await test("collectFieldDeps reads path roots from a compiled AST", async () => {
	const schema: Schema = [
		{ id: 1, key: "a", type: "number" },
		{ id: 2, key: "b", type: "number" },
		{ id: 3, key: "c", type: "number" },
		{
			id: 4,
			key: "items",
			type: "array",
			children: [{ id: 5, key: "n", type: "number" }],
		},
	];
	const ctx = ctxFor(schema);
	const resolved = await resolveExpression(
		parseExpression("1 + 2 , sum(5)"),
		ctx,
	);
	assert.deepEqual(resolved.deps, new Set([1, 2, 5]));
	assert.deepEqual(collectFieldDeps(resolved.ast), new Set([1, 2, 5]));
});

await test("flattenRecord: nested objects and arrays of objects", async () => {
	const row = {
		name: "ada",
		meta: { age: 36, city: "paris" },
		items: [
			{ product: 1, quantity: 2 },
			{ product: 2, quantity: 5 },
		],
		empty: [],
		missing: null,
	};
	const flat = flattenRecord(row);
	assert.equal(flat.name, "ada");
	assert.equal(flat["meta.age"], 36);
	assert.equal(flat["meta.city"], "paris");
	assert.deepEqual(flat["items.product"], [1, 2]);
	assert.deepEqual(flat["items.quantity"], [2, 5]);
	assert.deepEqual(flat.empty, []);
	assert.equal(flat.missing, null);
});

await test("resolveFramePath: walks structured frames in place", async () => {
	const row = {
		name: "ada",
		meta: { age: 36, city: "paris" },
		items: [
			{ product: 1, quantity: 2 },
			{ product: 2, quantity: 5 },
		],
		empty: [],
		missing: null,
	};
	// Leaves match flattenRecord's, but no flattened copy is materialised.
	assert.equal(resolveFramePath(row, "name"), "ada");
	assert.equal(resolveFramePath(row, "meta.age"), 36);
	assert.equal(resolveFramePath(row, "meta.city"), "paris");
	// Arrays never match a dotted segment (flatten's combined arrays are
	// expressly not produced on the direct read path)…
	assert.equal(resolveFramePath(row, "items.product"), undefined);
	assert.equal(resolveFramePath(row, "items.quantity"), undefined);
	// …but a leaf that is itself an array (or null) resolves to that value.
	assert.deepEqual(resolveFramePath(row, "empty"), []);
	assert.equal(resolveFramePath(row, "missing"), null);
	assert.equal(resolveFramePath(row, "nope.deep"), undefined);
	// Scalars and nulls are not walkable.
	assert.equal(resolveFramePath(row, "name.length"), undefined);
	assert.equal(resolveFramePath(row, "missing.x"), undefined);
	// Empty path returns the frame itself.
	assert.equal(resolveFramePath(row, ""), row);
	// Helper element frames are just child objects of the array.
	const element = row.items[0];
	assert.equal(resolveFramePath(element, "product"), 1);
	assert.equal(resolveFramePath(element, "quantity"), 2);
	assert.equal(resolveFramePath(element, "nested.deep"), undefined);
});
