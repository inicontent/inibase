import type { DatabaseResources } from "./resources.js";

interface Evidence {
	probes: number;
	milliseconds: number;
	nextAttempt: number;
}

/** No values/query history, no unbounded per-table Map, and no task queue. */
export const observeEqualityScan = (
	resources: DatabaseResources,
	tablePath: string,
	column: string,
	milliseconds: number,
	build: () => Promise<void>,
): void => {
	const key = `${tablePath}:automatic:${column}`;
	const evidence = resources.get<Evidence>(key) ?? {
		probes: 0,
		milliseconds: 0,
		nextAttempt: 0,
	};
	if (Date.now() < evidence.nextAttempt) return;
	evidence.probes = Math.min(65535, evidence.probes + 1);
	evidence.milliseconds = Math.min(
		3600000,
		evidence.milliseconds + milliseconds,
	);
	resources.set(key, evidence, 512 + key.length * 2);
	// Amortize construction over observed work, rather than indexing every field.
	if (evidence.probes < 16 || evidence.milliseconds < 64) return;
	if (resources.tryMaintenance(build)) {
		evidence.probes = 0;
		evidence.milliseconds = 0;
		evidence.nextAttempt = Date.now() + 10 * 60 * 1000;
	}
};
