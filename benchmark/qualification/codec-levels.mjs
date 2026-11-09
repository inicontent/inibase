// Compression tuning diagnostic; reusable context, identical independent pages.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [artifact, destination] = process.argv.slice(2);
const { RowEncoder } = await import(pathToFileURL(artifact));
const bytes = Buffer.from(
	Array.from({ length: 512 }, (_, i) =>
		createHash("sha256").update(`codec:${i}`).digest("hex"),
	).join(""),
);
const results = [];
for (let repeat = 0; repeat < 3; repeat++)
	for (const small of [false, true]) {
		const levels = [1, 4, 8],
			order = levels.slice(repeat).concat(levels.slice(0, repeat));
		for (const memoryLevel of order) {
			const encoder = new RowEncoder(32768, small, memoryLevel),
				start = performance.now();
			let size = 0;
			try {
				for (let i = 0; i < 1000; i++)
					size += (await encoder.encode(bytes)).length;
			} finally {
				await encoder.close();
			}
			results.push({
				repeat: repeat + 1,
				small,
				memoryLevel,
				ms: performance.now() - start,
				bytes: size,
				pages: 1000,
			});
		}
	}
await writeFile(
	destination,
	JSON.stringify({ artifact, runtime: process.versions, results }, null, 2) +
		"\n",
);
