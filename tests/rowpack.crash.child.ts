import { DatabaseResources } from "../src/resources.js";
import { buildRowPack } from "../src/rowpack.js";

const [directory, phase] = process.argv.slice(2);
async function* rows() {
	yield { id: 0, bytes: Buffer.from("new generation") };
}
await buildRowPack(
	directory,
	rows(),
	1,
	true,
	new DatabaseResources(),
	(point) => {
		if (point === phase) process.kill(process.pid, "SIGKILL");
	},
);
