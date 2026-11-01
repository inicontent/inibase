// Run only after timed workloads have stopped.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cp,
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
	"benchmark/results/rowstore-20261018/final-source.tar.gz",
	join(root, "before-source.tar.gz"),
);
execFileSync("tar", [
	"-czf",
	join(root, "after-source.tar.gz"),
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
execFileSync(
	"tar",
	[
		"-czf",
		join(root, "tooling.tar.gz"),
		"--exclude=node_modules",
		"benchmark/qualification/postgres",
		"benchmark/qualification/column-replace-profile.mjs",
		"benchmark/qualification/public-write-profile.mjs",
		"benchmark/qualification/local-profile.mjs",
		"benchmark/qualification/public-chunks-report.mjs",
		"benchmark/qualification/public-chunks-artifacts.mjs",
	],
	{ maxBuffer: 1024 * 1024 },
);
const evidence = { sources: [], tools: [], publicGraph: null };
for (const [archive, matrix] of [
	["before-source.tar.gz", "before"],
	["after-source.tar.gz", "after"],
	["after-source.tar.gz", "after-small"],
]) {
	const directory = await mkdtemp("/private/tmp/inibase-chunks-rebuild-");
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
		const metadata = await json(join(root, matrix, "environment.json"));
		const modules = [];
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
		assert.ok(modules.every((m) => m.expected === m.actual));
		evidence.sources.push({
			archive,
			matrix,
			sha256: await hash(join(root, archive)),
			matched: true,
			modules,
		});
		if (matrix === "before") {
			const historical = await json(
				"benchmark/results/rowstore-20261018/public-write-through/environment.json",
			);
			const visited = new Set();
			async function visit(name) {
				if (visited.has(name)) return;
				visited.add(name);
				const text = await readFile(join(directory, "dist", name), "utf8");
				for (const match of text.matchAll(
					/(?:from\s*|import\s*\(?)['"]\.\/([^'"]+\.js)['"]/g,
				))
					await visit(match[1]);
			}
			await visit("index.js");
			for (const name of visited)
				assert.equal(metadata.hashes[name], historical.hashes[name], name);
			const differences = Object.keys(metadata.hashes).filter(
				(n) => metadata.hashes[n] !== historical.hashes[n],
			);
			assert.deepEqual(differences, ["rowstore.js"]);
			assert.equal(visited.has("rowstore.js"), false);
			evidence.publicGraph = {
				matchedHistorical: true,
				modules: [...visited].sort(),
				unimportedDifferences: differences,
			};
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
for (const matrix of ["before", "after", "after-small"]) {
	const metadata = await json(join(root, matrix, "environment.json"));
	for (const [name, expected] of Object.entries(metadata.tools)) {
		const actual = await hash(
			join(repository, "benchmark/qualification/postgres", name),
		);
		assert.equal(actual, expected);
		evidence.tools.push({ matrix, name, expected, actual, matched: true });
	}
}
const check = await json(join(root, "baseline-artifact-check.json"));
check.publicGraph = evidence.publicGraph;
await writeFile(
	join(root, "baseline-artifact-check.json"),
	`${JSON.stringify(check, null, 2)}\n`,
);
evidence.archives = {};
for (const name of [
	"before-source.tar.gz",
	"after-source.tar.gz",
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
		publicGraph: evidence.publicGraph,
	}),
);
