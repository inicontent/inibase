#!/usr/bin/env node
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { basename } from "node:path";
import Inison from "inison";

import Inibase from "./index.js";
import { isJSON, isNumber } from "./utils.js";

const { path } = parseArgs({
	options: {
		path: { type: "string", short: "p" },
	},
}).values;

if (!path)
	throw new Error(
		"Please specify database folder path --path <databasePath> or -p <databasePath>",
	);

const db = new Inibase(basename(path));
const rl = createInterface({
	input: process.stdin,
	output: process.stdout,
	prompt: "\u001b[1;36m>  \u001b[0m",
});
console.clear();
rl.prompt();

rl.on("line", async (input) => {
	const trimedInput = input.trim();
	if (trimedInput === "clear") {
		process.stdout.write("\x1Bc");
		rl.prompt();
	}
	if (trimedInput === "exit") process.exit();

	const splitedInput = trimedInput.match(
		/[^\s"']+|"([^"]*)"|'([^']*)'/g,
	) as string[];
	if (
		["get", "post", "delete", "put"].includes(
			splitedInput[0].toLocaleLowerCase(),
		)
	) {
		const table = splitedInput[1];
		if (!table) throw new Error("Please specify table name");

		let { where, page, perPage, columns, data } = parseArgs({
			args: splitedInput.toSpliced(0, 2),
			options: {
				where: { type: "string", short: "w" },
				page: { type: "string", short: "p" },
				perPage: { type: "string", short: "l" },
				columns: { type: "string", short: "c", multiple: true },
				data: { type: "string", short: "d" },
			},
		}).values;
		if (where) {
			if (where === "'-1'" || where === '"-1"') where = -1 as any;
			else if (isNumber(where)) where = Number(where) as any;
			else if (isJSON(where)) where = Inison.unstringify(where) as any;
		}
		if (data) {
			if (isJSON(data)) data = Inison.unstringify(data) as any;
			else data = undefined;
		}
		switch (splitedInput[0].toLocaleLowerCase()) {
			case "get":
				console.log(
					await db.get(table, where, {
						page: Number(page) ?? 1,
						perPage: Number(perPage) ?? 15,
						columns,
					}),
				);
				break;
			case "post":
				console.log(
					await db.post(
						table,
						data as any,
						{
							page: Number(page) ?? 1,
							perPage: Number(perPage) ?? 15,
							columns,
						},
						true,
					),
				);
				break;
			case "put":
				console.log(
					await db.put(
						table,
						data as any,
						where,
						{
							page: Number(page) ?? 1,
							perPage: Number(perPage) ?? 15,
							columns,
						},
						true,
					),
				);
				break;
			case "delete":
				console.log(await db.delete(table, where));
				break;
			default:
				break;
		}
	}
	rl.prompt();
});
