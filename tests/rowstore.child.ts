import { DatabaseResources } from "../src/resources.js";
import { type RowCommitPhase, RowStore } from "../src/rowstore.js";

const [directory, mode, argument] = process.argv.slice(2);
const resources = new DatabaseResources();
const store = new RowStore(directory, resources);
async function* mutations() {
	if (mode === "writer") {
		for (let index = 0; index < 32; index++)
			yield {
				id: Number(argument) + index,
				value: Buffer.from(`writer:${argument}:${index}`),
			};
	} else {
		yield { id: 1, value: Buffer.from("new") };
		yield { id: 2, value: null };
		yield { id: 3, value: Buffer.from("inserted") };
	}
}
await store.commit(mutations(), async (phase: RowCommitPhase) => {
	if (mode === "crash" && phase === argument)
		process.kill(process.pid, "SIGKILL");
	if (mode === "pause" && phase === argument) {
		process.send?.({ paused: true });
		await new Promise<void>((accept) =>
			process.once("message", () => accept()),
		);
	}
});
await resources.close();
process.disconnect?.();
