import { type FileHandle, open, stat } from "node:fs/promises";
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

const checksum = (buffer: Uint8Array): number =>
	(typeof zlibCrc32 === "function"
		? zlibCrc32(buffer)
		: crc32Fallback(buffer)) >>> 0;

export interface UpdateRecord {
	/** Stable record id (as stored in the base `id` column). */
	id: string | number;
	/** Encoded column values, exactly as written by `formatData`. */
	cols: Record<string, unknown>;
	updatedAt: number;
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

	const sizeOf = (gen: number, recs: UpdateRecord[]) =>
		framePayload({ gen, records: recs }).length + HEADER_BYTES;

	for (const record of records) {
		const alone = sizeOf(firstGen + frames.length + (current.length ? 1 : 0), [
			record,
		]);
		if (alone > maxFrameBytes)
			throw new UpdateLogFrameTooLargeError(path, alone, maxFrameBytes);
		const candidate = sizeOf(firstGen + frames.length, [...current, record]);
		if (current.length && candidate > maxFrameBytes) {
			frames.push({ gen: firstGen + frames.length, records: current });
			current = [];
		}
		current.push(record);
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
			await handle.write(encodeFrame(frame));
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

		const chunk = Buffer.allocUnsafe(64 * 1024);
		let pending = Buffer.alloc(0);
		let committedBytes = 0;
		let frameCount = 0;
		let tornTail = false;

		try {
			for (;;) {
				const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
				if (bytesRead === 0) break;
				pending =
					pending.length === 0
						? Buffer.from(chunk.subarray(0, bytesRead))
						: Buffer.concat([pending, chunk.subarray(0, bytesRead)]);

				// Consume every complete, valid frame currently buffered.
				let offset = 0;
				while (pending.length - offset >= HEADER_BYTES) {
					const length = pending.readUInt32LE(offset);
					const storedCrc = pending.readUInt32LE(offset + 4);
					if (length > maxFrameBytes)
						throw new UpdateLogCorruptionError(
							this.path,
							offset,
							`frame length ${length} exceeds cap ${maxFrameBytes}`,
						);
					const frameEnd = offset + HEADER_BYTES + length;
					if (frameEnd > pending.length) break; // wait for more bytes
					const payload = pending.subarray(offset + HEADER_BYTES, frameEnd);
					if (checksum(payload) !== storedCrc) break; // decide at EOF
					const frame = parseFramePayload(
						payload,
						firstGen + frameCount,
						this.path,
						committedBytes,
					);
					if (onFrame) await onFrame(frame);
					frameCount++;
					offset = frameEnd;
					committedBytes += HEADER_BYTES + length;
				}
				pending = pending.subarray(offset);
			}

			// Leftover bytes: a partial header/payload, or a checksum failure.
			// If a frame's bytes all fit but the checksum failed and nothing is
			// left after it, it is a torn tail. Anything else is corruption.
			if (pending.length > 0) {
				if (pending.length < HEADER_BYTES) tornTail = true;
				else {
					const length = pending.readUInt32LE(0);
					const storedCrc = pending.readUInt32LE(4);
					const frameEnd = HEADER_BYTES + length;
					if (length > maxFrameBytes)
						throw new UpdateLogCorruptionError(
							this.path,
							committedBytes,
							`frame length ${length} exceeds cap ${maxFrameBytes}`,
						);
					if (frameEnd > pending.length) tornTail = true;
					else {
						const payload = pending.subarray(HEADER_BYTES, frameEnd);
						if (checksum(payload) !== storedCrc) {
							if (frameEnd === pending.length) tornTail = true;
							else
								throw new UpdateLogCorruptionError(
									this.path,
									committedBytes,
									"checksum mismatch",
								);
						} else {
							// Valid frame that only now fit: it is not corruption.
							const frame = parseFramePayload(
								payload,
								firstGen + frameCount,
								this.path,
								committedBytes,
							);
							if (onFrame) await onFrame(frame);
							frameCount++;
							committedBytes += HEADER_BYTES + length;
							if (pending.length > frameEnd) tornTail = true;
						}
					}
				}
			}
		} finally {
			await handle.close().catch(() => {});
		}

		return {
			committedBytes,
			tornTail,
			frameCount,
			lastGen: firstGen - 1 + frameCount,
		};
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
	): Promise<ScanResult> {
		const result = await this.scan(firstGen, maxFrameBytes, onFrame);
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
