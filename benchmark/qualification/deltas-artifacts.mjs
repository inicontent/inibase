// Source reconstruction after timing trials finish; never overlap builds with timings.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2]),
	repository = process.cwd();
const json = async (p) => JSON.parse(await readFile(p, "utf8"));
const hash = async (p) =>
	createHash("sha256")
		.update(await readFile(p))
		.digest("hex");
await cp(
	"benchmark/results/public-chunks-20261018/after-source.tar.gz",
	join(root, "before-source.tar.gz"),
);
execFileSync("tar", [
	"-czf",
	join(root, "qualified-source.tar.gz"),
	"src",
	"package.json",
	"tsconfig.json",
	"pnpm-lock.yaml",
]);
execFileSync("tar", [
	"-czf",
	join(root, "tests-source.tar.gz"),
	"tests",
	"benchmark/qualification/checks.mjs",
]);
execFileSync("tar", [
	"-czf",
	join(root, "tooling.tar.gz"),
	"--exclude=node_modules",
	"benchmark/qualification/postgres",
	"benchmark/qualification/deltas-artifacts.mjs",
	"benchmark/qualification/deltas-report.mjs",
	"benchmark/qualification/public-write-profile.mjs",
	"benchmark/qualification/local-profile.mjs",
]);
const evidence = { sources: [], tools: [] };
for (const [archive, matrix, environment] of [
	[
		"before-source.tar.gz",
		"before",
		"benchmark/results/public-chunks-20261018/after/environment.json",
	],
	[
		"initial-source.tar.gz",
		"comparison",
		join(root, "comparison/environment.json"),
	],
	...["qualified", "stress", "concurrent", "recovery"].map((name) => [
		"intermediate-source.tar.gz",
		`intermediate-${name}`,
		join(root, `intermediate-${name}/environment.json`),
	]),
	...["qualified", "stress", "concurrent", "recovery"].map((name) => [
		"qualified-source.tar.gz",
		name,
		join(root, name, "environment.json"),
	]),
]) {
	const directory = await mkdtemp("/private/tmp/inibase-delta-rebuild-");
	try {
		execFileSync("tar", ["-xzf", join(root, archive), "-C", directory]);
		await symlink(
			join(repository, "node_modules"),
			join(directory, "node_modules"),
		);
		execFileSync(
			process.execPath,
			[
				join(repository, "node_modules/typescript/bin/tsc"),
				"--project",
				join(directory, "tsconfig.json"),
			],
			{ cwd: directory },
		);
		const metadata = await json(environment),
			modules = [];
		for (const [name, expected] of Object.entries(metadata.hashes))
			modules.push({
				name,
				expected,
				actual: await hash(join(directory, "dist", name)),
			});
		assert.deepEqual(
			(await readdir(join(directory, "dist")))
				.filter((n) => n.endsWith(".js"))
				.sort(),
			Object.keys(metadata.hashes).sort(),
		);
		assert.ok(modules.every((m) => m.actual === m.expected));
		if (matrix === "intermediate-qualified") {
			await mkdir(join(directory, "tests"), { recursive: true });
			for (const name of [
				"automatic-deltas.test.ts",
				"automatic-deltas.child.ts",
			])
				await cp(join("tests", name), join(directory, "tests", name));
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					"--test",
					"--test-name-pattern=a cache-prefix lock|compressed sort spools",
					join(directory, "tests/automatic-deltas.test.ts"),
				],
				{ cwd: directory, encoding: "utf8" },
			);
			await writeFile(
				join(root, "intermediate-ownership-regression.log"),
				`${result.stdout ?? ""}${result.stderr ?? ""}`,
			);
			assert.notEqual(result.status, 0);
			assert.ok((result.stdout ?? "").includes("cache-prefix lock"));
			evidence.ownershipRegression = {
				expectedFailure: true,
				status: result.status,
			};
		}
		if (matrix === "before") {
			await mkdir(join(directory, "tests"), { recursive: true });
			await cp(
				"tests/automatic-deltas.test.ts",
				join(directory, "tests/automatic-deltas.test.ts"),
			);
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					"--test",
					"--test-name-pattern=automatic point writes/deletes keep",
					join(directory, "tests/automatic-deltas.test.ts"),
				],
				{ cwd: directory, encoding: "utf8" },
			);
			await writeFile(
				join(root, "before-regression.log"),
				`${result.stdout ?? ""}${result.stderr ?? ""}`,
			);
			assert.notEqual(result.status, 0);
			assert.ok(
				(result.stdout ?? "").includes("automatic point writes/deletes"),
			);
			evidence.beforeRegression = {
				expectedFailure: true,
				status: result.status,
			};
		}
		evidence.sources.push({
			archive,
			matrix,
			sha256: await hash(join(root, archive)),
			matched: true,
			modules,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
for (const matrix of [
	"comparison",
	"intermediate-qualified",
	"intermediate-stress",
	"intermediate-concurrent",
	"intermediate-recovery",
	"qualified",
	"stress",
	"concurrent",
	"recovery",
]) {
	const metadata = await json(join(root, matrix, "environment.json"));
	for (const [name, expected] of Object.entries(metadata.tools)) {
		const actual = await hash(
			join(repository, "benchmark/qualification/postgres", name),
		);
		assert.equal(actual, expected);
		evidence.tools.push({ matrix, name, expected, actual, matched: true });
	}
}
const deps = await json(
	"benchmark/results/public-chunks-20261018/dependency-verification.json",
);
for (const c of deps.checks) {
	const actual = c.path
		? await hash(c.path)
		: (
				await json(
					c.package === "pg"
						? "benchmark/qualification/postgres/node_modules/pg/package.json"
						: `node_modules/${c.package}/package.json`,
				)
			).version;
	assert.equal(actual, c.expected);
	c.actual = actual;
}
const dependencies = await json(
	"benchmark/results/public-chunks-20261018/dependencies.json",
);
assert.deepEqual(dependencies.node, process.versions);
await writeFile(
	join(root, "dependency-verification.json"),
	`${JSON.stringify({ ...deps, verified: true }, null, 2)}\n`,
);
await cp(
	"benchmark/results/public-chunks-20261018/dependencies.json",
	join(root, "dependencies.json"),
);
await cp(
	"benchmark/results/public-chunks-20261018/storage-hardware.txt",
	join(root, "storage-hardware.txt"),
);
evidence.archives = {};
for (const name of [
	"before-source.tar.gz",
	"initial-source.tar.gz",
	"intermediate-source.tar.gz",
	"qualified-source.tar.gz",
	"tests-source.tar.gz",
	"tooling.tar.gz",
])
	evidence.archives[name] = await hash(join(root, name));
await writeFile(
	join(root, "reproduction.json"),
	`${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(
	JSON.stringify({
		sources: evidence.sources.map((s) => ({
			archive: s.archive,
			matrix: s.matrix,
			matched: s.matched,
		})),
		tools: evidence.tools.length,
	}),
);
