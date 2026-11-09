import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Inibase from "../src/index.js";

const child = (root: string, mode: string, number = 0) => {
	const process = fork(
		fileURLToPath(new URL("./storage.child.ts", import.meta.url)),
		[root, mode, String(number)],
		{ execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] },
	);
	const messages: unknown[] = [];
	let errors = "";
	process.stderr?.on("data", (value) => {
		errors += value;
	});
	process.on("message", (value) => {
		messages.push(value);
	});
	const done = new Promise<{
		code: number | null;
		signal: string | null;
		messages: unknown[];
		errors: string;
	}>((resolve, reject) => {
		process.on("error", reject);
		process.on("exit", (code, signal) =>
			resolve({ code, signal, messages, errors }),
		);
	});
	return { process, done };
};
const seed = async (root: string) => {
	const db = new Inibase("db", root);
	await db.createTable(
		"records",
		[
			{ key: "key", type: "string", unique: true },
			{ key: "score", type: "number" },
		],
		{
			log: true,
			tombstones: true,
			decodeID: true,
			compression: true,
			seekable: true,
			indexes: ["key"],
		},
	);
	await db.post(
		"records",
		Array.from({ length: 30 }, (_, i) => ({
			key: `seed-${i + 1}`,
			score: i + 1,
		})),
	);
	await db.put("records", { score: 222 }, 22);
	await db.delete("records", 3);
	await db.close();
};

for (const [phase, number] of [
	["before-log", 0],
	["after-log", 0],
	["after-log-sync", 0],
	["ack", 0],
	["compact", 1],
	["compact", 2],
	["compact", 5],
	["migration", 1],
	["migration", 2],
	["migration", 5],
] as const) {
	test(
		`SIGKILL recovery: ${phase} ${number} (process crash, not power loss)`,
		{ timeout: 30000 },
		async () => {
			const root = await mkdtemp(join(tmpdir(), "inibase-kill-"));
			try {
				await seed(root);
				const verdict = await child(root, `crash:${phase}`, number).done;
				assert.equal(verdict.signal, "SIGKILL", verdict.errors);
				const db = new Inibase("db", root);
				try {
					assert.equal(await db.get("records", 3), null);
					assert.equal(((await db.get("records", 22)) as any).score, 222);
					const value = ((await db.get("records", 10)) as any).score;
					assert.ok(value === 10 || value === 777);
					if (["after-log-sync", "ack"].includes(phase))
						assert.equal(value, 777);
					if (phase === "before-log") assert.equal(value, 10);
					assert.equal(
						((await db.get("records", undefined, { perPage: -1 })) as any[])
							.length,
						29,
					);
					await db.put("records", { score: 999 }, 15);
					await db.compact("records");
					assert.equal(((await db.get("records", 15)) as any).score, 999);
				} finally {
					await db.close();
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
}

test(
	"multiple process writers/readers maintain indexed key changes, deletes and compaction",
	{ timeout: 60000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "inibase-process-"));
		try {
			await seed(root);
			const reader = child(root, "reader");
			const writers = [0, 1, 2].map((worker) => child(root, "writer", worker));
			const outcomes = await Promise.all(writers.map((writer) => writer.done));
			reader.process.send("stop");
			const read = await reader.done;
			for (const outcome of [...outcomes, read])
				assert.equal(outcome.code, 0, outcome.errors);
			assert.ok(read.messages.some((value: any) => value.iterations > 0));
			const uniques = await Promise.all([
				child(root, "unique").done,
				child(root, "unique").done,
			]);
			assert.deepEqual(uniques.flatMap((result) => result.messages).sort(), [
				"duplicate",
				"inserted",
			]);
			const db = new Inibase("db", root);
			try {
				const rows =
					(await db.get("records", undefined, { perPage: -1 })) ?? [];
				assert.equal(rows.length, 29 + 3 * 5 + 1);
				for (let worker = 0; worker < 3; worker++)
					for (let i = 0; i < 8; i++) {
						const value = await db.get("records", {
							key: `${worker}:${i}:ready`,
						});
						if (i % 3 === 0) assert.equal(value, null);
						else assert.equal((value as any[])[0].score, i);
					}
			} finally {
				await db.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
