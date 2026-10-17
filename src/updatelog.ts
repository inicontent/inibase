import { randomUUID } from "node:crypto";
import {
	copyFile,
	type FileHandle,
	open,
	stat,
	unlink,
} from "node:fs/promises";
import { join } from "node:path";
import * as zlib from "node:zlib";

/**
 * Append-only update log for incremental `put` writes.
 *
 * A table with the format-2 update log stores base columns exactly as before
 * (`.txt` / `.gz`) plus one `updates.log` file in the table directory. Every
 * logged update batch is a self-committing frame; readers overlay frames on the
 * base columns by stable record id.
 *
 * Frame layout (binary, little-endian):
 *
 *   <u32 payloadLength><u32 crc32(payload)><payload>
 *   payload = JSON: { "gen": number, "records": UpdateRecord[] }
 *
 * The payload ends with a `\n` and is included in both the length and the
 * checksum, so a frame is unambiguous and self-delimiting. `crc32` is computed
 * over the exact bytes (Node's zlib.crc32 where available, with a portable
 * fallback for older 22.x runtimes).
 *
 * Recovery contract (see plan §2):
 * - the committed boundary is the contiguous run of valid frames starting at
 *   `baseGen + 1`; a frame is committed once its bytes are complete and its
 *   checksum validates;
 * - a failing frame at end-of-file (no bytes after it) is a torn tail and is
 *   truncated before the next append;
 * - a failing frame with valid-looking bytes after it is mid-log corruption and
 *   is surfaced as {@link UpdateLogCorruptionError} — never silently skipped;
 * - `gen` must be strictly increasing by exactly one per frame.
 */

export const UPDATES_LOG_NAME = "updates.log";

/** Default hard cap for one encoded frame. Oversized batches are split. */
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** u32 length + u32 crc32. */
const HEADER_BYTES = 8;

const DURABLE = (process.env.INIBASE_DURABILITY ?? "full") !== "none";

const maybeSync = async (handle: FileHandle): Promise<void> => {
	if (DURABLE) await handle.sync();
};

/**
 * Portable CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320). Used only when the
 * runtime does not expose `zlib.crc32` (added in Node 22.2).
 */
const crc32Fallback = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	return (buffer: Uint8Array): number => {
		let crc = 0xffffffff;
		for (let i = 0; i < buffer.length; i++)
			crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
		return (crc ^ 0xffffffff) >>> 0;
	};
})();

const zlibCrc32 = (zlib as unknown as { crc32?: (data: Uint8Array) => number })
	.crc32;

export const checksum = (buffer: Uint8Array): number =>
	(typeof zlibCrc32 === "function"
		? zlibCrc32(buffer)
		: crc32Fallback(buffer)) >>> 0;

export interface UpdateRecord {
	/** Stable record id (as stored in the base `id` column). */
	id: string | number;
	/** Encoded column values, exactly as written by `formatData`. */
	cols: Record<string, unknown>;
	updatedAt: number;
	/** Format 3 durable row tombstone. Format 2 writers never emit this. */
	deleted?: boolean;
}

export interface UpdateFrame {
	/** Committed generation; strictly `baseGen + 1, + 2, ...` and never reused. */
	gen: number;
	records: UpdateRecord[];
}

export interface ScanResult {
	/** Byte offset just past the last valid frame. */
	committedBytes: number;
	/** True when trailing bytes did not form a complete valid frame. */
	tornTail: boolean;
	frameCount: number;
	/** Last committed generation, or `firstGen - 1` when no frame is valid. */
	lastGen: number;
	/** Last validated frame header, used to validate an incremental cursor. */
	anchor?: { offset: number; header: string };
}

export interface LogCursor {
	offset: number;
	anchor?: ScanResult["anchor"];
}

/** Raised for mid-log corruption (a reliable frame is followed by more bytes). */
export class UpdateLogCorruptionError extends Error {
	readonly path: string;
	readonly offset: number;
	readonly reason: string;

	constructor(path: string, offset: number, reason: string) {
		super(`UPDATE_LOG_CORRUPT: ${path} @${offset} (${reason})`);
		this.name = "UPDATE_LOG_CORRUPT";
		this.path = path;
		this.offset = offset;
		this.reason = reason;
	}
}

/** Raised when a single record cannot fit in one bounded frame. */
export class UpdateLogFrameTooLargeError extends Error {
	readonly path: string;
	readonly size: number;
	readonly maxFrameBytes: number;

	constructor(path: string, size: number, maxFrameBytes: number) {
		super(
			`UPDATE_LOG_FRAME_TOO_LARGE: ${path} needs ${size} bytes, cap ${maxFrameBytes}`,
		);
		this.name = "UPDATE_LOG_FRAME_TOO_LARGE";
		this.path = path;
		this.size = size;
		this.maxFrameBytes = maxFrameBytes;
	}
}

const framePayload = (frame: UpdateFrame): Buffer =>
	Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");

export const encodeFrame = (frame: UpdateFrame): Buffer => {
	const payload = framePayload(frame);
	const header = Buffer.allocUnsafe(HEADER_BYTES);
	header.writeUInt32LE(payload.length, 0);
	header.writeUInt32LE(checksum(payload), 4);
	return Buffer.concat([header, payload]);
};

const isRecord = (value: unknown): value is UpdateRecord =>
	typeof value === "object" &&
	value !== null &&
	"id" in value &&
	"cols" in value &&
	typeof (value as UpdateRecord).cols === "object" &&
	(value as UpdateRecord).cols !== null;

/**
 * Validate one decoded frame. Returns the parsed frame or throws a corruption
 * error when the shape is wrong (this is never a torn tail — the bytes were
 * complete and checksum-valid, so the content is untrustworthy).
 */
const parseFramePayload = (
	payload: Buffer,
	expectedGen: number,
	path: string,
	offset: number,
): UpdateFrame => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload.toString("utf8"));
	} catch {
		throw new UpdateLogCorruptionError(path, offset, "payload is not JSON");
	}
	if (typeof parsed !== "object" || parsed === null)
		throw new UpdateLogCorruptionError(
			path,
			offset,
			"payload is not an object",
		);
	const frame = parsed as UpdateFrame;
	if (frame.gen !== expectedGen)
		throw new UpdateLogCorruptionError(
			path,
			offset,
			`generation ${frame.gen} out of order (expected ${expectedGen})`,
		);
	if (!Array.isArray(frame.records) || !frame.records.every(isRecord))
		throw new UpdateLogCorruptionError(path, offset, "records are malformed");
	return frame;
};

/**
 * Scan a fully-buffered log. `firstGen` is `baseGen + 1`. Throws
 * {@link UpdateLogCorruptionError} for mid-log corruption; reports a torn tail
 * through {@link ScanResult} instead of throwing.
 */
export const scanFrames = (
	buffer: Buffer,
	firstGen: number,
	maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
	path = UPDATES_LOG_NAME,
): ScanResult => {
	const frames: UpdateFrame[] = [];
	let offset = 0;
	let tornTail = false;
	while (offset < buffer.length) {
		const remaining = buffer.length - offset;
		if (remaining < HEADER_BYTES) {
			tornTail = true;
			break;
		}
		const length = buffer.readUInt32LE(offset);
		const storedCrc = buffer.readUInt32LE(offset + 4);
		const frameEnd = offset + HEADER_BYTES + length;

		if (length > maxFrameBytes)
			throw new UpdateLogCorruptionError(
				path,
				offset,
				`frame length ${length} exceeds cap ${maxFrameBytes}`,
			);
		if (frameEnd > buffer.length) {
			// Header complete, payload short: a write was cut off at EOF.
			tornTail = true;
			break;
		}

		const payload = buffer.subarray(offset + HEADER_BYTES, frameEnd);
		if (checksum(payload) !== storedCrc) {
			// A failing checksum is only a torn tail when nothing follows it.
			if (frameEnd === buffer.length) {
				tornTail = true;
				break;
			}
			throw new UpdateLogCorruptionError(path, offset, "checksum mismatch");
		}

		frames.push(
			parseFramePayload(payload, firstGen + frames.length, path, offset),
		);
		offset = frameEnd;
	}
	return {
		committedBytes: offset,
		tornTail,
		frameCount: frames.length,
		lastGen: firstGen - 1 + frames.length,
	};
};

/**
 * Split records into bounded frames starting at `firstGen`. A record larger
 * than the cap on its own is rejected (it cannot be logged safely).
 */
export const buildFrames = (
	records: UpdateRecord[],
	firstGen: number,
	maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
	path = UPDATES_LOG_NAME,
): UpdateFrame[] => {
	const frames: UpdateFrame[] = [];
	let current: UpdateRecord[] = [];
	let recordBytes = 0;
	const overhead = () =>
		framePayload({ gen: firstGen + frames.length, records: [] }).length +
		HEADER_BYTES;

	for (const record of records) {
		const bytes = Buffer.byteLength(JSON.stringify(record));
		const alone = overhead() + bytes;
		if (alone > maxFrameBytes)
			throw new UpdateLogFrameTooLargeError(path, alone, maxFrameBytes);
		const candidate = overhead() + recordBytes + bytes + current.length;
		if (current.length && candidate > maxFrameBytes) {
			frames.push({ gen: firstGen + frames.length, records: current });
			current = [];
			recordBytes = 0;
		}
		// Crossing a power of ten in the generation can add a byte to the frame.
		if (overhead() + bytes > maxFrameBytes)
			throw new UpdateLogFrameTooLargeError(
				path,
				overhead() + bytes,
				maxFrameBytes,
			);
		current.push(record);
		recordBytes += bytes;
	}
	if (current.length)
		frames.push({ gen: firstGen + frames.length, records: current });
	return frames;
};

/**
 * Append-only handle. One instance per open table; callers must hold the table
 * writer lock around writes and repairs.
 */
export class UpdateLog {
	readonly path: string;

	constructor(tablePath: string) {
		this.path = join(tablePath, UPDATES_LOG_NAME);
	}

	/**
	 * Append one frame and make it durable. On a non-durable error the frame may
	 * or may not have reached disk (unknown outcome); callers must not ack.
	 *
	 * The handle is opened and closed per call: the append handle would
	 * otherwise live inside the process-wide overlay cache and be collected by
	 * GC of a long-idle table, closing the descriptor asynchronously.
	 */
	async append(frame: UpdateFrame): Promise<void> {
		const handle = await open(this.path, "a");
		try {
			// write() may legally perform a short write. writeFile() drains it.
			await handle.writeFile(encodeFrame(frame));
			await maybeSync(handle);
		} finally {
			await handle.close().catch(() => {});
		}
	}

	/** Append a whole batch, splitting into bounded frames. Returns the last gen. */
	async appendBatch(
		records: UpdateRecord[],
		firstGen: number,
		maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
	): Promise<number> {
		const frames = buildFrames(records, firstGen, maxFrameBytes, this.path);
		for (const frame of frames) await this.append(frame);
		return firstGen - 1 + frames.length;
	}

	/** Stage a multi-frame engine operation for the existing atomic file journal. */
	async stage(
		frames: UpdateFrame[],
		tablePath: string,
	): Promise<[string, string]> {
		const tmp = join(tablePath, ".tmp", `updates.batch-${randomUUID()}`);
		let handle: FileHandle | undefined;
		try {
			await copyFile(this.path, tmp).catch((error: any) => {
				if (error?.code !== "ENOENT") throw error;
			});
			handle = await open(tmp, "a");
			for (const frame of frames) await handle.writeFile(encodeFrame(frame));
			await maybeSync(handle);
			return [tmp, this.path];
		} catch (error) {
			await unlink(tmp).catch(() => {});
			throw error;
		} finally {
			await handle?.close();
		}
	}

	/**
	 * Stream every valid frame from `firstGen` in order, calling `onFrame` for
	 * each. The log is never loaded into one buffer, so replay is bounded by
	 * frame size rather than log size. Returns the committed boundary and
	 * whether a torn tail remains.
	 */
	async scan(
		firstGen: number,
		maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
		onFrame?: (frame: UpdateFrame) => void | Promise<void>,
		cursor?: LogCursor,
	): Promise<ScanResult> {
		let handle: FileHandle;
		try {
			handle = await open(this.path, "r");
		} catch (error: any) {
			if (error?.code === "ENOENT")
				return {
					committedBytes: 0,
					tornTail: false,
					frameCount: 0,
					lastGen: firstGen - 1,
				};
			throw error;
		}

		let committedBytes = cursor?.offset ?? 0;
		let frameCount = 0;
		let tornTail = false;
		let anchor = cursor?.anchor;
		const header = Buffer.allocUnsafe(HEADER_BYTES);
		const readAt = async (buffer: Buffer, position: number) => {
			let read = 0;
			while (read < buffer.length) {
				const { bytesRead } = await handle.read(
					buffer,
					read,
					buffer.length - read,
					position + read,
				);
				if (!bytesRead) break;
				read += bytesRead;
			}
			return read;
		};

		try {
			// Pin EOF: an append racing a reader is consumed on its next refresh.
			const end = (await handle.stat()).size;
			if (committedBytes > end)
				throw new UpdateLogCorruptionError(
					this.path,
					committedBytes,
					"stale cursor",
				);
			while (committedBytes < end) {
				if (
					end - committedBytes < HEADER_BYTES ||
					(await readAt(header, committedBytes)) !== HEADER_BYTES
				) {
					tornTail = true;
					break;
				}
				const length = header.readUInt32LE(0);
				const storedCrc = header.readUInt32LE(4);
				if (length > maxFrameBytes)
					throw new UpdateLogCorruptionError(
						this.path,
						committedBytes,
						`frame length ${length} exceeds cap ${maxFrameBytes}`,
					);
				const frameEnd = committedBytes + HEADER_BYTES + length;
				if (frameEnd > end) {
					tornTail = true;
					break;
				}
				const payload = Buffer.allocUnsafe(length);
				if ((await readAt(payload, committedBytes + HEADER_BYTES)) !== length) {
					tornTail = true;
					break;
				}
				if (checksum(payload) !== storedCrc) {
					if (frameEnd !== end)
						throw new UpdateLogCorruptionError(
							this.path,
							committedBytes,
							"checksum mismatch",
						);
					tornTail = true;
					break;
				}
				const frame = parseFramePayload(
					payload,
					firstGen + frameCount,
					this.path,
					committedBytes,
				);
				if (onFrame) await onFrame(frame);
				anchor = { offset: committedBytes, header: header.toString("hex") };
				frameCount++;
				committedBytes = frameEnd;
			}
		} finally {
			await handle.close().catch(() => {});
		}

		return {
			committedBytes,
			tornTail,
			frameCount,
			lastGen: firstGen - 1 + frameCount,
			anchor,
		};
	}

	/** Check the previously committed boundary before accepting an append. */
	async validateCursor(cursor: LogCursor): Promise<boolean> {
		if (!cursor.offset) return true;
		if (!cursor.anchor) return false;
		const handle = await open(this.path, "r");
		try {
			const header = Buffer.alloc(HEADER_BYTES);
			const { bytesRead } = await handle.read(
				header,
				0,
				HEADER_BYTES,
				cursor.anchor.offset,
			);
			if (
				bytesRead !== HEADER_BYTES ||
				header.toString("hex") !== cursor.anchor.header ||
				cursor.anchor.offset + HEADER_BYTES + header.readUInt32LE(0) !==
					cursor.offset
			)
				return false;
			const payload = Buffer.allocUnsafe(header.readUInt32LE(0));
			let read = 0;
			while (read < payload.length) {
				const { bytesRead: count } = await handle.read(
					payload,
					read,
					payload.length - read,
					cursor.anchor.offset + HEADER_BYTES + read,
				);
				if (!count) return false;
				read += count;
			}
			return checksum(payload) === header.readUInt32LE(4);
		} finally {
			await handle.close();
		}
	}

	/**
	 * Writer-only: scan, and when a torn tail is present truncate to the last
	 * valid boundary so future frames are never written behind unreadable bytes.
	 * Returns the committed generation. Throws on mid-log corruption.
	 */
	async repairTail(
		firstGen: number,
		maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
		onFrame?: (frame: UpdateFrame) => void | Promise<void>,
		cursor?: LogCursor,
	): Promise<ScanResult> {
		const result = await this.scan(firstGen, maxFrameBytes, onFrame, cursor);
		if (!result.tornTail) return result;
		const handle = await open(this.path, "r+");
		try {
			await handle.truncate(result.committedBytes);
			await maybeSync(handle);
		} finally {
			await handle.close().catch(() => {});
		}
		return result;
	}

	async dispose(): Promise<void> {
		// No persistent handle is held; kept for API symmetry so callers can
		// release a log deterministically.
	}

	/** Current on-disk size of the log (0 when absent); drives backpressure. */
	async bytes(): Promise<number> {
		try {
			return (await stat(this.path)).size;
		} catch {
			return 0;
		}
	}
}

/** True when a table directory contains an update log. */
export const updateLogExists = async (tablePath: string): Promise<boolean> => {
	try {
		const handle = await open(join(tablePath, UPDATES_LOG_NAME), "r");
		await handle.close();
		return true;
	} catch {
		return false;
	}
};
