import { DatabaseResources } from "../src/resources.js";
import { buildRowPack } from "../src/rowpack.js";

const [directory, phase] = process.argv.slice(2);
const count = phase === "index-partitioned" ? 2048 : 1;
async function* rows() {
	for (let id = 0; id < count; id++)
		yield { id, bytes: Buffer.from("new generation") };
}
await buildRowPack(
	directory,
	rows(),
	count,
	true,
	new DatabaseResources(),
	(point) => {
		if (point === phase) process.kill(process.pid, "SIGKILL");
	},
);
