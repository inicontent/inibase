import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { replacementChunks } from "../src/column-replace.js";
import * as File from "../src/file.js";

async function edited(
	text: string,
	changes: Record<number, unknown>,
	chunkBytes: number,
) {
	const data = Buffer.from(text);
	function* chunks() {
		for (let i = 0; i < data.length; i += chunkBytes)
			yield data.subarray(i, i + chunkBytes);
	}
	const output: Buffer[] = [];
	for await (const chunk of replacementChunks(
		Readable.from(chunks()),
		changes,
	)) {
		assert.ok(chunk.length <= 65536);
		output.push(chunk);
	}
	return Buffer.concat(output).toString();
}

test("chunked replacements preserve mixed line endings, empty cells, Unicode and EOF", async () => {
	const inputs = [
		"",
		"a",
		"\n",
		"\r",
		"\r\n",
		"a\r\nb\nc\rd",
		"\n\nlast\n",
		"🙂 العربية\r\nβ\nend",
		"a\r\n\r\nb",
	];
	for (const text of inputs) {
		const rows = text.split(/\r\n|\r|\n/);
		if (text === "" || /[\r\n]$/.test(text)) rows.pop();
		for (const changes of [
			{},
			{ 1: "new" },
			{ 2: "" },
			{ 1: null, 3: false },
			{ 2: ["a", "b"] },
		]) {
			const existing = rows
				.map(
					(value, i) =>
						`${String(
							Object.hasOwn(changes, i + 1)
								? changes[(i + 1) as keyof typeof changes]
								: value,
						)}\n`,
				)
				.join("");
			const extra = Object.keys(changes)
				.map(Number)
				.filter((n) => n > rows.length)
				.sort((a, b) => a - b);
			let suffix = "",
				next = rows.length + 1;
			for (const n of extra) {
				suffix +=
					"\n".repeat(n - next) + String(changes[n as keyof typeof changes]);
				next = n;
			}
			for (const chunkBytes of [1, 2, 3, 7, 65536])
				assert.equal(
					await edited(text, changes, chunkBytes),
					existing + suffix,
					JSON.stringify({ text, changes, chunkBytes }),
				);
		}
	}
});

test("large unchanged and replacement cells stream in bounded chunks including surrogate boundaries", async () => {
	const huge = "🙂العربية".repeat(200000);
	assert.equal(
		await edited(`${huge}\nold\ntail`, { 2: huge }, 65536),
		`${huge}\n${huge}\ntail\n`,
	);
	assert.equal(
		await edited("a\n", { 100000: "last" }, 65536),
		`a\n${"\n".repeat(99998)}last`,
	);
});

test("plain and multi-member gzip sparse rewrites preserve bytes; corrupt streams fail and clean temps", async () => {
	const dir = await mkdtemp(join(tmpdir(), "inibase-column-edit-"));
	try {
		await mkdir(join(dir, ".tmp"));
		for (const compressed of [false, true]) {
			const file = join(dir, compressed ? "cells.gz" : "cells");
			const first = "a\n\n🙂\n",
				second = "d\ne";
			await writeFile(
				file,
				compressed
					? Buffer.concat([gzipSync(first), gzipSync(second)])
					: first + second,
			);
			const [temp] = await File.replace(file, { 2: "changed", 5: 42 });
			assert.ok(temp);
			const raw = await readFile(temp);
			assert.equal(
				(compressed ? gunzipSync(raw) : raw).toString(),
				"a\nchanged\n🙂\nd\n42\n",
			);
			await rm(temp);
		}
		const corrupt = join(dir, "corrupt.gz");
		await writeFile(corrupt, gzipSync("a\nb\n").subarray(0, -5));
		await assert.rejects(File.replace(corrupt, { 1: "bad" }));
		assert.deepEqual(await readdir(join(dir, ".tmp")), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
