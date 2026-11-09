import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import Inibase from "../src/index.js";

const [root, mode] = process.argv.slice(2);
const db = new Inibase("db", root);
await new Promise<void>((resolve) => {
	process.once("message", () => resolve());
	process.send?.("ready");
});
const rename = fs.promises.rename;
let paused = false;
fs.promises.rename = async (...args: Parameters<typeof rename>) => {
	await rename(...args);
	if (
		mode !== "shift" &&
		!paused &&
		String(args[0]).endsWith("/key.txt.gz") &&
		String(args[1]).includes("/backup/")
	) {
		paused = true;
		await new Promise<void>((resolve) => {
			process.once("message", () => resolve());
			process.send?.("paused");
		});
	}
};
syncBuiltinESMExports();
await db.delete("records", { key: "removed" });
if (mode !== "shift" && !paused)
	throw new Error("publication pause was not reached");
await db.close();
process.disconnect?.();
