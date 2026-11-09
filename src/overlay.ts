import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DiskOverlay } from "./disk-overlay.js";
import { resourcesFor } from "./resources.js";
import {
	DEFAULT_MAX_FRAME_BYTES,
	encodeFrame,
	type LogCursor,
	type ScanResult,
	type UpdateFrame,
	UpdateLog,
} from "./updatelog.js";

/**
 * In-memory view of a table's update log: `internalId -> { cols, updatedAt }`.
 *
 * `cols` holds the *encoded* column values exactly as `joinPathesContents`
 * produces them (one entry per changed top-level column), so a merged read can
 * decode them with the same field config as the base columns. The overlay is
 * keyed by the internal numeric id, which is stable across line shifts caused
 * by `post`/`delete`, so it never has to be rebuilt when rows move.
 *
 * Freshness: `refresh()` compares the log's size and mtime with the last scan.
 * A change means another writer appended (or truncated) and the overlay is
 * rebuilt from `baseGen + 1`. `baseGen` is pinned by the caller from the
 * table's `.format` marker; a compaction (3.9) bumps it and the caller creates
 * a fresh overlay.
 */
export class TableOverlay {
	readonly log: UpdateLog;
	readonly baseGen: number;
	committedGen: number;
	deletedCount = 0;
	readonly columns = new Set<string>();
	readonly byId: DiskOverlay;
	private scannedSize = -1;
	private scannedStamp = "";
	private scannedIdentity = "";
	private cursor: LogCursor = { offset: 0 };
	private tornTail = false;
	private refreshing: Promise<void> = Promise.resolve();
	/** Diagnostic counters: cumulative work, not an estimate from wall time. */
	readonly replayStats = { frames: 0, bytes: 0, rebuilds: 0 };

	constructor(
		tablePath: string,
		baseGen: number,
		readonly tombstones = false,
	) {
		this.log = new UpdateLog(tablePath);
		this.byId = new DiskOverlay(tablePath, resourcesFor(dirname(tablePath)));
		this.baseGen = baseGen;
		this.committedGen = baseGen;
	}

	get size() {
		return this.byId.size;
	}

	get(id: string | number) {
		return this.byId.get(String(id));
	}

	/** Fold one committed frame onto the in-memory view (last write wins). */
	async applyFrame(frame: UpdateFrame): Promise<void> {
		for (const record of frame.records) {
			if (record.deleted && !this.tombstones)
				throw new Error("UNSUPPORTED_FORMAT: tombstone in format-2 log");
			const key = String(record.id);
			const previous = await this.byId.get(key);
			for (const column of Object.keys(record.cols)) this.columns.add(column);
			const deleted = record.deleted === true || previous?.deleted === true;
			if (deleted && !previous?.deleted) this.deletedCount++;
			await this.byId.set(key, {
				cols: deleted ? {} : { ...(previous?.cols ?? {}), ...record.cols },
				updatedAt: record.updatedAt,
				...(deleted ? { deleted: true } : {}),
			});
		}
		this.committedGen = frame.gen;
	}

	private async currentStat(): Promise<{
		size: number;
		stamp: string;
		identity: string;
	}> {
		try {
			const stats = await stat(this.log.path, { bigint: true });
			return {
				size: Number(stats.size),
				stamp: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`,
				identity: `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`,
			};
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
			return { size: 0, stamp: "missing", identity: "missing" };
		}
	}

	private serialize(fn: () => Promise<void>): Promise<void> {
		const next = this.refreshing.catch(() => {}).then(fn);
		this.refreshing = next;
		return next;
	}

	private async refreshCore(forWrite: boolean): Promise<void> {
		const before = await this.currentStat();
		if (before.stamp === this.scannedStamp && !(forWrite && this.tornTail))
			return;
		const incremental =
			this.scannedSize >= 0 &&
			!this.tornTail &&
			before.identity === this.scannedIdentity &&
			before.size > this.scannedSize &&
			(await this.log.validateCursor(this.cursor));
		if (!incremental) {
			await this.byId.clear();
			this.committedGen = this.baseGen;
			this.deletedCount = 0;
			this.columns.clear();
			this.cursor = { offset: 0 };
			this.replayStats.rebuilds++;
		}
		const start = this.cursor.offset;
		let result: ScanResult;
		try {
			const consume = (frame: UpdateFrame) => this.applyFrame(frame);
			result = forWrite
				? await this.log.repairTail(
						this.committedGen + 1,
						DEFAULT_MAX_FRAME_BYTES,
						consume,
						this.cursor,
					)
				: await this.log.scan(
						this.committedGen + 1,
						DEFAULT_MAX_FRAME_BYTES,
						consume,
						this.cursor,
					);
		} catch (error) {
			// A failed scan must not make a partial view appear fresh.
			this.scannedSize = -1;
			this.scannedStamp = "";
			throw error;
		}
		this.cursor = { offset: result.committedBytes, anchor: result.anchor };
		this.tornTail = result.tornTail && !forWrite;
		this.replayStats.frames += result.frameCount;
		this.replayStats.bytes += result.committedBytes - start;
		const after = await this.currentStat();
		// Do not mark bytes appended during a reader scan as already consumed.
		const stable = forWrite || before.stamp === after.stamp;
		this.scannedSize = stable ? after.size : result.committedBytes;
		this.scannedStamp = stable ? after.stamp : "";
		this.scannedIdentity = after.identity;
	}

	/**
	 * Reader refresh: rebuild only when the log file changed since the last
	 * scan. Both size *and* mtime are compared: a repaired torn tail followed by
	 * a same-size append (truncate + regrow) changes mtime even when the length
	 * is unchanged, which closes the stale-size window flagged in the plan. A
	 * torn tail is ignored (only complete, checksum-valid frames are applied);
	 * mid-log corruption is surfaced by the scanner.
	 */
	async refresh(): Promise<void> {
		return this.serialize(() => this.refreshCore(false));
	}

	/**
	 * Writer refresh: hold the table lock, repair any torn tail, then rebuild
	 * from the committed boundary. Never leaves unreadable bytes behind the
	 * next frame.
	 */
	async refreshForWrite(): Promise<void> {
		return this.serialize(() => this.refreshCore(true));
	}

	/**
	 * Apply frames that were just durably appended by this process without a
	 * rescan, and realign the scanned stat with the file. Only valid right after
	 * `refreshForWrite()` and while still holding the writer lock.
	 */
	async applyLocal(frames: UpdateFrame[]): Promise<void> {
		return this.serialize(async () => {
			try {
				for (const frame of frames) {
					// Another same-process reader may already have consumed this frame.
					if (frame.gen <= this.committedGen) continue;
					const encoded = encodeFrame(frame);
					this.cursor.anchor = {
						offset: this.cursor.offset,
						header: encoded.subarray(0, 8).toString("hex"),
					};
					this.cursor.offset += encoded.length;
					await this.applyFrame(frame);
				}
				const current = await this.currentStat();
				this.scannedSize = current.size;
				this.scannedStamp = current.stamp;
				this.scannedIdentity = current.identity;
				this.tornTail = false;
			} catch (error) {
				// The durable append can succeed while rebuilding scratch fails.
				// The cursor may already have advanced: never trust that partial
				// overlay on retry. Rebuild from the authoritative log instead.
				this.scannedSize = -1;
				this.scannedStamp = "";
				throw error;
			}
		});
	}

	async dispose(): Promise<void> {
		await this.refreshing.catch(() => {});
		await this.byId.clear();
	}
}
