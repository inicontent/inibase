#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import Inison from "inison";

import { isExists } from "./file.js";
import Inibase, { type Options, type Criteria, type Data } from "./index.js";
import { isStringified, isNumber, setField, unsetField } from "./utils.js";

const textGreen = (input: string) => `\u001b[1;32m${input}\u001b[0m`;
const textRed = (input: string) => `\u001b[1;31m${input}\u001b[0m`;
const textBlue = (input: string) => `\u001b[1;34m${input}\u001b[0m`;
const textMagenta = (input: string) => `\u001b[1;35m${input}\u001b[0m`;

let { path, version, table } = parseArgs({
	options: {
		path: { type: "string", short: "p" },
		version: { type: "boolean", short: "v" },
		table: { type: "string", short: "t" },
	},
}).values;

if (version) {
	console.log(JSON.parse(readFileSync("package.json", "utf8")).version);
	process.exit();
}

const rl = createInterface({
	input: process.stdin,
	output: process.stdout,
	prompt: textBlue(">  "),
});

const setPath = async (firstTime?: boolean) => {
	if (!path)
		path = await rl.question(
			firstTime ? "Database path: " : "Please type a valid database path: ",
		);
	if (!path || !(await isExists(path))) await setPath();
};
console.clear();

await setPath(true);

const db = new Inibase(path as string);

process.stdout.write("\u001b[3J\u001b[2J\u001b[1J");
console.clear();
rl.prompt();

rl.on("line", async (input) => {
	const splitedInput = input
		.trim()
		.match(/[^\s"']+|"([^"]*)"|'([^']*)'/g) as string[];
	switch (splitedInput[0].toLocaleLowerCase()) {
		case "clear":
			process.stdout.write("\u001b[3J\u001b[2J\u001b[1J");
			console.clear();
			rl.prompt();
			break;
		case "exit":
			return process.exit();
		// biome-ignore format:
		case "help": {
			if(!table)
				console.log(` ${textBlue("table")} | ${textBlue("t")} ${textRed("<")}tableName${textRed(">*")}`)

console.log(`   ${textGreen("config")} | ${textGreen("c")}
   	${textMagenta("get")} | ${textMagenta("g")} (compression|cache|prepend)?
   	${textMagenta("set")} | ${textMagenta("s")} (compression true|false)? (cache true|false)? (prepend true|false)?
   ${textGreen("schema")} | ${textGreen("s")}
   	${textMagenta("get")} | ${textMagenta("g")}  ${textRed("<")}keyName${textRed(">*")}	
	${textMagenta("set")} | ${textMagenta("s")}  ${textRed("<")}keyName${textRed(">*")} {{ Inison.stringify(Field) }}
   ${textGreen("get")} | ${textGreen("g")}
   ${textGreen("delete")} | ${textGreen("d")}
   ${textGreen("post")} | ${textGreen("p")}
   ${textGreen("put")} | ${textGreen("pu")}
	${textMagenta("--where")} | ${textMagenta("-w")}  (ID|Inison.stringify(Criteria)|LineNumber)?
	${textMagenta("--page")} | ${textMagenta("-p")}  number?	
	${textMagenta("--per-page")} | ${textMagenta("-l")}  number?
	${textMagenta("--columns")} | ${textMagenta("-c")}  columnName[]?
	${textMagenta("--sort")} | ${textMagenta("-s")}  (string|string[]|Inison.stringify(sortObject))?
	${textMagenta("--data")} | ${textMagenta("-d")}  Inison.stringify(Data) ${textRed("* POST & PUT")}`
);
			break;
		}
		case "c":
		case "config": {
			if (!table) {
				console.log(`${textRed("  Err:")} Please specify table name`);
				break;
			}
			const config = (await db.getTable(table)).config;

			if (!splitedInput[1]) {
				console.log(JSON.stringify(config, undefined, 2));
				break;
			}

			switch (splitedInput[1].toLocaleLowerCase()) {
				case "g":
				case "get": {
					if (!splitedInput[2])
						console.log(JSON.stringify(config, undefined, 2));
					else
						console.log(
							JSON.stringify((config as any)[splitedInput[2]], undefined, 2),
						);
					break;
				}
				case "s":
				case "set": {
					const newConfigObject: any = {};
					splitedInput.splice(0, 2);
					for (let index = 0; index < splitedInput.length; index++) {
						const configName = splitedInput[index].toLocaleLowerCase();
						if (["true", "false"].includes(configName)) continue;

						if (
							!["compression", "cache", "prepend", "decodeID"].includes(
								configName,
							)
						) {
							console.log(
								`${textRed("  Err:")} '${configName}' is not a valid config`,
							);
							break;
						}
						newConfigObject[configName] =
							splitedInput[index + 1].trim() === "true";
					}

					await db.updateTable(table, undefined, newConfigObject);
					break;
				}
				default:
					break;
			}
			break;
		}
		case "s":
		case "schema": {
			if (!table) {
				console.log(`${textRed("  Err:")} Please specify table name`);
				break;
			}
			const schema = (await db.getTable(table)).schema;

			if (!splitedInput[1] || !splitedInput[2]) {
				console.log(JSON.stringify(schema, undefined, 2));
				break;
			}
			const key = splitedInput[2];
			if (!key) {
				console.log(`${textRed("  Err:")} Please specify key name`);
				break;
			}
			const field: any = {};
			field.key = key;

			switch (splitedInput[1].toLocaleLowerCase()) {
				case "p":
				case "push":
					await db.updateTable(table, [...(schema ?? []), field]);
					break;
				case "u":
				case "unset":
				case "s":
				case "set": {
					if (!schema) {
						console.log(
							`${textRed("  Err:")} Schema is empty, please push first`,
						);
						break;
					}
					if (["set", "s"].includes(splitedInput[1].toLocaleLowerCase())) {
						if (!splitedInput[2]) {
							console.log(`${textRed("  Err:")} Give the field a schema`);
							break;
						}
						try {
							Object.assign(field, Inison.unstringify(splitedInput[2]));
							setField(key, schema, field);
						} catch {
							console.log(`${textRed("  Err:")} Give the field a valid schema`);
							break;
						}
					} else unsetField(key, schema);

					await db.updateTable(table, schema);
					break;
				}
				default:
					break;
			}
			break;
		}
		case "t":
		case "table":
			if (!splitedInput[1]) {
				console.log(`${textRed("  Err:")} Please specify table name`);
				break;
			}
			if (!(await isExists(join(path as string, splitedInput[1]))))
				console.log(`${textRed("  Err:")} Table doesn't exist`);
			else {
				table = splitedInput[1];
				rl.setPrompt(textBlue(`${table} >  `));
			}
			break;
		case "p":
		case "post":
		case "g":
		case "get":
		case "pu":
		case "put":
		case "d":
		case "delete": {
			if (!table) {
				console.log(`${textRed("  Err:")} Please specify table name`);
				break;
			}

			let where: undefined | string | number | Criteria | (string | number)[] =
					undefined,
				page: undefined | Options["page"] = undefined,
				perPage: undefined | Options["perPage"] = undefined,
				columns: undefined | Options["columns"] = undefined,
				sort: undefined | Options["sort"] = undefined,
				data: undefined | Data = undefined;

			if (splitedInput.toSpliced(0, 1).length) {
				const parsedArgs = parseArgs({
					args: splitedInput.toSpliced(0, table ? 1 : 2),
					options: {
						where: { type: "string", short: "w" },
						page: { type: "string", short: "p" },
						perPage: { type: "string", short: "l" },
						sort: { type: "string", short: "s" },
						columns: { type: "string", short: "c", multiple: true },
						data: { type: "string", short: "d" },
					},
				}).values;
				if (parsedArgs.where) {
					if (parsedArgs.where === "'-1'" || parsedArgs.where === '"-1"')
						where = -1 as any;
					else if (isNumber(parsedArgs.where)) where = Number(parsedArgs.where);
					else if (isStringified(parsedArgs.where))
						where = Inison.unstringify(parsedArgs.where) as any;
				}
				if (parsedArgs.sort) {
					if (isStringified(parsedArgs.sort))
						sort = Inison.unstringify(parsedArgs.sort) as any;
					else sort = parsedArgs.sort;
				}
				page = Number(parsedArgs.page) ?? undefined;
				perPage = Number(parsedArgs.perPage) ?? undefined;
				columns = parsedArgs.columns as string[];
				if (parsedArgs.data && isStringified(parsedArgs.data))
					data = Inison.unstringify(parsedArgs.data) as Data;
			}

			switch (splitedInput[0].toLocaleLowerCase()) {
				case "g":
				case "get":
					console.log(
						await db.get(table, where, {
							page: Number(page) ?? 1,
							perPage: Number(perPage) ?? 15,
							columns,
							sort,
						}),
					);
					break;
				case "p":
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
				case "pu":
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

				case "d":
				case "delete":
					console.log(await db.delete(table, where as any));
					break;
				default:
					break;
			}
			break;
		}
		default:
			break;
	}
	rl.prompt();
});
