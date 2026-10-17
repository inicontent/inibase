// Synthetic-only contract probe. Never takes a customer database path.
// LEGACY_INIBASE_MODULE=/isolated/inibase-3.2.0/dist/index.js node tests/production-upgrade.mjs
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

assert.ok(
	process.env.LEGACY_INIBASE_MODULE,
	"explicit isolated legacy engine module required",
);
process.env.INIBASE_SECRET = "11".repeat(32); // Public synthetic fixture, not a production key.
process.env.CACHE_ENABLED = "false";
process.env.INIBASE_CACHE = "false";
process.env.INIBASE_COMPRESSION = "false";
process.env.DOTENV_CONFIG_PATH = "/nonexistent-production-probe-env";
const legacyPath = process.env.LEGACY_INIBASE_MODULE;
const { default: Legacy } = await import(pathToFileURL(legacyPath));
const { default: Current } = await import("../dist/index.js");
const oldCrypto = await import(
	pathToFileURL(join(dirname(legacyPath), "utils.server.js"))
);
const newCrypto = await import("../dist/utils.server.js");
const root = await mkdtemp(join(tmpdir(), "inibase-production-upgrade-"));
const report = {
	legacy: "3.2.0",
	current: "3.8.0+sparse-read",
	syntheticOnly: true,
	checks: [],
	differences: [],
};
try {
	const old = new Legacy("fixture", root);
	await old.createTable("records", [
		{ key: "label", type: "string" },
		{ key: "count", type: "number" },
		{ key: "password", type: "password" },
	]);
	for (const label of [
		"plain",
		"مرحبا",
		"100%",
		"literal%20value",
		"line\nbreak",
		"slash\\value",
	])
		await old.post("records", {
			label,
			count: 1,
			password: "synthetic-password-only",
		});
	const before = await old.get("records", undefined, { perPage: -1 });
	const current = new Current("fixture", root);
	const after = await current.get("records", undefined, { perPage: -1 });
	for (let index = 0; index < before.length; index++) {
		if (before[index].label !== after[index].label)
			report.differences.push({
				direction: "old-write/new-read",
				row: index + 1,
				field: "label",
			});
		assert.equal(
			before[index].id,
			after[index].id,
			"encrypted identifiers changed",
		);
		assert.equal(
			newCrypto.comparePassword(
				after[index].password,
				"synthetic-password-only",
			),
			true,
		);
	}
	report.checks.push("legacy identifiers and password hashes preserved");
	assert.equal(
		oldCrypto.encodeID("1.1.1000.1000"),
		newCrypto.encodeID("1.1.1000.1000"),
		"legacy session cipher changed",
	);
	report.checks.push("legacy session cipher bytes unchanged with retained key");
	await current.put("records", { count: 2 }, after[0].id);
	assert.equal((await old.get("records", before[0].id)).count, 2);
	report.checks.push("plain legacy row read/update/readback works");
	await current.post("records", { label: "new\\escaped\nvalue", count: 3 });
	const newer = await current.get("records", undefined, { perPage: -1 });
	const downgraded = await old.get("records", undefined, { perPage: -1 });
	if (newer.at(-1).label !== downgraded.at(-1).label)
		report.differences.push({
			direction: "new-write/old-read",
			row: newer.length,
			field: "label",
		});
	assert.ok(
		!(await readdir(join(root, "fixture", "records"))).includes(".format"),
		"putLog/format migration unexpectedly enabled",
	);
	report.checks.push("no automatic format marker or putLog migration");
	console.log(JSON.stringify(report, null, 2));
	if (report.differences.length) process.exitCode = 1;
} finally {
	await rm(root, { recursive: true, force: true });
}
