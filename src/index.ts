import "dotenv/config";
import { randomBytes, scryptSync } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
	mkdir,
	readFile,
	readdir,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join, parse } from "node:path";
import { inspect } from "node:util";
import Inison from "inison";

import * as File from "./file.js";
import * as Utils from "./utils.js";
import * as UtilsServer from "./utils.server.js";

export interface Data {
	id?: number | string;
	[key: string]: any;
	createdAt?: number;
	updatedAt?: number;
}

export type FieldType =
	| "string"
	| "number"
	| "boolean"
	| "date"
	| "email"
	| "url"
	| "table"
	| "object"
	| "array"
	| "password"
	| "html"
	| "ip"
	| "json"
	| "id";

export type Field = {
	id?: string | number;
	key: string;
	type: FieldType | FieldType[];
	required?: boolean;
	table?: string;
	unique?: boolean;
	children?: FieldType | FieldType[] | Schema;
};

export type Schema = Field[];

export interface Options {
	page?: number;
	perPage?: number;
	columns?: string[] | string;
	sort?:
		| Record<string, 1 | -1 | "asc" | "ASC" | "desc" | "DESC">
		| string[]
		| string;
}

export interface Config {
	compression?: boolean;
	cache?: boolean;
	prepend?: boolean;
}

export interface TableObject {
	schema?: Schema;
	config: Config;
}

export type ComparisonOperator =
	| "="
	| "!="
	| ">"
	| "<"
	| ">="
	| "<="
	| "*"
	| "!*"
	| "[]"
	| "![]";

export type pageInfo = {
	total?: number;
	totalPages?: number;
} & Options;

export type Criteria =
	| ({
			[logic in "and" | "or"]?: Criteria | (string | number | boolean | null)[];
	  } & {
			[key: string]: string | number | boolean | undefined | Criteria;
	  })
	| null;

type Entries<T> = {
	[K in keyof T]: [K, T[K]];
}[keyof T][];

declare global {
	interface ObjectConstructor {
		entries<T extends object>(o: T): Entries<T>;
	}
}

export type ErrorCodes =
	| "FIELD_UNIQUE"
	| "FIELD_REQUIRED"
	| "NO_SCHEMA"
	| "NO_ITEMS"
	| "INVALID_ID"
	| "INVALID_TYPE"
	| "INVALID_PARAMETERS"
	| "NO_ENV"
	| "TABLE_EXISTS"
	| "TABLE_NOT_EXISTS";
export type ErrorLang = "en";

export default class Inibase {
	public pageInfo: Record<string, pageInfo>;
	public salt: Buffer;
	private databasePath: string;
	private tables: Record<string, TableObject>;
	private fileExtension = ".txt";
	private checkIFunique: Record<string, (string | number)[]>;
	private totalItems: Record<string, number>;

	constructor(database: string, mainFolder = ".") {
		this.databasePath = join(mainFolder, database);
		this.tables = {};
		this.totalItems = {};
		this.pageInfo = {};
		this.checkIFunique = {};

		if (!process.env.INIBASE_SECRET) {
			if (
				existsSync(".env") &&
				readFileSync(".env").includes("INIBASE_SECRET=")
			)
				throw this.throwError("NO_ENV");
			this.salt = scryptSync(randomBytes(16), randomBytes(16), 32);
			appendFileSync(".env", `\nINIBASE_SECRET=${this.salt.toString("hex")}\n`);
		} else this.salt = Buffer.from(process.env.INIBASE_SECRET, "hex");
	}

	private throwError(
		code: ErrorCodes,
		variable?: string | number | (string | number)[],
		language: ErrorLang = "en",
	): Error {
		const errorMessages: Record<ErrorLang, Record<ErrorCodes, string>> = {
			en: {
				FIELD_UNIQUE:
					"Field {variable} should be unique, got {variable} instead",
				FIELD_REQUIRED: "Field {variable} is required",
				TABLE_EXISTS: "Table {variable} already exists",
				TABLE_NOT_EXISTS: "Table {variable} doesn't exist",
				NO_SCHEMA: "Table {variable} does't have a schema",
				NO_ITEMS: "Table {variable} is empty",
				INVALID_ID: "The given ID(s) is/are not valid(s)",
				INVALID_TYPE:
					"Expect {variable} to be {variable}, got {variable} instead",
				INVALID_PARAMETERS: "The given parameters are not valid",
				NO_ENV:
					Number(process.versions.node.split(".").reduce((a, b) => a + b)) >= 26
						? "please run with '--env-file=.env'"
						: "please use dotenv",
			},
			// Add more languages and error messages as needed
		};

		const errorMessage = errorMessages[language][code];
		if (!errorMessage) return new Error("ERR");
		return new Error(
			variable
				? Array.isArray(variable)
					? errorMessage.replace(
							/\{variable\}/g,
							() => variable.shift()?.toString() ?? "",
						)
					: errorMessage.replaceAll("{variable}", `'${variable.toString()}'`)
				: errorMessage.replaceAll("{variable}", ""),
		);
	}

	private getFileExtension = (tableName: string) => {
		let mainExtension = this.fileExtension;
		// TODO: ADD ENCRYPTION
		// if(this.tables[tableName].config.encryption)
		// 	mainExtension += ".enc"
		if (this.tables[tableName].config.compression) mainExtension += ".gz";
		return mainExtension;
	};

	private _schemaToIdsPath = (
		tableName: string,
		schema: Schema,
		prefix = "",
	) => {
		const RETURN: any = {};
		for (const field of schema)
			if (
				(field.type === "array" || field.type === "object") &&
				field.children &&
				Utils.isArrayOfObjects(field.children)
			) {
				Utils.deepMerge(
					RETURN,
					this._schemaToIdsPath(
						tableName,
						field.children,
						`${(prefix ?? "") + field.key}.`,
					),
				);
			} else if (field.id)
				RETURN[field.id] = `${
					(prefix ?? "") + field.key
				}${this.getFileExtension(tableName)}`;

		return RETURN;
	};

	/**
	 * Create a new table inside database, with predefined schema and config
	 *
	 * @param {string} tableName
	 * @param {Schema} [schema]
	 * @param {Config} [config]
	 */
	public async createTable(
		tableName: string,
		schema?: Schema,
		config?: Config,
	) {
		const tablePath = join(this.databasePath, tableName);

		if (await File.isExists(tablePath))
			throw this.throwError("TABLE_EXISTS", tableName);

		await mkdir(join(tablePath, ".tmp"), { recursive: true });
		await mkdir(join(tablePath, ".cache"));

		// if config not set => load default global env config
		if (!config)
			config = {
				compression: process.env.INIBASE_COMPRESSION == "true",
				cache: process.env.INIBASE_CACHE === "true",
				prepend: process.env.INIBASE_PREPEND === "true",
			};

		if (config) {
			if (config.compression)
				await writeFile(join(tablePath, ".compression.config"), "");
			if (config.cache) await writeFile(join(tablePath, ".cache.config"), "");
			if (config.prepend)
				await writeFile(join(tablePath, ".prepend.config"), "");
		}
		if (schema)
			await writeFile(
				join(tablePath, "schema.json"),
				JSON.stringify(
					UtilsServer.addIdToSchema(schema, 0, this.salt),
					null,
					2,
				),
			);
	}

	// Function to replace the string in one schema.json file
	private async replaceStringInFile(
		filePath: string,
		targetString: string,
		replaceString: string,
	) {
		const data = await readFile(filePath, "utf8");

		if (data.includes(targetString)) {
			const updatedContent = data.replaceAll(targetString, replaceString);
			await writeFile(filePath, updatedContent, "utf8");
		}
	}

	// Function to process schema files one by one (sequentially)
	private async replaceStringInSchemas(
		directoryPath: string,
		targetString: string,
		replaceString: string,
	) {
		const files = await readdir(directoryPath);

		for (const file of files) {
			const fullPath = join(directoryPath, file);
			const fileStat = await stat(fullPath);

			if (fileStat.isDirectory()) {
				await this.replaceStringInSchemas(
					fullPath,
					targetString,
					replaceString,
				);
			} else if (file === "schema.json") {
				await this.replaceStringInFile(fullPath, targetString, replaceString);
			}
		}
	}

	/**
	 * Update table schema or config
	 *
	 * @param {string} tableName
	 * @param {Schema} [schema]
	 * @param {(Config&{name?: string})} [config]
	 */
	public async updateTable(
		tableName: string,
		schema?: Schema,
		config?: Config & { name?: string },
	) {
		const table = await this.getTable(tableName),
			tablePath = join(this.databasePath, tableName);

		if (schema) {
			// remove id from schema
			schema = schema.filter(
				({ key }) => !["id", "createdAt", "updatedAt"].includes(key),
			);
			if (await File.isExists(join(tablePath, "schema.json"))) {
				// update columns files names based on field id
				schema = UtilsServer.addIdToSchema(
					schema,
					table.schema?.length
						? UtilsServer.findLastIdNumber(table.schema, this.salt)
						: 0,
					this.salt,
				);
				if (table.schema?.length) {
					const replaceOldPathes = Utils.findChangedProperties(
						this._schemaToIdsPath(tableName, table.schema),
						this._schemaToIdsPath(tableName, schema),
					);
					if (replaceOldPathes)
						await Promise.all(
							Object.entries(replaceOldPathes).map(
								async ([oldPath, newPath]) => {
									if (await File.isExists(join(tablePath, oldPath)))
										await rename(
											join(tablePath, oldPath),
											join(tablePath, newPath),
										);
								},
							),
						);
				}
			} else schema = UtilsServer.addIdToSchema(schema, 0, this.salt);

			await writeFile(
				join(tablePath, "schema.json"),
				JSON.stringify(schema, null, 2),
			);
		}

		if (config) {
			if (
				config.compression !== undefined &&
				config.compression !== table.config.compression
			) {
				await UtilsServer.execFile(
					"find",
					[
						tableName,
						"-type",
						"f",
						"-name",
						`*${this.fileExtension}${config.compression ? "" : ".gz"}`,
						"-exec",
						config.compression ? "gzip" : "gunzip",
						"-f",
						"{}",
						"+",
					],
					{ cwd: this.databasePath },
				);
				if (config.compression)
					await writeFile(join(tablePath, ".compression.config"), "");
				else await unlink(join(tablePath, ".compression.config"));
			}
			if (config.cache !== undefined && config.cache !== table.config.cache) {
				if (config.cache) await writeFile(join(tablePath, ".cache.config"), "");
				else await unlink(join(tablePath, ".cache.config"));
			}
			if (
				config.prepend !== undefined &&
				config.prepend !== table.config.prepend
			) {
				await UtilsServer.execFile(
					"find",
					[
						tableName,
						"-type",
						"f",
						"-name",
						`*${this.fileExtension}${config.compression ? ".gz" : ""}`,
						"-exec",
						"sh",
						"-c",
						`for file; do ${
							config.compression
								? 'zcat "$file" | tac | gzip > "$file.reversed" && mv "$file.reversed" "$file"'
								: 'tac "$file" > "$file.reversed" && mv "$file.reversed" "$file"'
						}; done`,
						"_",
						"{}",
						"+",
					],
					{ cwd: this.databasePath },
				);
				if (config.prepend)
					await writeFile(join(tablePath, ".prepend.config"), "");
				else await unlink(join(tablePath, ".prepend.config"));
			}
			if (config.name) {
				await this.replaceStringInSchemas(
					this.databasePath,
					`"table": "${tableName}"`,
					`"table": "${config.name}"`,
				);
				await rename(tablePath, join(this.databasePath, config.name));
			}
		}

		delete this.tables[tableName];
	}

	/**
	 * Get table schema and config
	 *
	 * @param {string} tableName
	 * @return {*}  {Promise<TableObject>}
	 */
	public async getTable(tableName: string): Promise<TableObject> {
		const tablePath = join(this.databasePath, tableName);

		if (!(await File.isExists(tablePath)))
			throw this.throwError("TABLE_NOT_EXISTS", tableName);

		if (!this.tables[tableName])
			this.tables[tableName] = {
				schema: await this.getTableSchema(tableName),
				config: {
					compression: await File.isExists(
						join(tablePath, ".compression.config"),
					),
					cache: await File.isExists(join(tablePath, ".cache.config")),
					prepend: await File.isExists(join(tablePath, ".prepend.config")),
				},
			};
		return this.tables[tableName];
	}

	public async getTableSchema(
		tableName: string,
		encodeIDs = true,
	): Promise<Schema | undefined> {
		const tableSchemaPath = join(this.databasePath, tableName, "schema.json");
		if (!(await File.isExists(tableSchemaPath))) return undefined;

		const schemaFile = await readFile(tableSchemaPath, "utf8");

		if (!schemaFile) return undefined;

		let schema = JSON.parse(schemaFile);
		const lastIdNumber = UtilsServer.findLastIdNumber(schema, this.salt);

		schema = [
			{
				id: 0,
				key: "id",
				type: "id",
				required: true,
			},
			...schema,
			{
				id: lastIdNumber + 1,
				key: "createdAt",
				type: "date",
				required: true,
			},
			{
				id: lastIdNumber + 2,
				key: "updatedAt",
				type: "date",
				required: false,
			},
		];

		if (!encodeIDs) return schema;
		return UtilsServer.encodeSchemaID(schema, this.salt);
	}

	private async throwErrorIfTableEmpty(
		tableName: string,
	): Promise<TableObject> {
		const table = await this.getTable(tableName);

		if (!table.schema) throw this.throwError("NO_SCHEMA", tableName);

		if (
			!(await File.isExists(
				join(
					this.databasePath,
					tableName,
					`id${this.getFileExtension(tableName)}`,
				),
			))
		)
			throw this.throwError("NO_ITEMS", tableName);
		return table;
	}

	private validateData(
		data: Data | Data[],
		schema: Schema,
		skipRequiredField = false,
	): void {
		if (Utils.isArrayOfObjects(data))
			for (const single_data of data as Data[])
				this.validateData(single_data, schema, skipRequiredField);
		else if (Utils.isObject(data)) {
			for (const field of schema) {
				if (
					!Object.hasOwn(data, field.key) ||
					data[field.key] === null ||
					data[field.key] === undefined
				) {
					if (field.required && !skipRequiredField)
						throw this.throwError("FIELD_REQUIRED", field.key);
					return;
				}

				if (
					Object.hasOwn(data, field.key) &&
					!Utils.validateFieldType(
						data[field.key],
						field.type,
						(field.type === "array" || field.type === "object") &&
							field.children &&
							!Utils.isArrayOfObjects(field.children)
							? field.children
							: undefined,
					)
				)
					throw this.throwError("INVALID_TYPE", [
						field.key,
						Array.isArray(field.type) ? field.type.join(", ") : field.type,
						data[field.key],
					]);
				if (
					(field.type === "array" || field.type === "object") &&
					field.children &&
					Utils.isArrayOfObjects(field.children)
				)
					this.validateData(data[field.key], field.children, skipRequiredField);
				else if (field.unique) {
					if (!this.checkIFunique[field.key])
						this.checkIFunique[field.key] = [];
					this.checkIFunique[`${field.key}`].push(data[field.key]);
				}
			}
		}
	}

	private cleanObject<T extends Record<string, any>>(obj: T): T | null {
		const cleanedObject = Object.entries(obj).reduce((acc, [key, value]) => {
			if (value !== undefined && value !== null && value !== "")
				acc[key] = value;
			return acc;
		}, {} as T);

		return Object.keys(cleanedObject).length > 0 ? cleanedObject : null;
	}

	private formatField(
		value: Data | number | string,
		fieldType?: FieldType | FieldType[],
		fieldChildrenType?: FieldType | FieldType[] | Schema,
		_formatOnlyAvailiableKeys?: boolean,
	): Data | number | string | null;
	private formatField(
		value: (number | string | Data)[],
		fieldType?: FieldType | FieldType[],
		fieldChildrenType?: FieldType | FieldType[] | Schema,
		_formatOnlyAvailiableKeys?: boolean,
	): (number | string | null | Data)[];
	private formatField(
		value: Data | number | string | (number | string | Data)[],
		fieldType?: FieldType | FieldType[],
		fieldChildrenType?: FieldType | FieldType[] | Schema,
		_formatOnlyAvailiableKeys?: boolean,
	): Data | Data[] | number | string | null {
		if (Array.isArray(fieldType))
			fieldType = Utils.detectFieldType(value, fieldType) ?? fieldType[0];
		if (!value) return null;
		if (Array.isArray(value) && !["array", "json"].includes(fieldType))
			value = value[0];
		switch (fieldType) {
			case "array":
				if (!fieldChildrenType) return null;
				if (!Array.isArray(value)) value = [value];
				if (Utils.isArrayOfObjects(fieldChildrenType))
					return this.formatData(
						value as Data[],
						fieldChildrenType,
						_formatOnlyAvailiableKeys,
					);
				if (!value.length) return null;
				return (value as (string | number | Data)[]).map((_value) =>
					this.formatField(_value, fieldChildrenType),
				);
			case "object":
				if (Utils.isArrayOfObjects(fieldChildrenType))
					return this.formatData(
						value as Data,
						fieldChildrenType,
						_formatOnlyAvailiableKeys,
					);
				break;
			case "table":
				if (Utils.isObject(value)) {
					if (
						Object.hasOwn(value, "id") &&
						(Utils.isValidID((value as Data).id) ||
							Utils.isNumber((value as Data).id))
					)
						return Utils.isNumber((value as Data).id)
							? Number((value as Data).id)
							: UtilsServer.decodeID((value as Data).id as string, this.salt);
				} else if (Utils.isValidID(value) || Utils.isNumber(value))
					return Utils.isNumber(value)
						? Number(value)
						: UtilsServer.decodeID(value, this.salt);
				break;
			case "password":
				return Utils.isPassword(value)
					? value
					: UtilsServer.hashPassword(String(value));
			case "number":
				return Utils.isNumber(value) ? Number(value) : null;
			case "date": {
				if (Utils.isNumber(value)) return value;
				const dateToTimestamp = Date.parse(value as string);
				return Number.isNaN(dateToTimestamp) ? null : dateToTimestamp;
			}
			case "id":
				return Utils.isNumber(value)
					? value
					: UtilsServer.decodeID(value as string, this.salt);
			case "json": {
				if (typeof value === "string" && Utils.isStringified(value))
					return value;
				if (Utils.isObject(value)) {
					const cleanedObject = this.cleanObject(value as Data);
					if (cleanedObject) return Inison.stringify(cleanedObject);
				} else return Inison.stringify(value);
				return null;
			}
			default:
				return value;
		}
		return null;
	}

	private async checkUnique(tableName: string, schema: Schema) {
		const tablePath = join(this.databasePath, tableName);
		for await (const [key, values] of Object.entries(this.checkIFunique)) {
			const field = Utils.getField(key, schema);
			if (!field) continue;
			const [searchResult, totalLines] = await File.search(
				join(tablePath, `${key}${this.getFileExtension(tableName)}`),
				Array.isArray(values) ? "=" : "[]",
				values,
				undefined,
				field.type,
				field.children,
				1,
				undefined,
				false,
				this.salt,
			);

			if (searchResult && totalLines > 0)
				throw this.throwError("FIELD_UNIQUE", [
					field.key,
					Array.isArray(values) ? values.join(", ") : values,
				]);
		}
		this.checkIFunique = {};
	}

	private formatData(
		data: Data,
		schema: Schema,
		formatOnlyAvailiableKeys?: boolean,
	): Data;
	private formatData(
		data: Data | Data[],
		schema: Schema,
		formatOnlyAvailiableKeys?: boolean,
	): Data[];
	private formatData(
		data: Data | Data[],
		schema: Schema,
		formatOnlyAvailiableKeys?: boolean,
	): Data | Data[] {
		if (Utils.isArrayOfObjects(data))
			return data.map((single_data: Data) =>
				this.formatData(single_data, schema, formatOnlyAvailiableKeys),
			);
		if (Utils.isObject(data)) {
			const RETURN: Data = {};
			for (const field of schema) {
				if (!Object.hasOwn(data, field.key)) {
					if (formatOnlyAvailiableKeys) continue;
					RETURN[field.key] = this.getDefaultValue(field);
					continue;
				}
				RETURN[field.key] = this.formatField(
					data[field.key],
					field.type,
					field.children,
					formatOnlyAvailiableKeys,
				);
			}
			return RETURN;
		}
		return [];
	}

	private getDefaultValue(field: Field): any {
		if (Array.isArray(field.type))
			return this.getDefaultValue({
				...field,
				type: field.type.sort(
					(a: FieldType, b: FieldType) =>
						Number(b === "array") - Number(a === "array") ||
						Number(a === "string") - Number(b === "string") ||
						Number(a === "number") - Number(b === "number"),
				)[0],
			} as Field);

		switch (field.type) {
			case "array":
				return Utils.isArrayOfObjects(field.children)
					? [
							this.getDefaultValue({
								...field,
								type: "object",
								children: field.children as Schema,
							}),
						]
					: null;
			case "object": {
				if (!field.children || !Utils.isArrayOfObjects(field.children))
					return null;
				const RETURN: Record<string, any> = {};
				for (const f of field.children) RETURN[f.key] = this.getDefaultValue(f);
				return RETURN;
			}
			case "boolean":
				return false;
			default:
				return null;
		}
	}

	private _combineObjectsToArray = (
		input: any[],
	): Record<
		string,
		string | boolean | number | null | (string | boolean | number | null)[]
	> =>
		input.reduce((result, current) => {
			for (const [key, value] of Object.entries(current))
				if (Object.hasOwn(result, key) && Array.isArray(result[key]))
					result[key].push(value);
				else result[key] = [value];

			return result;
		}, {});
	private _CombineData = (
		data: Data | Data[],
		prefix?: string,
	): Record<
		string,
		string | boolean | number | null | (string | boolean | number | null)[]
	> => {
		if (Utils.isArrayOfObjects(data))
			return this._combineObjectsToArray(
				data.map((single_data) => this._CombineData(single_data)),
			);

		const RETURN: Record<
			string,
			string | boolean | number | null | (string | boolean | number | null)[]
		> = {};

		for (const [key, value] of Object.entries(data)) {
			if (Utils.isObject(value))
				Object.assign(RETURN, this._CombineData(value, `${key}.`));
			else if (Utils.isArrayOfObjects(value)) {
				Object.assign(
					RETURN,
					this._CombineData(
						this._combineObjectsToArray(value),
						`${(prefix ?? "") + key}.`,
					),
				);
			} else if (
				Utils.isArrayOfArrays(value) &&
				value.every(Utils.isArrayOfObjects)
			)
				Object.assign(
					RETURN,
					this._CombineData(
						this._combineObjectsToArray(value.map(this._combineObjectsToArray)),
						`${(prefix ?? "") + key}.`,
					),
				);
			else RETURN[(prefix ?? "") + key] = File.encode(value);
		}

		return RETURN;
	};

	private joinPathesContents(tableName: string, data: Data | Data[]) {
		const tablePath = join(this.databasePath, tableName),
			combinedData = this._CombineData(data);
		const newCombinedData: Record<string, any> = {};

		for (const [key, value] of Object.entries(combinedData))
			newCombinedData[
				join(tablePath, `${key}${this.getFileExtension(tableName)}`)
			] = value;

		return newCombinedData;
	}

	private _getItemsFromSchemaHelper(
		RETURN: Record<number, Data>,
		item: Data,
		index: number,
		field: Field,
	) {
		if (Utils.isObject(item)) {
			if (!RETURN[index]) RETURN[index] = {};
			if (!RETURN[index][field.key]) RETURN[index][field.key] = [];
			for (const child_field of (field.children as Schema).filter(
				(children) =>
					children.type === "array" &&
					Utils.isArrayOfObjects(children.children),
			)) {
				if (Utils.isObject(item[child_field.key])) {
					for (const [key, value] of Object.entries(item[child_field.key])) {
						for (let _i = 0; _i < value.length; _i++) {
							if (
								(Array.isArray(value[_i]) && Utils.isArrayOfNulls(value[_i])) ||
								value[_i] === null
							)
								continue;

							if (!RETURN[index][field.key][_i])
								RETURN[index][field.key][_i] = {};
							if (!RETURN[index][field.key][_i][child_field.key])
								RETURN[index][field.key][_i][child_field.key] = [];

							if (!Array.isArray(value[_i])) {
								if (!RETURN[index][field.key][_i][child_field.key][0])
									RETURN[index][field.key][_i][child_field.key][0] = {};
								RETURN[index][field.key][_i][child_field.key][0][key] =
									value[_i];
							} else {
								value[_i].forEach((_element: any, _index: number) => {
									// Recursive call
									this._getItemsFromSchemaHelper(
										RETURN[index][field.key][_i][child_field.key][_index],
										_element,
										_index,
										child_field,
									);

									// Perform property assignments
									if (!RETURN[index][field.key][_i][child_field.key][_index])
										RETURN[index][field.key][_i][child_field.key][_index] = {};
									RETURN[index][field.key][_i][child_field.key][_index][key] =
										_element;
								});
							}
						}
					}
				}
			}
		}
	}
	private async getItemsFromSchema(
		tableName: string,
		schema: Schema,
		linesNumber: number[],
		options: Options,
		prefix?: string,
	) {
		const tablePath = join(this.databasePath, tableName);
		const RETURN: Record<number, Data> = {};

		for await (const field of schema) {
			if (
				(field.type === "array" ||
					(Array.isArray(field.type) && field.type.includes("array"))) &&
				field.children
			) {
				if (Utils.isArrayOfObjects(field.children)) {
					if (
						field.children.filter(
							(children) =>
								children.type === "array" &&
								Utils.isArrayOfObjects(children.children),
						).length
					) {
						// one of children has array field type and has children array of object = Schema
						const childItems = await this.getItemsFromSchema(
							tableName,
							(field.children as Schema).filter(
								(children) =>
									children.type === "array" &&
									Utils.isArrayOfObjects(children.children),
							),
							linesNumber,
							options,
							`${(prefix ?? "") + field.key}.`,
						);
						if (childItems)
							for (const [index, item] of Object.entries(childItems))
								this._getItemsFromSchemaHelper(RETURN, item, index, field);

						field.children = field.children.filter(
							(children) =>
								children.type !== "array" ||
								!Utils.isArrayOfObjects(children.children),
						);
					}
					const fieldItems = await this.getItemsFromSchema(
						tableName,
						field.children,
						linesNumber,
						options,
						`${(prefix ?? "") + field.key}.`,
					);
					if (fieldItems)
						for (const [index, item] of Object.entries(fieldItems)) {
							if (!RETURN[index]) RETURN[index] = {};
							if (Utils.isObject(item)) {
								if (!Utils.isArrayOfNulls(Object.values(item))) {
									if (RETURN[index][field.key])
										Object.entries(item).forEach(([key, value], _index) => {
											for (let _index = 0; _index < value.length; _index++)
												if (RETURN[index][field.key][_index])
													Object.assign(RETURN[index][field.key][_index], {
														[key]: value[_index],
													});
												else
													RETURN[index][field.key][_index] = {
														[key]: value[_index],
													};
										});
									else if (
										Object.values(item).every(
											(_i) => Utils.isArrayOfArrays(_i) || Array.isArray(_i),
										) &&
										prefix
									)
										RETURN[index][field.key] = item;
									else {
										RETURN[index][field.key] = [];
										Object.entries(item).forEach(([key, value], _ind) => {
											if (!Array.isArray(value)) {
												RETURN[index][field.key][_ind] = {};
												RETURN[index][field.key][_ind][key] = value;
											} else
												for (let _i = 0; _i < value.length; _i++) {
													if (
														value[_i] === null ||
														(Array.isArray(value[_i]) &&
															Utils.isArrayOfNulls(value[_i]))
													)
														continue;

													if (!RETURN[index][field.key][_i])
														RETURN[index][field.key][_i] = {};
													RETURN[index][field.key][_i][key] = value[_i];
												}
										});
									}
								} else RETURN[index][field.key] = null;
							} else RETURN[index][field.key] = item;
						}
				} else if (
					field.children === "table" ||
					(Array.isArray(field.type) && field.type.includes("table")) ||
					(Array.isArray(field.children) && field.children.includes("table"))
				) {
					if (
						field.table &&
						(await File.isExists(join(this.databasePath, field.table))) &&
						(await File.isExists(
							join(
								tablePath,
								`${(prefix ?? "") + field.key}${this.getFileExtension(
									tableName,
								)}`,
							),
						))
					) {
						const itemsIDs = await File.get(
							join(
								tablePath,
								`${(prefix ?? "") + field.key}${this.getFileExtension(
									tableName,
								)}`,
							),
							linesNumber,
							field.type,
							field.children,
							this.salt,
						);
						if (itemsIDs) {
							const searchableIDs: Record<number, string[]> = {};
							for (const [index, item] of Object.entries(itemsIDs)) {
								if (!RETURN[index]) RETURN[index] = {};
								if (item !== null && item !== undefined)
									searchableIDs[index] = item as string[];
							}
							if (Object.keys(searchableIDs).length) {
								const items = await this.get(
									field.table,
									[].concat(...Object.values(searchableIDs)),
									{
										...options,
										perPage: Number.POSITIVE_INFINITY,
										columns: (options.columns as string[] | undefined)
											?.filter((column) => column.includes(`${field.key}.`))
											.map((column) => column.replace(`${field.key}.`, "")),
									},
								);

								if (items) {
									let cursor = 0;
									for (const [index, Ids] of Object.entries(searchableIDs)) {
										RETURN[index][field.key] = items.slice(
											cursor,
											cursor + Ids.length,
										);
										cursor += Ids.length;
									}
								}
							}
						}
					}
				} else if (
					await File.isExists(
						join(
							tablePath,
							`${(prefix ?? "") + field.key}${this.getFileExtension(
								tableName,
							)}`,
						),
					)
				) {
					const items = await File.get(
						join(
							tablePath,
							`${(prefix ?? "") + field.key}${this.getFileExtension(
								tableName,
							)}`,
						),
						linesNumber,
						field.type,
						field.children,
						this.salt,
					);

					if (items)
						for (const [index, item] of Object.entries(items)) {
							if (!RETURN[index]) RETURN[index] = {};
							if (item !== null && item !== undefined)
								RETURN[index][field.key] = item;
						}
				}
			} else if (field.type === "object") {
				const fieldItems = await this.getItemsFromSchema(
					tableName,
					field.children as Schema,
					linesNumber,
					options,
					`${(prefix ?? "") + field.key}.`,
				);
				if (fieldItems)
					for (const [index, item] of Object.entries(fieldItems)) {
						if (!RETURN[index]) RETURN[index] = {};
						if (Utils.isObject(item)) {
							if (!Object.values(item).every((i) => i === null))
								RETURN[index][field.key] = item;
						}
					}
			} else if (field.type === "table") {
				if (
					field.table &&
					(await File.isExists(join(this.databasePath, field.table))) &&
					(await File.isExists(
						join(
							tablePath,
							`${(prefix ?? "") + field.key}${this.getFileExtension(
								tableName,
							)}`,
						),
					))
				) {
					const itemsIDs = await File.get(
						join(
							tablePath,
							`${(prefix ?? "") + field.key}${this.getFileExtension(
								tableName,
							)}`,
						),
						linesNumber,
						field.type,
						field.children,
						this.salt,
					);
					if (itemsIDs) {
						const searchableIDs: Record<number, string> = {};
						for (const [index, item] of Object.entries(itemsIDs)) {
							if (!RETURN[index]) RETURN[index] = {};
							if (item !== null && item !== undefined)
								searchableIDs[index] = item as string;
						}
						if (Object.keys(searchableIDs).length) {
							const items = await this.get(
								field.table,
								Object.values(searchableIDs),
								{
									...options,
									perPage: Number.POSITIVE_INFINITY,
									columns: (options.columns as string[] | undefined)
										?.filter((column) => column.includes(`${field.key}.`))
										.map((column) => column.replace(`${field.key}.`, "")),
								},
							);

							if (items) {
								let cursor = 0;
								for (const [index] of Object.entries(searchableIDs)) {
									RETURN[index][field.key] = items[cursor];
									cursor++;
								}
							}
						}
					}
				}
			} else if (
				await File.isExists(
					join(
						tablePath,
						`${(prefix ?? "") + field.key}${this.getFileExtension(tableName)}`,
					),
				)
			) {
				const items = await File.get(
					join(
						tablePath,
						`${(prefix ?? "") + field.key}${this.getFileExtension(tableName)}`,
					),
					linesNumber,
					field.type,
					field.children,
					this.salt,
				);

				if (items)
					for (const [index, item] of Object.entries(items)) {
						if (!RETURN[index]) RETURN[index] = {};
						if (item !== null && item !== undefined)
							RETURN[index][field.key] = item;
					}
				// else
				// 	RETURN = Object.fromEntries(
				// 		Object.entries(RETURN).map(([index, data]) => [
				// 			index,
				// 			{ ...data, [field.key]: this.getDefaultValue(field) },
				// 		]),
				// 	);
			}
		}
		return RETURN;
	}

	private async applyCriteria(
		tableName: string,
		schema: Schema,
		options: Options,
		criteria?: Criteria,
		allTrue?: boolean,
	): Promise<[Record<number, Data> | null, Set<number> | null]> {
		const tablePath = join(this.databasePath, tableName);

		let RETURN: Record<number, Data> = {},
			RETURN_LineNumbers = null;
		if (!criteria) return [null, null];
		if (criteria.and && Utils.isObject(criteria.and)) {
			const [searchResult, lineNumbers] = await this.applyCriteria(
				tableName,
				schema,
				options,
				criteria.and as Criteria,
				true,
			);
			if (searchResult) {
				RETURN = Utils.deepMerge(
					RETURN,
					Object.fromEntries(
						Object.entries(searchResult).filter(
							([_k, v], _i) =>
								Object.keys(v).length ===
								Object.keys(criteria.and ?? {}).length,
						),
					),
				);
				delete criteria.and;
				RETURN_LineNumbers = lineNumbers;
			} else return [null, null];
		}

		if (criteria.or && Utils.isObject(criteria.or)) {
			const [searchResult, lineNumbers] = await this.applyCriteria(
				tableName,
				schema,
				options,
				criteria.or as Criteria,
				false,
			);
			delete criteria.or;
			if (searchResult) {
				RETURN = Utils.deepMerge(RETURN, searchResult);
				RETURN_LineNumbers = lineNumbers;
			}
		}

		if (Object.keys(criteria).length > 0) {
			if (allTrue === undefined) allTrue = true;

			let index = -1;
			for await (const [key, value] of Object.entries(criteria)) {
				const field = Utils.getField(key, schema);
				index++;
				let searchOperator:
						| ComparisonOperator
						| ComparisonOperator[]
						| undefined = undefined,
					searchComparedAtValue:
						| string
						| number
						| boolean
						| null
						| (string | number | boolean | null)[]
						| undefined = undefined,
					searchLogicalOperator: "and" | "or" | undefined = undefined;
				if (Utils.isObject(value)) {
					if (
						(value as Criteria)?.or &&
						Array.isArray((value as Criteria)?.or)
					) {
						const searchCriteria = (
							(value as Criteria)?.or as (string | number | boolean)[]
						)
							.map(
								(
									single_or,
								): [
									ComparisonOperator,
									string | number | boolean | null | (string | number | null)[],
								] =>
									typeof single_or === "string"
										? Utils.FormatObjectCriteriaValue(single_or)
										: ["=", single_or],
							)
							.filter((a) => a) as [ComparisonOperator, string | number][];
						if (searchCriteria.length > 0) {
							searchOperator = searchCriteria.map((single_or) => single_or[0]);
							searchComparedAtValue = searchCriteria.map(
								(single_or) => single_or[1],
							);
							searchLogicalOperator = "or";
						}
						delete value.or;
					}
					if (
						(value as Criteria)?.and &&
						Array.isArray((value as Criteria)?.and)
					) {
						const searchCriteria = (
							(value as Criteria)?.and as (string | number | boolean)[]
						)
							.map(
								(
									single_and,
								): [
									ComparisonOperator,
									string | number | boolean | null | (string | number | null)[],
								] =>
									typeof single_and === "string"
										? Utils.FormatObjectCriteriaValue(single_and)
										: ["=", single_and],
							)
							.filter((a) => a) as [ComparisonOperator, string | number][];
						if (searchCriteria.length > 0) {
							searchOperator = searchCriteria.map(
								(single_and) => single_and[0],
							);
							searchComparedAtValue = searchCriteria.map(
								(single_and) => single_and[1],
							);
							searchLogicalOperator = "and";
						}
						delete value.and;
					}
				} else if (Array.isArray(value)) {
					const searchCriteria = value
						.map(
							(
								single,
							): [
								ComparisonOperator,
								string | number | boolean | null | (string | number | null)[],
							] =>
								typeof single === "string"
									? Utils.FormatObjectCriteriaValue(single)
									: ["=", single],
						)
						.filter((a) => a) as [ComparisonOperator, string | number][];
					if (searchCriteria.length > 0) {
						searchOperator = searchCriteria.map((single) => single[0]);
						searchComparedAtValue = searchCriteria.map((single) => single[1]);
						searchLogicalOperator = "and";
					}
				} else if (typeof value === "string") {
					const ComparisonOperatorValue =
						Utils.FormatObjectCriteriaValue(value);
					if (ComparisonOperatorValue) {
						searchOperator = ComparisonOperatorValue[0];
						searchComparedAtValue = ComparisonOperatorValue[1];
					}
				} else {
					searchOperator = "=";
					searchComparedAtValue = value as number | boolean;
				}
				const [searchResult, totalLines, linesNumbers] = await File.search(
					join(tablePath, `${key}${this.getFileExtension(tableName)}`),
					searchOperator ?? "=",
					searchComparedAtValue ?? null,
					searchLogicalOperator,
					field?.type,
					field?.children,
					options.perPage,
					((options.page as number) - 1) * (options.perPage as number) + 1,
					true,
					this.salt,
				);

				if (searchResult) {
					RETURN = Utils.deepMerge(
						RETURN,
						Object.fromEntries(
							Object.entries(searchResult).map(([id, value]) => [
								id,
								{
									[key]: value,
								},
							]),
						),
					);
					this.totalItems[`${tableName}-${key}`] = totalLines;
					RETURN_LineNumbers = linesNumbers;
				}

				if (allTrue && index > 0) {
					if (!Object.keys(RETURN).length) RETURN = {};
					RETURN = Object.fromEntries(
						Object.entries(RETURN).filter(
							([_index, item]) => Object.keys(item).length > index,
						),
					);
					if (!Object.keys(RETURN).length) RETURN = {};
				}
			}
		}

		return [Object.keys(RETURN).length ? RETURN : null, RETURN_LineNumbers];
	}

	private _filterSchemaByColumns(schema: Schema, columns: string[]): Schema {
		return schema
			.map((field) => {
				if (columns.some((column) => column.startsWith("!")))
					return columns.includes(`!${field.key}`) ? null : field;
				if (columns.includes(field.key) || columns.includes("*")) return field;

				if (
					(field.type === "array" || field.type === "object") &&
					Utils.isArrayOfObjects(field.children) &&
					columns.filter(
						(column) =>
							column.startsWith(`${field.key}.`) ||
							column.startsWith(`!${field.key}.`),
					).length
				) {
					field.children = this._filterSchemaByColumns(
						field.children,
						columns
							.filter(
								(column) =>
									column.startsWith(`${field.key}.`) ||
									column.startsWith(`!${field.key}.`),
							)
							.map((column) => column.replace(`${field.key}.`, "")),
					);
					return field;
				}
				return null;
			})
			.filter((i) => i) as Schema;
	}

	/**
	 * Clear table cache
	 *
	 * @param {string} tableName
	 */
	public async clearCache(tableName: string) {
		const cacheFolderPath = join(this.databasePath, tableName, ".cache");
		await Promise.all(
			(await readdir(cacheFolderPath))
				.filter((file) => file !== ".pagination")
				.map((file) => unlink(join(cacheFolderPath, file))),
		);
	}

	/**
	 * Retrieve item(s) from a table
	 *
	 * @param {string} tableName
	 * @param {(string | number | (string | number)[] | Criteria)} [where]
	 * @param {Options} [options]
	 * @param {boolean} [onlyOne]
	 * @param {boolean} [onlyLinesNumbers]
	 * @return {*}  {(Promise<Data | number | (Data | number)[] | null>)}
	 */
	get(
		tableName: string,
		where: string | number | (string | number)[] | Criteria | undefined,
		options: Options | undefined,
		onlyOne: true,
		onlyLinesNumbers?: false,
	): Promise<Data | null>;
	get(
		tableName: string,
		where: string | number,
		options?: Options,
		onlyOne?: boolean,
		onlyLinesNumbers?: false,
	): Promise<Data | null>;
	get(
		tableName: string,
		where?: string | number | (string | number)[] | Criteria,
		options?: Options,
		onlyOne?: boolean,
		onlyLinesNumbers?: false,
	): Promise<Data[] | null>;
	get(
		tableName: string,
		where: string | number | (string | number)[] | Criteria | undefined,
		options: Options | undefined,
		onlyOne: false | undefined,
		onlyLinesNumbers: true,
	): Promise<number[] | null>;
	get(
		tableName: string,
		where: string | number | (string | number)[] | Criteria | undefined,
		options: Options | undefined,
		onlyOne: true,
		onlyLinesNumbers: true,
	): Promise<number | null>;
	public async get(
		tableName: string,
		where?: string | number | (string | number)[] | Criteria,
		options: Options = {
			page: 1,
			perPage: 15,
		},
		onlyOne?: boolean,
		onlyLinesNumbers?: boolean,
	): Promise<Data | number | (Data | number)[] | null> {
		const tablePath = join(this.databasePath, tableName);

		// Ensure options.columns is an array
		if (options.columns) {
			options.columns = Array.isArray(options.columns)
				? options.columns
				: [options.columns];

			if (options.columns.length && !options.columns.includes("id"))
				options.columns.push("id");
		}

		// Default values for page and perPage
		options.page = options.page || 1;
		options.perPage = options.perPage || 15;

		let RETURN!: Data | Data[] | null;
		let schema = (await this.getTable(tableName)).schema;

		if (!schema) throw this.throwError("NO_SCHEMA", tableName);

		if (
			!(await File.isExists(
				join(tablePath, `id${this.getFileExtension(tableName)}`),
			))
		)
			return null;

		if (options.columns?.length)
			schema = this._filterSchemaByColumns(schema, options.columns as string[]);

		if (
			where &&
			((Array.isArray(where) && !where.length) ||
				(Utils.isObject(where) && !Object.keys(where).length))
		)
			where = undefined;

		if (options.sort) {
			let sortArray: [string, boolean][],
				awkCommand = "";

			if (Utils.isObject(options.sort) && !Array.isArray(options.sort)) {
				// {name: "ASC", age: "DESC"}
				sortArray = Object.entries(options.sort).map(([key, value]) => [
					key,
					typeof value === "string" ? value.toLowerCase() === "asc" : value > 0,
				]);
			} else
				sortArray = ([] as string[])
					.concat(options.sort as string | string[])
					.map((column) => [column, true]);

			let cacheKey = "";
			// Criteria
			if (this.tables[tableName].config.cache)
				cacheKey = UtilsServer.hashString(inspect(sortArray, { sorted: true }));

			if (where) {
				const lineNumbers = await this.get(
					tableName,
					where,
					undefined,
					undefined,
					true,
				);
				if (!lineNumbers?.length) return null;
				const itemsIDs = Object.values(
					(await File.get(
						join(tablePath, `id${this.getFileExtension(tableName)}`),
						lineNumbers,
						"number",
						undefined,
						this.salt,
					)) ?? {},
				).map(Number);
				awkCommand = `awk '${itemsIDs.map((id) => `$1 == ${id}`).join(" || ")}'`;
			} else
				awkCommand = `awk '${Array.from(
					{ length: options.perPage },
					(_, index) =>
						((options.page as number) - 1) * (options.perPage as number) +
						index +
						1,
				)
					.map((lineNumber) => `NR==${lineNumber}`)
					.join(" || ")}'`;

			const filesPathes = [["id", true], ...sortArray].map((column) =>
				join(tablePath, `${column[0]}${this.getFileExtension(tableName)}`),
			);
			for await (const path of filesPathes.slice(1))
				if (!(await File.isExists(path))) return null;

			// Construct the paste command to merge files and filter lines by IDs
			const pasteCommand = `paste ${filesPathes.join(" ")}`;

			// Construct the sort command dynamically based on the number of files for sorting
			const index = 2;
			const sortColumns = sortArray
				.map(([key, ascending], i) => {
					const field = Utils.getField(key, schema);
					if (field)
						return `-k${i + index},${i + index}${
							Utils.isFieldType(
								["id", "number", "date"],
								field.type,
								field.children,
							)
								? "n"
								: ""
						}${!ascending ? "r" : ""}`;
					return "";
				})
				.join(" ");
			const sortCommand = `sort ${sortColumns} -T=${join(tablePath, ".tmp")}`;

			try {
				if (cacheKey) await File.lock(join(tablePath, ".tmp"), cacheKey);
				// Combine && Execute the commands synchronously
				let lines = (
					await UtilsServer.exec(
						this.tables[tableName].config.cache
							? (await File.isExists(
									join(tablePath, ".cache", `${cacheKey}${this.fileExtension}`),
								))
								? `${awkCommand} ${join(
										tablePath,
										".cache",
										`${cacheKey}${this.fileExtension}`,
									)}`
								: `${pasteCommand} | ${sortCommand} -o ${join(
										tablePath,
										".cache",
										`${cacheKey}${this.fileExtension}`,
									)} && ${awkCommand} ${join(
										tablePath,
										".cache",
										`${cacheKey}${this.fileExtension}`,
									)}`
							: `${pasteCommand} | ${sortCommand} | ${awkCommand}`,
						{
							encoding: "utf-8",
						},
					)
				).stdout
					.trimEnd()
					.split("\n");

				if (where)
					lines = lines.slice(
						((options.page as number) - 1) * (options.perPage as number),
						(options.page as number) * (options.perPage as number),
					);
				else if (!this.totalItems[`${tableName}-*`])
					this.totalItems[`${tableName}-*`] = await File.count(
						join(tablePath, `id${this.getFileExtension(tableName)}`),
					);

				if (!lines.length) return null;

				// Parse the result and extract the specified lines
				const outputArray: Data[] = lines.map((line) => {
					const splitedFileColumns = line.split("\t"); // Assuming tab-separated columns
					const outputObject: Record<string, any> = {};

					// Extract values for each file, including `id${this.getFileExtension(tableName)}`
					filesPathes.forEach((fileName, index) => {
						const field = Utils.getField(parse(fileName).name, schema);
						if (field)
							outputObject[field.key as string] = File.decode(
								splitedFileColumns[index],
								field?.type,
								field?.children as any,
								this.salt,
							);
					});

					return outputObject;
				});

				const restOfColumns = await this.get(
					tableName,
					outputArray.map(({ id }) => id as string),
					(({ sort, ...rest }) => rest)(options),
				);

				return restOfColumns
					? outputArray.map((item) => ({
							...item,
							...restOfColumns.find(({ id }) => id === item.id),
						}))
					: outputArray;
			} finally {
				if (cacheKey) await File.unlock(join(tablePath, ".tmp"), cacheKey);
			}
		}

		if (!where) {
			// Display all data
			RETURN = Object.values(
				await this.getItemsFromSchema(
					tableName,
					schema,
					Array.from(
						{ length: options.perPage },
						(_, index) =>
							((options.page as number) - 1) * (options.perPage as number) +
							index +
							1,
					),
					options,
				),
			);
			if (await File.isExists(join(tablePath, ".cache", ".pagination"))) {
				if (!this.totalItems[`${tableName}-*`])
					this.totalItems[`${tableName}-*`] = Number(
						(
							await readFile(join(tablePath, ".cache", ".pagination"), "utf8")
						).split(",")[1],
					);
			} else {
				const lastId = Number(
					Object.keys(
						(
							await File.get(
								join(tablePath, `id${this.getFileExtension(tableName)}`),
								-1,
								"number",
								undefined,
								this.salt,
								true,
							)
						)?.[0] ?? 0,
					),
				);

				if (!this.totalItems[`${tableName}-*`])
					this.totalItems[`${tableName}-*`] = await File.count(
						join(tablePath, `id${this.getFileExtension(tableName)}`),
					);

				await writeFile(
					join(tablePath, ".cache", ".pagination"),
					`${lastId},${this.totalItems[`${tableName}-*`]}`,
				);
			}
		} else if (
			(Array.isArray(where) && where.every(Utils.isNumber)) ||
			Utils.isNumber(where)
		) {
			// "where" in this case, is the line(s) number(s) and not id(s)
			let lineNumbers = where as number | number[];
			if (!Array.isArray(lineNumbers)) lineNumbers = [lineNumbers];

			if (!this.totalItems[`${tableName}-*`])
				this.totalItems[`${tableName}-*`] = lineNumbers.length;

			// useless
			if (onlyLinesNumbers) return lineNumbers;

			RETURN = Object.values(
				(await this.getItemsFromSchema(
					tableName,
					schema,
					lineNumbers,
					options,
				)) ?? {},
			);

			if (RETURN?.length && !Array.isArray(where))
				RETURN = (RETURN as Data[])[0];
		} else if (
			(Array.isArray(where) && where.every(Utils.isValidID)) ||
			Utils.isValidID(where)
		) {
			let Ids = where as string | number | (string | number)[];
			if (!Array.isArray(Ids)) Ids = [Ids];
			const [lineNumbers, countItems] = await File.search(
				join(tablePath, `id${this.getFileExtension(tableName)}`),
				"[]",
				Ids.map((id) =>
					Utils.isNumber(id) ? Number(id) : UtilsServer.decodeID(id, this.salt),
				),
				undefined,
				"number",
				undefined,
				Ids.length,
				0,
				!this.totalItems[`${tableName}-*`],
				this.salt,
			);
			if (!lineNumbers) return null;

			if (!this.totalItems[`${tableName}-*`])
				this.totalItems[`${tableName}-*`] = countItems;

			if (onlyLinesNumbers)
				return Object.keys(lineNumbers).length
					? Object.keys(lineNumbers).map(Number)
					: null;

			if (options.columns) {
				options.columns = (options.columns as string[]).filter(
					(column) => column !== "id",
				);
				if (!options.columns?.length) options.columns = undefined;
			}

			RETURN = Object.values(
				(await this.getItemsFromSchema(
					tableName,
					schema,
					Object.keys(lineNumbers).map(Number),
					options,
				)) ?? {},
			);

			if (RETURN?.length && !Array.isArray(where))
				RETURN = (RETURN as Data[])[0];
		} else if (Utils.isObject(where)) {
			let cachedFilePath = "";
			// Criteria
			if (this.tables[tableName].config.cache)
				cachedFilePath = join(
					tablePath,
					".cache",
					`${UtilsServer.hashString(inspect(where, { sorted: true }))}${
						this.fileExtension
					}`,
				);

			if (
				this.tables[tableName].config.cache &&
				(await File.isExists(cachedFilePath))
			) {
				const cachedItems = (await readFile(cachedFilePath, "utf8")).split(",");
				if (!this.totalItems[`${tableName}-*`])
					this.totalItems[`${tableName}-*`] = cachedItems.length;
				if (onlyLinesNumbers)
					return onlyOne ? Number(cachedItems[0]) : cachedItems.map(Number);

				return this.get(
					tableName,
					cachedItems
						.slice(
							((options.page as number) - 1) * options.perPage,
							(options.page as number) * options.perPage,
						)
						.map(Number),
					options,
					onlyOne,
				);
			}
			let linesNumbers = null;
			[RETURN, linesNumbers] = await this.applyCriteria(
				tableName,
				schema,
				options,
				where as Criteria,
			);
			if (RETURN && linesNumbers?.size) {
				if (!this.totalItems[`${tableName}-*`])
					this.totalItems[`${tableName}-*`] = linesNumbers.size;
				if (onlyLinesNumbers)
					return onlyOne
						? (linesNumbers.values().next().value as number)
						: Array.from(linesNumbers);
				const alreadyExistsColumns = Object.keys(Object.values(RETURN)[0]),
					alreadyExistsColumnsIDs = Utils.flattenSchema(schema)
						.filter(({ key }) => alreadyExistsColumns.includes(key))
						.map(({ id }) => id);

				RETURN = Object.values(
					Utils.deepMerge(
						RETURN,
						await this.getItemsFromSchema(
							tableName,
							Utils.filterSchema(
								schema,
								({ id, type, children }) =>
									!alreadyExistsColumnsIDs.includes(id) ||
									Utils.isFieldType("table", type, children),
							),
							Object.keys(RETURN).map(Number),
							options,
						),
					),
				);
				if (this.tables[tableName].config.cache)
					await writeFile(cachedFilePath, Array.from(linesNumbers).join(","));
			}
		}

		if (
			!RETURN ||
			(Utils.isObject(RETURN) && !Object.keys(RETURN).length) ||
			(Array.isArray(RETURN) && !RETURN.length)
		)
			return null;

		const greatestTotalItems =
			this.totalItems[`${tableName}-*`] ??
			Math.max(
				...Object.entries(this.totalItems)
					.filter(([k]) => k.startsWith(`${tableName}-`))
					.map(([, v]) => v),
			);

		this.pageInfo[tableName] = {
			...(({ columns, ...restOfOptions }) => restOfOptions)(options),
			perPage: Array.isArray(RETURN) ? RETURN.length : 1,
			totalPages: Math.ceil(greatestTotalItems / options.perPage),
			total: greatestTotalItems,
		};

		return onlyOne && Array.isArray(RETURN) ? RETURN[0] : RETURN;
	}

	/**
	 * Create new item(s) in a table
	 *
	 * @param {string} tableName
	 * @param {(Data | Data[])} data Can be array of objects or a single object
	 * @param {Options} [options] Pagination options, useful when the returnPostedData param is true
	 * @param {boolean} [returnPostedData] By default function returns void, if you want to get the posted data, set this param to true
	 * @return {*}  {Promise<Data | Data[] | null | void>}
	 */
	post(
		tableName: string,
		data: Data | Data[],
		options?: Options,
		returnPostedData?: boolean,
	): Promise<void>;
	post(
		tableName: string,
		data: Data,
		options: Options | undefined,
		returnPostedData: true,
	): Promise<Data | null>;
	post(
		tableName: string,
		data: Data[],
		options: Options | undefined,
		returnPostedData: true,
	): Promise<Data[] | null>;
	public async post(
		tableName: string,
		data: Data | Data[],
		options?: Options,
		returnPostedData?: boolean,
	): Promise<Data | Data[] | null | void> {
		if (!options)
			options = {
				page: 1,
				perPage: 15,
			};
		const tablePath = join(this.databasePath, tableName),
			schema = (await this.getTable(tableName)).schema;

		if (!schema) throw this.throwError("NO_SCHEMA", tableName);

		if (!returnPostedData) returnPostedData = false;
		let RETURN: Data | Data[] | null | undefined;

		const keys = UtilsServer.hashString(
			Object.keys(Array.isArray(data) ? data[0] : data).join("."),
		);

		let lastId = 0,
			renameList: string[][] = [];
		try {
			await File.lock(join(tablePath, ".tmp"), keys);

			if (
				await File.isExists(
					join(tablePath, `id${this.getFileExtension(tableName)}`),
				)
			) {
				if (await File.isExists(join(tablePath, ".cache", ".pagination")))
					[lastId, this.totalItems[`${tableName}-*`]] = (
						await readFile(join(tablePath, ".cache", ".pagination"), "utf8")
					)
						.split(",")
						.map(Number);
				else {
					lastId = Number(
						Object.keys(
							(
								await File.get(
									join(tablePath, `id${this.getFileExtension(tableName)}`),
									-1,
									"number",
									undefined,
									this.salt,
									true,
								)
							)?.[0] ?? 0,
						),
					);
					if (!this.totalItems[`${tableName}-*`])
						this.totalItems[`${tableName}-*`] = await File.count(
							join(tablePath, `id${this.getFileExtension(tableName)}`),
						);
				}
			} else this.totalItems[`${tableName}-*`] = 0;

			if (Utils.isArrayOfObjects(data))
				RETURN = data.map(({ id, updatedAt, createdAt, ...rest }) => ({
					id: ++lastId,
					...rest,
					createdAt: Date.now(),
				}));
			else
				RETURN = (({ id, updatedAt, createdAt, ...rest }) => ({
					id: ++lastId,
					...rest,
					createdAt: Date.now(),
				}))(data);

			this.validateData(RETURN, schema);
			await this.checkUnique(tableName, schema);
			RETURN = this.formatData(RETURN, schema);

			const pathesContents = this.joinPathesContents(
				tableName,
				this.tables[tableName].config.prepend
					? Array.isArray(RETURN)
						? RETURN.toReversed()
						: RETURN
					: RETURN,
			);

			await Promise.all(
				Object.entries(pathesContents).map(async ([path, content]) =>
					renameList.push(
						this.tables[tableName].config.prepend
							? await File.prepend(path, content)
							: await File.append(path, content),
					),
				),
			);

			await Promise.all(
				renameList.map(async ([tempPath, filePath]) =>
					rename(tempPath, filePath),
				),
			);
			renameList = [];

			if (this.tables[tableName].config.cache) await this.clearCache(tableName);

			this.totalItems[`${tableName}-*`] += Array.isArray(RETURN)
				? RETURN.length
				: 1;
			await writeFile(
				join(tablePath, ".cache", ".pagination"),
				`${lastId},${this.totalItems[`${tableName}-*`]}`,
			);

			if (returnPostedData)
				return this.get(
					tableName,
					this.tables[tableName].config.prepend
						? Array.isArray(RETURN)
							? RETURN.map((_, index) => index + 1).toReversed()
							: 1
						: Array.isArray(RETURN)
							? RETURN.map(
									(_, index) => this.totalItems[`${tableName}-*`] - index,
								).toReversed()
							: this.totalItems[`${tableName}-*`],
					options,
					!Utils.isArrayOfObjects(data), // return only one item if data is not array of objects
				);
		} finally {
			if (renameList.length)
				await Promise.allSettled(
					renameList.map(async ([tempPath, _]) => unlink(tempPath)),
				);
			await File.unlock(join(tablePath, ".tmp"), keys);
		}
	}

	/**
	 * Update item(s) in a table
	 *
	 * @param {string} tableName
	 * @param {(Data | Data[])} data
	 * @param {(number | string | (number | string)[] | Criteria)} [where]
	 * @param {Options} [options]
	 * @param {false} [returnUpdatedData]
	 * @return {*}  {Promise<Data | Data[] | null | undefined | void>}
	 */
	put(
		tableName: string,
		data: Data | Data[],
		where?: number | string | (number | string)[] | Criteria,
		options?: Options,
		returnUpdatedData?: false,
	): Promise<void>;
	put(
		tableName: string,
		data: Data,
		where: number | string | (number | string)[] | Criteria | undefined,
		options: Options | undefined,
		returnUpdatedData: true,
	): Promise<Data | null>;
	put(
		tableName: string,
		data: Data[],
		where: number | string | (number | string)[] | Criteria | undefined,
		options: Options | undefined,
		returnUpdatedData: true,
	): Promise<Data[] | null>;
	public async put(
		tableName: string,
		data: Data | Data[],
		where?: number | string | (number | string)[] | Criteria,
		options: Options = {
			page: 1,
			perPage: 15,
		},
		returnUpdatedData?: boolean,
	): Promise<Data | Data[] | null | undefined | void> {
		let renameList: string[][] = [];
		const tablePath = join(this.databasePath, tableName);
		const schema = (await this.throwErrorIfTableEmpty(tableName))
			.schema as Schema;

		if (!where) {
			if (Utils.isArrayOfObjects(data)) {
				if (
					!data.every(
						(item) => Object.hasOwn(item, "id") && Utils.isValidID(item.id),
					)
				)
					throw this.throwError("INVALID_ID");

				return this.put(
					tableName,
					data,
					data.map(({ id }) => id),
					options,
					returnUpdatedData || undefined,
				);
			}
			if (Object.hasOwn(data, "id")) {
				if (!Utils.isValidID(data.id))
					throw this.throwError("INVALID_ID", data.id);
				return this.put(
					tableName,
					data,
					data.id,
					options,
					returnUpdatedData || undefined,
				);
			}
			let totalItems: number;
			if (await File.isExists(join(tablePath, ".cache", ".pagination")))
				totalItems = (
					await readFile(join(tablePath, ".cache", ".pagination"), "utf8")
				)
					.split(",")
					.map(Number)[1];
			else
				totalItems = await File.count(
					join(tablePath, `id${this.getFileExtension(tableName)}`),
				);

			this.validateData(data, schema, true);
			await this.checkUnique(tableName, schema);
			data = this.formatData(data, schema, true);

			const pathesContents = this.joinPathesContents(tableName, {
				...(({ id, ...restOfData }) => restOfData)(data as Data),
				updatedAt: Date.now(),
			});

			try {
				await File.lock(join(tablePath, ".tmp"));

				await Promise.all(
					Object.entries(pathesContents).map(async ([path, content]) => {
						const replacementObject: Record<number, any> = {};
						for (const index of [...Array(totalItems)].keys())
							replacementObject[`${index + 1}`] = content;
						renameList.push(await File.replace(path, replacementObject));
					}),
				);

				await Promise.all(
					renameList.map(async ([tempPath, filePath]) =>
						rename(tempPath, filePath),
					),
				);

				if (this.tables[tableName].config.cache)
					await this.clearCache(join(tablePath, ".cache"));

				if (returnUpdatedData)
					return await this.get(tableName, undefined, options);
			} finally {
				if (renameList.length)
					await Promise.allSettled(
						renameList.map(async ([tempPath, _]) => unlink(tempPath)),
					);
				await File.unlock(join(tablePath, ".tmp"));
			}
		} else if (
			(Array.isArray(where) && where.every(Utils.isValidID)) ||
			Utils.isValidID(where)
		) {
			const lineNumbers = await this.get(
				tableName,
				where,
				undefined,
				undefined,
				true,
			);
			return this.put(
				tableName,
				data,
				lineNumbers,
				options,
				returnUpdatedData || undefined,
			);
		} else if (
			(Array.isArray(where) && where.every(Utils.isNumber)) ||
			Utils.isNumber(where)
		) {
			// "where" in this case, is the line(s) number(s) and not id(s)
			this.validateData(data, schema, true);
			await this.checkUnique(tableName, schema);
			data = this.formatData(data, schema, true);

			const pathesContents = Object.fromEntries(
				Object.entries(
					this.joinPathesContents(
						tableName,
						Utils.isArrayOfObjects(data)
							? data.map((item: any) => ({
									...item,
									updatedAt: Date.now(),
								}))
							: { ...data, updatedAt: Date.now() },
					),
				).map(([path, content]) => [
					path,
					([...(Array.isArray(where) ? where : [where])] as number[]).reduce(
						(obj, lineNum, index) =>
							Object.assign(obj, {
								[lineNum]: Array.isArray(content) ? content[index] : content,
							}),
						{},
					),
				]),
			);

			const keys = UtilsServer.hashString(
				Object.keys(pathesContents)
					.map((path) => path.replaceAll(this.getFileExtension(tableName), ""))
					.join("."),
			);

			try {
				await File.lock(join(tablePath, ".tmp"), keys);

				await Promise.all(
					Object.entries(pathesContents).map(async ([path, content]) =>
						renameList.push(await File.replace(path, content)),
					),
				);

				await Promise.all(
					renameList.map(async ([tempPath, filePath]) =>
						rename(tempPath, filePath),
					),
				);
				renameList = [];

				if (this.tables[tableName].config.cache)
					await this.clearCache(tableName);

				if (returnUpdatedData)
					return this.get(tableName, where, options, !Array.isArray(where));
			} finally {
				if (renameList.length)
					await Promise.allSettled(
						renameList.map(async ([tempPath, _]) => unlink(tempPath)),
					);
				await File.unlock(join(tablePath, ".tmp"), keys);
			}
		} else if (Utils.isObject(where)) {
			const lineNumbers = await this.get(
				tableName,
				where,
				undefined,
				undefined,
				true,
			);
			return this.put(
				tableName,
				data,
				lineNumbers,
				options,
				returnUpdatedData || undefined,
			);
		} else throw this.throwError("INVALID_PARAMETERS");
	}

	/**
	 * Delete item(s) in a table
	 *
	 * @param {string} tableName
	 * @param {(number | string | (number | string)[] | Criteria)} [where]
	 * @return {boolean | null}  {(Promise<boolean | null>)}
	 */
	public async delete(
		tableName: string,
		where?: number | string | (number | string)[] | Criteria,
		_id?: string | string[],
	): Promise<boolean | null> {
		const renameList: string[][] = [];

		const tablePath = join(this.databasePath, tableName);
		await this.throwErrorIfTableEmpty(tableName);

		if (!where) {
			try {
				await File.lock(join(tablePath, ".tmp"));
				await Promise.all(
					(await readdir(tablePath))
						?.filter((fileName: string) =>
							fileName.endsWith(this.getFileExtension(tableName)),
						)
						.map(async (file) => unlink(join(tablePath, file))),
				);

				if (this.tables[tableName].config.cache)
					await this.clearCache(tableName);
				return true;
			} finally {
				await File.unlock(join(tablePath, ".tmp"));
			}
		}
		if (
			(Array.isArray(where) && where.every(Utils.isValidID)) ||
			Utils.isValidID(where)
		) {
			const lineNumbers = await this.get(
				tableName,
				where,
				undefined,
				undefined,
				true,
			);
			return this.delete(tableName, lineNumbers, where);
		}
		if (
			(Array.isArray(where) && where.every(Utils.isNumber)) ||
			Utils.isNumber(where)
		) {
			// "where" in this case, is the line(s) number(s) and not id(s)
			const files = (await readdir(tablePath))?.filter((fileName: string) =>
				fileName.endsWith(this.getFileExtension(tableName)),
			);

			if (files.length) {
				try {
					await File.lock(join(tablePath, ".tmp"));

					await Promise.all(
						files.map(async (file) =>
							renameList.push(await File.remove(join(tablePath, file), where)),
						),
					);

					await Promise.all(
						renameList.map(async ([tempPath, filePath]) =>
							rename(tempPath, filePath),
						),
					);

					if (this.tables[tableName].config.cache)
						await this.clearCache(tableName);
					if (await File.isExists(join(tablePath, ".cache", ".pagination"))) {
						const [lastId, totalItems] = (
							await readFile(join(tablePath, ".cache", ".pagination"), "utf8")
						)
							.split(",")
							.map(Number);

						await writeFile(
							join(tablePath, ".cache", ".pagination"),
							`${lastId},${
								totalItems - (Array.isArray(where) ? where.length : 1)
							}`,
						);
					}
					return true;
				} finally {
					if (renameList.length)
						await Promise.allSettled(
							renameList.map(async ([tempPath, _]) => unlink(tempPath)),
						);
					await File.unlock(join(tablePath, ".tmp"));
				}
			}
		} else if (Utils.isObject(where)) {
			const lineNumbers = await this.get(
				tableName,
				where,
				undefined,
				undefined,
				true,
			);
			return this.delete(tableName, lineNumbers);
		} else throw this.throwError("INVALID_PARAMETERS");
		return false;
	}

	/**
	 * Generate sum of column(s) in a table
	 *
	 * @param {string} tableName
	 * @param {string} columns
	 * @param {(number | string | (number | string)[] | Criteria)} [where]
	 * @return {*}  {Promise<number | Record<string, number>>}
	 */
	sum(
		tableName: string,
		columns: string,
		where?: number | string | (number | string)[] | Criteria,
	): Promise<number>;
	sum(
		tableName: string,
		columns: string[],
		where?: number | string | (number | string)[] | Criteria,
	): Promise<Record<string, number>>;
	public async sum(
		tableName: string,
		columns: string | string[],
		where?: number | string | (number | string)[] | Criteria,
	): Promise<number | Record<string, number>> {
		const RETURN: Record<string, number> = {};
		const tablePath = join(this.databasePath, tableName);
		await this.throwErrorIfTableEmpty(tableName);

		if (!Array.isArray(columns)) columns = [columns];
		for await (const column of columns) {
			const columnPath = join(
				tablePath,
				`${column}${this.getFileExtension(tableName)}`,
			);
			if (await File.isExists(columnPath)) {
				if (where) {
					const lineNumbers = await this.get(
						tableName,
						where,
						undefined,
						undefined,
						true,
					);

					RETURN[column] = lineNumbers
						? await File.sum(columnPath, lineNumbers)
						: 0;
				} else RETURN[column] = await File.sum(columnPath);
			}
		}
		return Array.isArray(columns) ? RETURN : Object.values(RETURN)[0];
	}

	/**
	 * Generate max of column(s) in a table
	 *
	 * @param {string} tableName
	 * @param {string} columns
	 * @param {(number | string | (number | string)[] | Criteria)} [where]
	 * @return {*}  {Promise<number>}
	 */
	max(
		tableName: string,
		columns: string,
		where?: number | string | (number | string)[] | Criteria,
	): Promise<number>;
	max(
		tableName: string,
		columns: string[],
		where?: number | string | (number | string)[] | Criteria,
	): Promise<Record<string, number>>;
	public async max(
		tableName: string,
		columns: string | string[],
		where?: number | string | (number | string)[] | Criteria,
	): Promise<number | Record<string, number>> {
		const RETURN: Record<string, number> = {};
		const tablePath = join(this.databasePath, tableName);
		await this.throwErrorIfTableEmpty(tableName);

		if (!Array.isArray(columns)) columns = [columns];
		for await (const column of columns) {
			const columnPath = join(
				tablePath,
				`${column}${this.getFileExtension(tableName)}`,
			);
			if (await File.isExists(columnPath)) {
				if (where) {
					const lineNumbers = await this.get(
						tableName,
						where,
						undefined,
						undefined,
						true,
					);
					RETURN[column] = lineNumbers
						? await File.max(columnPath, lineNumbers)
						: 0;
				} else RETURN[column] = await File.max(columnPath);
			}
		}
		return RETURN;
	}

	/**
	 * Generate min of column(s) in a table
	 *
	 * @param {string} tableName
	 * @param {string} columns
	 * @param {(number | string | (number | string)[] | Criteria)} [where]
	 * @return {*}  {Promise<number>}
	 */
	min(
		tableName: string,
		columns: string,
		where?: number | string | (number | string)[] | Criteria,
	): Promise<number>;
	min(
		tableName: string,
		columns: string[],
		where?: number | string | (number | string)[] | Criteria,
	): Promise<Record<string, number>>;
	public async min(
		tableName: string,
		columns: string | string[],
		where?: number | string | (number | string)[] | Criteria,
	): Promise<number | Record<string, number>> {
		const RETURN: Record<string, number> = {};
		const tablePath = join(this.databasePath, tableName);
		await this.throwErrorIfTableEmpty(tableName);

		if (!Array.isArray(columns)) columns = [columns];
		for await (const column of columns) {
			const columnPath = join(
				tablePath,
				`${column}${this.getFileExtension(tableName)}`,
			);
			if (await File.isExists(columnPath)) {
				if (where) {
					const lineNumbers = await this.get(
						tableName,
						where,
						undefined,
						undefined,
						true,
					);
					RETURN[column] = lineNumbers
						? await File.min(columnPath, lineNumbers)
						: 0;
				} else RETURN[column] = await File.min(columnPath);
			}
		}
		return RETURN;
	}
}
