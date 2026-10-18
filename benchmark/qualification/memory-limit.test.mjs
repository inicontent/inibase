import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("./memory-limit.mjs", import.meta.url));
test(
	"unsupported hosts retain failure evidence and never execute the workload",
	{ skip: process.platform === "linux" },
	async () => {
		const temporary = await mkdtemp(
			join(os.tmpdir(), "inibase-memory-refusal-"),
		);
		try {
			const output = join(temporary, "result");
			const result = spawnSync(
				process.execPath,
				[
					launcher,
					"--bytes=67108864",
					`--output=${output}`,
					"--",
					process.execPath,
					"-e",
					"process.stdout.write('WORKLOAD_EXECUTED')",
				],
				{ encoding: "utf8" },
			);
			assert.equal(result.status, 1);
			assert.doesNotMatch(result.stdout, /WORKLOAD_EXECUTED/);
			const evidence = JSON.parse(
				await readFile(join(output, "memory-limit.json"), "utf8"),
			);
			assert.equal(evidence.qualified, false);
			assert.equal(evidence.status, "unqualified");
			assert.match(evidence.error, /require Linux cgroup v2/);
			const repeat = spawnSync(
				process.execPath,
				[launcher, "--bytes=67108864", `--output=${output}`, "--", "true"],
				{ encoding: "utf8" },
			);
			assert.notEqual(repeat.status, 0);
			assert.deepEqual(
				JSON.parse(await readFile(join(output, "memory-limit.json"), "utf8")),
				evidence,
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	},
);

test("invalid limits fail before starting the workload", () => {
	for (const bytes of ["0", "-1", "NaN", "9007199254740992"]) {
		const result = spawnSync(
			process.execPath,
			[
				launcher,
				`--bytes=${bytes}`,
				"--output=/unused",
				"--",
				process.execPath,
				"-e",
				"process.stdout.write('WORKLOAD_EXECUTED')",
			],
			{ encoding: "utf8" },
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Usage:/);
		assert.doesNotMatch(result.stdout, /WORKLOAD_EXECUTED/);
	}
});
