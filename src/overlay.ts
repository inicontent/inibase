import { stat } from "node:fs/promises";
import {
	DEFAULT_MAX_FRAME_BYTES,
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
	readonly byId = new Map<
		string,
		{ cols: Record<string, unknown>; updatedAt?: number }
	>();
	private scannedSize = -1;
	private scannedMtimeMs = -1;

	constructor(tablePath: string, baseGen: number) {
		this.log = new UpdateLog(tablePath);
		this.baseGen = baseGen;
		this.committedGen = baseGen;
	}

	get size() {
		return this.byId.size;
	}

	get(id: string | number) {
		return this.byId.get(String(id));
	}

	has(id: string | number) {
		return this.byId.has(String(id));
	}

	delete(id: string | number) {
		return this.byId.delete(String(id));
	}

	/** Fold one committed frame onto the in-memory view (last write wins). */
	applyFrame(frame: UpdateFrame) {
		for (const record of frame.records) {
			const key = String(record.id);
			const previous = this.byId.get(key);
			this.byId.set(key, {
				cols: { ...(previous?.cols ?? {}), ...record.cols },
				updatedAt: record.updatedAt,
			});
		}
		this.committedGen = frame.gen;
	}

	private async currentStat(): Promise<{ size: number; mtimeMs: number }> {
		try {
			const stats = await stat(this.log.path);
			return { size: stats.size, mtimeMs: stats.mtimeMs };
		} catch {
			return { size: 0, mtimeMs: 0 };
		}
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
		const { size, mtimeMs } = await this.currentStat();
		if (size === this.scannedSize && mtimeMs === this.scannedMtimeMs) return;
		this.byId.clear();
		this.committedGen = this.baseGen;
		await this.log.scan(this.baseGen + 1, DEFAULT_MAX_FRAME_BYTES, (frame) =>
			this.applyFrame(frame),
		);
		this.scannedSize = size;
		this.scannedMtimeMs = mtimeMs;
	}

	/**
	 * Writer refresh: hold the table lock, repair any torn tail, then rebuild
	 * from the committed boundary. Never leaves unreadable bytes behind the
	 * next frame.
	 */
	async refreshForWrite(): Promise<void> {
		this.byId.clear();
		this.committedGen = this.baseGen;
		await this.log.repairTail(
			this.baseGen + 1,
			DEFAULT_MAX_FRAME_BYTES,
			(frame) => this.applyFrame(frame),
		);
		const { size, mtimeMs } = await this.currentStat();
		this.scannedSize = size;
		this.scannedMtimeMs = mtimeMs;
	}

	/**
	 * Apply frames that were just durably appended by this process without a
	 * rescan, and realign the scanned stat with the file. Only valid right after
	 * `refreshForWrite()` and while still holding the writer lock.
	 */
	async applyLocal(frames: UpdateFrame[]): Promise<void> {
		for (const frame of frames) this.applyFrame(frame);
		const { size, mtimeMs } = await this.currentStat();
		this.scannedSize = size;
		this.scannedMtimeMs = mtimeMs;
	}
}
