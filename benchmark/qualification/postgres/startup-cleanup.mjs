import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	chmod,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// Inject failure after a real server starts. A failed pg_ctl must not leak it.
const output = resolve(process.argv[2]);
const binaries = resolve(
	process.argv[3] ?? "/opt/homebrew/opt/postgresql@18/bin",
);
const fixture = await mkdtemp("/private/tmp/inibase-pg-fault-");
const before = new Set(await readdir(".work"));
const command = promisify(execFile);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const proof = { expectedStartExit: 42, expectedStatusExit: 3 };
try {
	for (const name of ["initdb", "postgres"])
		await symlink(join(binaries, name), join(fixture, name));
	await writeFile(
		join(fixture, "pg_ctl"),
		`#!/bin/sh
${quote(join(binaries, "pg_ctl"))} "$@"
pg_status=$?
if [ "$pg_status" -ne 0 ]; then exit "$pg_status"; fi
for pg_arg do :; done
if [ "$pg_arg" = start ]; then exit 42; fi
exit 0
`,
	);
	await chmod(join(fixture, "pg_ctl"), 0o700);
	try {
		await command(process.execPath, [
			new URL("./run.mjs", import.meta.url).pathname,
			`--pgBin=${fixture}`,
			"--engines=postgres",
			"--rows=1000",
			"--profiles=compact",
			"--repeats=1",
			`--output=${output}`,
		]);
		assert.fail("injected startup failure unexpectedly succeeded");
	} catch (error) {
		assert.equal(error.code, 1);
		proof.runner = {
			code: error.code,
			stdout: error.stdout,
			stderr: error.stderr,
		};
	}
	const failures = JSON.parse(
		await readFile(join(output, "failures.json"), "utf8"),
	);
	assert.equal(failures.length, 1);
	const resources = JSON.parse(
		await readFile(
			join(output, "postgres-compact-1000-1.resources.json"),
			"utf8",
		),
	);
	assert.ok(
		resources.serverStopMs >= 0,
		"finally must stop the server even though startup threw",
	);
	const directories = (await readdir(".work")).filter(
		(name) => name.startsWith("postgres-compare-") && !before.has(name),
	);
	assert.equal(directories.length, 1);
	proof.directory = resolve(".work", directories[0]);
	try {
		await command(join(binaries, "pg_ctl"), [
			"-D",
			join(proof.directory, "cluster"),
			"status",
		]);
		assert.fail("server leaked after failed startup");
	} catch (error) {
		assert.equal(error.code, 3);
		proof.serverStatus = {
			code: error.code,
			stdout: error.stdout,
			stderr: error.stderr,
		};
	}
	proof.verified = true;
} finally {
	await rm(fixture, { recursive: true, force: true });
	await writeFile(
		`${output}.proof.json`,
		`${JSON.stringify(proof, null, 2)}\n`,
	);
}
console.log(proof);
