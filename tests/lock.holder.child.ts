// Holds a table lock (`<tablePath>/.tmp`) for `holdMs` so the parent test can
// verify that a *live* same-host lock owner is never stolen (only dead owners
// or foreign-host/TTL cases are). Sequence: lock -> "locked" message -> sleep
// -> unlock -> "released" message -> exit.
import * as File from "../src/file.js";

const tableTmpPath = process.argv[2];
const holdMs = Number(process.argv[3] ?? 3000);

await File.lock(tableTmpPath);
process.send?.("locked");

await new Promise((resolve) => setTimeout(resolve, holdMs));
await File.unlock(tableTmpPath);
process.send?.("released");
process.exit(0);