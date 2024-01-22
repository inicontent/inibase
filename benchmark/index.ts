import { rm } from "node:fs/promises";
import { Bench } from "tinybench";
import { isExists } from "../src/file";
import Inibase from "../src";

const bench = new Bench();

if (await isExists("test")) await rm("test", { recursive: true });

const db = new Inibase("test");
let i = 0;
await db.setTableSchema("user", [
  {
    key: "username",
    type: "string",
    required: true,
  },
  {
    key: "email",
    type: "email",
    required: true,
  },
]);

bench
  .add("POST", async () => {
    await db.post("user", {
      username: `username`,
      email: `email@test.com`,
    });
  })
  .add("PUT", async () => {
    await db.put("user", { username: "edited" }, 1);
  })
  .add("GET", async () => {
    await db.get("user", 1);
  })
  .add("DELETE", async () => {
    await db.delete("user", 1);
  });

await bench.warmup(); // make results more reliable, ref: https://github.com/tinylibs/tinybench/pull/50
await bench.run();

console.table(bench.table());
