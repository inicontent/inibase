import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Inibase from "../src/index.js";

test(
	"a read starting during paused file publication cannot return a missing committed key",
	{ timeout: 15000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "inibase-publication-"));
		const db = new Inibase("db", root);
		let child: ReturnType<typeof fork> | undefined;
		try {
			await db.createTable(
				"records",
				[
					{ key: "key", type: "string" },
					{ key: "score", type: "number" },
				],
				{ compression: true, decodeID: true, cache: false },
			);
			await db.post("records", [
				{ key: "removed", score: 1 },
				{ key: "retained", score: 2 },
			]);
			await db.optimize("records", { indexes: ["key"] });
			child = fork(new URL("./publication.child.ts", import.meta.url), [root], {
				execArgv: ["--import", "tsx"],
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			});
			child.stdout?.resume();
			let stderr = "";
			child.stderr?.on("data", (chunk) => {
				stderr += chunk;
			});
			const done = new Promise<void>((resolve, reject) => {
				child?.on("error", reject);
				child?.on("exit", (code, signal) =>
					code === 0
						? resolve()
						: reject(new Error(`${code}/${signal}: ${stderr}`)),
				);
			});
			done.catch(() => {});
			const message = (expected: string) =>
				new Promise<void>((resolve, reject) => {
					const listener = (value: unknown) => {
						if (value === expected) {
							child?.off("message", listener);
							resolve();
						}
					};
					child?.on("message", listener);
					done.then(() => reject(new Error(`exit before ${expected}`)), reject);
				});
			await message("ready");
			const original = (db as any).snapshotTableFiles.bind(db);
			let enteredResolve!: () => void;
			const entered = new Promise<void>((resolve) => {
				enteredResolve = resolve;
			});
			let first = true;
			(db as any).snapshotTableFiles = async (...args: unknown[]) => {
				if (first) {
					first = false;
					const paused = message("paused");
					child?.send("start");
					await paused;
					enteredResolve();
				}
				return original(...args);
			};
			let settled = false;
			const read = db
				.get("records", { key: "retained" }, { perPage: -1 })
				.finally(() => {
					settled = true;
				});
			read.catch(() => {});
			await entered;
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(
				settled,
				false,
				"read must wait while a committed primary column is temporarily absent",
			);
			child.send("release");
			const values = await read;
			assert.equal(values?.length, 1);
			assert.equal(values?.[0].key, "retained");
			assert.equal(values?.[0].score, 2);
			await done;
		} finally {
			if (child?.exitCode === null && !child.signalCode) {
				child.kill("SIGKILL");
				await new Promise((resolve) => child?.once("exit", resolve));
			}
			await db.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);

for (const operation of ["put", "delete"] as const)
	test(
		`criteria ${operation} keeps selection locked against a concurrent row shift`,
		{ timeout: 15000 },
		async () => {
			const root = await mkdtemp(join(tmpdir(), "inibase-selection-"));
			const db = new Inibase("db", root);
			let child: ReturnType<typeof fork> | undefined;
			try {
				await db.createTable(
					"records",
					[
						{ key: "key", type: "string" },
						{ key: "score", type: "number" },
					],
					{ compression: true, decodeID: true, cache: false },
				);
				await db.post("records", [
					{ key: "removed", score: 1 },
					{ key: "target", score: 2 },
					{ key: "neighbor", score: 3 },
				]);
				await db.optimize("records", { indexes: ["key"] });
				child = fork(
					new URL("./publication.child.ts", import.meta.url),
					[root, "shift"],
					{
						execArgv: ["--import", "tsx"],
						stdio: ["ignore", "pipe", "pipe", "ipc"],
					},
				);
				child.stdout?.resume();
				let stderr = "",
					shifted = false;
				child.stderr?.on("data", (chunk) => {
					stderr += chunk;
				});
				const done = new Promise<void>((resolve, reject) => {
					child?.on("error", reject);
					child?.on("exit", (code, signal) => {
						shifted = true;
						code === 0
							? resolve()
							: reject(new Error(`${code}/${signal}: ${stderr}`));
					});
				});
				done.catch(() => {});
				await new Promise<void>((resolve, reject) => {
					child?.once("message", () => resolve());
					done.then(() => reject(new Error("exit before ready")), reject);
				});
				const original = db.get.bind(db);
				let selected = false,
					shiftedDuringSelection = false;
				(db as any).get = async (...args: any[]) => {
					const result = await (original as any)(...args);
					if (!selected && args[1]?.key === "target" && args[4] === true) {
						selected = true;
						child?.send("start");
						await new Promise((resolve) => setTimeout(resolve, 150));
						shiftedDuringSelection = shifted;
					}
					return result;
				};
				if (operation === "put")
					await db.put("records", { score: 222 }, { key: "target" });
				else await db.delete("records", { key: "target" });
				await done;
				assert.equal(selected, true);
				assert.equal(
					shiftedDuringSelection,
					false,
					"another writer must not shift already selected physical rows",
				);
				const target = await db.get(
					"records",
					{ key: "target" },
					{ perPage: -1 },
				);
				if (operation === "put") assert.equal(target?.[0].score, 222);
				else assert.equal(target, null);
				assert.equal(
					(await db.get("records", { key: "neighbor" }, { perPage: -1 }))?.[0]
						.score,
					3,
				);
			} finally {
				if (child?.exitCode === null && !child.signalCode) {
					child.kill("SIGKILL");
					await new Promise((resolve) => child?.once("exit", resolve));
				}
				await db.close();
				await rm(root, { recursive: true, force: true });
			}
		},
	);
