// Run after benchmarks: reconstruction/type-checking must not overlap timings.
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
import os from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2]);
const repository = process.cwd();
const hash = async (file) =>
	createHash("sha256")
		.update(await readFile(file))
		.digest("hex");
const evidence = {
	sources: [],
	tools: [],
	baselineLockRegression: null,
	baselineGenerationRegression: null,
};
for (const [archive, measurements] of [
	["candidate-source.tar.gz", "kernel-write-through"],
	["qualified-source.tar.gz", "kernel-qualified"],
	["qualified-source.tar.gz", "public-write-through"],
	["aligned-source.tar.gz", "kernel-aligned"],
	["final-source.tar.gz", "kernel-final"],
]) {
	const directory = await mkdtemp(
		join(os.tmpdir(), "inibase-rowstore-artifact-"),
	);
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
			{ cwd: directory, stdio: "pipe" },
		);
		const metadata = JSON.parse(
			await readFile(join(root, measurements, "environment.json"), "utf8"),
		);
		const modules = [];
		for (const [name, expected] of Object.entries(metadata.hashes))
			modules.push({
				name,
				expected,
				actual: await hash(join(directory, "dist", name)),
			});
		const observed = (await readdir(join(directory, "dist")))
			.filter((name) => name.endsWith(".js"))
			.sort();
		const matched =
			modules.every((module) => module.expected === module.actual) &&
			JSON.stringify(observed) ===
				JSON.stringify(Object.keys(metadata.hashes).sort());
		evidence.sources.push({
			archive,
			measurements,
			archiveSha256: await hash(join(root, archive)),
			matched,
			modules,
		});
		if (!matched) throw new Error(`Source artifact mismatch: ${measurements}`);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
const toolDirectory = await mkdtemp(
	join(os.tmpdir(), "inibase-rowstore-tools-"),
);
try {
	execFileSync("tar", [
		"-xzf",
		join(root, "tooling.tar.gz"),
		"-C",
		toolDirectory,
	]);
	for (const measurements of [
		"kernel-write-through",
		"kernel-qualified",
		"public-write-through",
		"kernel-aligned",
		"kernel-final",
	]) {
		const metadata = JSON.parse(
			await readFile(join(root, measurements, "environment.json"), "utf8"),
		);
		for (const [name, expected] of Object.entries(metadata.tools)) {
			const actual = await hash(
				join(toolDirectory, "benchmark/qualification/postgres", name),
			);
			evidence.tools.push({
				measurements,
				name,
				expected,
				actual,
				matched: expected === actual,
			});
			if (actual !== expected)
				throw new Error(`Tool artifact mismatch: ${measurements}/${name}`);
		}
	}
} finally {
	await rm(toolDirectory, { recursive: true, force: true });
}

// Reproduce the lock-file leak with the pre-fix File implementation, isolated.
const regression = await mkdtemp(
	join(os.tmpdir(), "inibase-rowstore-lock-baseline-"),
);
try {
	execFileSync("tar", [
		"-xzf",
		join(root, "qualified-source.tar.gz"),
		"-C",
		regression,
	]);
	await mkdir(join(regression, "tests"));
	await cp(
		join(repository, "tests/rowstore.test.ts"),
		join(regression, "tests/rowstore.test.ts"),
	);
	await symlink(
		join(repository, "node_modules"),
		join(regression, "node_modules"),
	);
	const oldFile = execFileSync("git", ["show", "19058a7:src/file.ts"], {
		cwd: repository,
	});
	await writeFile(join(regression, "src/file.ts"), oldFile);
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--test",
			"--test-name-pattern=actual synchronization errors",
			"tests/rowstore.test.ts",
		],
		{
			cwd: regression,
			encoding: "utf8",
			timeout: 15000,
			env: { ...process.env, INIBASE_DURABILITY: "full" },
		},
	);
	await writeFile(
		join(root, "before-lock-fix.log"),
		`${result.stdout}\n${result.stderr}`,
	);
	evidence.baselineLockRegression = {
		baselineFileCommit: "19058a7",
		baselineFileSha256: createHash("sha256").update(oldFile).digest("hex"),
		code: result.status,
		signal: result.signal,
		error: result.error?.message,
		expectedAssertionFailure:
			result.status === 1 && /true !== false/.test(result.stdout),
		scope:
			"Qualified source and one focused test with the exact pre-fix File implementation; original optional-depth user edit is absent and unrelated to this lock-initialization failure.",
	};
	if (!evidence.baselineLockRegression.expectedAssertionFailure)
		throw new Error(
			"Baseline did not reproduce the expected stale-lock assertion",
		);
} finally {
	await rm(regression, { recursive: true, force: true });
}
const generation = await mkdtemp(
	join(os.tmpdir(), "inibase-rowstore-generation-baseline-"),
);
try {
	execFileSync("tar", [
		"-xzf",
		join(root, "aligned-source.tar.gz"),
		"-C",
		generation,
	]);
	await mkdir(join(generation, "tests"));
	await cp(
		join(repository, "tests/rowstore.test.ts"),
		join(generation, "tests/rowstore.test.ts"),
	);
	await symlink(
		join(repository, "node_modules"),
		join(generation, "node_modules"),
	);
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--test",
			"--test-name-pattern=replaced generation paths",
			"tests/rowstore.test.ts",
		],
		{
			cwd: generation,
			encoding: "utf8",
			timeout: 15000,
			env: { ...process.env, INIBASE_DURABILITY: "full" },
		},
	);
	await writeFile(
		join(root, "before-generation-check-artifact.log"),
		`${result.stdout}\n${result.stderr}`,
	);
	evidence.baselineGenerationRegression = {
		sourceArchive: "aligned-source.tar.gz",
		sourceCommit: "1ddd7c4",
		code: result.status,
		signal: result.signal,
		error: result.error?.message,
		expectedAssertionFailure:
			result.status === 1 && /Missing expected rejection/.test(result.stdout),
	};
	if (!evidence.baselineGenerationRegression.expectedAssertionFailure)
		throw new Error(
			"Baseline did not reproduce the expected generation replacement failure",
		);
} finally {
	await rm(generation, { recursive: true, force: true });
}
await writeFile(
	join(root, "artifact-reproduction.json"),
	`${JSON.stringify(evidence, null, 2)}\n`,
);
console.log({
	reconstructedSources: evidence.sources.length,
	toolChecks: evidence.tools.length,
	baselineLockRegression:
		evidence.baselineLockRegression.expectedAssertionFailure,
	baselineGenerationRegression:
		evidence.baselineGenerationRegression.expectedAssertionFailure,
});
