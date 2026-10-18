import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

export const fields = ["seq", "key", "title", "category", "body", "score"];
export const values = (row) => fields.map((field) => row[field]);
const schema = fields.map((key) => ({
	key,
	type: ["seq", "score"].includes(key) ? "number" : "string",
	required: true,
}));
const definitions =
	"seq INTEGER PRIMARY KEY, key TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL, body TEXT NOT NULL, score INTEGER NOT NULL";
// All table/column names below are fixed benchmark identifiers, never user input.
export async function adapter(options) {
	const { engine, directory, modulePath, socket, budget } = options;
	if (engine === "inibase") {
		const Engine = (await import(pathToFileURL(modulePath))).default;
		let db;
		return {
			async open() {
				db = new Engine("db", directory);
			},
			async close() {
				await db?.close();
			},
			async create(table) {
				await db.createTable(table, schema, {
					compression: true,
					decodeID: true,
					cache: false,
				});
			},
			async insert(table, rows) {
				await db.post(table, rows);
			},
			async all(columns = fields) {
				return (
					(await db.get("records", undefined, {
						perPage: -1,
						columns: [...columns],
					})) ?? []
				);
			},
			async point(key) {
				return (await db.get("records", { key }, { perPage: -1 }))?.[0];
			},
			async filter(category) {
				return (await db.get("records", { category }, { perPage: -1 })) ?? [];
			},
			async update(key, score) {
				await db.put("records", { score }, { key });
			},
			async remove(key) {
				await db.delete("records", { key });
			},
			async index() {
				await db.optimize("records", { indexes: ["key"] });
			},
			async maintain() {
				await db.compact("records");
			},
			async transaction(callback) {
				return db.transaction(["records"], callback);
			},
			async info() {
				return { memory: db?.memoryUsage() ?? null, modulePath };
			},
		};
	}
	if (engine === "sqlite") {
		const { DatabaseSync } = await import("node:sqlite");
		let db;
		return {
			async open() {
				db = new DatabaseSync(join(directory, "db.sqlite"), {
					timeout: options.busyTimeout ?? 0,
				});
				db.exec(
					`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-${Math.floor(budget / 1024)}`,
				);
			},
			async close() {
				db?.close();
				db = null;
			},
			async create(table) {
				db.exec(`CREATE TABLE ${table} (${definitions})`);
			},
			async insert(table, rows) {
				const statement = db.prepare(
					`INSERT INTO ${table} VALUES (?,?,?,?,?,?)`,
				);
				db.exec("BEGIN");
				try {
					for (const row of rows) statement.run(...values(row));
					db.exec("COMMIT");
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			},
			async all(columns = fields) {
				return db.prepare(`SELECT ${columns.join(",")} FROM records`).all();
			},
			async point(key) {
				return db.prepare("SELECT * FROM records WHERE key=?").get(key);
			},
			async filter(category) {
				return db
					.prepare("SELECT * FROM records WHERE category=?")
					.all(category);
			},
			async update(key, score) {
				db.prepare("UPDATE records SET score=? WHERE key=?").run(score, key);
			},
			async remove(key) {
				db.prepare("DELETE FROM records WHERE key=?").run(key);
			},
			async index() {
				db.exec("CREATE INDEX records_key ON records(key)");
			},
			async maintain() {
				db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			},
			async transaction(callback) {
				db.exec("BEGIN");
				try {
					const result = await callback();
					db.exec("COMMIT");
					return result;
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			},
			async info() {
				return {
					sqlite: process.versions.sqlite,
					settings: Object.fromEntries(
						[
							"journal_mode",
							"synchronous",
							"fullfsync",
							"cache_size",
							"page_size",
							"mmap_size",
						].map((key) => [key, db.prepare(`PRAGMA ${key}`).get()]),
					),
				};
			},
		};
	}
	if (engine !== "postgres") throw new Error(`Unknown engine: ${engine}`);
	let client;
	const query = async (text, parameters) => client.query(text, parameters);
	return {
		async open() {
			client = new pg.Client({
				host: socket,
				port: 55432,
				user: "benchmark",
				database: "postgres",
				application_name: "inibase-qualification",
			});
			await client.connect();
		},
		async close() {
			await client?.end();
			client = null;
		},
		async create(table) {
			await query(`CREATE TABLE ${table} (${definitions})`);
		},
		async insert(table, rows) {
			const parameters = rows.flatMap(values);
			const placeholders = rows
				.map(
					(_, i) =>
						`(${fields.map((_, j) => `$${i * fields.length + j + 1}`).join(",")})`,
				)
				.join(",");
			await query(`INSERT INTO ${table} VALUES ${placeholders}`, parameters);
		},
		async all(columns = fields) {
			return (await query(`SELECT ${columns.join(",")} FROM records`)).rows;
		},
		async point(key) {
			return (await query("SELECT * FROM records WHERE key=$1", [key])).rows[0];
		},
		async filter(category) {
			return (
				await query("SELECT * FROM records WHERE category=$1", [category])
			).rows;
		},
		async update(key, score) {
			await query("UPDATE records SET score=$1 WHERE key=$2", [score, key]);
		},
		async remove(key) {
			await query("DELETE FROM records WHERE key=$1", [key]);
		},
		async index() {
			await query("CREATE INDEX records_key ON records(key)");
			await query("ANALYZE records");
		},
		async maintain() {
			await query("VACUUM (ANALYZE) records");
			await query("CHECKPOINT");
		},
		async transaction(callback) {
			await query("BEGIN");
			try {
				const result = await callback();
				await query("COMMIT");
				return result;
			} catch (error) {
				await query("ROLLBACK");
				throw error;
			}
		},
		async info() {
			return {
				version: (await query("SELECT version() AS version")).rows[0].version,
				settings: (
					await query(
						"SELECT name,setting,unit FROM pg_settings WHERE name = ANY($1::text[]) ORDER BY name",
						[
							[
								"fsync",
								"synchronous_commit",
								"full_page_writes",
								"wal_sync_method",
								"shared_buffers",
								"work_mem",
								"temp_buffers",
								"maintenance_work_mem",
								"autovacuum",
								"max_connections",
								"data_checksums",
								"listen_addresses",
								"track_io_timing",
							],
						],
					)
				).rows,
				database: (
					await query(
						"SELECT pg_database_size(current_database()) AS bytes, pg_total_relation_size('records') AS records_bytes",
					)
				).rows[0],
				io: (await query("SELECT * FROM pg_stat_io")).rows,
				wal: (await query("SELECT * FROM pg_stat_wal")).rows,
			};
		},
	};
}
