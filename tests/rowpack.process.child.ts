import assert from "node:assert/strict";
import { DatabaseResources } from "../src/resources.js";
import { buildRowPack, RowPack } from "../src/rowpack.js";

const [directory, mode] = process.argv.slice(2);
const resources = new DatabaseResources();
const read = async (pack: RowPack, id: number) => {
	const chunks: Buffer[] = [];
	for await (const bytes of pack.read(id)) chunks.push(bytes);
	return Buffer.concat(chunks).toString();
};
try {
	if (mode === "reader") {
		let alive = true,
			reads = 0;
		process.on("message", () => {
			alive = false;
		});
		process.on("disconnect", () => {
			alive = false;
		});
		const original = await RowPack.open(directory, resources);
		process.send?.({ ready: true });
		while (alive) {
			const pack = await RowPack.open(directory, resources);
			const first = await read(pack, 0),
				generation = first.split(":")[0];
			for (const id of [0, 14, 1499])
				assert.equal(await read(pack, id), `${generation}:${id}`);
			assert.equal(await read(original, 1499), "generation-0:1499");
			reads++;
			await new Promise((resolve) => setImmediate(resolve));
		}
		process.send?.({ reads });
	} else {
		for (let round = 1; round <= 3; round++) {
			const generation = Number(mode) * 3 + round;
			async function* rows() {
				for (let id = 0; id < 1500; id++)
					yield { id, bytes: Buffer.from(`generation-${generation}:${id}`) };
			}
			await buildRowPack(directory, rows(), 1500, round % 2 === 1, resources);
		}
	}
} finally {
	await resources.close();
	process.disconnect?.();
}
