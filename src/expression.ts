/**
 * Computed-fields expression language (v1 — id-only).
 *
 * Grammar
 * -------
 * ```
 * expression := term (("+" | "-") term)*
 * term       := factor (("*" | "/" | "%") factor)*   // "*" = multiply
 * factor     := integer-literal | path | function-call | "(" expression ")"
 * path       := id ( "." id )*                       // "." = link/binding hop
 * function   := "sum" | "count" | "avg" | "min" | "max" "(" expression ")"
 * ```
 *
 * Every symbol is a numeric field `id` (per-table dense counter, nested
 * children included). There are no decimal literals: `.` is reserved as the
 * path separator, so `3.4` is a link hop (`field 3`, then `field 4` in the
 * table `field 3` links to), never the decimal 3.4. Fractional results are
 * reachable via division (`314 / 100` → 3.14).
 *
 * A bare integer that **matches a field id in the table's schema** is that
 * field's value (ids are locative); a bare integer that matches no field id
 * is an integer literal. This is what makes both `sum(4 * 3.4)` (id 4 =
 * quantity) and `314 / 100` (no such ids) usable.
 *
 * Compiled expressions are persisted with the schema as
 * `{ expr: string, ast: CompiledExpressionNode }` so key/table renames never
 * retarget an expression: the AST carries only field ids (+ the id of the
 * array ancestor a helper iterates), and every key path is re-derived from
 * the *current* schema at write time.
 */

import type { ErrorLang, Field, Schema } from "./index.js";
import { createError, isArrayOfObjects } from "./utils.js";

/** Cap on the raw `computed` string length (bound work at validation). */
export const COMPUTED_EXPR_MAX_LENGTH = 512;
/** Cap on the parsed AST depth (protects the parser/evaluator recursion). */
export const COMPUTED_EXPR_MAX_DEPTH = 64;

export type ComputedFunctionName = "sum" | "count" | "avg" | "min" | "max";

export type BinaryOp = "add" | "sub" | "mul" | "div" | "mod";

/** Raw AST produced by {@link parseExpression} (field ids unresolved). */
export type RawExpressionNode =
	| { kind: "num"; value: number }
	| { kind: "path"; ids: number[] }
	| {
			kind: "bin";
			op: BinaryOp;
			left: RawExpressionNode;
			right: RawExpressionNode;
	  }
	| { kind: "fn"; name: ComputedFunctionName; arg: RawExpressionNode };

/**
 * Compiled AST stored in the schema. Path nodes carry only ids (+ the id of
 * the array ancestor a helper iterates); all key paths are resolved against
 * the current schema at evaluation time, so renames never break expressions.
 */
export type CompiledExpressionNode =
	| { kind: "num"; value: number }
	| { kind: "path"; ids: number[]; arrayFieldId: number | null }
	| {
			kind: "bin";
			op: BinaryOp;
			left: CompiledExpressionNode;
			right: CompiledExpressionNode;
	  }
	| {
			kind: "fn";
			name: ComputedFunctionName;
			/** id of the array ancestor every path in `arg` lives in. */
			arrayFieldId: number;
			arg: CompiledExpressionNode;
	  };

/** Persisted form of a `computed` schema property. (A type alias so it stays
 *  assignable to Inison's recursive `Data` type.) */
export type ComputedFieldSpec = {
	expr: string;
	ast: CompiledExpressionNode;
};

/**
 * Schema index used for id resolution: maps a field id to its dotted key path,
 * the resolved field, and the nearest array-of-objects ancestor (if any).
 */
export interface FieldRef {
	key: string;
	field: Field;
	/** Nearest `array`-typed ancestor with object children, or null. */
	arrayAncestor: { id: number; key: string } | null;
	/** True when `arrayAncestor` itself sits inside another array of objects. */
	nestedInArrayOfArrays: boolean;
}

const FN_NAMES: ComputedFunctionName[] = ["sum", "count", "avg", "min", "max"];

/* ---------------------------------------------------------------------------
 * Tokenizer + parser
 * ------------------------------------------------------------------------- */

type Token =
	| { t: "num"; v: number }
	| { t: "ident"; v: string }
	| { t: "op"; v: "+" | "-" | "*" | "/" | "%" }
	| { t: "dot" }
	| { t: "lp" }
	| { t: "rp" }
	| { t: "eof" };

const syntaxError = (language: ErrorLang, fieldKey: string): Error =>
	createError(language, "COMPUTED_FIELD_SYNTAX", fieldKey);

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			i++;
			continue;
		}
		if (ch >= "0" && ch <= "9") {
			let j = i;
			while (j < source.length && source[j] >= "0" && source[j] <= "9") j++;
			tokens.push({ t: "num", v: Number(source.slice(i, j)) });
			i = j;
			continue;
		}
		if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")) {
			let j = i;
			while (
				j < source.length &&
				((source[j] >= "a" && source[j] <= "z") ||
					(source[j] >= "A" && source[j] <= "Z") ||
					(source[j] >= "0" && source[j] <= "9") ||
					source[j] === "_")
			)
				j++;
			tokens.push({ t: "ident", v: source.slice(i, j) });
			i = j;
			continue;
		}
		switch (ch) {
			case ".":
				tokens.push({ t: "dot" });
				i++;
				continue;
			case "(":
				tokens.push({ t: "lp" });
				i++;
				continue;
			case ")":
				tokens.push({ t: "rp" });
				i++;
				continue;
			case "+":
			case "-":
			case "*":
			case "/":
			case "%":
				tokens.push({ t: "op", v: ch });
				i++;
				continue;
			default:
				throw syntaxError("en", "");
		}
	}
	tokens.push({ t: "eof" });
	return tokens;
}

/**
 * Parse a `computed` expression into a raw AST. Throws
 * `COMPUTED_FIELD_SYNTAX` on invalid syntax, oversized input or excessive
 * nesting.
 */
export function parseExpression(
	source: string,
	language: ErrorLang = "en",
	fieldKey = "",
): RawExpressionNode {
	if (typeof source !== "string" || !source.length)
		throw syntaxError(language, fieldKey);
	if (source.length > COMPUTED_EXPR_MAX_LENGTH)
		throw syntaxError(language, fieldKey);

	const tokens = tokenize(source);
	let pos = 0;
	let depth = 0;

	const peek = (): Token => tokens[pos];
	const next = (): Token => tokens[pos++];
	const fail = (): Error => syntaxError(language, fieldKey);

	const enter = (): void => {
		if (++depth > COMPUTED_EXPR_MAX_DEPTH) throw fail();
	};
	const leave = (): void => {
		depth--;
	};

	const expression = (): RawExpressionNode => {
		enter();
		let left = term();
		let token = peek();
		while (token.t === "op" && (token.v === "+" || token.v === "-")) {
			const op = (next() as { t: "op"; v: "+" | "-" }).v;
			left = {
				kind: "bin",
				op: op === "+" ? "add" : "sub",
				left,
				right: term(),
			};
			token = peek();
		}
		leave();
		return left;
	};

	const term = (): RawExpressionNode => {
		enter();
		let left = factor();
		while (peek().t === "op" && ["*", "/", "%"].includes((peek() as any).v)) {
			const op = (next() as { t: "op"; v: "*" | "/" | "%" }).v;
			const binOp: BinaryOp = op === "*" ? "mul" : op === "/" ? "div" : "mod";
			left = { kind: "bin", op: binOp, left, right: factor() };
		}
		leave();
		return left;
	};

	const factor = (): RawExpressionNode => {
		enter();
		const token = next();
		if (token.t === "num") {
			if (peek().t === "dot") {
				const ids = [token.v];
				while (peek().t === "dot") {
					next();
					const seg = next();
					if (seg.t !== "num") throw fail();
					ids.push(seg.v);
				}
				leave();
				return { kind: "path", ids };
			}
			leave();
			return { kind: "num", value: token.v };
		}
		if (token.t === "ident") {
			const name = token.v;
			if (!FN_NAMES.includes(name as ComputedFunctionName)) throw fail();
			if (next().t !== "lp") throw fail();
			const arg = expression();
			if (next().t !== "rp") throw fail();
			leave();
			return { kind: "fn", name: name as ComputedFunctionName, arg };
		}
		if (token.t === "lp") {
			const inner = expression();
			if (next().t !== "rp") throw fail();
			leave();
			return inner;
		}
		throw fail();
	};

	const root = expression();
	if (next().t !== "eof") throw fail();
	return root;
}

/* ---------------------------------------------------------------------------
 * Schema index
 * ------------------------------------------------------------------------- */

/**
 * Build the id → {@link FieldRef} index of a schema (nested children included,
 * using dotted key paths). Container fields (array/object with object
 * children) are indexed too so unknown ids are detected, but they can't be
 * referenced by an expression.
 */
export function buildFieldIndex(schema: Schema): Map<number, FieldRef> {
	const index = new Map<number, FieldRef>();

	const isArrayOfObjectsContainer = (field: Field): boolean =>
		Array.isArray(field.children) && isArrayOfObjects(field.children);

	const walk = (
		fields: Schema,
		prefix: string,
		ancestors: { field: Field; key: string }[],
	): void => {
		for (const field of fields) {
			const key = prefix ? `${prefix}.${field.key}` : field.key;
			if (field.id !== undefined) {
				let arrayAncestor: { id: number; key: string } | null = null;
				let nestedInArrayOfArrays = false;
				for (let i = ancestors.length - 1; i >= 0; i--) {
					const ancestor = ancestors[i];
					if (
						ancestor.field.type === "array" &&
						isArrayOfObjectsContainer(ancestor.field)
					) {
						arrayAncestor = {
							id: ancestor.field.id as number,
							key: ancestor.key,
						};
						for (let j = i - 1; j >= 0; j--) {
							const parent = ancestors[j].field;
							if (
								parent.type === "array" &&
								isArrayOfObjectsContainer(parent)
							) {
								nestedInArrayOfArrays = true;
								break;
							}
						}
						break;
					}
				}
				index.set(field.id, {
					key,
					field,
					arrayAncestor,
					nestedInArrayOfArrays,
				});
			}
			if (isArrayOfObjectsContainer(field))
				walk(field.children as Schema, key, [...ancestors, { field, key }]);
		}
	};

	walk(schema, "", []);
	return index;
}

/* ---------------------------------------------------------------------------
 * Resolution (id → schema)
 * ------------------------------------------------------------------------- */

export interface ResolveContext {
	language: ErrorLang;
	/** Key of the computed field being compiled (error context). */
	ownKey: string;
	/** Id index of the table the computed field belongs to. */
	index: Map<number, FieldRef>;
	/** Fetch (and cache) the id index of another table, or undefined. */
	getTableIndex: (
		tableName: string,
	) => Promise<Map<number, FieldRef> | undefined>;
	/**
	 * When set, the expression being compiled belongs to an *element* of the
	 * array-of-objects field with this id (a child computed field). Every
	 * referenced field must be a sibling child of that same array; top-level
	 * fields and helpers are rejected.
	 */
	elementContext?: { arrayRootId: number } | null;
}

const isContainer = (field: Field): boolean =>
	Array.isArray(field.children) && isArrayOfObjects(field.children);

/** Collect every path node of a (compiled or raw) expression tree. */
function collectPaths(node: {
	kind: string;
	left?: any;
	right?: any;
	arg?: any;
}): { kind: "path"; ids: number[]; arrayFieldId?: number | null }[] {
	if (node.kind === "path") return [node as any];
	const paths: { kind: "path"; ids: number[]; arrayFieldId?: number | null }[] =
		[];
	if (node.kind === "bin") {
		paths.push(...collectPaths(node.left));
		paths.push(...collectPaths(node.right));
	} else if (node.kind === "fn") paths.push(...collectPaths(node.arg));
	return paths;
}

async function resolvePathNode(
	node: { kind: "path"; ids: number[] },
	ctx: ResolveContext,
	inHelper: boolean,
): Promise<{ node: CompiledExpressionNode; deps: Set<number> }> {
	const ids = node.ids;
	const hop0 = ctx.index.get(ids[0]);
	if (!hop0)
		throw createError(ctx.language, "COMPUTED_FIELD_UNKNOWN_FIELD", [
			ctx.ownKey,
			ids[0],
		]);
	if (isContainer(hop0.field))
		throw createError(ctx.language, "COMPUTED_FIELD_INVALID_TARGET", [
			ctx.ownKey,
			ids[0],
		]);

	const arrayFieldId: number | null = hop0.arrayAncestor?.id ?? null;

	if (ctx.elementContext) {
		// Child computed field: every reference must be a sibling child of the
		// computed field's own array root (helpers that recurse into other
		// arrays and reads of top-level columns are invalid here).
		if (hop0.arrayAncestor?.id !== ctx.elementContext.arrayRootId)
			throw createError(ctx.language, "COMPUTED_FIELD_INVALID_TARGET", [
				ctx.ownKey,
				ids[0],
			]);
		if (hop0.nestedInArrayOfArrays)
			throw createError(ctx.language, "COMPUTED_FIELD_INVALID_TARGET", [
				ctx.ownKey,
				ids[0],
			]);
	} else if (!inHelper && arrayFieldId !== null)
		throw createError(ctx.language, "COMPUTED_FIELD_INVALID_TARGET", [
			ctx.ownKey,
			ids[0],
		]);
	else if (inHelper && hop0.arrayAncestor !== null && hop0.nestedInArrayOfArrays)
		throw createError(ctx.language, "COMPUTED_FIELD_INVALID_TARGET", [
			ctx.ownKey,
			ids[0],
		]);

	// Link hops: each hop beyond the first must live in the table the previous
	// hop's field links to.
	let currentRef = hop0;
	for (let i = 1; i < ids.length; i++) {
		const linkField = currentRef.field;
		if (linkField.type !== "table" || typeof linkField.table !== "string")
			throw createError(ctx.language, "COMPUTED_FIELD_INVALID_LINK", [
				ctx.ownKey,
				ids[i],
			]);
		const targetIndex = await ctx.getTableIndex(linkField.table);
		if (!targetIndex)
			throw createError(ctx.language, "TABLE_NOT_EXISTS", linkField.table);
		const ref = targetIndex.get(ids[i]);
		if (!ref)
			throw createError(ctx.language, "COMPUTED_FIELD_UNKNOWN_FIELD", [
				ctx.ownKey,
				ids[i],
			]);
		if (isContainer(ref.field))
			throw createError(ctx.language, "COMPUTED_FIELD_INVALID_TARGET", [
				ctx.ownKey,
				ids[i],
			]);
		currentRef = ref;
	}

	return {
		node: { kind: "path", ids, arrayFieldId },
		deps: new Set([ids[0]]),
	};
}

async function resolveNode(
	node: RawExpressionNode,
	ctx: ResolveContext,
	inHelper: boolean,
): Promise<{ node: CompiledExpressionNode; deps: Set<number> }> {
	switch (node.kind) {
		case "num":
			// A bare integer that matches an existing field id is that field
			// (ids are locative, inside helpers included — this is what makes
			// `sum(5 * 4.2)` and `sum(5 * 6)` usable); any other bare integer is
			// an integer literal (`314 / 100`).
			if (ctx.index.has(node.value))
				return resolvePathNode(
					{ kind: "path", ids: [node.value] },
					ctx,
					inHelper,
				);
			return { node: { kind: "num", value: node.value }, deps: new Set() };
		case "path":
			return resolvePathNode(node, ctx, inHelper);
		case "bin": {
			const left = await resolveNode(node.left, ctx, inHelper);
			const right = await resolveNode(node.right, ctx, inHelper);
			const deps = new Set<number>([...left.deps, ...right.deps]);
			return {
				node: { kind: "bin", op: node.op, left: left.node, right: right.node },
				deps,
			};
		}
		case "fn": {
			if (inHelper || ctx.elementContext)
				throw createError(ctx.language, "COMPUTED_FIELD_INVALID_TARGET", [
					ctx.ownKey,
				]);
			const arg = await resolveNode(node.arg, ctx, true);
			const paths = collectPaths(arg.node);
			if (!paths.length)
				throw createError(ctx.language, "COMPUTED_FIELD_INVALID_TARGET", [
					ctx.ownKey,
				]);
			const arrayFieldIds = new Set(
				paths.map((path) => path.arrayFieldId ?? null),
			);
			if (arrayFieldIds.size !== 1 || arrayFieldIds.has(null))
				throw createError(ctx.language, "COMPUTED_FIELD_INVALID_TARGET", [
					ctx.ownKey,
				]);
			return {
				node: {
					kind: "fn",
					name: node.name,
					arrayFieldId: arrayFieldIds.values().next().value as number,
					arg: arg.node,
				},
				deps: arg.deps,
			};
		}
	}
}

/**
 * Resolve a raw expression against the schema (and linked tables), returning
 * the compiled node plus the set of field ids it reads from the current
 * table (used for dependency ordering / cycle detection between computed
 * fields).
 */
export async function resolveExpression(
	expression: RawExpressionNode,
	ctx: ResolveContext,
): Promise<{ ast: CompiledExpressionNode; deps: Set<number> }> {
	const resolved = await resolveNode(expression, ctx, false);
	return { ast: resolved.node, deps: resolved.deps };
}

/** Every field id a compiled expression reads from the *current* table. */
export function collectFieldDeps(node: CompiledExpressionNode): Set<number> {
	const deps = new Set<number>();
	const visit = (n: CompiledExpressionNode): void => {
		switch (n.kind) {
			case "num":
				return;
			case "path":
				deps.add(n.ids[0]);
				return;
			case "bin":
				visit(n.left);
				visit(n.right);
				return;
			case "fn":
				visit(n.arg);
				return;
		}
	};
	visit(node);
	return deps;
}

export interface ComputedFieldMeta {
	id: number;
	key: string;
	deps: Set<number>;
}

/**
 * Order computed fields so every dependency is evaluated before its dependents.
 * Throws `COMPUTED_FIELD_CYCLE` when a field (transitively) depends on itself.
 */
export function topoSortComputedFields(
	fields: ComputedFieldMeta[],
	language: ErrorLang,
): ComputedFieldMeta[] {
	const byId = new Map(fields.map((field) => [field.id, field]));
	const remaining = new Set(fields.map((field) => field.id));
	const ordered: ComputedFieldMeta[] = [];
	const blocked: Map<number, number[]> = new Map(); // dependent -> dependencies still missing
	const indegree: Map<number, number> = new Map();

	for (const field of fields) {
		const dependents = [] as number[];
		for (const depId of field.deps) if (byId.has(depId)) dependents.push(depId);
		blocked.set(field.id, dependents);
	}

	const ready: number[] = [];
	for (const [id, deps] of blocked) {
		indegree.set(id, deps.length);
		if (deps.length === 0) ready.push(id);
	}

	while (ready.length) {
		const id = ready.shift() as number;
		const field = byId.get(id);
		if (!field) continue;
		ordered.push(field);
		remaining.delete(id);
		for (const [otherId, deps] of blocked) {
			if (!remaining.has(otherId)) continue;
			if (deps.includes(id)) {
				const nextIndegree = (indegree.get(otherId) ?? 1) - 1;
				indegree.set(otherId, nextIndegree);
				if (nextIndegree === 0) ready.push(otherId);
			}
		}
	}

	if (remaining.size) {
		const keys = fields
			.filter((field) => remaining.has(field.id))
			.map((field) => field.key);
		throw createError(language, "COMPUTED_FIELD_CYCLE", keys.join(", "));
	}
	return ordered;
}

/* ---------------------------------------------------------------------------
 * Row flattening (shared by the evaluator)
 * ------------------------------------------------------------------------- */

/**
 * Flatten a formatted row into a dot-notation record. Objects are flattened
 * (`meta.age`), arrays of objects are combined per child key
 * (`items.quantity` -> array of per-element values) and everything else is
 * stored under its dotted key.
 */
export function flattenRecord(
	obj: Record<string, any>,
	prefix = "",
): Record<string, any> {
	const out: Record<string, any> = {};
	for (const [k, v] of Object.entries(obj)) {
		const key = prefix ? `${prefix}.${k}` : k;
		if (v !== null && typeof v === "object" && !Array.isArray(v))
			Object.assign(out, flattenRecord(v, key));
		else if (Array.isArray(v) && v.length && isArrayOfObjects(v)) {
			const combined: Record<string, any[]> = {};
			for (const element of v)
				for (const [childKey, childValue] of Object.entries(element)) {
					if (!combined[childKey]) combined[childKey] = [];
					combined[childKey].push(childValue);
				}
			for (const [childKey, values] of Object.entries(combined))
				out[`${key}.${childKey}`] = values;
		} else out[key] = v;
	}
	return out;
}

/**
 * Resolve a dotted key path against a structured frame in place — the direct
 * read-path counterpart of `flattenRecord`. Walks `obj` segment by segment
 * and returns `undefined` when any intermediate is null, undefined, a
 * non-object, or an array (arrays resolve numerically only, so they never
 * match a dotted segment), mirroring the leaves `flattenRecord` would have
 * produced without materialising the flattened record.
 */
export function resolveFramePath(
	obj: Record<string, any>,
	dottedKey: string,
): any {
	if (dottedKey.length === 0) return obj;
	let cur: any = obj;
	for (const segment of dottedKey.split(".")) {
		if (
			cur === null ||
			cur === undefined ||
			typeof cur !== "object" ||
			Array.isArray(cur)
		)
			return undefined;
		cur = (cur as Record<string, any>)[segment];
	}
	return cur;
}
