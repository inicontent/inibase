// Functional-parity helper for tests/transaction.test.ts. Runs a DML +
// transaction cycle under INIBASE_DURABILITY=none (no fsyncs) and reports the
// result so the parent can assert that `none` produces the same observable
// state as `full` — only the durability of the calls differs.
import Inibase from "../src/index.js";

const dbPath = process.argv[2];
const db = new Inibase(dbPath);

const schema = [{ key: "name", type: "string", required: true }];
await db.createTable("items", schema, { decodeID: true });

await db.post("items", { name: "a" });
await db.post("items", { name: "b" });
const rows1 = (await db.get("items", undefined, { page: 1, perPage: -1 })) as any[];

await db.begin();
await db.post("items", { name: "c" }); // rolled back
await db.rollback();
await db.begin(["items"]);
await db.post("items", { name: "d" });
await db.commit();
const rows2 = (await db.get("items", undefined, { page: 1, perPage: -1 })) as any[];

const report = {
	count1: rows1.length,
	names1: rows1.map((row) => row.name as string).sort(),
	count2: rows2.length,
	names2: rows2.map((row) => row.name as string).sort(),
};
process.send?.(JSON.stringify(report));
process.exit(0);