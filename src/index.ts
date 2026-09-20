import "dotenv/config";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
	glob,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, join, parse, resolve } from "node:path";
import { inspect } from "node:util";
import Inison from "inison";

import * as File from "./file.js";
import { DatabaseJournal, Journal, type JournalFileOp } from "./journal.js";
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
	id?: number;
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

/**
 * Per-table state maintained while a database transaction is open: the writer
 * lock is held for the whole transaction, pagination state is staged in
 * memory (the live files only change at commit()), and `staged` collects the
 * journaled ops that commit() publishes (one per table per transaction).
 */
export interface TxnTableEntry {
	locked: boolean;
	/** Live pagination path the first staged op builds on. */
	paginationFrom: string;
	/** Staged last-id / row count (chained across ops in the txn). */
	lastId: number;
	total: number;
	staged: {
		ops: JournalFileOp[];
		pagination: { from: string; to: string } | null;
	}[];
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

export const ERROR_CODES = [
	"GROUP_UNIQUE",
	"FIELD_UNIQUE",
	"FIELD_REQUIRED",
	"NO_SCHEMA",
	"TABLE_EMPTY",
	"INVALID_ID",
	"INVALID_TYPE",
	"INVALID_PARAMETERS",
	"NO_ENV",
	"TABLE_EXISTS",
	"TABLE_NOT_EXISTS",
	"INVALID_REGEX_MATCH",
	"INVALID_NAME",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type ErrorLang = "en" | "ar" | "fr" | "es";

// hide ExperimentalWarning glob()
// Guard against non-Node environments (e.g. accidental import in a browser bundle)
if (
	typeof process !== "undefined" &&
	typeof process.removeAllListeners === "function"
) {
	process.removeAllListeners("warning");
}

export const globalConfig: {
	[database: string]: {
		tables?: Map<string, TableObject & { timestamp?: Date }>;
	};
} & { salt?: string | Buffer } = {};

/**
 * @param {string} database - Database name
 * @param {string} [mainFolder="."] - Main folder path
 * @param {ErrorLang} [language="en"] - Language for error messages
 */
export default class Inibase {
	public pageInfo: Record<string, pageInfo>;
	public language: ErrorLang;
	public fileExtension = ".txt";
	public totalItems: Map<string, number>;
	/** Tracks whether a decodeID table's stored ids are the dense sequence
	 *  1..rowCount (no rows ever deleted). When true, `get`/`put`/`delete` can
	 *  resolve numeric ids to line numbers arithmetically instead of scanning
	 *  the id file. Set false by any partial row deletion. */
	private idDensity = new Map<string, boolean>();
	private databasePath: string;
	private uniqueMap: Map<
		string | number,
		{ exclude: Set<number>; columnsValues: Map<number, Set<string | number>> }
	>;
	private schemaFileExtension = process.env.INIBASE_SCHEMA_EXTENSION ?? "json";

	/**
	 * Open database transaction (see begin/commit/rollback). Holds the
	 * database lock (`<db>/.tmp/.locked`) for its whole lifetime and the
	 * per-table writer lock of every table it mutates, so mutations stage into
	 * the database journal and publish only on commit().
	 */
	private transaction: {
		id: string;
		journal: DatabaseJournal;
		tables: Map<string, TxnTableEntry>;
	} | null = null;

	constructor(database: string, mainFolder = ".", language: ErrorLang = "en") {
		this.language = language;

		this.validateName(database);

		this.databasePath = join(mainFolder, database);

		this.pageInfo = {};

		this.totalItems = new Map();

		this.uniqueMap = new Map();

		if (!globalConfig[this.databasePath])
			globalConfig[this.databasePath] = { tables: new Map() };

		if (!process?.env.INIBASE_SECRET) {
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

	public createError(
		name: ErrorCode,
		variable?: string | number | (string | number)[],
	): Error {
		return Utils.createError(this.language, name, variable);
	}

	private validateName(name: string): void {
		Utils.validateName(name, this.language);
	}

	/**
	 * Validates column paths used in the `columns` option.
	 *
	 * Each column may be a nested path of dot-separated names
	 * (e.g. "address.street", "hobbies.name") and may optionally
	 * start with "!" for exclusion. The "*" wildcard (select all)
	 * and its "!*" counterpart are special values and are skipped.
	 * Every segment of a path is validated individually.
	 */
	private validateColumns(columns: string[]): void {
		for (const column of columns) {
			if (column === "*" || column === "!*") continue;

			const path = column.startsWith("!") ? column.slice(1) : column;
			for (const segment of path.split(".")) {
				if (!segment) this.validateName(column);
				else this.validateName(segment);
			}
		}
	}

	private validateSchema(schema: Schema): void {
		Utils.validateSchema(schema, this.language);
	}

	private getFileExtension(tableName: string) {
		let mainExtension = this.fileExtension;
		// TODO: ADD ENCRYPTION
		// if(globalConfig[this.databasePath].tables?.get(tableName)?.config.encryption)
		// 	mainExtension += ".enc"
		if (
			globalConfig[this.databasePath].tables?.get(tableName)?.config.compression
		)
			mainExtension += ".gz";
		return mainExtension;
	}

	private schemaToIdsPath(tableName: string, schema: Schema, prefix = "") {
		const RETURN: any = {};
		for (const field of schema)
			if (
				(field.type === "array" || field.type === "object") &&
				field.children &&
				Utils.isArrayOfObjects(field.children)
			)
				Utils.deepMerge(
					RETURN,
					this.schemaToIdsPath(
						tableName,
						field.children,
						`${(prefix ?? "") + field.key}.`,
					),
				);
			else if (field.id)
				RETURN[field.id] =
					`${(prefix ?? "") + field.key}${this.getFileExtension(tableName)}`;

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
		this.validateName(tableName);

		// DDL does not participate in the write-ahead journal: schema surgery
		// inside a transaction would escape the atomic publish/rollback scope.
		if (this.transaction) throw this.createError("INVALID_PARAMETERS");
		await this.ensureDatabaseRecovered();

		if (schema) this.validateSchema(schema);

		const tablePath = join(this.databasePath, tableName);

		if (await File.isExists(tablePath))
			throw this.createError("TABLE_EXISTS", tableName);

		await mkdir(join(tablePath, ".tmp"), { recursive: true });
		await mkdir(join(tablePath, ".cache"));

		// if config not set => load default global env config
		if (!config)
			config = {
				compression: process.env.INIBASE_COMPRESSION === "true",
				cache: process.env.INIBASE_CACHE === "true",
				prepend: process.env.INIBASE_PREPEND === "true",
				decodeID: process.env.INIBASE_ENCODEID === "true",
			};

		if (config) {
			if (config.compression)
				await File.write(join(tablePath, ".compression.config"), "");
			if (config.cache) await File.write(join(tablePath, ".cache.config"), "");
			if (config.prepend)
				await File.write(join(tablePath, ".prepend.config"), "");
			if (config.decodeID)
				await File.write(join(tablePath, ".decodeID.config"), "");
		}
		if (schema) {
			const lastSchemaID = { value: 0 };
			await File.write(
				join(tablePath, `schema.${this.schemaFileExtension}`),
				this.schemaFileExtension === "json"
					? JSON.stringify(Utils.addIdToSchema(schema, lastSchemaID), null, 2)
					: Inison.stringify(Utils.addIdToSchema(schema, lastSchemaID)),
			);
			await File.write(join(tablePath, `${lastSchemaID.value}.schema`), "");
		} else await File.write(join(tablePath, "0.schema"), "");

		await File.write(join(tablePath, "0-0.pagination"), "");

		// Make the new table's metadata durable before acknowledging creation.
		await File.syncDir(tablePath);
		await File.syncDir(join(tablePath, ".tmp"));

		this.idDensity.set(tableName, true);
	}

	// Function to replace the string in one schema file
	private async replaceStringInFile(
		filePath: string,
		targetString: string,
		replaceString: string,
	) {
		const data = await readFile(filePath, "utf8");

		if (data.includes(targetString)) {
			const updatedContent = data.replaceAll(targetString, replaceString);
			// File.write fsyncs the replacement so a link-update after a table
			// rename survives a crash.
			await File.write(filePath, updatedContent);
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
		this.validateName(tableName);

		// DDL does not participate in the write-ahead journal: schema surgery
		// inside a transaction would escape the atomic publish/rollback scope.
		if (this.transaction) throw this.createError("INVALID_PARAMETERS");
		await this.ensureDatabaseRecovered();

		if (config?.name) this.validateName(config.name);

		const table = await this.getTable(tableName);
		if (!table) return;
		const tablePath = join(this.databasePath, tableName);

		// DDL is serialized with DML writers on the same per-table lock, so a
		// post/put/delete can never interleave with schema/file surgery.
		try {
			await File.lock(join(tablePath, ".tmp"));
			await this.updateTableLocked(tableName, table, tablePath, schema, config);
		} finally {
			await File.unlock(join(tablePath, ".tmp"));
			// Renaming the table moves its .tmp (and with it the lock file)
			// to the new directory, so the unlock above only released the old
			// path. Release the lock at its new location too, or the renamed
			// table is left with a perpetual live-owner lock no writer can
			// steal.
			if (config?.name && config.name !== tableName)
				await File.unlock(join(join(this.databasePath, config.name), ".tmp"));
		}
	}

	private async updateTableLocked(
		tableName: string,
		table: TableObject,
		tablePath: string,
		schema?: Schema,
		config?: TableConfig & { name?: string },
	) {
		if (schema) {
			this.validateSchema(schema);
			// remove id from schema
			schema = schema.filter(
				({ key }) => !["id", "createdAt", "updatedAt"].includes(key),
			);

			let schemaIdFilePath: string = "";
			for await (const fileName of glob("*.schema", { cwd: tablePath }))
				schemaIdFilePath = join(tablePath, fileName);

			const lastSchemaID = {
				value: schemaIdFilePath ? Number(parse(schemaIdFilePath).name) : 0,
			};

			schema = Utils.addIdToSchema(schema, lastSchemaID);

			// if schema file exists, update columns files names based on field id
			if (
				(await File.isExists(
					join(tablePath, `schema.${this.schemaFileExtension}`),
				)) &&
				table.schema?.length
			) {
				const replaceOldPathes = Utils.findChangedProperties(
					this.schemaToIdsPath(
						tableName,
						table.schema.filter(
							({ key }) => !["createdAt", "updatedAt"].includes(key),
						),
					),
					this.schemaToIdsPath(tableName, schema),
				);
				if (replaceOldPathes)
					await Promise.allSettled(
						Object.entries(replaceOldPathes).map(async ([oldPath, newPath]) => {
							if (await File.isExists(join(tablePath, oldPath))) {
								// if newPath is null, it means the field was removed
								if (newPath === null) await unlink(join(tablePath, oldPath));
								else
									await rename(
										join(tablePath, oldPath),
										join(tablePath, newPath),
									);
							}
						}),
					);
			}

			// Data-bearing schema writes go through File.write so they are
			// fsynced before updateTable returns.
			await File.write(
				join(tablePath, `schema.${this.schemaFileExtension}`),
				this.schemaFileExtension === "json"
					? JSON.stringify(schema, null, 2)
					: Inison.stringify(schema),
			);
			if (schemaIdFilePath)
				await rename(
					schemaIdFilePath,
					join(tablePath, `${lastSchemaID.value}.schema`),
				);
			else
				await File.write(join(tablePath, `${lastSchemaID.value}.schema`), "");

			// Fields added by this migration have no backing file yet. If the
			// first post after the migration writes such a file from scratch it
			// starts at line 1 and every existing row becomes misaligned (the
			// new value lands on the wrong record). Materialize missing column
			// files padded with one empty line per existing row so appends keep
			// line-aligned with the other column files (decode("") is
			// undefined/null, matching the "no value yet" semantics).
			let totalLines = 0;
			for await (const paginationFileName of glob("*.pagination", {
				cwd: tablePath,
			}))
				totalLines = parse(paginationFileName).name.split("-").map(Number)[1];

			await Promise.allSettled(
				schema.map(async ({ key }) => {
					const filePath = join(
						tablePath,
						`${key}${this.getFileExtension(tableName)}`,
					);
					if (!(await File.isExists(filePath)))
						await File.write(filePath, "\n".repeat(totalLines));
				}),
			);
		}

		if (config) {
			if (
				config.compression !== undefined &&
				config.compression !== table.config.compression
			) {
				// Toggle compression crash-safely: the shell only decompresses
				// to a temp file (streamed), the publish step fsyncs each temp
				// before renaming it over the original, then the config marker
				// is fsynced. A crash mid-toggle leaves valid (uncompressed or
				// compressed) files, never a truncated one.
				const toggleFiles = (await readdir(tablePath)).filter((name) =>
					config.compression
						? name.endsWith(this.fileExtension) &&
							!name.endsWith(`${this.fileExtension}.gz`)
						: name.endsWith(`${this.fileExtension}.gz`),
				);
				for (const name of toggleFiles) {
					const src = join(tablePath, name);
					const tmp = `${src}.recompressed`;
					const target = config.compression ? `${src}.gz` : src.slice(0, -3); // strip ".gz"
					await UtilsServer.exec(
						`${config.compression ? "gzip" : "gunzip"} -c ${File.escapeShellPath(src)} > ${File.escapeShellPath(tmp)}`,
					);
					await File.syncFile(tmp);
					await rename(tmp, target);
				}
				if (config.compression)
					await File.write(join(tablePath, ".compression.config"), "");
				else await unlink(join(tablePath, ".compression.config"));
			}
			if (config.cache !== undefined && config.cache !== table.config.cache) {
				if (config.cache)
					await File.write(join(tablePath, ".cache.config"), "");
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
					await File.write(join(tablePath, ".decodeID.config"), "");
				else await unlink(join(tablePath, ".decodeID.config"));
			}
			if (
				config.prepend !== undefined &&
				config.prepend !== table.config.prepend
			) {
				// Reverse every column file so the "first" row stays first after
				// toggling prepend. The (streaming) shell only writes `<file>.reversed`
				// temp files; the publish step below fsyncs each temp before renaming
				// it into place, so a crash mid-toggle never leaves a half-reversed
				// live file (the old file stays valid until the rename).
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
								? `zcat "$file" | ${process.platform === "darwin" ? "tail -r" : "tac"} | gzip > "$file.reversed"`
								: `${process.platform === "darwin" ? "tail -r" : "tac"} "$file" > "$file.reversed"`
						}; done`,
						"_",
						"{}",
						"+",
					],
					{ cwd: this.databasePath },
				);

				const reversedSuffix = `${this.fileExtension}${
					config.compression ? ".gz" : ""
				}.reversed`;
				for (const fileName of await readdir(tablePath)) {
					if (!fileName.endsWith(reversedSuffix)) continue;
					const reversedPath = join(tablePath, fileName);
					await File.syncFile(reversedPath);
					await rename(
						reversedPath,
						join(tablePath, fileName.slice(0, -".reversed".length)),
					);
				}
				if (config.prepend)
					await File.write(join(tablePath, ".prepend.config"), "");
				else await unlink(join(tablePath, ".prepend.config"));
			}
			if (config.name) {
				await rename(tablePath, join(this.databasePath, config.name));
				// replace table name in other linked tables (relationship).
				// glob() returns paths relative to `cwd`, so resolve them
				// against the database path before touching the files.
				for await (const schemaPath of glob(
					`**/schema.${this.schemaFileExtension}`,
					{
						cwd: this.databasePath,
					},
				))
					await this.replaceStringInFile(
						resolve(this.databasePath, schemaPath),
						// TODO: escape caracters in table name
						this.schemaFileExtension === "json"
							? `"table": "${tableName}"`
							: `table:${tableName}`,
						this.schemaFileExtension === "json"
							? `"table": "${config.name}"`
							: `table:${config.name}`,
					);
			}
		}

		// Flush the directory entries touched by this DDL (renames, unlinks,
		// fresh config markers) before updateTable returns so the schema/config
		// change survives a crash.
		await File.syncDir(config?.name ? this.databasePath : tablePath);

		globalConfig[this.databasePath].tables?.delete(tableName);
	}

	/**
	 * Get table schema and config
	 *
	 * @param {string} tableName
	 * @return {*}  {Promise<TableObject | undefined>}
	 */
	public async getTable(tableName: string): Promise<TableObject | undefined> {
		this.validateName(tableName);

		const tablePath = join(this.databasePath, tableName);

		if (!(await File.isExists(tablePath)))
			throw this.createError("TABLE_NOT_EXISTS", tableName);

		if (
			!globalConfig[this.databasePath].tables?.has(tableName) ||
			globalConfig[this.databasePath].tables?.get(tableName)?.timestamp !==
				(await File.getFileDate(
					join(tablePath, `schema.${this.schemaFileExtension}`),
				))
		)
			globalConfig[this.databasePath].tables?.set(tableName, {
				schema: await this.getTableSchema(tableName),
				config: {
					compression: await File.isExists(
						join(tablePath, ".compression.config"),
					),
					cache: await File.isExists(join(tablePath, ".cache.config")),
					prepend: await File.isExists(join(tablePath, ".prepend.config")),
					decodeID: await File.isExists(join(tablePath, ".decodeID.config")),
				},
				timestamp: await File.getFileDate(
					join(tablePath, `schema.${this.schemaFileExtension}`),
				),
			});
		return globalConfig[this.databasePath].tables?.get(tableName);
	}

	public async getTableSchema(tableName: string) {
		this.validateName(tableName);

		const tablePath = join(this.databasePath, tableName);
		let schemaFile: string | undefined;
		let schema: Schema | undefined;

		if (
			!(await File.isExists(
				join(tablePath, `schema.${this.schemaFileExtension}`),
			))
		) {
			const otherSchemaFileExtension =
				this.schemaFileExtension === "json" ? "inis" : "json";
			if (
				!(await File.isExists(
					join(tablePath, `schema.${otherSchemaFileExtension}`),
				))
			)
				return undefined;

			schemaFile = await readFile(
				join(tablePath, `schema.${otherSchemaFileExtension}`),
				"utf8",
			);

			if (!schemaFile) return undefined;

			schema =
				otherSchemaFileExtension === "json"
					? JSON.parse(schemaFile)
					: Inison.unstringify(schemaFile);

			// Mirror the legacy schema file into the preferred extension and
			// drop the old one (fsync-backed; this read-path migration must
			// survive a crash).
			await File.write(
				join(tablePath, `schema.${this.schemaFileExtension}`),
				this.schemaFileExtension === "json"
					? JSON.stringify(schema, null, 2)
					: Inison.stringify(schema),
			);
			await unlink(join(tablePath, `schema.${otherSchemaFileExtension}`));
			await File.syncDir(tablePath);
		} else
			schemaFile = await readFile(
				join(tablePath, `schema.${this.schemaFileExtension}`),
				"utf8",
			);

		if (!schemaFile) return undefined;

		if (!schema)
			schema =
				this.schemaFileExtension === "json"
					? JSON.parse(schemaFile)
					: Inison.unstringify(schemaFile);

		return [
			{
				id: 0,
				key: "id",
				type: "id",
				required: true,
			},
			...(schema || []),
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
		] as Schema;
	}

	private async throwErrorIfTableEmpty(tableName: string): Promise<void> {
		const table = await this.getTable(tableName);

		if (!table?.schema) throw this.createError("NO_SCHEMA", tableName);

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

	public validateData(
		data: Data | Data[],
		schema: Schema,
		skipRequiredField = false,
	): void {
		if (Utils.isArrayOfObjects(data)) {
			for (const single_data of data as Data[])
				this.validateData(single_data, schema, skipRequiredField);
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
					this.validateData(data[field.key], field.children, skipRequiredField);
				else {
					if (
						field.table &&
						Utils.isObject(data[field.key]) &&
						Object.hasOwn(data[field.key], "id")
					)
						data[field.key] = data[field.key].id;

					if (field.regex) {
						const regex = UtilsServer.getCachedRegex(field.regex);
						if (
							(Array.isArray(data[field.key]) &&
								data[field.key].some((v: unknown) => !regex.test(String(v)))) ||
							!regex.test(String(data[field.key]))
						)
							throw this.createError("INVALID_REGEX_MATCH", [field.key]);
					}
					if (field.unique && field.id !== undefined) {
						const fieldId: number = field.id;
						const uniqueKey: string | number =
							typeof field.unique === "boolean" ? fieldId : field.unique;
						if (!this.uniqueMap.has(uniqueKey))
							this.uniqueMap.set(uniqueKey, {
								exclude: new Set(),
								columnsValues: new Map(),
							});

						if (!this.uniqueMap.get(uniqueKey)?.columnsValues.has(fieldId))
							this.uniqueMap
								?.get(uniqueKey)
								?.columnsValues.set(fieldId, new Set());

						if (data.id) this.uniqueMap.get(uniqueKey)?.exclude.add(-data.id);

						this.uniqueMap
							.get(uniqueKey)
							?.columnsValues.get(fieldId)
							?.add(data[field.key]);
					}
				}
			}
		}
	}
	private async validateTableData(
		tableName: string,
		data: Data | Data[],
		skipRequiredField = false,
	): Promise<void> {
		// `data` is always a private clone owned by the caller (post/put already
		// cloned it once), so validate in place instead of re-cloning — otherwise
		// every bulk write holds several full copies of the payload in memory.
		// Skip ID and (created|updated)At
		this.validateData(
			data,
			globalConfig[this.databasePath].tables
				?.get(tableName)
				?.schema?.slice(1, -2) ?? [],
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
		if (value === null || value === undefined || value === "") return value;
		if (!field) return value as Data | Data[] | number | string | null;

		let _fieldType = field.type;
		if (Array.isArray(_fieldType))
			_fieldType = Utils.detectFieldType(value, _fieldType) ?? _fieldType[0];

		if (Array.isArray(value) && !["array", "json"].includes(_fieldType))
			value = value[0];

		switch (_fieldType) {
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
					} as Field),
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
			case "date":
				return Utils.dateToTimestamp(value);
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
				return typeof value === "string" ? value.trim() : value;
		}
		return null;
	}

	private async checkUnique(tableName: string) {
		const tablePath = join(this.databasePath, tableName);
		const flattenSchema = Utils.flattenSchema(
			globalConfig[this.databasePath].tables?.get(tableName)?.schema ?? [],
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
				if (!field) continue;
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
							!!(lineNumbers && hasDuplicates(lineNumbers, mergedLineNumbers)))
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
					lineNumbers?.forEach(mergedLineNumbers.add, mergedLineNumbers);
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
		// formatData only reads its input (all transformations produce new
		// values), so no defensive clone is needed. Callers pass data they no
		// longer need, and skipping the copy halves the payload footprint of
		// every bulk post/put.
		const clonedData: (TData & Data) | (TData & Data)[] = data;
		if (Utils.isArrayOfObjects(clonedData))
			return clonedData.map((singleData) =>
				this.formatData(singleData, schema, formatOnlyAvailiableKeys),
			);
		if (Utils.isObject(clonedData)) {
			const RETURN: Record<string, any> = {};
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
		linesNumber?: number[],
		options?: Options,
		prefix?: string,
	): Promise<Record<number, TData & Data>> {
		const RETURN: Record<number, TData & Data> = {};

		// Fast path: read every top-level simple column in one `paste | sed`
		// child process instead of spawning one child process per column.
		// Nested (prefixed) schemas keep the per-column path.
		let batchedKeys: Set<string> | null = null;
		if (!prefix && linesNumber?.length) {
			const simpleFields = schema.filter((field) =>
				this.isSimpleField(field.type),
			);
			const batched = await this.processSimpleFieldsBatch(
				tableName,
				simpleFields,
				linesNumber,
			);
			if (batched) {
				batchedKeys = new Set(simpleFields.map((field) => field.key));
				for (const [line, row] of Object.entries(batched)) {
					if (!RETURN[line]) RETURN[line] = {} as TData & Data;
					Object.assign(RETURN[line], row);
				}
			}
		}

		for (const field of schema) {
			// Batch-read fields were already merged into RETURN.
			if (batchedKeys?.has(field.key)) continue;

			// If the field is of simple type (non-recursive), process it directly
			if (this.isSimpleField(field.type)) {
				await this.processSimpleField(
					tableName,
					field,
					RETURN,
					linesNumber,
					prefix,
				);
			} else if (this.isArrayField(field.type)) {
				// Process array fields (recursive if needed)
				await this.processArrayField(
					tableName,
					field,
					RETURN,
					linesNumber,
					options,
					prefix,
				);
			} else if (this.isObjectField(field.type)) {
				// Process object fields (recursive if needed)
				await this.processObjectField(
					tableName,
					field,
					RETURN,
					linesNumber,
					options,
					prefix,
				);
			} else if (this.isTableField(field.type)) {
				// Process table reference fields
				await this.processTableField(
					tableName,
					field,
					RETURN,
					linesNumber,
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
		RETURN: Record<number, Data>,
		linesNumber?: number[],
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
					globalConfig[this.databasePath].tables?.get(tableName)?.config
						.decodeID
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

	/**
	 * Batched read for top-level simple columns: a single `paste | sed` child
	 * process returns every requested line of every column at once instead of
	 * spawning one `sed`/`gunzip|sed` child process per column. Returning null
	 * (e.g. when any column file is missing, or the shell command fails) makes
	 * the caller fall back to the existing per-column reads.
	 */
	private async processSimpleFieldsBatch(
		tableName: string,
		fields: Field[],
		linesNumber: number[],
	): Promise<Record<number, Record<string, any>> | null> {
		if (!fields.length || !linesNumber.length) return null;

		const decodeID =
			globalConfig[this.databasePath].tables?.get(tableName)?.config
				.decodeID === true;
		// Decode configs are computed once per column (the per-column read path
		// builds one config per file too), not once per cell.
		const cols: {
			path: string;
			key: string;
			config: Field & { databasePath: string };
		}[] = [];
		for (const field of fields) {
			const path = join(
				this.databasePath,
				tableName,
				`${field.key}${this.getFileExtension(tableName)}`,
			);
			if (!(await File.isExists(path))) return null;
			cols.push({
				path,
				key: field.key,
				config: {
					...field,
					type: field.key === "id" && decodeID ? "number" : field.type,
					databasePath: this.databasePath,
				},
			});
		}

		const sortedLines = [...linesNumber].sort((a, b) => a - b);
		const range = File._groupIntoRanges(sortedLines);
		const files = cols.map(({ path }) => File.escapeShellPath(path)).join(" ");
		const isGz = this.getFileExtension(tableName).endsWith(".gz");
		// Each compressed column needs its own process substitution so the
		// streams stay aligned column-by-column inside `paste`.
		const pasteInputs = isGz
			? cols
					.map(({ path }) => `<(gunzip -c ${File.escapeShellPath(path)})`)
					.join(" ")
			: files;
		const command = isGz
			? `bash -c 'paste -d "\\t" ${pasteInputs} | sed -n "${range}"'`
			: `paste -d'\\t' ${files} | sed -n '${range}'`;

		let output: string;
		try {
			output = ((await UtilsServer.exec(command)) as { stdout: string }).stdout;
		} catch {
			return null;
		}

		const outLines = output.trimEnd().split("\n");
		const RETURN: Record<number, Record<string, any>> = {};
		for (let i = 0; i < outLines.length && i < sortedLines.length; i++) {
			const lineNo = sortedLines[i];
			const cells = outLines[i].split("\t");
			const row: Record<string, any> = {};
			let added = false;
			for (let c = 0; c < cols.length; c++) {
				const raw = cells[c];
				if (raw === undefined) continue;
				const value = File.decode(raw, cols[c].config);
				if (value !== undefined) {
					row[cols[c].key] = value;
					added = true;
				}
			}
			if (added) RETURN[lineNo] = row;
		}
		return Object.keys(RETURN).length ? RETURN : null;
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
		RETURN: Record<number, Data>,
		linesNumber?: number[],
		options?: Options,
		prefix?: string,
	) {
		if (Array.isArray(field.children)) {
			if (this.isSimpleField(field.children)) {
				await this.processSimpleField(
					tableName,
					field,
					RETURN,
					linesNumber,
					prefix,
				);
			} else if (this.isTableField(field.children)) {
				await this.processTableField(
					tableName,
					field,
					RETURN,
					linesNumber,
					options,
					prefix,
				);
			} else {
				let _fieldChildren = field.children as Schema;
				// Handling array of objects and filtering nested arrays
				const nestedArrayFields = _fieldChildren.filter(
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
					_fieldChildren = _fieldChildren.filter(
						(children: Field) =>
							!nestedArrayFields.map(({ key }) => key).includes(children.key),
					) as Schema;
				}

				// Process remaining items for the field's children
				const items = await this.processSchemaData(
					tableName,
					_fieldChildren,
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
							// Values without a second per-row tuple array.
							const itemValues = Object.values(item);
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
												RETURN[index][field.key][_i][key] = Array.isArray(
													value[_i],
												)
													? value[_i].filter(Boolean)
													: value[_i];
											}
									}
								}
							}
						} else RETURN[index][field.key] = item;
					}
				}
			}
		} else if (field.children != null && this.isSimpleField(field.children)) {
			// If `children` is FieldType, handle it as an array of simple types (no recursion needed here)
			await this.processSimpleField(
				tableName,
				field,
				RETURN,
				linesNumber,
				prefix,
			);
		} else if (field.children != null && this.isTableField(field.children)) {
			await this.processTableField(
				tableName,
				field,
				RETURN,
				linesNumber,
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
		RETURN: Record<number, Data>,
		linesNumber?: number[],
		options?: Options,
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
		RETURN: Record<number, Data>,
		linesNumber?: number[],
		options?: Options,
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
								perPage: -1,
								columns: (options?.columns as string[] | undefined)
									?.filter((column) => column.includes(`${field.key}.`))
									.map((column) => column.replace(`${field.key}.`, "")),
							},
						);

						const formatLineContent = (
							lineContent?: string | number | (string | number)[],
						): Data | Data[] | string | number | undefined =>
							Array.isArray(lineContent)
								? lineContent
										.map((singleContent) =>
											singleContent
												? Array.isArray(singleContent)
													? singleContent.map(formatLineContent)
													: items?.find(({ id }) => singleContent === id)
												: singleContent,
										)
										.filter((item) => item !== undefined)
								: items?.find(({ id }) => lineContent === id);
						for (const [lineNumber, lineContent] of searchableIDs.entries()) {
							if (!lineContent) continue;
							const formatedLineContent = formatLineContent(lineContent);
							if (
								formatedLineContent &&
								(!Array.isArray(formatedLineContent) ||
									formatedLineContent.length > 0)
							)
								RETURN[lineNumber][field.key] = formatedLineContent;
						}
					}
				}
			}
		}
	}

	private _setNestedKey(obj: any, path: string, value: any): void {
		const keys = path.split(".");
		const lastKey = keys.pop();
		const target = keys.reduce((acc, key) => {
			if (typeof acc[key] !== "object" || acc[key] === null) {
				acc[key] = {};
			}
			return acc[key];
		}, obj);
		if (lastKey !== undefined) target[lastKey] = value;
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

		if (!criteria || Object.keys(criteria).length === 0) return null;

		const criteriaAND = criteria.and;
		if (criteriaAND) delete criteria.and;

		const criteriaOR = criteria.or;
		if (criteriaOR) delete criteria.or;

		const schema =
			globalConfig[this.databasePath].tables?.get(tableName)?.schema ?? [];

		if (Object.keys(criteria).length) {
			if (allTrue === undefined) allTrue = true;

			for await (let [key, value] of Object.entries(criteria)) {
				const field = Utils.getField(key, schema);
				if (!field) continue;

				if (field.table && Utils.isObject(value)) {
					const items = await this.get(field.table, value as Criteria, {
						columns: "id",
						perPage: -1,
					});
					if (items?.length) value = `[]${items.map(({ id }) => id)}`;
					else if (allTrue) return null;
				}

				let searchOperator:
					| ComparisonOperator
					| ComparisonOperator[]
					| undefined;
				let searchComparedAtValue:
					| string
					| number
					| boolean
					| null
					| (string | number | boolean | null)[]
					| undefined;
				let searchLogicalOperator: "and" | "or" | undefined;

				if (Utils.isObject(value)) {
					/* nested object with .and / .or inside */
					const nestedAnd = (value as NonNullable<Criteria>).and;
					const nestedOr = (value as NonNullable<Criteria>).or;
					if (nestedAnd || nestedOr) {
						const logicalChild = nestedAnd ?? nestedOr;
						const logic: "and" | "or" = nestedAnd ? "and" : "or";

						if (logicalChild && !Array.isArray(logicalChild)) {
							const crit = Object.entries(logicalChild)
								.map((item) =>
									typeof item[1] === "string"
										? Utils.FormatObjectCriteriaValue(item[1] as string)
										: ["=", item[1]],
								)
								.filter(Boolean) as [ComparisonOperator, any][];

							if (crit.length) {
								searchOperator = crit.map((c) => c[0]);
								searchComparedAtValue = crit.map((c) => c[1]);
								searchLogicalOperator = logic;
							}
						} else if (Array.isArray(logicalChild)) {
							const crit = (
								logicalChild as (string | number | boolean | null)[]
							)
								.map((item) =>
									typeof item === "string"
										? Utils.FormatObjectCriteriaValue(item)
										: ["=", item],
								)
								.filter(Boolean) as [ComparisonOperator, any][];

							if (crit.length) {
								searchOperator = crit.map((c) => c[0]);
								searchComparedAtValue = crit.map((c) => c[1]);
								searchLogicalOperator = logic;
							}
						}

						delete (value as NonNullable<Criteria>)[logic];
					}
				} else if (typeof value === "string") {
					const [op, val] = Utils.FormatObjectCriteriaValue(value);
					searchOperator = op;
					searchComparedAtValue = val;
				} else {
					searchOperator = "=";
					searchComparedAtValue = value;
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
					(options.perPage ?? 0) < 0 ? undefined : options.perPage,
					(options.perPage ?? 0) < 0
						? undefined
						: ((options.page as number) - 1) * (options.perPage as number) +
								((options.page ?? 1) > 1 ? 1 : 0),
					true,
				);
				if (!searchResult) {
					if (allTrue) return null;
					continue;
				}

				// Merge matched lines into RETURN. The old code round-tripped through
				// Object.entries(...).map(...) + Object.fromEntries, allocating two
				// tuple arrays + a map array per matched row; building the nested
				// result object directly keeps the exact same semantics with less
				// garbage. Note: in `allTrue` mode RETURN is *replaced* per key
				// (searchIn narrowing is what enforces the AND), so the assignment
				// below intentionally mirrors the original replace/merge behavior.
				const formatedSearchResult: Record<string, Data> = {};
				for (const id of Object.keys(searchResult)) {
					const nestedObj: Record<string, any> = {};
					this._setNestedKey(nestedObj, key, searchResult[id]);
					formatedSearchResult[id] = nestedObj;
				}

				RETURN = allTrue
					? formatedSearchResult
					: Utils.deepMerge(RETURN, formatedSearchResult);

				this.totalItems.set(`${tableName}-${key}`, totalLines);

				if (linesNumbers?.size && allTrue) searchIn = linesNumbers;
			}
		}

		if (criteriaAND && Utils.isObject(criteriaAND)) {
			const searchResult = await this.applyCriteria(
				tableName,
				criteriaOR ? { ...(options ?? {}), perPage: -1 } : options,
				criteriaAND as Criteria,
				true,
				searchIn,
			);

			if (searchResult) {
				searchIn = new Set(Object.keys(searchResult).map(Number));
				RETURN = Utils.deepMerge(
					RETURN,
					Object.fromEntries(
						Object.entries(searchResult).filter(
							([_k, v], _i) =>
								Object.keys(v).filter((key) =>
									Object.keys(criteriaAND).find(
										(criteriaKey) =>
											criteriaKey === key || criteriaKey.startsWith(`${key}.`),
									),
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

				// Filter RETURN in place instead of rebuilding it through
				// Object.entries/fromEntries on every OR iteration. The key list of
				// criteriaOR is hoisted out of the per-row check as well.
				const orKeys = Object.keys(criteriaOR);
				for (const id of Object.keys(RETURN)) {
					const item = RETURN[id];
					const matches = Object.keys(item).some(
						(key) =>
							orKeys.includes(key) ||
							orKeys.some((criteriaKey) => criteriaKey.startsWith(`${key}.`)),
					);
					if (!matches) delete RETURN[id];
				}
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
		this.validateName(tableName);

		const cacheFolderPath = join(this.databasePath, tableName, ".cache");
		await rm(cacheFolderPath, { recursive: true, force: true });
		await mkdir(cacheFolderPath);
	}

	/**
	 * Commit a multi-file mutation crash-atomically:
	 * 1. fsync every freshly-written temp file;
	 * 2. write the journal `begin` entry and fsync it;
	 * 3. rename the pagination metadata file first (atomic publication point:
	 *    the row count flips in a single rename, which is what lock-free
	 *    readers observe) and then swap each live file aside (backup) and
	 *    rename the temp into place;
	 * 4. write the journal `commit` marker and fsync it;
	 * 5. discard backups/temps + the journal, fsync the directories.
	 *
	 * On any failure before `commit`, the journal is rolled back so the table
	 * is left exactly as it was. `renameList` entries are [tempPath, livePath]
	 * pairs; a null tempPath means a pure removal (live file taken out).
	 */
	private async commitFiles(
		tablePath: string,
		renameList: (string | null)[][],
		pagination: { from: string; to: string } | null,
	): Promise<void> {
		const txn = randomUUID();
		const ops: JournalFileOp[] = [];
		// Backups are parked in a per-transaction subdirectory
		// (.tmp/backup/<txn>/), so a later transaction can never collide with
		// the leftovers of an earlier crashed one.
		const backupDir = join(tablePath, ".tmp", "backup", txn);
		await mkdir(backupDir, { recursive: true });
		for (const [tmp, live] of renameList) {
			if (!live) continue;
			ops.push({
				live,
				backup: join(backupDir, basename(live)),
				tmp,
				existed: await File.isExists(live),
			});
		}

		const journal = new Journal(tablePath, txn);
		try {
			// Make every replacement durable before it can be published.
			await Promise.allSettled(
				ops
					.filter((op) => op.tmp)
					.map(async (op) => File.syncFile(op.tmp as string)),
			);

			await journal.begin(ops, pagination);

			// Publish: the pagination rename is the atomic publication point
			// (row count flips in one rename) and MUST come first — readers
			// that snapshot file identities detect the flip and retry. Then
			// park each original and move the replacement in.
			if (pagination) await rename(pagination.from, pagination.to);
			for (const op of ops) {
				if (op.existed) await rename(op.live, op.backup);
				if (op.tmp) await rename(op.tmp, op.live);
			}

			await journal.commit();
		} catch (error) {
			await journal.rollback().catch(() => {});
			throw error;
		} finally {
			await Promise.allSettled(
				ops.map((op) => unlink(op.backup).catch(() => {})),
			);
			await rm(backupDir, { recursive: true, force: true }).catch(() => {});
			await journal.dispose();
			await unlink(journal.path).catch(() => {});
			// Make the renames durable before acknowledging the commit.
			await File.syncDir(join(tablePath, ".tmp"));
			await File.syncDir(tablePath);
		}
	}

	/**
	 * Runs crash recovery for a table (and any crashed database transaction)
	 * before a read. Mutation paths get the same guarantee implicitly (the
	 * writer lock runs recovery on acquire); reads call this explicitly
	 * because they never take the table lock.
	 */
	private async ensureTableRecovered(tableName: string): Promise<void> {
		const tablePath = join(this.databasePath, tableName);
		if (await File.isExists(join(tablePath, ".tmp", "journal.jsonl"))) {
			await File.lock(join(tablePath, ".tmp"));
			await File.unlock(join(tablePath, ".tmp"));
		}
		// A database journal exists only while a live transaction holds the
		// database lock, or after one crashed. Recovery must never roll back a
		// live transaction, so acquire the database lock non-blocking here:
		// on success the previous owner is gone (recovery ran); on failure a
		// live transaction owns the lock across processes and readers simply
		// proceed against the committed state.
		const dbTmp = join(this.databasePath, ".tmp");
		if (await File.isExists(join(dbTmp, "journal.jsonl"))) {
			if (await File.tryLock(dbTmp)) await File.unlock(dbTmp);
		}
	}

	/**
	 * Blocking database-journal recovery, used by mutation paths (writers are
	 * serialized with live transactions on the database lock anyway).
	 */
	private async ensureDatabaseRecovered(): Promise<void> {
		const dbTmp = join(this.databasePath, ".tmp");
		if (await File.isExists(join(dbTmp, "journal.jsonl"))) {
			await File.lock(dbTmp);
			await File.unlock(dbTmp);
		}
	}

	private async ensureDatabaseTmpDir(): Promise<void> {
		await mkdir(join(this.databasePath, ".tmp"), { recursive: true });
	}

	/** Staged per-table entry of the open transaction, or null when none. */
	private txnTableEntry(tableName: string): TxnTableEntry | null {
		const txn = this.transaction;
		if (!txn) return null;
		let entry = txn.tables.get(tableName);
		if (!entry) {
			entry = {
				locked: false,
				paginationFrom: "",
				lastId: 0,
				total: 0,
				staged: [],
			};
			txn.tables.set(tableName, entry);
		}
		return entry;
	}

	/** Lock a table for the open transaction (idempotent per transaction). */
	private async ensureTxnLock(tableName: string): Promise<void> {
		const entry = this.txnTableEntry(tableName);
		if (!entry || entry.locked) return;
		await File.lock(join(this.databasePath, tableName, ".tmp"));
		entry.locked = true;
	}

	/**
	 * Resolve the pagination state a DML op should build on. Outside a
	 * transaction this reads the live pagination file (as before); inside a
	 * transaction the first touch reads it once and the entry keeps the staged
	 * id/count so chained ops (guarded to one per table) and commit() stay
	 * consistent without publishing anything early.
	 */
	private async resolvePagination(tableName: string): Promise<{
		filePath: string;
		lastId: number;
		total: number;
	}> {
		const tablePath = join(this.databasePath, tableName);
		const entry = this.txnTableEntry(tableName);
		if (entry?.paginationFrom) {
			return {
				filePath: entry.paginationFrom,
				lastId: entry.lastId,
				total: entry.total,
			};
		}
		let paginationFilePath = "";
		for await (const fileName of glob("*.pagination", { cwd: tablePath }))
			paginationFilePath = join(tablePath, fileName);
		const [lastId, total] = parse(paginationFilePath)
			.name.split("-")
			.map(Number) as [number, number];
		if (entry) {
			entry.paginationFrom = paginationFilePath;
			entry.lastId = lastId;
			entry.total = total;
		}
		return { filePath: paginationFilePath, lastId, total };
	}

	/**
	 * Stage one table mutation into the open transaction: fsync its temps and
	 * append an `op` entry to the database journal (no live file is touched;
	 * commit() performs the actual renames). One staged mutation per table per
	 * transaction (multi-table atomicity; a second touch of the same table
	 * would need read-your-writes composition).
	 */
	private async stageTxnOp(
		tableName: string,
		renameList: (string | null)[][],
		pagination: { from: string; to: string } | null,
	): Promise<void> {
		const txn = this.transaction;
		const entry = this.txnTableEntry(tableName);
		if (!txn || !entry) throw this.createError("INVALID_PARAMETERS");
		if (entry.staged.length) throw this.createError("INVALID_PARAMETERS");
		const backupDir = join(this.databasePath, ".tmp", "backup", txn.id);
		await mkdir(backupDir, { recursive: true });
		const ops: JournalFileOp[] = [];
		for (const [tmp, live] of renameList) {
			if (!live) continue;
			// Benchmarks must be unique within the whole transaction: the same
			// column basename can exist in several tables, and rollback
			// restores by path. Namespace per table (one staged op per table).
			ops.push({
				live,
				backup: join(
					backupDir,
					`${entry.staged.length}-${tableName}-${basename(live)}`,
				),
				tmp,
				existed: await File.isExists(live),
			});
		}
		// Make every replacement durable before the journal records intent.
		await Promise.allSettled(
			ops
				.filter((op) => op.tmp)
				.map(async (op) => File.syncFile(op.tmp as string)),
		);
		await txn.journal.op(ops, pagination);
		entry.staged.push({ ops, pagination });
		if (pagination) entry.paginationFrom = pagination.to;
	}

	/**
	 * Begin a database transaction. Mutations issued while the transaction is
	 * open (post/put/delete, including cascade deletes) are staged into the
	 * database journal and published atomically at commit(); rollback()
	 * discards them without touching any live file.
	 *
	 * @param tables Optional table names to pre-lock at begin() in sorted
	 * order (the deadlock-free way to span tables). Tables not listed are
	 * locked on first touch, in first-touch order.
	 */
	public async begin(tables: string[] = []): Promise<void> {
		if (this.transaction) throw this.createError("INVALID_PARAMETERS");
		await this.ensureDatabaseTmpDir();
		// The database lock is the transaction mutex: it serializes
		// transactions and its acquisition runs crash recovery on any journal
		// left behind by a crashed transaction.
		await File.lock(join(this.databasePath, ".tmp"));
		const uniqueTables = [...new Set(tables)].sort();
		const acquired: string[] = [];
		try {
			// Validate every listed table before locking anything.
			for (const name of uniqueTables) {
				this.validateName(name);
				await this.getTable(name); // throws TABLE_NOT_EXISTS
			}

			const id = randomUUID();
			this.transaction = {
				id,
				journal: new DatabaseJournal(this.databasePath, id),
				tables: new Map(),
			};
			await this.transaction.journal.begin(uniqueTables);

			for (const name of uniqueTables) {
				await File.lock(join(this.databasePath, name, ".tmp"));
				acquired.push(name);
				this.transaction.tables.set(name, {
					locked: true,
					paginationFrom: "",
					lastId: 0,
					total: 0,
					staged: [],
				});
			}
		} catch (error) {
			// Release only the table locks this process actually took (an
			// unlock of a never-acquired path could unlink another process's
			// lock file).
			for (const name of acquired)
				await File.unlock(join(this.databasePath, name, ".tmp")).catch(
					() => {},
				);
			this.transaction = null;
			await File.unlock(join(this.databasePath, ".tmp")).catch(() => {});
			throw error;
		}
	}

	/**
	 * Publish every staged mutation atomically: per table (sorted), the
	 * pagination rename comes first (the atomic publication point readers
	 * observe) and then live->backup + tmp->live swaps, before a single fsynced
	 * `commit` marker makes the whole transaction durable. A crash at any
	 * point is recovered by the journal rule (no marker -> roll back all
	 * tables, marker -> roll forward all tables).
	 */
	public async commit(): Promise<void> {
		const txn = this.transaction;
		if (!txn) throw this.createError("INVALID_PARAMETERS");
		try {
			for (const tableName of [...txn.tables.keys()].sort()) {
				const entry = txn.tables.get(tableName);
				if (!entry) continue;
				for (const { ops, pagination } of entry.staged) {
					if (pagination) await rename(pagination.from, pagination.to);
					for (const op of ops) {
						if (op.existed) await rename(op.live, op.backup);
						if (op.tmp) await rename(op.tmp, op.live);
					}
				}
			}

			await txn.journal.commit();

			// Clean the fast-path leftovers; recovery owns any crash leftovers.
			await txn.journal.dispose();
			await unlink(txn.journal.path).catch(() => {});
			await rm(join(this.databasePath, ".tmp", "backup", txn.id), {
				recursive: true,
				force: true,
			}).catch(() => {});
			await File.syncDir(join(this.databasePath, ".tmp"));
			await File.syncDir(this.databasePath);
			for (const tableName of txn.tables.keys()) {
				await File.syncDir(join(this.databasePath, tableName));
				await File.syncDir(join(this.databasePath, tableName, ".tmp"));
			}
		} catch (error) {
			await txn.journal.rollback().catch(() => {});
			throw error;
		} finally {
			for (const tableName of [...txn.tables.keys()].sort().reverse())
				await File.unlock(join(this.databasePath, tableName, ".tmp"));
			await File.unlock(join(this.databasePath, ".tmp"));
			this.transaction = null;
		}
	}

	/**
	 * Discard the open transaction: temps and the journal are removed and no
	 * live file is touched (nothing is published before commit()).
	 */
	public async rollback(): Promise<void> {
		const txn = this.transaction;
		if (!txn) throw this.createError("INVALID_PARAMETERS");
		try {
			await txn.journal.rollback().catch(() => {});
		} finally {
			for (const tableName of [...txn.tables.keys()].sort().reverse())
				await File.unlock(join(this.databasePath, tableName, ".tmp"));
			await File.unlock(join(this.databasePath, ".tmp"));
			this.transaction = null;
		}
	}

	/**
	 * Snapshot the identity (dev:inode:mtime:size) of every column file and
	 * the pagination file. Reading data and then re-verifying this snapshot
	 * lets lock-free readers detect an in-flight writer commit and retry
	 * instead of returning a torn row set.
	 */
	private async snapshotTableFiles(
		tableName: string,
	): Promise<Map<string, string>> {
		const tablePath = join(this.databasePath, tableName);
		const extension = this.getFileExtension(tableName);
		const snapshot = new Map<string, string>();
		for (const fileName of await readdir(tablePath).catch(() => [])) {
			if (!fileName.endsWith(extension) && !fileName.endsWith(".pagination"))
				continue;
			const filePath = join(tablePath, fileName);
			const fileStat = await stat(filePath).catch(() => null);
			if (fileStat)
				snapshot.set(
					filePath,
					`${fileStat.dev}:${fileStat.ino}:${fileStat.mtimeMs}:${fileStat.size}`,
				);
		}
		return snapshot;
	}

	/** True when every snapshotted file is still present and unchanged. */
	private async verifyTableFiles(
		snapshot: Map<string, string>,
	): Promise<boolean> {
		for (const [filePath, identity] of snapshot) {
			const fileStat = await stat(filePath).catch(() => null);
			if (
				!fileStat ||
				`${fileStat.dev}:${fileStat.ino}:${fileStat.mtimeMs}:${fileStat.size}` !==
					identity
			)
				return false;
		}
		return true;
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
	get<_TData extends Record<string, any> & Partial<Data>>(
		tableName: string,
		where: string | number | (string | number)[] | Criteria | undefined,
		options: Options | undefined,
		onlyOne: false | undefined,
		onlyLinesNumbers: true,
		_whereIsLinesNumbers?: boolean,
	): Promise<number[] | null>;
	get<_TData extends Record<string, any> & Partial<Data>>(
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
		this.validateName(tableName);
		await this.ensureTableRecovered(tableName);

		// Lock-free reads with optimistic retry: snapshot the identity of every
		// column + pagination file, run the read, then verify nothing changed
		// mid-scan. A writer commit flips at least one file identity, so a torn
		// read is detected and re-run instead of being returned.
		for (let attempt = 0; ; attempt++) {
			const snapshot = await this.snapshotTableFiles(tableName);
			const result = await this.getOnce<TData>(
				tableName,
				where,
				options,
				onlyOne,
				onlyLinesNumbers,
				_whereIsLinesNumbers,
			);
			if (attempt === 2 || (await this.verifyTableFiles(snapshot)))
				return result;
		}
	}

	private async getOnce<TData extends Record<string, any> & Partial<Data>>(
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

			this.validateColumns(options.columns);

			if (options.columns.length && !options.columns.includes("id"))
				options.columns.push("id");
		}

		// Default values for page and perPage
		options.columns = options.columns || [];
		options.page = options.page || 1;
		options.perPage = options.perPage || 15;

		let total: number | undefined;
		let RETURN!: (Data & TData) | (Data & TData)[] | null;

		let schema = structuredClone((await this.getTable(tableName))?.schema);

		if (!schema) throw this.createError("NO_SCHEMA", tableName);

		let pagination: [number, number] = [0, 0];
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
			// Criteria. The sort cache is versioned by the pagination row count
			// (see the criteria-cache note) so stale sorted line numbers from
			// before a post/delete are never replayed.
			if (globalConfig[this.databasePath].tables?.get(tableName)?.config.cache)
				cacheKey = UtilsServer.hashString(
					inspect([sortArray, pagination[1]], { sorted: true }),
				);

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
			}
			// perPage < 0 means "no limit": select every line instead of
			// generating an empty awk window (with perPage -1 the old code
			// produced `awk ''`, which prints nothing and the empty stdout
			// decoded into a single hollow row).
			else
				awkCommand =
					options.perPage < 0
						? "awk '1'"
						: `awk '${Array.from(
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

			const _idPrepended = !sortArray.find(([key]) => key === "id");
			const sortColumns = sortArray
				.map(([key, ascending], i) => {
					const field = Utils.getField(key, schema);
					if (!field) return "";
					const colIndex = _idPrepended ? i + 2 : i + 1;
					return `-k${colIndex},${colIndex}${
						Utils.isFieldType(field, ["id", "number", "date"]) ? "n" : ""
					}${!ascending ? "r" : ""}`;
				})
				.join(" ");

			const sortCommand = `sort ${sortColumns} -T='${join(tablePath, ".tmp")}'`;

			try {
				if (cacheKey) await File.lock(join(tablePath, ".tmp"), cacheKey);
				// Combine && Execute the commands synchronously
				let lines = (
					await UtilsServer.exec(
						globalConfig[this.databasePath].tables?.get(tableName)?.config.cache
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

				if (where && options.perPage >= 0)
					lines = lines.slice(
						((options.page as number) - 1) * (options.perPage as number),
						(options.page as number) * (options.perPage as number),
					);
				else if (!where && !this.totalItems.has(`${tableName}-*`))
					this.totalItems.set(`${tableName}-*`, pagination[1]);
				if (!lines.length) return null;

				// Parse the result and extract the specified lines
				const outputArray: (Data & TData)[] = lines.map((line) => {
					const splitedFileColumns = line.split("\t"); // Assuming tab-separated columns
					const outputObject: Record<string, any> = {};

					// Extract values for each file, including `id${this.getFileExtension(tableName)}`
					filesPathes.forEach((fileName, index) => {
						const field = Utils.getField(parse(fileName).name, schema);
						if (field) {
							if (
								field.key === "id" &&
								globalConfig[this.databasePath].tables?.get(tableName)?.config
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
					outputArray
						.map(({ id }) => id)
						.filter((id): id is string | number => id !== undefined),
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
					options.perPage < 0
						? undefined
						: Array.from(
								{ length: options.perPage },
								(_, index) =>
									((options.page as number) - 1) * (options.perPage as number) +
									index +
									1,
							),
					options,
				),
			);

			this.totalItems.set(`${tableName}-id`, pagination[1]);
		} else if (
			((Array.isArray(where) && where.every(Utils.isNumber)) ||
				Utils.isNumber(where)) &&
			(_whereIsLinesNumbers ||
				!globalConfig[this.databasePath].tables?.get(tableName)?.config
					.decodeID)
		) {
			// "where" in this case, is the line(s) number(s) and not id(s)
			let lineNumbers = where as number | number[];
			if (!Array.isArray(lineNumbers)) lineNumbers = [lineNumbers];

			this.totalItems.set(`${tableName}-id`, lineNumbers.length);

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
				globalConfig[this.databasePath].tables?.get(tableName)?.config
					.decodeID &&
				((Array.isArray(where) && where.every(Utils.isNumber)) ||
					Utils.isNumber(where))) ||
			(Array.isArray(where) && where.every(Utils.isValidID)) ||
			Utils.isValidID(where)
		) {
			let Ids = where as string | number | (string | number)[];
			if (!Array.isArray(Ids)) Ids = [Ids];

			// Fast path for decodeID tables whose ids are the dense sequence
			// 1..N: when the requested numeric ids form a duplicate-free
			// consecutive range [min..max] with max within the row count, the
			// line numbers ARE the ids — no id-file scan required.
			let lineNumbers: Record<
				number,
				| number
				| string
				| boolean
				| null
				| undefined
				| (string | number | boolean | null)[]
			> | null = null;
			let countItems = 0;
			const isDecodeID =
				globalConfig[this.databasePath].tables?.get(tableName)?.config
					.decodeID === true &&
				!globalConfig[this.databasePath].tables?.get(tableName)?.config.prepend;
			if (
				isDecodeID &&
				this.idDensity.get(tableName) &&
				Ids.every(Utils.isNumber)
			) {
				const seen = new Set<number>();
				let min = Number.POSITIVE_INFINITY;
				let max = Number.NEGATIVE_INFINITY;
				let distinct = true;
				for (const raw of Ids) {
					const n = Number(raw);
					if (seen.has(n)) {
						distinct = false;
						break;
					}
					seen.add(n);
					if (n < min) min = n;
					if (n > max) max = n;
				}
				if (
					distinct &&
					min >= 1 &&
					max <= pagination[1] &&
					max - min + 1 === Ids.length
				) {
					lineNumbers = {};
					for (let line = min; line <= max; line++) lineNumbers[line] = line;
					countItems = Ids.length;
				}
			}
			if (!lineNumbers) {
				[lineNumbers, countItems] = await File.search(
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
					!this.totalItems.has(`${tableName}-id`),
				);
			}
			if (!lineNumbers) return null;

			this.totalItems.set(`${tableName}-id`, countItems);

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
			if (
				globalConfig[this.databasePath].tables?.get(tableName)?.config.cache
			) {
				// Cache entries are versioned by the pagination row count so a
				// stale cache written before a post/delete (in this process or
				// another) is detectable: the candidate filename simply stops
				// matching and the cache is rebuilt.
				cachedFilePath = join(
					tablePath,
					".cache",
					`${UtilsServer.hashString(inspect(where, { sorted: true }))}-${
						pagination[1]
					}${this.fileExtension}`,
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
					) as any;
				}
			}
			const LineNumberDataObj = await this.applyCriteria<TData>(
				tableName,
				options,
				structuredClone(where) as Criteria,
			);

			if (LineNumberDataObj) {
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
				total = Math.min(
					...[...this.totalItems.entries()]
						.filter(([k]) => k.startsWith(`${tableName}-`))
						.map(([, v]) => v),
				);

				for (const [key] of this.totalItems)
					if (key.startsWith(`${tableName}-`) && key !== `${tableName}-id`)
						this.totalItems.delete(key);

				if (
					globalConfig[this.databasePath].tables?.get(tableName)?.config.cache
				)
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

		if (total === undefined)
			total = this.totalItems.has(`${tableName}-*`)
				? (this.totalItems.get(`${tableName}-*`) ?? 0)
				: Math.max(
						...[...this.totalItems.entries()]
							.filter(([k]) => k.startsWith(`${tableName}-`))
							.map(([, v]) => v),
					);
		this.pageInfo[tableName] = {
			...(({ columns, ...restOfOptions }) => restOfOptions)(options),
			perPage: Array.isArray(RETURN) ? RETURN.length : 1,
			totalPages: options.perPage < 0 ? 1 : Math.ceil(total / options.perPage),
			total,
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
		this.validateName(tableName);

		if (options.columns)
			this.validateColumns(
				(Array.isArray(options.columns)
					? options.columns
					: [options.columns]) as string[],
			);

		const tablePath = join(this.databasePath, tableName);
		if (!this.transaction) await this.ensureDatabaseRecovered();
		await this.getTable(tableName);

		if (!globalConfig[this.databasePath].tables?.get(tableName)?.schema)
			throw this.createError("NO_SCHEMA", tableName);

		if (!returnPostedData) returnPostedData = false;

		let clonedData = structuredClone(data);

		await this.validateTableData(tableName, clonedData);

		const renameList: (string | null)[][] = [];
		let txnStaged = false;
		try {
			// Inside a transaction the table lock is taken once per txn (and
			// held until commit/rollback); otherwise the usual writer lock.
			if (this.transaction) await this.ensureTxnLock(tableName);
			else await File.lock(join(tablePath, ".tmp"));

			const {
				filePath: paginationFilePath,
				lastId,
				total: _totalItems,
			} = await this.resolvePagination(tableName);
			let lastIdValue = lastId;

			if (!this.transaction) this.totalItems.set(`${tableName}-*`, _totalItems);

			if (Utils.isArrayOfObjects(clonedData))
				for (let index = 0; index < clonedData.length; index++) {
					const element = clonedData[index];
					element.id = ++lastIdValue as any;
					element.createdAt = Date.now();
					element.updatedAt = undefined;
				}
			else {
				clonedData.id = ++lastIdValue as any;
				clonedData.createdAt = Date.now();
				clonedData.updatedAt = undefined;
			}

			clonedData = this.formatData<TData>(
				clonedData,
				globalConfig[this.databasePath].tables?.get(tableName)?.schema ?? [],
				false,
			);

			const pathesContents = this.joinPathesContents(
				tableName,
				globalConfig[this.databasePath].tables?.get(tableName)?.config.prepend
					? Array.isArray(clonedData)
						? clonedData.toReversed()
						: clonedData
					: clonedData,
			);

			await Promise.allSettled(
				Object.entries(pathesContents).map(async ([path, content]) =>
					renameList.push(
						globalConfig[this.databasePath].tables?.get(tableName)?.config
							.prepend
							? await File.prepend(path, content)
							: await File.append(path, content),
					),
				),
			);

			const newTotal = _totalItems + (Array.isArray(data) ? data.length : 1);

			const pagination = {
				from: paginationFilePath,
				to: join(tablePath, `${lastIdValue}-${newTotal}.pagination`),
			};

			if (this.transaction) {
				// Stage: journal the intent (fsynced op entry); the live files
				// only change when commit() publishes.
				await this.stageTxnOp(tableName, renameList, pagination);
				txnStaged = true;
				const stagedEntry = this.txnTableEntry(tableName);
				if (stagedEntry) {
					stagedEntry.lastId = lastIdValue;
					stagedEntry.total = newTotal;
				}
			} else {
				// Crash-atomic commit: journal + backup swap + pagination rename.
				await this.commitFiles(tablePath, renameList, pagination);

				this.totalItems.set(`${tableName}-*`, newTotal);

				if (
					globalConfig[this.databasePath].tables?.get(tableName)?.config.cache
				)
					await this.clearCache(tableName);
			}

			if (returnPostedData) {
				if (this.transaction)
					// No read-your-writes yet: return the formatted staged rows
					// (ids + defaults) instead of a committed-state read.
					return (Array.isArray(clonedData) ? clonedData : clonedData) as any;
				return this.get<TData>(
					tableName,
					globalConfig[this.databasePath].tables?.get(tableName)?.config.prepend
						? Array.isArray(clonedData)
							? clonedData.map((_, index) => index + 1).toReversed()
							: 1
						: Array.isArray(clonedData)
							? clonedData
									.map(
										(_, index) =>
											(this.totalItems.get(`${tableName}-*`) ?? 0) - index,
									)
									.toReversed()
							: this.totalItems.get(`${tableName}-*`),
					options,
					!Utils.isArrayOfObjects(clonedData), // return only one item if data is not array of objects
					undefined,
					true,
				);
			}

			return Array.isArray(clonedData)
				? (globalConfig[this.databasePath].tables?.get(tableName)?.config
						.prepend
						? clonedData.toReversed()
						: clonedData
					).map(({ id }) => UtilsServer.encodeID(id as string | number))
				: UtilsServer.encodeID(
						(clonedData as Data & TData).id as string | number,
					);
		} finally {
			if (this.transaction) {
				// Staged temps belong to the journal op; commit()/rollback()
				// owns them. Temps from a failed pre-stage attempt are cleaned
				// here so nothing leaks.
				if (!txnStaged && renameList.length)
					await Promise.allSettled(
						renameList
							.filter((pair): pair is [string, string] => Boolean(pair[1]))
							.map(async ([tempPath, _]) => unlink(tempPath)),
					);
			} else {
				if (renameList.length)
					await Promise.allSettled(
						renameList
							.filter((pair): pair is [string, string] => Boolean(pair[1]))
							.map(async ([tempPath, _]) => unlink(tempPath)),
					);
				await File.unlock(join(tablePath, ".tmp"));
			}
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
	): Promise<(Data & TData) | (Data & TData)[] | null | undefined | undefined> {
		const renameList: (string | null)[][] = [];
		let txnStaged = false;
		this.validateName(tableName);

		if (options.columns)
			this.validateColumns(
				(Array.isArray(options.columns)
					? options.columns
					: [options.columns]) as string[],
			);

		const tablePath = join(this.databasePath, tableName);
		if (!this.transaction) await this.ensureDatabaseRecovered();
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
					clonedData
						.map(({ id }) => id)
						.filter((id): id is string | number => id !== undefined),
					options,
					returnUpdatedData as boolean,
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
					returnUpdatedData as boolean,
				);
			}

			await this.validateTableData(tableName, clonedData, true);

			clonedData = this.formatData<TData>(
				clonedData,
				globalConfig[this.databasePath].tables?.get(tableName)?.schema ?? [],
				true,
			);

			const pathesContents = this.joinPathesContents(tableName, {
				...(({ id, ...restOfData }) => restOfData)(clonedData as TData & Data),
				updatedAt: Date.now(),
			});

			try {
				if (this.transaction) await this.ensureTxnLock(tableName);
				else await File.lock(join(tablePath, ".tmp"));

				const { total } = await this.resolvePagination(tableName);

				await Promise.allSettled(
					Object.entries(pathesContents).map(async ([path, content]) =>
						renameList.push(await File.replace(path, content, total)),
					),
				);

				if (this.transaction) {
					// Stage instead of publishing: row count is unchanged so
					// there is no pagination rename to journal.
					await this.stageTxnOp(tableName, renameList, null);
					txnStaged = true;
				} else {
					// Crash-atomic commit (row count unchanged -> no pagination rename).
					await this.commitFiles(tablePath, renameList, null);

					if (
						globalConfig[this.databasePath].tables?.get(tableName)?.config.cache
					)
						await this.clearCache(tableName);
				}

				if (returnUpdatedData) {
					if (this.transaction)
						// Reading the committed state would miss the staged
						// write (no read-your-writes yet).
						throw this.createError("INVALID_PARAMETERS");
					return await this.get<TData>(tableName, undefined, options);
				}
			} finally {
				if (this.transaction) {
					// Staged temps belong to the journal op; commit()/rollback()
					// owns them.
					if (!txnStaged && renameList.length)
						await Promise.allSettled(
							renameList
								.filter((pair): pair is [string, string] => Boolean(pair[1]))
								.map(async ([tempPath, _]) => unlink(tempPath)),
						);
				} else {
					if (renameList.length)
						await Promise.allSettled(
							renameList
								.filter((pair): pair is [string, string] => Boolean(pair[1]))
								.map(async ([tempPath, _]) => unlink(tempPath)),
						);
					await File.unlock(join(tablePath, ".tmp"));
				}
			}
		} else if (
			((Array.isArray(where) && where.every(Utils.isNumber)) ||
				Utils.isNumber(where)) &&
			(_whereIsLinesNumbers ||
				!globalConfig[this.databasePath].tables?.get(tableName)?.config
					.decodeID)
		) {
			// "where" in this case, is the line(s) number(s) and not id(s)

			await this.validateTableData(tableName, clonedData, true);

			clonedData = this.formatData<TData>(
				clonedData,
				globalConfig[this.databasePath].tables?.get(tableName)?.schema ?? [],
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
						(obj: Record<number, any>, lineNum, index) => {
							obj[lineNum] = Array.isArray(content) ? content[index] : content;
							return obj;
						},
						{},
					),
				]),
			);

			try {
				// One global lock per table serializes every writer; inside a
				// transaction the lock is held for the whole txn.
				if (this.transaction) await this.ensureTxnLock(tableName);
				else await File.lock(join(tablePath, ".tmp"));

				await Promise.allSettled(
					Object.entries(pathesContents).map(async ([path, content]) =>
						renameList.push(await File.replace(path, content)),
					),
				);

				if (this.transaction) {
					await this.stageTxnOp(tableName, renameList, null);
					txnStaged = true;
				} else {
					await this.commitFiles(tablePath, renameList, null);

					if (
						globalConfig[this.databasePath].tables?.get(tableName)?.config.cache
					)
						await this.clearCache(tableName);
				}

				if (returnUpdatedData) {
					if (this.transaction) throw this.createError("INVALID_PARAMETERS");
					return this.get(
						tableName,
						where,
						options,
						!Array.isArray(where),
						undefined,
						true,
					);
				}
			} finally {
				if (this.transaction) {
					if (!txnStaged && renameList.length)
						await Promise.allSettled(
							renameList
								.filter((pair): pair is [string, string] => Boolean(pair[1]))
								.map(async ([tempPath, _]) => unlink(tempPath)),
						);
				} else {
					if (renameList.length)
						await Promise.allSettled(
							renameList
								.filter((pair): pair is [string, string] => Boolean(pair[1]))
								.map(async ([tempPath, _]) => unlink(tempPath)),
						);
					await File.unlock(join(tablePath, ".tmp"));
				}
			}
		} else if (
			(!_whereIsLinesNumbers &&
				globalConfig[this.databasePath].tables?.get(tableName)?.config
					.decodeID &&
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
					// get() with onlyLinesNumbers always returns an array; a
					// single-id update must keep the scalar so the recursive
					// line-numbers branch returns a single row (matching the
					// shape of get(singleId)) instead of a one-element array.
					!Array.isArray(where) && Array.isArray(lineNumbers)
						? lineNumbers[0]
						: lineNumbers,
					options,
					returnUpdatedData as boolean,
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
					returnUpdatedData as boolean,
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
		_cascadeGuard?: Set<string>,
	): Promise<boolean | null> {
		this.validateName(tableName);

		if (!this.transaction) await this.ensureDatabaseRecovered();
		const tablePath = join(this.databasePath, tableName);
		await this.throwErrorIfTableEmpty(tableName);

		if (!where) {
			let txnStaged = false;
			// Crash-atomic truncate: park every column file (pure removal
			// ops) and publish the empty row count in one journaled commit.
			const renameList: (string | null)[][] = [];
			try {
				if (this.transaction) await this.ensureTxnLock(tableName);
				else await File.lock(join(tablePath, ".tmp"));

				const files = (await readdir(tablePath)) ?? [];
				renameList.push(
					...files
						.filter((fileName: string) =>
							fileName.endsWith(this.getFileExtension(tableName)),
						)
						.map((file) => [null, join(tablePath, file)] as (string | null)[]),
				);

				const {
					filePath: paginationFilePath,
					lastId,
					total,
				} = await this.resolvePagination(tableName);

				const pagination = {
					from: paginationFilePath,
					to: join(tablePath, `${lastId}-0.pagination`),
				};

				if (this.transaction) {
					await this.stageTxnOp(tableName, renameList, pagination);
					txnStaged = true;
					const stagedEntry = this.txnTableEntry(tableName);
					if (stagedEntry) stagedEntry.total = 0;
				} else {
					await this.commitFiles(tablePath, renameList, pagination);

					if (
						globalConfig[this.databasePath].tables?.get(tableName)?.config.cache
					)
						await this.clearCache(tableName);
				}

				this.idDensity.set(tableName, true);

				// Deleting every row must also delete rows that reference them.
				if (total) {
					const allLines = Array.from({ length: total }, (_, i) => i + 1);
					await this.cascadeDelete(tableName, allLines, new Set());
				}

				return true;
			} finally {
				if (this.transaction) {
					if (!txnStaged && renameList.length)
						await Promise.allSettled(
							renameList
								.filter((pair): pair is [string, string] => Boolean(pair[1]))
								.map(async ([tempPath, _]) => unlink(tempPath)),
						);
				} else {
					if (renameList.length)
						await Promise.allSettled(
							renameList
								.filter((pair): pair is [string, string] => Boolean(pair[1]))
								.map(async ([tempPath, _]) => unlink(tempPath)),
						);
					await File.unlock(join(tablePath, ".tmp"));
				}
			}
		}
		if (
			((Array.isArray(where) && where.every(Utils.isNumber)) ||
				Utils.isNumber(where)) &&
			(_whereIsLinesNumbers ||
				!globalConfig[this.databasePath].tables?.get(tableName)?.config
					.decodeID)
		) {
			// "where" in this case, is the line(s) number(s) and not id(s)
			const files = (await readdir(tablePath))?.filter((fileName: string) =>
				fileName.endsWith(this.getFileExtension(tableName)),
			);

			if (files.length) {
				const renameList: (string | null)[][] = [];
				let txnStaged = false;
				try {
					if (this.transaction) await this.ensureTxnLock(tableName);
					else await File.lock(join(tablePath, ".tmp"));

					const {
						filePath: paginationFilePath,
						lastId,
						total,
					} = await this.resolvePagination(tableName);

					const remaining = total - (Array.isArray(where) ? where.length : 1);

					if (total && remaining > 0) {
						this.idDensity.set(tableName, false);
						await Promise.allSettled(
							files.map(async (file) =>
								renameList.push(
									await File.remove(join(tablePath, file), where),
								),
							),
						);

						const pagination = {
							from: paginationFilePath,
							to: join(tablePath, `${lastId}-${remaining}.pagination`),
						};
						if (this.transaction) {
							await this.stageTxnOp(tableName, renameList, pagination);
							txnStaged = true;
							const stagedEntry = this.txnTableEntry(tableName);
							if (stagedEntry) stagedEntry.total = remaining;
						} else {
							await this.commitFiles(tablePath, renameList, pagination);
						}
					} else {
						this.idDensity.set(tableName, true);
						// Deleting every remaining row: pure removals.
						const truncateList: (string | null)[][] = (await readdir(tablePath))
							?.filter((fileName: string) =>
								fileName.endsWith(this.getFileExtension(tableName)),
							)
							.map((file) => [null, join(tablePath, file)]);

						const pagination = {
							from: paginationFilePath,
							to: join(tablePath, `${lastId}-0.pagination`),
						};
						if (this.transaction) {
							await this.stageTxnOp(tableName, truncateList, pagination);
							txnStaged = true;
							const stagedEntry = this.txnTableEntry(tableName);
							if (stagedEntry) stagedEntry.total = 0;
						} else {
							await this.commitFiles(tablePath, truncateList, pagination);
						}
					}

					// Cache still describes the committed state while a
					// transaction is open, so only clear it outside one.
					if (
						!this.transaction &&
						globalConfig[this.databasePath].tables?.get(tableName)?.config.cache
					)
						await this.clearCache(tableName);

					// Cascade: rows in other tables referencing the deleted rows
					// (via `table`-typed fields) are removed too.
					await this.cascadeDelete(
						tableName,
						Array.isArray(where) ? where : [where],
						_cascadeGuard ?? new Set(),
					);

					return true;
				} finally {
					if (this.transaction) {
						if (!txnStaged && renameList.length)
							await Promise.allSettled(
								renameList
									.filter((pair): pair is [string, string] => Boolean(pair[1]))
									.map(async ([tempPath, _]) => unlink(tempPath)),
							);
					} else {
						if (renameList.length)
							await Promise.allSettled(
								renameList
									.filter((pair): pair is [string, string] => Boolean(pair[1]))
									.map(async ([tempPath, _]) => unlink(tempPath)),
							);
						await File.unlock(join(tablePath, ".tmp"));
					}
				}
			}
		}
		if (
			(!_whereIsLinesNumbers &&
				globalConfig[this.databasePath].tables?.get(tableName)?.config
					.decodeID &&
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
			// Deleting a non-existent id must not fall through to the
			// "delete all rows" branch (this.delete(_, null, _) would truncate
			// the whole table), so resolve the id to line numbers first and
			// only delegate when something actually matched.
			if (lineNumbers)
				return this.delete(
					tableName,
					lineNumbers,
					true,
					_cascadeGuard ?? new Set(),
				);
			return false;
		}
		if (Utils.isObject(where)) {
			const lineNumbers = await this.get(
				tableName,
				where,
				undefined,
				undefined,
				true,
			);
			if (lineNumbers)
				return this.delete(
					tableName,
					lineNumbers,
					true,
					_cascadeGuard ?? new Set(),
				);
		} else throw this.createError("INVALID_PARAMETERS");
		return false;
	}

	/**
	 * Cascade delete: remove rows in other tables whose `table`-typed schema
	 * fields reference the given rows. Reference columns store the numeric
	 * (line-number) id of the referenced row, so deleted ids are matched
	 * against them directly. Recursion into child tables happens through
	 * `delete` itself (which calls this method again); the `guard` set keeps
	 * deep/cyclic reference chains from re-processing the same (table, line).
	 */
	private async cascadeDelete(
		tableName: string,
		deletedLines: number[],
		guard: Set<string>,
	): Promise<void> {
		if (!deletedLines.length) return;

		for (const line of deletedLines) guard.add(`${tableName}:${line}`);

		const tables = globalConfig[this.databasePath]?.tables;
		if (!tables) return;

		for (const [candidateName, tableData] of tables) {
			if (candidateName === tableName || !tableData?.schema) continue;

			// Only direct `table`-typed columns hold one stored id per row;
			// arrays/objects of table refs serialize differently and are
			// intentionally out of scope for the cascade.
			const refFields = Utils.flattenSchema(tableData.schema, true).filter(
				(field) => field.table === tableName && field.type === "table",
			);
			if (!refFields.length) continue;

			for (const field of refFields) {
				const refPath = join(
					this.databasePath,
					candidateName,
					`${field.key}${this.getFileExtension(candidateName)}`,
				);
				if (!(await File.isExists(refPath))) continue;

				const matching = new Set<number>();
				for (const line of deletedLines) {
					try {
						const [, , found] = await File.search(
							refPath,
							"=",
							line,
							undefined,
							undefined,
							{
								key: field.key,
								type: "number",
								databasePath: this.databasePath,
							},
							undefined,
							undefined,
							false,
						);
						if (found) for (const l of found) matching.add(l);
					} catch (error) {
						// Unreadable/unsupported column -> skip this reference.
						// Inside a transaction a broken reference must abort the
						// whole cascade (all-or-nothing).
						if (this.transaction) throw error;
					}
				}

				const toDelete = [...matching].filter((line) => {
					const key = `${candidateName}:${line}`;
					if (guard.has(key)) return false;
					guard.add(key);
					return true;
				});
				if (!toDelete.length) continue;

				try {
					await this.delete(candidateName, toDelete, true, guard);
				} catch (error) {
					// Cascade is best-effort outside a transaction: never break
					// the parent delete. Inside a transaction a cascade failure
					// must abort the whole txn (all-or-nothing).
					if (this.transaction) throw error;
				}
			}
		}
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
		this.validateName(tableName);

		if (!Array.isArray(columns)) columns = [columns];
		for (const column of columns) this.validateName(column);

		await this.throwErrorIfTableEmpty(tableName);
		const RETURN: Record<string, number> = {};
		const tablePath = join(this.databasePath, tableName);

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
		return columns.length > 1 ? RETURN : Object.values(RETURN)[0];
	}

	/**
	 * Generate average of column(s) in a table
	 *
	 * @param {string} tableName
	 * @param {string} columns
	 * @param {(number | string | (number | string)[] | Criteria)} [where]
	 * @return {*}  {Promise<number | Record<string, number>>}
	 */
	avg(
		tableName: string,
		columns: string,
		where?: number | string | (number | string)[] | Criteria,
	): Promise<number>;
	avg(
		tableName: string,
		columns: string[],
		where?: number | string | (number | string)[] | Criteria,
	): Promise<Record<string, number>>;
	public async avg(
		tableName: string,
		columns: string | string[],
		where?: number | string | (number | string)[] | Criteria,
	): Promise<number | Record<string, number>> {
		this.validateName(tableName);

		if (!Array.isArray(columns)) columns = [columns];
		for (const column of columns) this.validateName(column);

		await this.throwErrorIfTableEmpty(tableName);
		const RETURN: Record<string, number> = {};
		const tablePath = join(this.databasePath, tableName);

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
						? await File.avg(columnPath, lineNumbers)
						: 0;
				} else RETURN[column] = await File.avg(columnPath);
			}
		}
		return columns.length > 1 ? RETURN : Object.values(RETURN)[0];
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
		this.validateName(tableName);

		if (!Array.isArray(columns)) columns = [columns];
		for (const column of columns) this.validateName(column);

		const RETURN: Record<string, number> = {};
		const tablePath = join(this.databasePath, tableName);
		await this.throwErrorIfTableEmpty(tableName);

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
		this.validateName(tableName);

		if (!Array.isArray(columns)) columns = [columns];
		for (const column of columns) this.validateName(column);

		const RETURN: Record<string, number> = {};
		const tablePath = join(this.databasePath, tableName);
		await this.throwErrorIfTableEmpty(tableName);

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
