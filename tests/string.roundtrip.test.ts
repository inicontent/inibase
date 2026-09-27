import { strict as assert } from "node:assert";
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import * as File from "../src/file.js";
import Inibase, { type Schema } from "../src/index.js";

// Regression suite: string cells must read back exactly as they were written.
// Before this fix, two things corrupted text on the way to/from disk:
//   1. encode() URI-decoded every string ("%20" -> " ", and any "%" that is
//      not a valid escape, like "(15%)", was stripped from the whole value);
//   2. a literal backslash-n typed by the user ("join('\n')" in source code)
//      came back as a real line break, because only LF was escaped.
// (Values starting with "[" / "{" still decode as Inison by design — see
// "Decode resilience for `{`/`[`-leading string values" in the advanced suite.)

const dbPath = "test-db-string-roundtrip";

function removeDatabase() {
	if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
}

// A realistic single-file tool: CSS percentages, template literals with
// `\n`, a URI-encoded string, a regex, a Windows path and Arabic text.
const HTML_TOOL = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><style>.box{width:100%;margin:0 5%}</style></head>
<body>
<h1>ضريبة القيمة المضافة (15%)</h1>
<script>
const lines = rows.map((r, i) => \`\${i + 1}) \${r.name}\`).join('\\n');
const text = \`ملخص:\\n\${lines}\\n\\nالعمولة (5%)\`;
const url = 'https://example.com/?q=a%20b&x=%D8%A7';
const re = /^\\d+\\.\\d{2}$/;
const path = "C:\\\\new\\\\report.txt";
</script>
</body>
</html>`;

const CASES: Record<string, string> = {
	"literal \\n in code": "x.join('\\n')",
	"literal \\n and real newline": "a\\nb\nc",
	"escaped backslash before n": "C:\\\\new",
	"lone backslash at end": "trailing\\",
	"percent sign": "width:50%",
	"invalid percent escape": "100%zz",
	"valid percent escape": "a%20b",
	"encoded arabic": "%D8%A7",
	"CRLF line endings": "l1\r\nl2\r\n",
	"marker char at start": "\u0001not escaped",
	"html tool": HTML_TOOL,
};

test("encode/decode round-trip for scalar string types", () => {
	for (const type of ["string", "html", "url", "email"] as const) {
		for (const [label, value] of Object.entries(CASES)) {
			const encoded = File.encode(value);
			assert.equal(
				String(encoded).includes("\n") || String(encoded).includes("\r"),
				false,
				`[${type}] ${label}: encoded cell must fit on one line`,
			);
			assert.equal(
				File.decode(encoded as string, { key: "v", type }),
				value,
				`[${type}] ${label}`,
			);
		}
	}
});

test("legacy cells still decode as before", () => {
	const field = { key: "v", type: "string" as const };
	// newline-only escaping written by previous versions
	assert.equal(File.decode("line1\\nline2", field), "line1\nline2");
	// plain text is unchanged
	assert.equal(File.decode("hello world", field), "hello world");
	// common strings (no backslash / CR) are stored byte-identically to before
	assert.equal(File.encode("hello\nworld"), "hello\\nworld");
	assert.equal(File.encode("plain text"), "plain text");
});

test("non-string fields keep Inison decoding", () => {
	assert.deepEqual(
		File.decode("[a,b]", { key: "v", type: "array", children: "string" }),
		["a", "b"],
	);
	assert.deepEqual(File.decode("{a:1}", { key: "v", type: "json" }), { a: 1 });
});

test("end to end: post, get, search and put keep strings exact", async (t) => {
	removeDatabase();
	const inibase = new Inibase(dbPath);
	const tableName = "tools";
	const schema: Schema = [
		{ key: "name", type: "string", required: true },
		{ key: "code", type: "string" },
		{ key: "body", type: "html" },
	];
	await inibase.createTable(tableName, schema);

	const ids: Record<string, string> = {};
	await t.test("post + get by id", async () => {
		for (const [label, value] of Object.entries(CASES)) {
			// the engine trims string values on write; keep that behaviour out
			// of this test by comparing against the trimmed value
			const expected = value.trim();
			const item = (await inibase.post(
				tableName,
				{ name: label, code: value, body: HTML_TOOL },
				undefined,
				true,
			)) as { id: string };
			ids[label] = item.id;
			const got = (await inibase.get(tableName, item.id, undefined, true)) as {
				code: string;
				body: string;
			};
			assert.equal(got.code, expected, `code: ${label}`);
			assert.equal(got.body, HTML_TOOL, `body: ${label}`);
		}
	});

	await t.test("every column file keeps one line per row", () => {
		const tablePath = join(dbPath, tableName);
		const total = Object.keys(CASES).length;
		for (const file of readdirSync(tablePath).filter((f) =>
			/^(name|code|body)\./.test(f),
		)) {
			const raw = readFileSync(join(tablePath, file), "utf8");
			const lines = raw.split("\n").length - (raw.endsWith("\n") ? 1 : 0);
			assert.equal(lines, total, `${file} line count`);
		}
	});

	await t.test("equality search on an escaped value", async () => {
		const value = "x.join('\\n')";
		const found = (await inibase.get(tableName, { code: value })) as {
			name: string;
		}[];
		assert.equal(found?.length, 1);
		assert.equal(found[0].name, "literal \\n in code");
	});

	await t.test("put keeps strings exact", async () => {
		const id = ids["percent sign"];
		await inibase.put(tableName, { code: HTML_TOOL }, id);
		const got = (await inibase.get(tableName, id, undefined, true)) as {
			code: string;
		};
		assert.equal(got.code, HTML_TOOL);
	});

	removeDatabase();
});

test("a legacy column file written by an older version still reads", async () => {
	removeDatabase();
	const inibase = new Inibase(dbPath);
	const tableName = "legacy";
	await inibase.createTable(tableName, [{ key: "note", type: "string" }]);
	await inibase.post(tableName, { note: "placeholder" });
	const tablePath = join(dbPath, tableName);
	const noteFile = readdirSync(tablePath).find((f) => f.startsWith("note."));
	assert.ok(noteFile, "note column file exists");
	// what 3.4.0 wrote for "first line\nsecond line"
	writeFileSync(join(tablePath, noteFile), "first line\\nsecond line\n");
	const [row] = (await inibase.get(tableName)) as { note: string }[];
	assert.equal(row.note, "first line\nsecond line");
	removeDatabase();
});
