import { isExists } from "../src/file";
import Inibase from "../src/index";
import { rm } from "node:fs/promises";
import { Console } from "node:console";

const single = async () => {
	const logger = new Console({
			stdout: process.stdout,
			stderr: process.stderr,
		}),
		db = new Inibase("test");
	let startTime: number,
		startMemory: number,
		table: Record<string | number, string | number>[] = [];
	// Delete test folder
	if (await isExists("test")) await rm("test", { recursive: true });

	await db.createTable("user", [
		{
			key: "username",
			type: "string",
			required: true,
		},
		{
			key: "password",
			type: "password",
			required: true,
		},
		{
			key: "email",
			type: "email",
			required: true,
		},
	]);

	logger.group("Single");

	table[0] = {};
	table[0].METHOD = "POST";

	// SINGLE POST 10
	if (gc) gc();
	startMemory = process.memoryUsage().heapUsed;
	startTime = Date.now();
	for (let i = 0; i < 10; i++)
		await db.post("user", {
			username: `username_${i + 1}`,
			email: `email_${i + 1}@test.com`,
			password: `password_${i + 1}`,
		});

	table[0][10] = `${Date.now() - startTime} ms (${(
		(process.memoryUsage().heapUsed - startMemory) /
		(1024 * 1024)
	).toFixed(2)} mb)`;

	// SINGLE POST 100
	if (gc) gc();
	startMemory = process.memoryUsage().heapUsed;
	startTime = Date.now();
	for (let i = 0; i < 100; i++)
		await db.post("user", {
			username: `username_${i + 1}`,
			email: `email_${i + 1}@test.com`,
			password: `password_${i + 1}`,
		});

	table[0][100] = `${Date.now() - startTime} ms (${(
		(process.memoryUsage().heapUsed - startMemory) /
		(1024 * 1024)
	).toFixed(2)} mb)`;

	// SINGLE POST 1000
	if (gc) gc();
	startMemory = process.memoryUsage().heapUsed;
	startTime = Date.now();
	for (let i = 0; i < 1000; i++)
		await db.post("user", {
			username: `username_${i + 1}`,
			email: `email_${i + 1}@test.com`,
			password: `password_${i + 1}`,
		});

	table[0][1000] = `${Date.now() - startTime} ms (${(
		(process.memoryUsage().heapUsed - startMemory) /
		(1024 * 1024)
	).toFixed(2)} mb)`;

	// SINGLE GET
	table[1] = {};
	table[1].METHOD = "GET";

	// SINGLE GET 10
	if (gc) gc();
	startMemory = process.memoryUsage().heapUsed;
	startTime = Date.now();
	for (let i = 0; i < 10; i++) await db.get("user", i + 1);

	table[1][10] = `${Date.now() - startTime} ms (${(
		(process.memoryUsage().heapUsed - startMemory) /
		(1024 * 1024)
	).toFixed(2)} mb)`;

	// SINGLE GET 100
	if (gc) gc();
	startMemory = process.memoryUsage().heapUsed;
	startTime = Date.now();
	for (let i = 0; i < 100; i++) await db.get("user", i + 1);

	table[1][100] = `${Date.now() - startTime} ms (${(
		(process.memoryUsage().heapUsed - startMemory) /
		(1024 * 1024)
	).toFixed(2)} mb)`;

	// SINGLE GET 1000
	if (gc) gc();
	startMemory = process.memoryUsage().heapUsed;
	startTime = Date.now();
	for (let i = 0; i < 1000; i++) await db.get("user", i + 1);

	table[1][1000] = `${Date.now() - startTime} ms (${(
		(process.memoryUsage().heapUsed - startMemory) /
		(1024 * 1024)
	).toFixed(2)} mb)`;

	// SINGLE PUT
	table[2] = {};
	table[2].METHOD = "PUT";

	// SINGLE PUT 10
	if (gc) gc();
	startMemory = process.memoryUsage().heapUsed;
	startTime = Date.now();
	for (let i = 0; i < 10; i++)
		await db.put("user", { username: "edited_username" }, i + 1);

	table[2][10] = `${Date.now() - startTime} ms (${(
		(process.memoryUsage().heapUsed - startMemory) /
		(1024 * 1024)
	).toFixed(2)} mb)`;

	// SINGLE PUT 100
	if (gc) gc();
	startMemory = process.memoryUsage().heapUsed;
	startTime = Date.now();
	for (let i = 0; i < 100; i++)
		await db.put("user", { username: "edited_username" }, i + 1);

	table[2][100] = `${Date.now() - startTime} ms (${(
		(process.memoryUsage().heapUsed - startMemory) /
		(1024 * 1024)
	).toFixed(2)} mb)`;

	// SINGLE PUT 1000
	if (gc) gc();
	startMemory = process.memoryUsage().heapUsed;
	startTime = Date.now();
	for (let i = 0; i < 1000; i++)
		await db.put("user", { username: "edited_username" }, i + 1);

	table[2][1000] = `${Date.now() - startTime} ms (${(
		(process.memoryUsage().heapUsed - startMemory) /
		(1024 * 1024)
	).toFixed(2)} mb)`;

	// SINGLE DELETE
	table[3] = {};
	table[3].METHOD = "DELETE";

	// SINGLE DELETE 10
	if (gc) gc();
	startMemory = process.memoryUsage().heapUsed;
	startTime = Date.now();
	for (let i = 0; i < 10; i++) await db.delete("user", 1110 - (i + 1));

	table[3][10] = `${Date.now() - startTime} ms (${(
		(process.memoryUsage().heapUsed - startMemory) /
		(1024 * 1024)
	).toFixed(2)} mb)`;

	// SINGLE DELETE 100
	if (gc) gc();
	startMemory = process.memoryUsage().heapUsed;
	startTime = Date.now();
	for (let i = 0; i < 100; i++) await db.delete("user", 1100 - (i + 1));

	table[3][100] = `${Date.now() - startTime} ms (${(
		(process.memoryUsage().heapUsed - startMemory) /
		(1024 * 1024)
	).toFixed(2)} mb)`;

	// SINGLE DELETE 1000
	if (gc) gc();
	startMemory = process.memoryUsage().heapUsed;
	startTime = Date.now();
	for (let i = 0; i < 1000; i++) await db.delete("user", 1000 - (i + 1));

	table[3][1000] = `${Date.now() - startTime} ms (${(
		(process.memoryUsage().heapUsed - startMemory) /
		(1024 * 1024)
	).toFixed(2)} mb)`;

	logger.table(
		table.reduce((arr, { METHOD, ...x }) => {
			arr[METHOD] = x as any;
			return arr;
		}, {}),
	);
	logger.groupEnd();
};
single();
