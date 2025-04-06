import "dotenv/config";
import { randomBytes, scryptSync } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
	glob,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
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
	id?: string | number;
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
	unique?: boolean | number | string;
	children?: FieldType | FieldType[] | Schema;
	regex?: string;
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

export interface TableConfig {
	compression?: boolean;
	cache?: boolean;
	prepend?: boolean;
	decodeID?: boolean;
}

export interface TableObject {
	schema?: Schema;
	config: TableConfig;
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
			[key: string]:
				| string
				| number
				| boolean
				| undefined
				| Criteria
				| (string | number | boolean)[];
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
	| "GROUP_UNIQUE"
	| "FIELD_UNIQUE"
	| "FIELD_REQUIRED"
	| "NO_SCHEMA"
	| "TABLE_EMPTY"
	| "INVALID_ID"
	| "INVALID_TYPE"
	| "INVALID_PARAMETERS"
	| "NO_ENV"
	| "TABLE_EXISTS"
	| "TABLE_NOT_EXISTS"
	| "INVALID_REGEX_MATCH";
export type ErrorLang = "en" | "ar" | "fr" | "es";

// hide ExperimentalWarning glob()
process.removeAllListeners("warning");

export const globalConfig: {
	[database: string]: {
		tables?: Map<string, TableObject>;
	};
} & { salt?: string | Buffer } = {};

export default class Inibase {
	public pageInfo: Record<string, pageInfo>;
	public language: ErrorLang;
	public fileExtension = ".txt";
	private databasePath: string;
	private uniqueMap: Map<
		string | number,
		{ exclude: Set<number>; columnsValues: Map<number, Set<string | number>> }
	>;
	private totalItems: Map<string, number>;

	constructor(database: string, mainFolder = ".", language: ErrorLang = "en") {
		this.databasePath = join(mainFolder, database);

		this.language = language;

		this.pageInfo = {};

		this.totalItems = new Map();

		this.uniqueMap = new Map();

		if (!globalConfig[this.databasePath])
			globalConfig[this.databasePath] = { tables: new Map() };

		if (!process.env.INIBASE_SECRET) {
			if (
				existsSync(".env") &&
				readFileSync(".env").includes("INIBASE_SECRET=")
			)
				throw this.createError("NO_ENV");
			globalConfig.salt = scryptSync(randomBytes(16), randomBytes(16), 32);
			appendFileSync(
				".env",
				`\nINIBASE_SECRET=${globalConfig.salt.toString("hex")}\n`,
			);
		} else globalConfig.salt = Buffer.from(process.env.INIBASE_SECRET, "hex");
	}

	private static errorMessages: Record<ErrorLang, Record<ErrorCodes, string>> =
		{
			en: {
				TABLE_EMPTY: "Table {variable} is empty",
				TABLE_EXISTS: "Table {variable} already exists",
				TABLE_NOT_EXISTS: "Table {variable} doesn't exist",
				NO_SCHEMA: "Table {variable} does't have a schema",
				GROUP_UNIQUE:
					"Group {variable} should be unique, got duplicated content in {variable}",
				FIELD_UNIQUE:
					"Field {variable} should be unique, got {variable} instead",
				FIELD_REQUIRED: "Field {variable} is required",
				INVALID_ID: "The given ID(s) is/are not valid(s)",
				INVALID_TYPE:
					"Expect {variable} to be {variable}, got {variable} instead",
				INVALID_PARAMETERS: "The given parameters are not valid",
				INVALID_REGEX_MATCH:
					"Field {variable} does not match the expected pattern",
				NO_ENV:
					Number(process.versions.node.split(".").reduce((a, b) => a + b)) >= 26
						? "please run with '--env-file=.env'"
						: "please use dotenv",
			},
			ar: {
				TABLE_EMPTY: "الجدول {variable} فارغ",
				TABLE_EXISTS: "الجدول {variable} موجود بالفعل",
				TABLE_NOT_EXISTS: "الجدول {variable} غير موجود",
				NO_SCHEMA: "الجدول {variable} ليس لديه مخطط",
				GROUP_UNIQUE:
					"المجموعة {variable} يجب أن تكون فريدة، تم العثور على محتوى مكرر في {variable}",
				FIELD_UNIQUE:
					"الحقل {variable} يجب أن يكون فريدًا، تم العثور على {variable} بدلاً من ذلك",
				FIELD_REQUIRED: "الحقل {variable} مطلوب",
				INVALID_ID: "المعرف أو المعرفات المقدمة غير صالحة",
				INVALID_TYPE:
					"من المتوقع أن يكون {variable} من النوع {variable}، لكن تم العثور على {variable} بدلاً من ذلك",
				INVALID_PARAMETERS: "المعلمات المقدمة غير صالحة",
				INVALID_REGEX_MATCH: "الحقل {variable} لا يتطابق مع النمط المتوقع",
				NO_ENV:
					Number(process.versions.node.split(".").reduce((a, b) => a + b)) >= 26
						? "يرجى التشغيل باستخدام '--env-file=.env'"
						: "يرجى استخدام dotenv",
			},
			fr: {
				TABLE_EMPTY: "La table {variable} est vide",
				TABLE_EXISTS: "La table {variable} existe déjà",
				TABLE_NOT_EXISTS: "La table {variable} n'existe pas",
				NO_SCHEMA: "La table {variable} n'a pas de schéma",
				GROUP_UNIQUE:
					"Le groupe {variable} doit être unique, contenu dupliqué trouvé dans {variable}",
				FIELD_UNIQUE:
					"Le champ {variable} doit être unique, trouvé {variable} à la place",
				FIELD_REQUIRED: "Le champ {variable} est obligatoire",
				INVALID_ID: "Le(s) ID donné(s) n'est/ne sont pas valide(s)",
				INVALID_TYPE:
					"Attendu que {variable} soit de type {variable}, mais trouvé {variable} à la place",
				INVALID_PARAMETERS: "Les paramètres donnés ne sont pas valides",
				INVALID_REGEX_MATCH:
					"Le champ {variable} ne correspond pas au modèle attendu",
				NO_ENV:
					Number(process.versions.node.split(".").reduce((a, b) => a + b)) >= 26
						? "veuillez exécuter avec '--env-file=.env'"
						: "veuillez utiliser dotenv",
			},
			es: {
				TABLE_EMPTY: "La tabla {variable} está vacía",
				TABLE_EXISTS: "La tabla {variable} ya existe",
				TABLE_NOT_EXISTS: "La tabla {variable} no existe",
				NO_SCHEMA: "La tabla {variable} no tiene un esquema",
				GROUP_UNIQUE:
					"El grupo {variable} debe ser único, se encontró contenido duplicado en {variable}",
				FIELD_UNIQUE:
					"El campo {variable} debe ser único, se encontró {variable} en su lugar",
				FIELD_REQUIRED: "El campo {variable} es obligatorio",
				INVALID_ID: "El/los ID proporcionado(s) no es/son válido(s)",
				INVALID_TYPE:
					"Se espera que {variable} sea {variable}, pero se encontró {variable} en su lugar",
				INVALID_PARAMETERS: "Los parámetros proporcionados no son válidos",
				INVALID_REGEX_MATCH:
					"El campo {variable} no coincide con el patrón esperado",
				NO_ENV:
					Number(process.versions.node.split(".").reduce((a, b) => a + b)) >= 26
						? "por favor ejecute con '--env-file=.env'"
						: "por favor use dotenv",
			},
		};

	public createError(
		name: ErrorCodes,
		variable?: string | number | (string | number)[],
	): Error {
		const errorMessage = Inibase.errorMessages[this.language]?.[name];
		if (!errorMessage) return new Error("ERR");
		const error = new Error(
			variable
				? Array.isArray(variable)
					? errorMessage.replace(
							/\{variable\}/g,
							() => variable.shift()?.toString() ?? "",
						)
					: errorMessage.replaceAll("{variable}", `'${variable.toString()}'`)
				: errorMessage.replaceAll("{variable}", ""),
		);
		error.name = name;
		return error;
	}

	private getFileExtension(tableName: string) {
		let mainExtension = this.fileExtension;
		// TODO: ADD ENCRYPTION
		// if(globalConfig[this.databasePath].tables.get(tableName).config.encryption)
		// 	mainExtension += ".enc"
		if (
			globalConfig[this.databasePath].tables.get(tableName).config.compression
		)
			mainExtension += ".gz";
		return mainExtension;
	}

	private _schemaToIdsPath(tableName: string, schema: Schema, prefix = "") {
		const RETURN: any = {};
		for (const field of schema)
			if (
				(field.type === "array" || field.type === "object") &&
				field.children &&
				Utils.isArrayOfObjects(field.children)
			)
				Utils.deepMerge(
					RETURN,
					this._schemaToIdsPath(
						tableName,
						field.children,
						`${(prefix ?? "") + field.key}.`,
					),
				);
			else if (field.id)
				RETURN[
					Utils.isValidID(field.id) ? UtilsServer.decodeID(field.id) : field.id
				] = `${(prefix ?? "") + field.key}${this.getFileExtension(tableName)}`;

		return RETURN;
	}

	/**
	 * Create a new table inside database, with predefined schema and config
	 *
	 * @param {string} tableName
	 * @param {Schema} [schema]
	 * @param {TableConfig} [config]
	 */
	public async createTable(
		tableName: string,
		schema?: Schema,
		config?: TableConfig,
	) {
		const tablePath = join(this.databasePath, tableName);

		if (await File.isExists(tablePath))
			throw this.createError("TABLE_EXISTS", tableName);

		await mkdir(join(tablePath, ".tmp"), { recursive: true });
		await mkdir(join(tablePath, ".cache"));

		// if config not set => load default global env config
		if (!config)
			config = {
				compression: process.env.INIBASE_COMPRESSION == "true",
				cache: process.env.INIBASE_CACHE === "true",
				prepend: process.env.INIBASE_PREPEND === "true",
				decodeID: process.env.INIBASE_ENCODEID === "true",
			};

		if (config) {
			if (config.compression)
				await writeFile(join(tablePath, ".compression.config"), "");
			if (config.cache) await writeFile(join(tablePath, ".cache.config"), "");
			if (config.prepend)
				await writeFile(join(tablePath, ".prepend.config"), "");
		}
		if (schema) {
			const lastSchemaID = { value: 0 };
			await writeFile(
				join(tablePath, "schema.json"),
				JSON.stringify(
					UtilsServer.addIdToSchema(schema, lastSchemaID),
					null,
					2,
				),
			);
			await writeFile(join(tablePath, `${lastSchemaID.value}.schema`), "");
		} else await writeFile(join(tablePath, "0.schema"), "");

		await writeFile(join(tablePath, "0-0.pagination"), "");
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

	/**
	 * Update table schema or config
	 *
	 * @param {string} tableName
	 * @param {Schema} [schema]
	 * @param {(TableConfig&{name?: string})} [config]
	 */
	public async updateTable(
		tableName: string,
		schema?: Schema,
		config?: TableConfig & { name?: string },
	) {
		const table = await this.getTable(tableName);
		const tablePath = join(this.databasePath, tableName);

		if (schema) {
			// remove id from schema
			schema = schema.filter(
				({ key }) => !["id", "createdAt", "updatedAt"].includes(key),
			);

			let schemaIdFilePath: string;
			for await (const fileName of glob("*.schema", { cwd: tablePath }))
				schemaIdFilePath = join(tablePath, fileName);

			const lastSchemaID = {
				value: schemaIdFilePath ? Number(parse(schemaIdFilePath).name) : 0,
			};

			if (await File.isExists(join(tablePath, "schema.json"))) {
				// update columns files names based on field id
				schema = UtilsServer.addIdToSchema(schema, lastSchemaID);
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
			} else schema = UtilsServer.addIdToSchema(schema, lastSchemaID);

			await writeFile(
				join(tablePath, "schema.json"),
				JSON.stringify(schema, null, 2),
			);
			if (schemaIdFilePath)
				await rename(
					schemaIdFilePath,
					join(tablePath, `${lastSchemaID.value}.schema`),
				);
			else await writeFile(join(tablePath, `${lastSchemaID.value}.schema`), "");
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
				else {
					await this.clearCache(tableName);
					await unlink(join(tablePath, ".cache.config"));
				}
			}
			if (
				config.decodeID !== undefined &&
				config.decodeID !== table.config.decodeID
			) {
				if (config.decodeID)
					await writeFile(join(tablePath, ".decodeID.config"), "");
				else await unlink(join(tablePath, ".decodeID.config"));
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
				await rename(tablePath, join(this.databasePath, config.name));
				// replace table name in other linked tables (relationship)
				for await (const schemaPath of glob("**/schema.json", {
					cwd: this.databasePath,
				}))
					await this.replaceStringInFile(
						schemaPath,
						`"table": "${tableName}"`,
						`"table": "${config.name}"`,
					);
			}
		}

		globalConfig[this.databasePath].tables.delete(tableName);
	}

	/**
	 * Get table schema and config
	 *
	 * @param {string} tableName
	 * @return {*}  {Promise<TableObject>}
	 */
	public async getTable(
		tableName: string,
		encodeIDs = true,
	): Promise<TableObject> {
		const tablePath = join(this.databasePath, tableName);

		if (!(await File.isExists(tablePath)))
			throw this.createError("TABLE_NOT_EXISTS", tableName);

		if (!globalConfig[this.databasePath].tables.has(tableName))
			globalConfig[this.databasePath].tables.set(tableName, {
				schema: await this.getTableSchema(tableName, encodeIDs),
				config: {
					compression: await File.isExists(
						join(tablePath, ".compression.config"),
					),
					cache: await File.isExists(join(tablePath, ".cache.config")),
					prepend: await File.isExists(join(tablePath, ".prepend.config")),
					decodeID: await File.isExists(join(tablePath, ".decodeID.config")),
				},
			});
		return globalConfig[this.databasePath].tables.get(tableName);
	}

	public async getTableSchema(tableName: string, encodeIDs = true) {
		const tablePath = join(this.databasePath, tableName);
		if (!(await File.isExists(join(tablePath, "schema.json"))))
			return undefined;

		const schemaFile = await readFile(join(tablePath, "schema.json"), "utf8");

		if (!schemaFile) return undefined;

		let schema: Schema = JSON.parse(schemaFile);

		schema = [
			{
				id: 0,
				key: "id",
				type: "id",
				required: true,
			},
			...schema,
			{
				id: -1,
				key: "createdAt",
				type: "date",
				required: true,
			},
			{
				id: -2,
				key: "updatedAt",
				type: "date",
			},
		];

		if (!encodeIDs) return schema;
		return UtilsServer.encodeSchemaID(schema);
	}

	private async throwErrorIfTableEmpty(tableName: string): Promise<void> {
		const table = await this.getTable(tableName, false);

		if (!table.schema) throw this.createError("NO_SCHEMA", tableName);

		if (
			!(await File.isExists(
				join(
					this.databasePath,
					tableName,
					`id${this.getFileExtension(tableName)}`,
				),
			))
		)
			throw this.createError("TABLE_EMPTY", tableName);
	}

	private _validateData(
		data: Data | Data[],
		schema: Schema,
		skipRequiredField = false,
	): void {
		if (Utils.isArrayOfObjects(data)) {
			for (const single_data of data as Data[])
				this._validateData(single_data, schema, skipRequiredField);
			return;
		}
		if (Utils.isObject(data)) {
			for (const field of schema) {
				if (
					!Object.hasOwn(data, field.key) ||
					data[field.key] === null ||
					data[field.key] === undefined ||
					data[field.key] === ""
				) {
					if (field.required && !skipRequiredField)
						throw this.createError("FIELD_REQUIRED", field.key);
					continue;
				}

				if (!Utils.validateFieldType(data[field.key], field))
					throw this.createError("INVALID_TYPE", [
						field.key,
						(Array.isArray(field.type) ? field.type.join(", ") : field.type) +
							(field.children
								? Array.isArray(field.children)
									? Utils.isArrayOfObjects(field.children)
										? "[object]"
										: `[${field.children.join("|")}]`
									: `[${field.children}]`
								: ""),
						data[field.key],
					]);
				if (
					(field.type === "array" || field.type === "object") &&
					field.children &&
					Utils.isArrayOfObjects(field.children)
				)
					this._validateData(
						data[field.key],
						field.children,
						skipRequiredField,
					);
				else {
					if (
						field.table &&
						Utils.isObject(data[field.key]) &&
						Object.hasOwn(data[field.key], "id")
					)
						data[field.key] = data[field.key].id;

					if (field.regex) {
						const regex = UtilsServer.getCachedRegex(field.regex);
						if (!regex.test(data[field.key]))
							throw this.createError("INVALID_REGEX_MATCH", [field.key]);
					}
					if (field.unique) {
						let uniqueKey: string | number;
						if (typeof field.unique === "boolean") uniqueKey = field.id;
						else uniqueKey = field.unique;
						if (!this.uniqueMap.has(uniqueKey))
							this.uniqueMap.set(uniqueKey, {
								exclude: new Set(),
								columnsValues: new Map(),
							});

						if (
							!this.uniqueMap
								.get(uniqueKey)
								.columnsValues.has(field.id as number)
						)
							this.uniqueMap
								.get(uniqueKey)
								.columnsValues.set(field.id as number, new Set());

						if (data.id)
							this.uniqueMap.get(uniqueKey).exclude.add(-data.id as number);

						this.uniqueMap
							.get(uniqueKey)
							.columnsValues.get(field.id as number)
							.add(data[field.key]);
					}
				}
			}
		}
	}
	private async validateData(
		tableName: string,
		data: Data | Data[],
		skipRequiredField = false,
	): Promise<void> {
		const clonedData = structuredClone(data);
		// Skip ID and (created|updated)At
		this._validateData(
			clonedData,
			globalConfig[this.databasePath].tables.get(tableName).schema.slice(1, -2),
			skipRequiredField,
		);
		await this.checkUnique(tableName);
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
		field?: Field,
		_formatOnlyAvailiableKeys?: boolean,
	): Data | number | string | null;
	private formatField(
		value: (number | string | Data)[],
		field?: Field,
		_formatOnlyAvailiableKeys?: boolean,
	): (number | string | null | Data)[];
	private formatField(
		value: Data | number | string | (number | string | Data)[],
		field?: Field,
		_formatOnlyAvailiableKeys?: boolean,
	): Data | Data[] | number | string | null {
		if (value === null || value === undefined) return value;
		if (Array.isArray(field.type))
			field.type = Utils.detectFieldType(value, field.type) ?? field.type[0];
		if (Array.isArray(value) && !["array", "json"].includes(field.type))
			value = value[0];
		switch (field.type) {
			case "array":
				if (!field.children) return null;

				if (!Array.isArray(value)) value = [value];

				if (Utils.isArrayOfObjects(field.children))
					return this.formatData(
						value as Data[],
						field.children,
						_formatOnlyAvailiableKeys,
					);

				if (!value.length) return null;

				return (value as (string | number | Data)[]).map((_value) =>
					this.formatField(_value, {
						...field,
						type: field.children as FieldType | FieldType[],
					}),
				);
			case "object":
				if (Utils.isArrayOfObjects(field.children))
					return this.formatData(
						value as Data,
						field.children,
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
							: UtilsServer.decodeID((value as Data).id as string);
				} else if (Utils.isValidID(value) || Utils.isNumber(value))
					return Utils.isNumber(value)
						? Number(value)
						: UtilsServer.decodeID(value);
				break;
			case "password":
				return Utils.isPassword(value)
					? value
					: UtilsServer.hashPassword(String(value));
			case "number":
				return Utils.isNumber(value)
					? typeof value === "number"
						? value
						: Number((value as string).trim())
					: 0;
			case "id":
				return Utils.isNumber(value)
					? value
					: UtilsServer.decodeID(value as string);
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

	private async checkUnique(tableName: string) {
		const tablePath = join(this.databasePath, tableName);
		const flattenSchema = Utils.flattenSchema(
			globalConfig[this.databasePath].tables.get(tableName).schema,
		);
		function hasDuplicates(setA: Set<number>, setB: Set<number>) {
			for (const value of setA) if (setB.has(value)) return true; // Stop and return true if a duplicate is found
			return false; // No duplicates found
		}
		for await (const [_uniqueID, valueObject] of this.uniqueMap) {
			let index = 0;
			let shouldContinueParent = false; // Flag to manage parent loop continuation
			const mergedLineNumbers = new Set<number>();
			const fieldsKeys = [];
			for await (const [columnID, values] of valueObject.columnsValues) {
				index++;
				const field = flattenSchema.find(({ id }) => id === columnID);
				fieldsKeys.push(field.key);
				const [_, totalLines, lineNumbers] = await File.search(
					join(tablePath, `${field.key}${this.getFileExtension(tableName)}`),
					"[]",
					Array.from(values),
					undefined,
					valueObject.exclude,
					{ ...field, databasePath: this.databasePath },
					1,
					undefined,
					false,
				);
				if (totalLines > 0) {
					if (
						valueObject.columnsValues.size === 1 ||
						(valueObject.columnsValues.size === index &&
							hasDuplicates(lineNumbers, mergedLineNumbers))
					) {
						this.uniqueMap = new Map();

						if (valueObject.columnsValues.size > 1)
							throw this.createError("GROUP_UNIQUE", [
								fieldsKeys.join(" & "),
								field.key,
							]);

						throw this.createError("FIELD_UNIQUE", [
							fieldsKeys.join(" & "),
							Array.from(values).join(", "),
						]);
					}
					lineNumbers.forEach(mergedLineNumbers.add, mergedLineNumbers);
				} else {
					shouldContinueParent = true; // Flag to skip the rest of this inner loop
					break; // Exit the inner loop
				}
			}
			if (shouldContinueParent) continue;
		}
		this.uniqueMap = new Map();
	}

	private formatData<TData extends Record<string, any> & Partial<Data>>(
		data: TData & Data,
		schema: Schema,
		formatOnlyAvailiableKeys?: boolean,
	): TData & Data;
	private formatData<TData extends Record<string, any> & Partial<Data>>(
		data: (TData & Data) | (TData & Data)[],
		schema: Schema,
		formatOnlyAvailiableKeys?: boolean,
	): (TData & Data)[];
	private formatData<TData extends Record<string, any> & Partial<Data>>(
		data: (TData & Data) | (TData & Data)[],
		schema: Schema,
		formatOnlyAvailiableKeys?: boolean,
	): (TData & Data) | (TData & Data)[] {
		const clonedData: (TData & Data) | (TData & Data)[] = structuredClone(data);
		if (Utils.isArrayOfObjects(clonedData))
			return clonedData.map((singleData) =>
				this.formatData(singleData, schema, formatOnlyAvailiableKeys),
			);
		if (Utils.isObject(clonedData)) {
			const RETURN = {};
			for (const field of schema) {
				if (!Object.hasOwn(clonedData, field.key)) {
					if (formatOnlyAvailiableKeys) RETURN[field.key] = "undefined";
					else RETURN[field.key] = this.getDefaultValue(field);
					continue;
				}
				if (
					Array.isArray(clonedData[field.key]) &&
					!clonedData[field.key].length
				) {
					RETURN[field.key] = this.getDefaultValue(field);
					continue;
				}
				RETURN[field.key] = this.formatField(
					clonedData[field.key],
					field,
					formatOnlyAvailiableKeys,
				);
			}
			return RETURN as TData & Data;
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
						Number(a === "number") - Number(b === "number") ||
						Number(a === "string") - Number(b === "string"),
				)[0],
			} as Field);

		switch (field.type) {
			case "array":
			case "object": {
				if (!field.children || !Utils.isArrayOfObjects(field.children))
					return null;
				const RETURN: Record<string, any> = {};
				for (const f of field.children) RETURN[f.key] = this.getDefaultValue(f);
				return RETURN;
			}
			case "number":
				return 0;
			case "boolean":
				return false;
			default:
				return "";
		}
	}

	private _combineObjectsToArray(
		input: any[],
	): Record<
		string,
		string | boolean | number | null | (string | boolean | number | null)[]
	> {
		return input.reduce((result, current) => {
			for (const [key, value] of Object.entries(current))
				if (Object.hasOwn(result, key) && Array.isArray(result[key]))
					result[key].push(value);
				else result[key] = [value];

			return result;
		}, {});
	}
	private _CombineData(
		data: Data | Data[],
		prefix?: string,
	): Record<
		string,
		string | boolean | number | null | (string | boolean | number | null)[]
	> {
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
				Object.assign(
					RETURN,
					this._CombineData(value, `${(prefix ?? "") + key}.`),
				);
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
			else if (value !== "undefined")
				RETURN[(prefix ?? "") + key] = File.encode(
					Array.isArray(value)
						? value.map((_value) =>
								typeof _value === "string" && _value === "undefined"
									? ""
									: _value,
							)
						: value,
				);
		}

		return RETURN;
	}

	private joinPathesContents(tableName: string, data: Data | Data[]) {
		const tablePath = join(this.databasePath, tableName);
		const combinedData = this._CombineData(data);
		const newCombinedData: Record<string, any> = {};

		for (const [key, value] of Object.entries(combinedData))
			newCombinedData[
				join(tablePath, `${key}${this.getFileExtension(tableName)}`)
			] = value;

		return newCombinedData;
	}

	private _processSchemaDataHelper(
		RETURN: Record<number, Data>,
		item: Data,
		index: number,
		field: Field,
	) {
		// If the item is an object, we need to process its children
		if (Utils.isObject(item)) {
			if (!RETURN[index]) RETURN[index] = {}; // Ensure the index exists
			if (!RETURN[index][field.key]) RETURN[index][field.key] = [];

			// Process children fields (recursive if needed)
			for (const child_field of (field.children as Schema).filter(
				(children) =>
					children.type === "array" &&
					Utils.isArrayOfObjects(children.children),
			)) {
				if (Utils.isObject(item[child_field.key])) {
					for (const [key, value] of Object.entries(item[child_field.key])) {
						for (let _i = 0; _i < value.length; _i++) {
							if (
								value[_i] === null ||
								(Array.isArray(value[_i]) && Utils.isArrayOfNulls(value[_i]))
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
								for (let _index = 0; _index < value[_i].length; _index++) {
									const element = value[_i][_index];
									if (element === null) continue;
									// Recursive call to handle nested structure
									this._processSchemaDataHelper(
										RETURN,
										element,
										_index,
										child_field,
									);

									// Perform property assignments
									if (!RETURN[index][field.key][_i][child_field.key][_index])
										RETURN[index][field.key][_i][child_field.key][_index] = {};
									RETURN[index][field.key][_i][child_field.key][_index][key] =
										element;
								}
							}
						}
					}
				}
			}
		}
	}
	private async processSchemaData<
		TData extends Record<string, any> & Partial<Data>,
	>(
		tableName: string,
		schema: Schema,
		linesNumber: number[],
		options: Options,
		prefix?: string,
	): Promise<Record<number, TData & Data>> {
		const RETURN: Record<number, TData & Data> = {};
		for (const field of schema) {
			// If the field is of simple type (non-recursive), process it directly
			if (this.isSimpleField(field.type)) {
				await this.processSimpleField(
					tableName,
					field,
					linesNumber,
					RETURN,
					options,
					prefix,
				);
			} else if (this.isArrayField(field.type)) {
				// Process array fields (recursive if needed)
				await this.processArrayField(
					tableName,
					field,
					linesNumber,
					RETURN,
					options,
					prefix,
				);
			} else if (this.isObjectField(field.type)) {
				// Process object fields (recursive if needed)
				await this.processObjectField(
					tableName,
					field,
					linesNumber,
					RETURN,
					options,
					prefix,
				);
			} else if (this.isTableField(field.type)) {
				// Process table reference fields
				await this.processTableField(
					tableName,
					field,
					linesNumber,
					RETURN,
					options,
					prefix,
				);
			}
		}

		return RETURN;
	}

	// Helper function to determine if a field is simple
	private isSimpleField(fieldType: FieldType | FieldType[] | Schema): boolean {
		const complexTypes = ["array", "object", "table"];
		if (Array.isArray(fieldType))
			return fieldType.every(
				(type) => typeof type === "string" && !complexTypes.includes(type),
			);

		return !complexTypes.includes(fieldType);
	}

	// Process a simple field (non-recursive)
	private async processSimpleField(
		tableName: string,
		field: Field,
		linesNumber: number[],
		RETURN: Record<number, Data>,
		_options: Options,
		prefix?: string,
	) {
		const fieldPath = join(
			this.databasePath,
			tableName,
			`${prefix ?? ""}${field.key}${this.getFileExtension(tableName)}`,
		);
		if (await File.isExists(fieldPath)) {
			const items = await File.get(fieldPath, linesNumber, {
				...field,
				type:
					field.key === "id" &&
					globalConfig[this.databasePath].tables.get(tableName).config.decodeID
						? "number"
						: field.type,
				databasePath: this.databasePath,
			});
			if (items) {
				for (const [index, item] of Object.entries(items)) {
					if (typeof item === "undefined") continue; // Skip undefined items
					if (!RETURN[index]) RETURN[index] = {}; // Ensure the index exists
					RETURN[index][field.key] = item; // Assign item to the RETURN object
				}
			}
		}
	}

	// Helper function to check if the field type is array
	private isArrayField(fieldType: FieldType | FieldType[] | Schema): boolean {
		return (
			(Array.isArray(fieldType) &&
				fieldType.every((type) => typeof type === "string") &&
				fieldType.includes("array")) ||
			fieldType === "array"
		);
	}

	// Process array fields (recursive if needed)
	private async processArrayField(
		tableName: string,
		field: Field,
		linesNumber: number[],
		RETURN: Record<number, Data>,
		options: Options,
		prefix?: string,
	) {
		if (Array.isArray(field.children)) {
			if (this.isSimpleField(field.children)) {
				await this.processSimpleField(
					tableName,
					field,
					linesNumber,
					RETURN,
					options,
					prefix,
				);
			} else if (this.isTableField(field.children)) {
				await this.processTableField(
					tableName,
					field,
					linesNumber,
					RETURN,
					options,
					prefix,
				);
			} else {
				// Handling array of objects and filtering nested arrays
				const nestedArrayFields = field.children.filter(
					(children: Field) =>
						children.type === "array" &&
						Utils.isArrayOfObjects(children.children),
				) as Schema;
				if (nestedArrayFields.length > 0) {
					// one of children has array field type and has children array of object = Schema
					const childItems = await this.processSchemaData(
						tableName,
						nestedArrayFields,
						linesNumber,
						options,
						`${(prefix ?? "") + field.key}.`,
					);

					if (childItems)
						for (const [index, item] of Object.entries(childItems))
							this._processSchemaDataHelper(RETURN, item, index, field);

					// Remove nested arrays after processing
					field.children = field.children.filter(
						(children: Field) =>
							!nestedArrayFields.map(({ key }) => key).includes(children.key),
					) as Schema;
				}

				// Process remaining items for the field's children
				const items = await this.processSchemaData(
					tableName,
					field.children as Schema,
					linesNumber,
					options,
					`${(prefix ?? "") + field.key}.`,
				);

				// Process the items after retrieval
				if (items) {
					for (const [index, item] of Object.entries(items)) {
						if (typeof item === "undefined") continue; // Skip undefined items
						if (!RETURN[index]) RETURN[index] = {};
						if (Utils.isObject(item)) {
							const itemEntries = Object.entries(item);
							const itemValues = itemEntries.map(([_key, value]) => value);
							if (!Utils.isArrayOfNulls(itemValues)) {
								if (RETURN[index][field.key])
									for (let _index = 0; _index < itemEntries.length; _index++) {
										const [key, value] = itemEntries[_index];
										for (let _index = 0; _index < value.length; _index++) {
											if (value[_index] === null) continue;
											if (RETURN[index][field.key][_index])
												Object.assign(RETURN[index][field.key][_index], {
													[key]: value[_index],
												});
											else
												RETURN[index][field.key][_index] = {
													[key]: value[_index],
												};
										}
									}
								else if (
									itemValues.every((_i) => Utils.isArrayOfArrays(_i)) &&
									prefix
								)
									RETURN[index][field.key] = item;
								else {
									RETURN[index][field.key] = [];
									for (let _index = 0; _index < itemEntries.length; _index++) {
										const [key, value] = itemEntries[_index];
										if (!Array.isArray(value)) {
											RETURN[index][field.key][_index] = {};
											RETURN[index][field.key][_index][key] = value;
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
									}
								}
							}
						} else RETURN[index][field.key] = item;
					}
				}
			}
		} else if (this.isSimpleField(field.children)) {
			// If `children` is FieldType, handle it as an array of simple types (no recursion needed here)

			await this.processSimpleField(
				tableName,
				field,
				linesNumber,
				RETURN,
				options,
				prefix,
			);
		} else if (this.isTableField(field.children)) {
			await this.processTableField(
				tableName,
				field,
				linesNumber,
				RETURN,
				options,
				prefix,
			);
		}
	}

	// Helper function to check if the field type is object
	private isObjectField(fieldType: FieldType | FieldType[] | Schema): boolean {
		return (
			fieldType === "object" ||
			(Array.isArray(fieldType) &&
				fieldType.every((type) => typeof type === "string") &&
				fieldType.includes("object"))
		);
	}

	// Process object fields (recursive if needed)
	private async processObjectField(
		tableName: string,
		field: Field,
		linesNumber: number[],
		RETURN: Record<number, Data>,
		options: Options,
		prefix?: string,
	) {
		if (Array.isArray(field.children)) {
			// If `children` is a Schema (array of Field objects), recurse
			const items = await this.processSchemaData(
				tableName,
				field.children as Schema,
				linesNumber,
				options,
				`${prefix ?? ""}${field.key}.`,
			);
			for (const [index, item] of Object.entries(items)) {
				if (typeof item === "undefined") continue; // Skip undefined items
				if (!RETURN[index]) RETURN[index] = {};
				if (Utils.isObject(item)) {
					if (!Object.values(item).every((i) => i === null || i === 0))
						RETURN[index][field.key] = item;
				}
			}
		}
	}

	// Helper function to check if the field type is table
	private isTableField(fieldType: FieldType | FieldType[] | Schema): boolean {
		return (
			fieldType === "table" ||
			(Array.isArray(fieldType) &&
				fieldType.every((type) => typeof type === "string") &&
				fieldType.includes("table"))
		);
	}

	// Process table reference fields
	private async processTableField(
		tableName: string,
		field: Field,
		linesNumber: number[],
		RETURN: Record<number, Data>,
		options: Options,
		prefix?: string,
	) {
		if (
			field.table &&
			(await File.isExists(join(this.databasePath, field.table)))
		) {
			const fieldPath = join(
				this.databasePath,
				tableName,
				`${prefix ?? ""}${field.key}${this.getFileExtension(tableName)}`,
			);
			if (await File.isExists(fieldPath)) {
				// add table to globalConfig
				await this.getTable(field.table);

				const itemsIDs = (await File.get(fieldPath, linesNumber, {
					...field,
					databasePath: this.databasePath,
				})) as Record<number, number | number[]>;

				if (itemsIDs) {
					const searchableIDs = new Map<
						number,
						number | string | (number | string)[]
					>();
					for (const [lineNumber, lineContent] of Object.entries(itemsIDs)) {
						if (typeof lineContent === "undefined") continue; // Skip undefined items
						if (!RETURN[lineNumber]) RETURN[lineNumber] = {};
						if (lineContent !== null && lineContent !== undefined)
							searchableIDs.set(lineNumber, lineContent);
					}

					if (searchableIDs.size) {
						const items = await this.get(
							field.table,
							Array.from(new Set(Array.from(searchableIDs.values()).flat()))
								.flat()
								.filter((item) => item),
							{
								...options,
								perPage: Number.POSITIVE_INFINITY,
								columns: (options.columns as string[] | undefined)
									?.filter((column) => column.includes(`${field.key}.`))
									.map((column) => column.replace(`${field.key}.`, "")),
							},
						);

						const formatLineContent = (
							lineContent?: string | number | (string | number)[],
						) =>
							Array.isArray(lineContent)
								? lineContent.map((singleContent) =>
										singleContent
											? Array.isArray(singleContent)
												? singleContent.map(formatLineContent)
												: items
													? items.find(({ id }) => singleContent === id)
													: {
															id: singleContent,
														}
											: singleContent,
									)
								: (items?.find(({ id }) => lineContent === id) ?? {
										id: lineContent,
									});
						for (const [lineNumber, lineContent] of searchableIDs.entries()) {
							if (!lineContent) continue;
							RETURN[lineNumber][field.key] = formatLineContent(lineContent);
						}
					}
				}
			}
		}
	}

	private _setNestedKey(obj: any, path: string, value: any) {
		const keys = path.split(".");
		let current = obj;
		keys.forEach((key, index) => {
			if (index === keys.length - 1) {
				current[key] = value; // Set the value at the last key
			} else {
				current[key] = current[key] || {}; // Ensure the object structure exists
				current = current[key];
			}
		});
	}
	private async applyCriteria<
		TData extends Record<string, any> & Partial<Data>,
	>(
		tableName: string,
		options: Options,
		criteria?: Criteria,
		allTrue?: boolean,
		searchIn?: Set<number>,
	): Promise<Record<number, TData & Data> | null> {
		const tablePath = join(this.databasePath, tableName);

		let RETURN: Record<number, TData & Data> = {};
		if (!criteria) return [null, null];

		const criteriaAND = criteria.and;
		if (criteriaAND) delete criteria.and;

		const criteriaOR = criteria.or;
		if (criteriaOR) delete criteria.or;

		if (Object.keys(criteria).length > 0) {
			if (allTrue === undefined) allTrue = true;

			criteria = Utils.toDotNotation(criteria, ["or", "and"]);

			let index = -1;
			for await (const [key, value] of Object.entries(criteria)) {
				const field = Utils.getField(
					key,
					globalConfig[this.databasePath].tables.get(tableName).schema,
				);
				if (!field) continue;
				index++;
				let searchOperator:
					| ComparisonOperator
					| ComparisonOperator[]
					| undefined = undefined;
				let searchComparedAtValue:
					| string
					| number
					| boolean
					| null
					| (string | number | boolean | null)[]
					| undefined = undefined;
				let searchLogicalOperator: "and" | "or" | undefined = undefined;
				if (Utils.isObject(value)) {
					if (
						(value as Criteria)?.or &&
						Array.isArray((value as Criteria)?.or)
					) {
						const searchCriteria = (
							(value as Criteria)?.or as (string | number | boolean)[]
						)
							.map((single_or) =>
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
						delete (value as Criteria).or;
					}
					if (
						(value as Criteria)?.and &&
						Array.isArray((value as Criteria)?.and)
					) {
						const searchCriteria = (
							(value as Criteria)?.and as (string | number | boolean)[]
						)
							.map((single_and) =>
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
						delete (value as Criteria).and;
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
					searchIn,
					{
						...field,
						databasePath: this.databasePath,
						table: field.table ?? tableName,
					},
					options.perPage,
					((options.page as number) - 1) * (options.perPage as number) + 1,
					true,
				);
				console.log(searchResult, totalLines, linesNumbers);

				if (searchResult) {
					const formatedSearchResult = Object.fromEntries(
						Object.entries(searchResult).map(([id, value]) => {
							const nestedObj = {};
							this._setNestedKey(nestedObj, key, value);
							return [id, nestedObj];
						}),
					);

					RETURN = allTrue
						? formatedSearchResult
						: Utils.deepMerge(RETURN, formatedSearchResult);

					this.totalItems.set(`${tableName}-${key}`, totalLines);

					if (linesNumbers?.size && allTrue) searchIn = linesNumbers;
				} else if (allTrue) return null;
			}
		}

		if (criteriaAND && Utils.isObject(criteriaAND)) {
			const searchResult = await this.applyCriteria(
				tableName,
				options,
				criteriaAND as Criteria,
				true,
				searchIn,
			);

			if (searchResult) {
				RETURN = Utils.deepMerge(
					RETURN,
					Object.fromEntries(
						Object.entries(searchResult).filter(
							([_k, v], _i) =>
								Object.keys(v).filter((key) =>
									Object.keys(criteriaAND).includes(key),
								).length,
						),
					),
				);
			} else return null;
		}

		if (criteriaOR && Utils.isObject(criteriaOR)) {
			const searchResult = await this.applyCriteria(
				tableName,
				options,
				criteriaOR as Criteria,
				false,
				searchIn,
			);

			if (searchResult) {
				RETURN = Utils.deepMerge(RETURN, searchResult);

				if (!Object.keys(RETURN).length) RETURN = {};
				RETURN = Object.fromEntries(
					Object.entries(RETURN).filter(
						([_index, item]) =>
							Object.keys(item).filter(
								(key) =>
									Object.keys(criteriaOR).includes(key) ||
									Object.keys(criteriaOR).some((criteriaKey) =>
										criteriaKey.startsWith(`${key}.`),
									),
							).length,
					),
				);
				if (!Object.keys(RETURN).length) RETURN = {};
			} else RETURN = {};
		}

		return Object.keys(RETURN).length ? RETURN : null;
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
		await rm(cacheFolderPath, { recursive: true, force: true });
		await mkdir(cacheFolderPath);
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
	get<TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		where: string | number | (string | number)[] | Criteria | undefined,
		options: Options | undefined,
		onlyOne: true,
		onlyLinesNumbers?: false,
		_whereIsLinesNumbers?: boolean,
	): Promise<(Data & TData) | null>;
	get<TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		where: string | number,
		options?: Options,
		onlyOne?: boolean,
		onlyLinesNumbers?: false,
		_whereIsLinesNumbers?: boolean,
	): Promise<(Data & TData) | null>;
	get<TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		where?: string | number | (string | number)[] | Criteria,
		options?: Options,
		onlyOne?: boolean,
		onlyLinesNumbers?: false,
		_whereIsLinesNumbers?: boolean,
	): Promise<(Data & TData)[] | null>;
	get<TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		where: string | number | (string | number)[] | Criteria | undefined,
		options: Options | undefined,
		onlyOne: false | undefined,
		onlyLinesNumbers: true,
		_whereIsLinesNumbers?: boolean,
	): Promise<number[] | null>;
	get<TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		where: string | number | (string | number)[] | Criteria | undefined,
		options: Options | undefined,
		onlyOne: true,
		onlyLinesNumbers: true,
		_whereIsLinesNumbers?: boolean,
	): Promise<number | null>;
	public async get<TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		where?: string | number | (string | number)[] | Criteria,
		options: Options = {
			page: 1,
			perPage: 15,
		},
		onlyOne?: boolean,
		onlyLinesNumbers?: boolean,
		_whereIsLinesNumbers?: boolean,
	): Promise<(Data & TData) | number | ((Data & TData) | number)[] | null> {
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
		let RETURN!: (Data & TData) | (Data & TData)[] | null;

		let schema = structuredClone((await this.getTable(tableName)).schema);

		if (!schema) throw this.createError("NO_SCHEMA", tableName);

		let pagination: [number, number];
		for await (const paginationFileName of glob("*.pagination", {
			cwd: tablePath,
		}))
			pagination = parse(paginationFileName).name.split("-").map(Number) as [
				number,
				number,
			];

		if (!pagination[1]) return null;

		if (options.columns?.length)
			schema = this._filterSchemaByColumns(schema, options.columns as string[]);

		if (
			where &&
			((Array.isArray(where) && !where.length) ||
				(Utils.isObject(where) && !Object.keys(where).length))
		)
			where = undefined;

		if (options.sort) {
			let sortArray: [string, boolean][];
			let awkCommand = "";

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
			if (globalConfig[this.databasePath].tables.get(tableName).config.cache)
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
						{ key: "BLABLA", type: "number" },
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

			const filesPathes = (
				sortArray.find(([key]) => key === "id")
					? sortArray
					: [["id", true], ...sortArray]
			).map((column) =>
				join(tablePath, `${column[0]}${this.getFileExtension(tableName)}`),
			);
			for await (const path of filesPathes.slice(1))
				if (!(await File.isExists(path))) return null;

			// Construct the paste command to merge files and filter lines by IDs
			const pasteCommand = `paste '${filesPathes.join("' '")}'`;

			// Construct the sort command dynamically based on the number of files for sorting
			const index = 1;
			const sortColumns = sortArray
				.map(([key, ascending], i) => {
					const field = Utils.getField(key, schema);
					if (field)
						return `-k${i + index},${i + index}${
							Utils.isFieldType(field, ["id", "number", "date"]) ? "n" : ""
						}${!ascending ? "r" : ""}`;
					return "";
				})
				.join(" ");
			const sortCommand = `sort ${sortColumns} -T='${join(tablePath, ".tmp")}'`;

			try {
				if (cacheKey) await File.lock(join(tablePath, ".tmp"), cacheKey);
				// Combine && Execute the commands synchronously
				let lines = (
					await UtilsServer.exec(
						globalConfig[this.databasePath].tables.get(tableName).config.cache
							? (await File.isExists(
									join(tablePath, ".cache", `${cacheKey}${this.fileExtension}`),
								))
								? `${awkCommand} '${join(
										tablePath,
										".cache",
										`${cacheKey}${this.fileExtension}`,
									)}'`
								: `${pasteCommand} | ${sortCommand} -o '${join(
										tablePath,
										".cache",
										`${cacheKey}${this.fileExtension}`,
									)}' && ${awkCommand} '${join(
										tablePath,
										".cache",
										`${cacheKey}${this.fileExtension}`,
									)}'`
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
				else if (!this.totalItems.has(`${tableName}-*`))
					this.totalItems.set(`${tableName}-*`, pagination[1]);
				if (!lines.length) return null;

				// Parse the result and extract the specified lines
				const outputArray: (Data & TData)[] = lines.map((line) => {
					const splitedFileColumns = line.split("\t"); // Assuming tab-separated columns
					const outputObject = {};

					// Extract values for each file, including `id${this.getFileExtension(tableName)}`
					filesPathes.forEach((fileName, index) => {
						const field = Utils.getField(parse(fileName).name, schema);
						if (field) {
							if (
								field.key === "id" &&
								globalConfig[this.databasePath].tables.get(tableName).config
									.decodeID
							)
								outputObject[field.key as string] = splitedFileColumns[index];
							else
								outputObject[field.key as string] = File.decode(
									splitedFileColumns[index],
									{ ...field, databasePath: this.databasePath },
								);
						}
					});

					return outputObject;
				}) as (Data & TData)[];

				const restOfColumns = await this.get<TData>(
					tableName,
					outputArray.map(({ id }) => id),
					(({ sort, ...rest }) => rest)(options),
				);

				return restOfColumns
					? outputArray.map((item) => ({
							...item,
							...restOfColumns.find(
								({ id }) =>
									id === (Utils.isNumber(item.id) ? Number(item.id) : item.id),
							),
						}))
					: outputArray;
			} finally {
				if (cacheKey) await File.unlock(join(tablePath, ".tmp"), cacheKey);
			}
		}

		if (!where) {
			// Display all data
			RETURN = Object.values(
				await this.processSchemaData(
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

			if (!this.totalItems.has(`${tableName}-*`))
				this.totalItems.set(`${tableName}-*`, pagination[1]);
		} else if (
			((Array.isArray(where) && where.every(Utils.isNumber)) ||
				Utils.isNumber(where)) &&
			(_whereIsLinesNumbers ||
				!globalConfig[this.databasePath].tables.get(tableName).config.decodeID)
		) {
			// "where" in this case, is the line(s) number(s) and not id(s)
			let lineNumbers = where as number | number[];
			if (!Array.isArray(lineNumbers)) lineNumbers = [lineNumbers];

			if (!this.totalItems.has(`${tableName}-*`))
				this.totalItems.set(`${tableName}-*`, lineNumbers.length);

			// useless
			if (onlyLinesNumbers) return lineNumbers;

			RETURN = Object.values(
				(await this.processSchemaData<TData>(
					tableName,
					schema,
					lineNumbers,
					options,
				)) ?? {},
			);

			if (RETURN?.length && !Array.isArray(where))
				RETURN = (RETURN as (Data & TData)[])[0];
		} else if (
			(!_whereIsLinesNumbers &&
				globalConfig[this.databasePath].tables.get(tableName).config.decodeID &&
				((Array.isArray(where) && where.every(Utils.isNumber)) ||
					Utils.isNumber(where))) ||
			(Array.isArray(where) && where.every(Utils.isValidID)) ||
			Utils.isValidID(where)
		) {
			let Ids = where as string | number | (string | number)[];
			if (!Array.isArray(Ids)) Ids = [Ids];
			const [lineNumbers, countItems] = await File.search(
				join(tablePath, `id${this.getFileExtension(tableName)}`),
				"[]",
				Ids.map((id) =>
					Utils.isNumber(id) ? Number(id) : UtilsServer.decodeID(id),
				),
				undefined,
				undefined,
				{ key: "BLABLA", type: "number" },
				Ids.length,
				0,
				!this.totalItems.has(`${tableName}-*`),
			);
			if (!lineNumbers) return null;

			if (!this.totalItems.has(`${tableName}-*`))
				this.totalItems.set(`${tableName}-*`, countItems);

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
				(await this.processSchemaData<TData>(
					tableName,
					schema,
					Object.keys(lineNumbers).map(Number),
					options,
				)) ?? {},
			);

			if (RETURN?.length && !Array.isArray(where))
				RETURN = (RETURN as (Data & TData)[])[0];
		} else if (Utils.isObject(where)) {
			let cachedFilePath = "";
			// Criteria
			if (globalConfig[this.databasePath].tables.get(tableName).config.cache) {
				cachedFilePath = join(
					tablePath,
					".cache",
					`${UtilsServer.hashString(inspect(where, { sorted: true }))}${
						this.fileExtension
					}`,
				);

				if (await File.isExists(cachedFilePath)) {
					const cachedItems = (await readFile(cachedFilePath, "utf8")).split(
						",",
					);

					if (!this.totalItems.has(`${tableName}-*`))
						this.totalItems.set(`${tableName}-*`, cachedItems.length);

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
						undefined,
						true,
					);
				}
			}

			const LineNumberDataObj = await this.applyCriteria<TData>(
				tableName,
				options,
				where as Criteria,
			);
			if (LineNumberDataObj) {
				if (!this.totalItems.has(`${tableName}-*`))
					this.totalItems.set(
						`${tableName}-*`,
						Object.keys(LineNumberDataObj).length,
					);

				if (onlyLinesNumbers)
					return onlyOne
						? Number(Object.keys(LineNumberDataObj)[0])
						: Object.keys(LineNumberDataObj).map(Number);
				const alreadyExistsColumns = Object.keys(
					Object.values(LineNumberDataObj)[0],
				);
				const alreadyExistsColumnsIDs = Utils.flattenSchema(schema)
					.filter(({ key }) => alreadyExistsColumns.includes(key))
					.map(({ id }) => id);

				RETURN = Object.values(
					Utils.deepMerge(
						LineNumberDataObj,
						await this.processSchemaData(
							tableName,
							Utils.filterSchema(
								schema,
								(field) =>
									!alreadyExistsColumnsIDs.includes(field.id) ||
									Utils.isFieldType(field, "table"),
							),
							Object.keys(LineNumberDataObj).map(Number),
							options,
						),
					),
				);
				if (globalConfig[this.databasePath].tables.get(tableName).config.cache)
					await writeFile(
						cachedFilePath,
						Object.keys(LineNumberDataObj).join(","),
					);
			}
		}

		if (
			!RETURN ||
			(Utils.isObject(RETURN) && !Object.keys(RETURN).length) ||
			(Array.isArray(RETURN) && !RETURN.length)
		)
			return null;

		const greatestTotalItems = this.totalItems.has(`${tableName}-*`)
			? this.totalItems.get(`${tableName}-*`)
			: Math.max(
					...[...this.totalItems.entries()]
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
	 * @param {((Data & TData) | (Data & TData)[])} data Can be array of objects or a single object
	 * @param {Options} [options] Pagination options, useful when the returnPostedData param is true
	 * @param {boolean} [returnPostedData] By default function returns void, if you want to get the posted data, set this param to true
	 * @return {*}  {Promise<Data | Data[] | null | void>}
	 */
	post<TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		data: Data & TData,
		options?: Options,
		returnPostedData?: boolean,
	): Promise<string>;
	post<TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		data: (Data & TData)[],
		options?: Options,
		returnPostedData?: boolean,
	): Promise<string[]>;
	post<TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		data: Data & TData,
		options: Options | undefined,
		returnPostedData: true,
	): Promise<(Data & TData) | null>;
	post<TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		data: (Data & TData)[],
		options: Options | undefined,
		returnPostedData: true,
	): Promise<(Data & TData)[] | null>;
	public async post<TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		data: (Data & TData) | (Data & TData)[],
		options?: Options,
		returnPostedData?: boolean,
	): Promise<(Data & TData) | (Data & TData)[] | null | string | string[]> {
		if (!options)
			options = {
				page: 1,
				perPage: 15,
			};
		const tablePath = join(this.databasePath, tableName);
		await this.getTable(tableName);

		if (!globalConfig[this.databasePath].tables.get(tableName).schema)
			throw this.createError("NO_SCHEMA", tableName);

		if (!returnPostedData) returnPostedData = false;

		let clonedData = structuredClone(data);

		const keys = UtilsServer.hashString(
			Object.keys(Array.isArray(clonedData) ? clonedData[0] : clonedData).join(
				".",
			),
		);

		await this.validateData(tableName, clonedData);

		const renameList: string[][] = [];
		try {
			await File.lock(join(tablePath, ".tmp"), keys);

			let paginationFilePath: string;
			for await (const fileName of glob("*.pagination", { cwd: tablePath }))
				paginationFilePath = join(tablePath, fileName);

			let [lastId, _totalItems] = parse(paginationFilePath)
				.name.split("-")
				.map(Number) as [number, number];

			this.totalItems.set(`${tableName}-*`, _totalItems);

			if (Utils.isArrayOfObjects(clonedData))
				for (let index = 0; index < clonedData.length; index++) {
					const element = clonedData[index];
					element.id = ++lastId as any;
					element.createdAt = Date.now();
					element.updatedAt = undefined;
				}
			else {
				clonedData.id = ++lastId as any;
				clonedData.createdAt = Date.now();
				clonedData.updatedAt = undefined;
			}

			clonedData = this.formatData<TData>(
				clonedData,
				globalConfig[this.databasePath].tables.get(tableName).schema,
				false,
			);

			const pathesContents = this.joinPathesContents(
				tableName,
				globalConfig[this.databasePath].tables.get(tableName).config.prepend
					? Array.isArray(clonedData)
						? clonedData.toReversed()
						: clonedData
					: clonedData,
			);

			await Promise.allSettled(
				Object.entries(pathesContents).map(async ([path, content]) =>
					renameList.push(
						globalConfig[this.databasePath].tables.get(tableName).config.prepend
							? await File.prepend(path, content)
							: await File.append(path, content),
					),
				),
			);

			await Promise.allSettled(
				renameList
					.filter(([_, filePath]) => filePath)
					.map(async ([tempPath, filePath]) => rename(tempPath, filePath)),
			);

			if (globalConfig[this.databasePath].tables.get(tableName).config.cache)
				await this.clearCache(tableName);

			const currentValue = this.totalItems.get(`${tableName}-*`) || 0;
			this.totalItems.set(
				`${tableName}-*`,
				currentValue + (Array.isArray(data) ? data.length : 1),
			);

			await rename(
				paginationFilePath,
				join(
					tablePath,
					`${lastId}-${this.totalItems.get(`${tableName}-*`)}.pagination`,
				),
			);

			if (returnPostedData)
				return this.get<TData>(
					tableName,
					globalConfig[this.databasePath].tables.get(tableName).config.prepend
						? Array.isArray(clonedData)
							? clonedData.map((_, index) => index + 1).toReversed()
							: 1
						: Array.isArray(clonedData)
							? clonedData
									.map(
										(_, index) => this.totalItems.get(`${tableName}-*`) - index,
									)
									.toReversed()
							: this.totalItems.get(`${tableName}-*`),
					options,
					!Utils.isArrayOfObjects(clonedData), // return only one item if data is not array of objects
					undefined,
					true,
				);

			return Array.isArray(clonedData)
				? (globalConfig[this.databasePath].tables.get(tableName).config.prepend
						? clonedData.toReversed()
						: clonedData
					).map(({ id }) => UtilsServer.encodeID(id))
				: UtilsServer.encodeID((clonedData as Data & TData).id);
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
	 * @param {(Data & TData) | (Data & TData[])} data
	 * @param {(number | string | (number | string)[] | Criteria)} [where]
	 * @param {Options} [options]
	 * @param {boolean} [returnUpdatedData]
	 * @return {*}  {Promise<Data | Data[] | null | undefined | void>}
	 */
	put<TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		data?: (Data & TData) | (Data & TData)[],
		where?: number | string | (number | string)[] | Criteria | undefined,
		options?: Options | undefined,
		returnUpdatedData?: false,
		_whereIsLinesNumbers?: boolean,
	): Promise<void>;
	put<TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		data: Data & TData,
		where: number | string | (number | string)[] | Criteria | undefined,
		options: Options | undefined,
		returnUpdatedData: true | boolean,
		_whereIsLinesNumbers?: boolean,
	): Promise<(Data & TData) | null>;
	put<TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		data: (Data & TData)[],
		where: number | string | (number | string)[] | Criteria | undefined,
		options: Options | undefined,
		returnUpdatedData: true | boolean,
		_whereIsLinesNumbers?: boolean,
	): Promise<(Data & TData)[] | null>;
	put<TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		data: (Data & TData) | (Data & TData)[],
		where: number | string | (number | string)[] | Criteria | undefined,
		options: Options | undefined,
		returnUpdatedData: true | boolean,
		_whereIsLinesNumbers?: boolean,
	): Promise<(Data & TData) | (Data & TData)[] | null>;
	public async put<TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		data: (Data & TData) | (Data & TData)[],
		where?: number | string | (number | string)[] | Criteria,
		options: Options = {
			page: 1,
			perPage: 15,
		},
		returnUpdatedData?: boolean,
		_whereIsLinesNumbers?: boolean,
	): Promise<(Data & TData) | (Data & TData)[] | null | undefined | void> {
		const renameList: string[][] = [];
		const tablePath = join(this.databasePath, tableName);
		await this.throwErrorIfTableEmpty(tableName);

		let clonedData: (Data & TData) | (Data & TData)[] = structuredClone(data);

		if (!where) {
			if (Utils.isArrayOfObjects(clonedData)) {
				if (
					!clonedData.every(
						(item) => Object.hasOwn(item, "id") && Utils.isValidID(item.id),
					)
				)
					throw this.createError("INVALID_ID");

				return this.put<TData>(
					tableName,
					clonedData,
					clonedData.map(({ id }) => id),
					options,
					returnUpdatedData,
				);
			}
			if (Object.hasOwn(clonedData, "id")) {
				if (!Utils.isValidID(clonedData.id))
					throw this.createError("INVALID_ID", clonedData.id);
				return this.put<TData>(
					tableName,
					clonedData,
					clonedData.id,
					options,
					returnUpdatedData,
				);
			}

			await this.validateData(tableName, clonedData, true);

			clonedData = this.formatData<TData>(
				clonedData,
				globalConfig[this.databasePath].tables.get(tableName).schema,
				true,
			);

			const pathesContents = this.joinPathesContents(tableName, {
				...(({ id, ...restOfData }) => restOfData)(clonedData as TData & Data),
				updatedAt: Date.now(),
			});

			try {
				await File.lock(join(tablePath, ".tmp"));

				for await (const paginationFileName of glob("*.pagination", {
					cwd: tablePath,
				}))
					this.totalItems.set(
						`${tableName}-*`,
						parse(paginationFileName).name.split("-").map(Number)[1],
					);

				await Promise.allSettled(
					Object.entries(pathesContents).map(async ([path, content]) =>
						renameList.push(
							await File.replace(
								path,
								content,
								this.totalItems.get(`${tableName}-*`),
							),
						),
					),
				);

				await Promise.allSettled(
					renameList
						.filter(([_, filePath]) => filePath)
						.map(async ([tempPath, filePath]) => rename(tempPath, filePath)),
				);

				if (globalConfig[this.databasePath].tables.get(tableName).config.cache)
					await this.clearCache(join(tablePath, ".cache"));

				if (returnUpdatedData)
					return await this.get<TData>(tableName, undefined, options);
			} finally {
				if (renameList.length)
					await Promise.allSettled(
						renameList.map(async ([tempPath, _]) => unlink(tempPath)),
					);
				await File.unlock(join(tablePath, ".tmp"));
			}
		} else if (
			((Array.isArray(where) && where.every(Utils.isNumber)) ||
				Utils.isNumber(where)) &&
			(_whereIsLinesNumbers ||
				!globalConfig[this.databasePath].tables.get(tableName).config.decodeID)
		) {
			// "where" in this case, is the line(s) number(s) and not id(s)

			await this.validateData(tableName, clonedData, true);

			clonedData = this.formatData<TData>(
				clonedData,
				globalConfig[this.databasePath].tables.get(tableName).schema,
				true,
			);

			const pathesContents = Object.fromEntries(
				Object.entries(
					this.joinPathesContents(
						tableName,
						Array.isArray(clonedData)
							? clonedData.map((item) => ({
									...item,
									updatedAt: Date.now(),
								}))
							: { ...(clonedData as TData & Data), updatedAt: Date.now() },
					),
				).map(([path, content]) => [
					path,
					(Array.isArray(where) ? where : [where]).reduce(
						(obj, lineNum, index) => {
							obj[lineNum] = Array.isArray(content) ? content[index] : content;
							return obj;
						},
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

				await Promise.allSettled(
					Object.entries(pathesContents).map(async ([path, content]) =>
						renameList.push(await File.replace(path, content)),
					),
				);

				await Promise.allSettled(
					renameList
						.filter(([_, filePath]) => filePath)
						.map(async ([tempPath, filePath]) => rename(tempPath, filePath)),
				);

				if (globalConfig[this.databasePath].tables.get(tableName).config.cache)
					await this.clearCache(tableName);

				if (returnUpdatedData)
					return this.get(
						tableName,
						where,
						options,
						!Array.isArray(where),
						undefined,
						true,
					);
			} finally {
				if (renameList.length)
					await Promise.allSettled(
						renameList.map(async ([tempPath, _]) => unlink(tempPath)),
					);
				await File.unlock(join(tablePath, ".tmp"), keys);
			}
		} else if (
			(!_whereIsLinesNumbers &&
				globalConfig[this.databasePath].tables.get(tableName).config.decodeID &&
				((Array.isArray(where) && where.every(Utils.isNumber)) ||
					Utils.isNumber(where))) ||
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
			if (lineNumbers)
				return this.put<TData>(
					tableName,
					clonedData as TData & Data,
					lineNumbers,
					options,
					returnUpdatedData,
					true,
				);
		} else if (Utils.isObject(where)) {
			const lineNumbers = await this.get(
				tableName,
				where,
				undefined,
				undefined,
				true,
			);
			if (lineNumbers)
				return this.put<TData>(
					tableName,
					clonedData,
					lineNumbers,
					options,
					returnUpdatedData,
					true,
				);
		} else throw this.createError("INVALID_PARAMETERS");
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
		_whereIsLinesNumbers?: boolean,
	): Promise<boolean | null> {
		const tablePath = join(this.databasePath, tableName);
		await this.throwErrorIfTableEmpty(tableName);

		if (!where) {
			try {
				await File.lock(join(tablePath, ".tmp"));

				let paginationFilePath: string;
				let pagination: [number, number];
				for await (const paginationFileName of glob("*.pagination", {
					cwd: tablePath,
				})) {
					paginationFilePath = join(tablePath, paginationFileName);
					pagination = parse(paginationFileName)
						.name.split("-")
						.map(Number) as [number, number];
				}

				await Promise.all(
					(await readdir(tablePath))
						?.filter((fileName: string) =>
							fileName.endsWith(this.getFileExtension(tableName)),
						)
						.map(async (file) => unlink(join(tablePath, file))),
				);

				if (globalConfig[this.databasePath].tables.get(tableName).config.cache)
					await this.clearCache(tableName);

				await rename(
					paginationFilePath,
					join(tablePath, `${pagination[0]}-0.pagination`),
				);

				return true;
			} finally {
				await File.unlock(join(tablePath, ".tmp"));
			}
		}
		if (
			((Array.isArray(where) && where.every(Utils.isNumber)) ||
				Utils.isNumber(where)) &&
			(_whereIsLinesNumbers ||
				!globalConfig[this.databasePath].tables.get(tableName).config.decodeID)
		) {
			// "where" in this case, is the line(s) number(s) and not id(s)
			const files = (await readdir(tablePath))?.filter((fileName: string) =>
				fileName.endsWith(this.getFileExtension(tableName)),
			);

			if (files.length) {
				const renameList: string[][] = [];
				try {
					await File.lock(join(tablePath, ".tmp"));

					let paginationFilePath: string;
					let pagination: [number, number];
					for await (const paginationFileName of glob("*.pagination", {
						cwd: tablePath,
					})) {
						paginationFilePath = join(tablePath, paginationFileName);
						pagination = parse(paginationFileName)
							.name.split("-")
							.map(Number) as [number, number];
					}

					if (
						pagination[1] &&
						pagination[1] - (Array.isArray(where) ? where.length : 1) > 0
					) {
						await Promise.all(
							files.map(async (file) =>
								renameList.push(
									await File.remove(join(tablePath, file), where),
								),
							),
						);

						await Promise.all(
							renameList
								.filter(([_, filePath]) => filePath)
								.map(async ([tempPath, filePath]) =>
									rename(tempPath, filePath),
								),
						);
					} else
						await Promise.all(
							(await readdir(tablePath))
								?.filter((fileName: string) =>
									fileName.endsWith(this.getFileExtension(tableName)),
								)
								.map(async (file) => unlink(join(tablePath, file))),
						);

					if (
						globalConfig[this.databasePath].tables.get(tableName).config.cache
					)
						await this.clearCache(tableName);

					await rename(
						paginationFilePath,
						join(
							tablePath,
							`${pagination[0]}-${pagination[1] - (Array.isArray(where) ? where.length : 1)}.pagination`,
						),
					);

					return true;
				} finally {
					if (renameList.length)
						await Promise.allSettled(
							renameList.map(async ([tempPath, _]) => unlink(tempPath)),
						);
					await File.unlock(join(tablePath, ".tmp"));
				}
			}
		}
		if (
			(!_whereIsLinesNumbers &&
				globalConfig[this.databasePath].tables.get(tableName).config.decodeID &&
				((Array.isArray(where) && where.every(Utils.isNumber)) ||
					Utils.isNumber(where))) ||
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
			return this.delete(tableName, lineNumbers, true);
		}
		if (Utils.isObject(where)) {
			const lineNumbers = await this.get(
				tableName,
				where,
				undefined,
				undefined,
				true,
			);
			if (lineNumbers) return this.delete(tableName, lineNumbers, true);
		} else throw this.createError("INVALID_PARAMETERS");
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
