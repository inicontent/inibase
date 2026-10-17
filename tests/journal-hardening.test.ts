import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Journal, recover } from "../src/journal.js";

test("failed rollback retains its journal and backup for a later recovery", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-journal-"));
	try {
		await mkdir(join(root, ".tmp/backup/txn"), { recursive: true });
		const backup = join(root, ".tmp/backup/txn/value.txt");
		const live = join(root, "missing/value.txt");
		await writeFile(backup, "acknowledged-value\n");
		const journal = new Journal(root, "txn");
		await journal.begin([{ live, backup, tmp: null, existed: true }]);
		await assert.rejects(() => journal.rollback(), (error: any) => error.code === "ENOENT");
		assert.ok(existsSync(journal.path)); assert.ok(existsSync(backup));
		await mkdir(join(root, "missing"));
		await recover(join(root, ".tmp"));
		assert.equal(await readFile(live, "utf8"), "acknowledged-value\n");
		assert.equal(existsSync(journal.path), false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("complete malformed journal records fail closed instead of being skipped", async () => {
	const root = await mkdtemp(join(tmpdir(), "inibase-journal-"));
	try {
		await mkdir(join(root, ".tmp"));
		const path = join(root, ".tmp/journal.jsonl");
		await writeFile(path, `${JSON.stringify({ txn: "txn", type: "begin", files: [] })}\n{broken}\n${JSON.stringify({ txn: "txn", type: "commit" })}\n`);
		await assert.rejects(() => recover(join(root, ".tmp")), /JOURNAL_CORRUPT/);
		assert.ok(existsSync(path));
	} finally { await rm(root, { recursive: true, force: true }); }
});
