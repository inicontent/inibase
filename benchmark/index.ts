import { rm } from "node:fs/promises";
import { Bench } from "tinybench";
import Inibase from "../src";
import { isExists } from "../src/file";

const bench = new Bench();

if (await isExists("test")) await rm("test", { recursive: true });

const db = new Inibase("test");
let i: number;
await db.createTable("user", [
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
	.add(
		"POST",
		async () => {
			await db.post("user", {
				username: `username_${i}`,
				email: `email_${i}@test.com`,
			});
		},
		{
			beforeAll() {
				i = 0;
			},
			beforeEach() {
				i++;
			},
		},
	)
	.add(
		"PUT",
		async () => {
			await db.put("user", { username: `edited_${i}` }, i);
		},
		{
			beforeAll() {
				i = 0;
			},
			beforeEach() {
				i++;
			},
		},
	)
	.add(
		"GET",
		async () => {
			await db.get("user", i);
		},
		{
			beforeAll() {
				i = 0;
			},
			beforeEach() {
				i++;
			},
		},
	);
// .add("DELETE", async () => {
// 	await db.delete("user", 1);
// });

await bench.warmup(); // make results more reliable, ref: https://github.com/tinylibs/tinybench/pull/50
await bench.run();

console.table(bench.table());
