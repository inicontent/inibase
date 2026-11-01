import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [root, mode, argument] = process.argv.slice(2);
if (mode === "crash") {
	const point = argument,
		originalOpen = fs.promises.open.bind(fs.promises),
		originalRename = fs.promises.rename.bind(fs.promises);
	const pause = async () => {
		process.send?.({ paused: point });
		await new Promise(() => {});
	};
	fs.promises.open = async (...args: any[]) => {
		const handle = await originalOpen(
			...(args as Parameters<typeof originalOpen>),
		);
		if (String(args[0]).endsWith("/updates.log") && args[1] === "a") {
			const write = handle.writeFile.bind(handle),
				sync = handle.sync.bind(handle);
			handle.writeFile = async (...data: Parameters<typeof write>) => {
				await write(...data);
				if (point === "append") await pause();
			};
			handle.sync = async () => {
				await sync();
				if (point === "sync") await pause();
			};
		}
		return handle;
	};
	fs.promises.rename = async (from, to) => {
		await originalRename(from, to);
		if (String(to).endsWith("/.format") && point === "marker") await pause();
	};
	syncBuiltinESMExports();
}
if (mode === "failure") {
	const open = fs.promises.open.bind(fs.promises);
	let fail = true;
	fs.promises.open = async (...args: Parameters<typeof open>) => {
		const handle = await open(...args);
		if (String(args[0]).endsWith("/updates.log") && args[1] === "a") {
			const sync = handle.sync.bind(handle);
			handle.sync = async () => {
				if (fail) {
					fail = false;
					throw Object.assign(Error("injected synchronization failure"), {
						code: "EIO",
					});
				}
				await sync();
			};
		}
		return handle;
	};
	syncBuiltinESMExports();
}
if (mode === "compact-crash") {
	const rename = fs.promises.rename.bind(fs.promises);
	fs.promises.rename = async (from, to) => {
		await rename(from, to);
		if (
			String(from).includes("/.tmp/score.txt.gz.") &&
			String(to).endsWith("/score.txt.gz")
		) {
			process.send?.({ paused: "compaction" });
			await new Promise(() => {});
		}
	};
	syncBuiltinESMExports();
}
const { default: Inibase } = await import("../src/index.js");
const db = new Inibase("db", root);
try {
	if (mode === "crash") await db.put("records", { score: 900 }, 10);
	else if (mode === "failure") {
		let rejected = false;
		try {
			await db.put("records", { score: 900 }, 10);
		} catch (error: any) {
			if (error.code !== "EIO") throw error;
			rejected = true;
		}
		if (!rejected)
			throw Error("write was acknowledged after synchronization failure");
		await db.put("records", { score: 777 }, 11);
	} else if (mode === "compact-crash") await db.compact("records");
	else if (mode === "memory") {
		const names = Array.from({ length: 12 }, (_, i) => `table_${i}`);
		for (const name of names) {
			await db.createTable(name, [{ key: "score", type: "number" }], {
				decodeID: true,
				compression: true,
			});
			await db.post(
				name,
				Array.from({ length: 128 }, (_, i) => ({ score: i })),
			);
		}
		await Promise.all(
			names.map(async (name, i) => {
				await db.put(name, { score: 1000 + i }, 64);
				await db.delete(name, 65);
			}),
		);
		for (let i = 0; i < names.length; i++) {
			if (
				((await db.get(names[i], 64)) as any).score !== 1000 + i ||
				(await db.get(names[i], 65)) !== null
			)
				throw Error("wrong multi-table result");
		}
		const sorted = (await db.get(names[0], undefined, {
			sort: { score: "DESC" },
			perPage: 1,
		})) as any[];
		if (sorted[0].id !== 64) throw Error("wrong bounded sort result");
		const memory = db.memoryUsage();
		if (memory.peakAccountedBytes > 262144 || memory.openFiles > 4)
			throw Error("resource allowance exceeded");
		process.send?.({ statistics: memory });
	} else if (mode === "writer") {
		const worker = Number(argument);
		for (let i = 0; i < 8; i++) {
			await db.put(
				"records",
				{ score: worker * 100 + i + 1000 },
				10 + worker * 10 + i,
			);
			await db.delete("records", 100 + worker * 10 + i);
		}
	} else if (mode === "compact") {
		for (let i = 0; i < 24; i++)
			await db.put("records", { score: 2000 + i }, 10 + i);
		await db.compact("records");
	}
} finally {
	await db.close();
}
process.send?.({ done: true });
