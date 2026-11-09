import assert from "node:assert/strict";
import Inibase from "../src/index.js";

const [root, mode] = process.argv.slice(2);
const db = new Inibase("db", root);
try {
	if (mode === "writer") {
		for (let i = 0; i < 12; i++) {
			await db.post("records", { slug: `appended-${i}`, value: i });
			await db.put("records", { value: -i }, i + 1);
		}
	} else {
		for (let i = 0; i < 64; i++) {
			const index = (i * 73) % 1000;
			assert.equal(
				(await db.get("records", { slug: `item-${index}` }))?.[0].slug,
				`item-${index}`,
			);
		}
	}
} finally {
	await db.close();
}
