import {
	type FileHandle,
	open,
	readFile,
	rename,
	rmdir,
	unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

// Durability mirror of src/file.ts (kept local to avoid an ESM import cycle:
// file.ts imports recover() from here). `none` skips fsyncs, `full` fsyncs
// journal appends, recoveries and directory touches.
const DURABLE = (process.env.INIBASE_DURABILITY ?? "full") !== "none";

const maybeSync = async (handle: FileHandle): Promise<void> => {
	if (DURABLE) await handle.sync();
};

/**
 * Write-ahead journal for crash-atomic, multi-file commits.
 *
 * A transaction writes its intent to `journal.jsonl` (fsynced) before touching
 * any live file, then swaps each live file aside (see `backup`), renames the
 * freshly-written temp file into place, optionally renames the pagination
 * metadata file, and finally appends a `commit` marker (fsynced).
 *
 * Two journal layouts share one recovery rule:
 * - single-table ops: one `begin` entry carrying `files` + `pagination`;
 * - database transactions: a `begin` entry (tables only) followed by one `op`
 *   entry per staged mutation (`files` + optional `pagination`), then `commit`.
 *
 * Recovery rule (run under the lock before any access):
 * - journal without `commit`  -> roll back (restore backups, undo pagination,
 *   discard temps);
 * - journal with `commit`     -> roll forward (complete swaps, discard backups).
 *
 * After recovery the journal is removed, so a logical operation spanning many
 * column files + pagination (single- or multi-table) is atomic w.r.t. crashes.
 */

export interface JournalFileOp {
	/** Absolute path of the live file being replaced or removed. */
	live: string;
	/** Absolute path where the original file is parked while the swap is in flight. */
	backup: string;
	/** Absolute path of the fully-written replacement, or null for pure removals. */
	tmp: string | null;
	/** Whether the live file existed when the transaction began. */
	existed: boolean;
}

export interface JournalBeginEntry {
	txn: string;
	type: "begin";
	/** Tables touched by a database transaction (single-table ops omit this). */
	tables?: string[];
	/** Single-table ops carry their intent directly on the begin entry. */
	files?: JournalFileOp[];
	/** Old/new absolute pagination file paths, or null when counts don't change. */
	pagination?: { from: string; to: string } | null;
}

export interface JournalOpEntry {
	txn: string;
	type: "op";
	files: JournalFileOp[];
	/** Old/new absolute pagination file paths, or null when counts don't change. */
	pagination?: { from: string; to: string } | null;
}

export interface JournalCommitEntry {
	txn: string;
	type: "commit";
}

export type JournalEntry =
	| JournalBeginEntry
	| JournalOpEntry
	| JournalCommitEntry;

const exists = async (path: string): Promise<boolean> => {
	try {
		const handle = await open(path, "r");
		await handle.close();
		return true;
	} catch {
		return false;
	}
};

const syncDir = async (path: string): Promise<void> => {
	let handle: FileHandle | null = null;
	try {
		handle = await open(path, "r");
		await maybeSync(handle);
	} catch {
		// Directory fsync is not supported on every platform/filesystem.
	} finally {
		await handle?.close();
	}
};

/** Parse every journal entry; partial trailing lines (crash mid-append) are ignored. */
const readEntries = async (journalPath: string): Promise<JournalEntry[]> => {
	let content: string;
	try {
		content = await readFile(journalPath, "utf8");
	} catch {
		return [];
	}
	const entries: JournalEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line) continue;
		try {
			entries.push(JSON.parse(line) as JournalEntry);
		} catch {
			// Partial trailing line: the append that wrote it was never
			// fsynced, so the transaction never reached its `commit` marker.
		}
	}
	return entries;
};

const readBegin = async (
	journalPath: string,
): Promise<JournalBeginEntry | null> => {
	for (const entry of await readEntries(journalPath))
		if (entry.type === "begin") return entry;
	return null;
};

/** Flatten begin/op entries into ordered file ops and pagination renames. */
const collectOps = (
	entries: JournalEntry[],
): { ops: JournalFileOp[]; paginations: { from: string; to: string }[] } => {
	const ops: JournalFileOp[] = [];
	const paginations: { from: string; to: string }[] = [];
	for (const entry of entries) {
		if (entry.type === "commit") continue;
		if (entry.files?.length) ops.push(...entry.files);
		if (entry.pagination) paginations.push(entry.pagination);
	}
	return { ops, paginations };
};

/**
 * Undo an uncommitted transaction (in reverse order so chained pagination
 * renames and repeated swaps of the same live file unwind correctly), discard
 * temps and backups, and fsync the affected directories.
 */
const applyRollback = async (
	ops: JournalFileOp[],
	paginations: { from: string; to: string }[],
): Promise<void> => {
	for (const op of ops.toReversed()) {
		if (op.existed && (await exists(op.backup))) {
			await unlink(op.live).catch(() => {});
			await rename(op.backup, op.live);
		} else if (!op.existed) {
			await unlink(op.live).catch(() => {});
		}
		if (op.tmp) await unlink(op.tmp).catch(() => {});
		await unlink(op.backup).catch(() => {});
		// Drop the per-txn backup subdirectory once it is empty.
		await rmEmptyDir(dirname(op.backup));
	}
	for (const { from, to } of paginations.toReversed())
		if ((await exists(to)) && !(await exists(from))) await rename(to, from);
};

/** Complete a committed transaction: finish any missing swaps, drop backups. */
const applyRollForward = async (
	ops: JournalFileOp[],
	paginations: { from: string; to: string }[],
): Promise<void> => {
	for (const op of ops) {
		if (op.tmp && !(await exists(op.live)) && (await exists(op.tmp)))
			await rename(op.tmp, op.live);
		await unlink(op.backup).catch(() => {});
		if (op.tmp) await unlink(op.tmp).catch(() => {});
		await rmEmptyDir(dirname(op.backup));
	}
	for (const { from, to } of paginations)
		if ((await exists(from)) && !(await exists(to))) await rename(from, to);
};

/** Best-effort removal of an empty directory (per-txn backup dir). */
const rmEmptyDir = async (dirPath: string): Promise<void> => {
	try {
		await rmdir(dirPath);
	} catch {
		// Not empty or already gone: leave it.
	}
};

export class Journal {
	readonly path: string;
	private readonly txn: string;
	private handle: FileHandle | null = null;

	constructor(tablePath: string, txn: string) {
		this.txn = txn;
		this.path = join(tablePath, ".tmp", "journal.jsonl");
	}

	private async openJournal(): Promise<void> {
		if (!this.handle) this.handle = await open(this.path, "a+");
	}

	private async append(entry: JournalEntry): Promise<void> {
		await this.openJournal();
		const handle = this.handle;
		if (!handle) throw new Error("JOURNAL_NOT_OPEN");
		await handle.writeFile(`${JSON.stringify(entry)}\n`);
		await maybeSync(handle);
	}

	async begin(
		files: JournalFileOp[],
		pagination: JournalBeginEntry["pagination"] = null,
	): Promise<void> {
		await this.append({ txn: this.txn, type: "begin", files, pagination });
	}

	async commit(): Promise<void> {
		await this.append({ txn: this.txn, type: "commit" });
	}

	/**
	 * Undo an in-flight transaction whose `commit` marker was never written.
	 * Restores originals from backups, undoes the pagination rename (if any),
	 * removes created files and leftovers, then discards the journal.
	 */
	async rollback(): Promise<void> {
		try {
			const begin = await readBegin(this.path);
			if (!begin) return;
			const { ops, paginations } = collectOps([begin]);
			await applyRollback(ops, paginations);
		} finally {
			await this.dispose();
			await unlink(this.path).catch(() => {});
		}
	}

	async dispose(): Promise<void> {
		await this.handle?.close();
		this.handle = null;
	}
}

/**
 * Write-ahead journal for a database-level transaction spanning multiple
 * tables. Holds `begin(tables)` once, then one `op` per staged mutation, and
 * finally a single `commit` marker. Lives in `<database>/.tmp/journal.jsonl`
 * next to the per-table `.tmp` directories.
 */
export class DatabaseJournal {
	readonly path: string;
	private readonly txn: string;
	private handle: FileHandle | null = null;

	constructor(dbPath: string, txn: string) {
		this.txn = txn;
		this.path = join(dbPath, ".tmp", "journal.jsonl");
	}

	private async openJournal(): Promise<void> {
		if (!this.handle) this.handle = await open(this.path, "a+");
	}

	private async append(entry: JournalEntry): Promise<void> {
		await this.openJournal();
		const handle = this.handle;
		if (!handle) throw new Error("JOURNAL_NOT_OPEN");
		await handle.writeFile(`${JSON.stringify(entry)}\n`);
		await maybeSync(handle);
	}

	async begin(tables: string[]): Promise<void> {
		await this.append({ txn: this.txn, type: "begin", tables });
	}

	async op(
		files: JournalFileOp[],
		pagination: JournalOpEntry["pagination"] = null,
	): Promise<void> {
		await this.append({ txn: this.txn, type: "op", files, pagination });
	}

	async commit(): Promise<void> {
		await this.append({ txn: this.txn, type: "commit" });
	}

	/**
	 * Undo the transaction: restore any published files (crash mid-commit in
	 * the same process — callers normally roll back before anything is
	 * published), discard temps/journals. Handles the un-published case
	 * identically (no backups exist -> restores are no-ops).
	 */
	async rollback(): Promise<void> {
		try {
			const { ops, paginations } = collectOps(await readEntries(this.path));
			await applyRollback(ops, paginations);
		} finally {
			await this.dispose();
			await unlink(this.path).catch(() => {});
		}
	}

	async dispose(): Promise<void> {
		await this.handle?.close();
		this.handle = null;
	}
}

/**
 * Recover from a crash. `tmpDirPath` is a `.tmp` directory (a table's or the
 * database's) where `journal.jsonl` lives, in either single-table or
 * database-transaction layout. Entries carry absolute paths, so no other
 * context is needed. Must be called while holding the corresponding lock so no
 * live writer can interleave.
 */
export async function recover(tmpDirPath: string): Promise<void> {
	const journalPath = join(tmpDirPath, "journal.jsonl");
	const entries = await readEntries(journalPath);
	if (!entries.length) return; // no journal -> nothing to recover

	const begin = entries.find(
		(entry): entry is JournalBeginEntry => entry.type === "begin",
	);
	if (!begin) {
		// Journal exists but its begin entry never became durable: no rename
		// was performed, so the live files are untouched. Discard the journal.
		await unlink(journalPath).catch(() => {});
		return;
	}

	const committed = entries.some((entry) => entry.type === "commit");
	const { ops, paginations } = collectOps(entries);

	if (committed) {
		// Roll forward: every rename already happened before `commit` was
		// written; just make sure swaps completed and discard the backups.
		await applyRollForward(ops, paginations);
	} else {
		// Roll back: restore originals, undo pagination renames, remove files
		// the transaction created and discard every leftover.
		await applyRollback(ops, paginations);
	}

	await unlink(journalPath).catch(() => {});
	await syncDir(tmpDirPath);
	await syncDir(dirname(tmpDirPath));
}
