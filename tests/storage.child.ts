import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import Inibase from "../src/index.js";

const [root, mode, number = "0"] = process.argv.slice(2);
const db = new Inibase("db", root);
const kill = () => process.kill(process.pid, "SIGKILL");

if (mode.startsWith("crash:")) {
	const phase = mode.slice(6);
	const open = fs.promises.open;
	const rename = fs.promises.rename;
	let renames = 0;
	fs.promises.open = (async (...args: Parameters<typeof open>) => {
		const handle = await open(...args);
		const path = String(args[0]);
		if (path.endsWith("/updates.log") && String(args[1]).includes("a")) {
			const write = handle.writeFile.bind(handle),
				sync = handle.sync.bind(handle);
			handle.writeFile = async (...values: Parameters<typeof write>) => {
				if (phase === "before-log") kill();
				const result = await write(...values);
				if (phase === "after-log") kill();
				return result;
			};
			handle.sync = async () => {
				await sync();
				if (phase === "after-log-sync") kill();
			};
		}
		return handle;
	}) as typeof open;
	fs.promises.rename = async (...args: Parameters<typeof rename>) => {
		await rename(...args);
		if (
			(phase === "compact" || phase === "migration") &&
			++renames === Number(number)
		)
			kill();
	};
	syncBuiltinESMExports();
	if (phase === "compact") await db.compact("records");
	else if (phase === "migration")
		await db.optimize("records", { indexes: ["key"] });
	else {
		await db.put("records", { score: 777 }, 10);
		process.send?.("acknowledged");
		kill();
	}
	throw new Error("crash point was not reached");
} else if (mode === "writer") {
	const worker = Number(number);
	for (let i = 0; i < 8; i++) {
		const id = await db.post("records", {
			key: `${worker}:${i}:new`,
			score: -1,
		});
		await db.put("records", { key: `${worker}:${i}:ready`, score: i }, id);
		if (i % 3 === 0) await db.delete("records", id);
		if (i % 4 === 0) await db.compact("records");
	}
	await db.close();
	process.send?.("done");
} else if (mode === "unique") {
	try {
		await db.post("records", { key: "racing-key", score: 9 });
		process.send?.("inserted");
	} catch (error: any) {
		if (error.name !== "FIELD_UNIQUE") throw error;
		process.send?.("duplicate");
	}
	await db.close();
} else if (mode === "reader") {
	let stop = false,
		iterations = 0;
	process.on("message", () => {
		stop = true;
	});
	while (!stop) {
		const values = (await db.get("records", undefined, { perPage: -1 })) ?? [];
		for (const value of values) {
			if (
				typeof value.key !== "string" ||
				typeof value.score !== "number" ||
				value.id === undefined
			)
				throw new Error("torn row");
			if (value.key.endsWith(":new") && value.score !== -1)
				throw new Error("torn inserted row");
			if (value.key.endsWith(":ready") && value.score < 0)
				throw new Error("torn updated row");
		}
		iterations++;
	}
	await db.close();
	process.send?.({ iterations });
	process.disconnect?.();
}
if (mode !== "reader") process.disconnect?.();
