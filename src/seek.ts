import { createReadStream } from "node:fs";
import {
	copyFile,
	type FileHandle,
	open,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { createGunzip, gunzipSync, gzipSync } from "node:zlib";
import { resourcesFor } from "./resources.js";
import { checksum } from "./updatelog.js";

const HEADER = 256;
const ENTRY = 40;
export const DEFAULT_BLOCK_BYTES = 128 * 1024;
const MAX_BLOCK_BYTES = 256 * 1024;

export interface AppendPrefix {
	bytes: number;
	stamp: string;
}

const appendBase = async (
	live: string,
	prefix: AppendPrefix | undefined,
	blockBytes: number,
) => {
	if (!prefix) return null;
	let directory: FileHandle;
	try {
		directory = await open(`${live}.seek`, "r");
	} catch (error: any) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
	try {
		const headerBytes = Buffer.alloc(HEADER);
		await readExact(directory, headerBytes, 0);
		const header = decodeHeader(headerBytes);
		if (
			header.v !== 1 ||
			header.entry !== ENTRY ||
			header.blockBytes !== blockBytes ||
			!header.blocks ||
			header.stamp !== prefix.stamp ||
			(await pathContentStamp(live)) !== prefix.stamp ||
			(await stat(live)).size !== prefix.bytes
		)
			return null;
		const entry = Buffer.alloc(ENTRY);
		await readExact(directory, entry, HEADER + (header.blocks - 1) * ENTRY);
		if (checksum(entry.subarray(0, 32)) !== entry.readUInt32LE(32))
			throw new Error("SEEK_ENTRY_CHECKSUM");
		const offset = Number(entry.readBigUInt64LE(16)),
			length = entry.readUInt32LE(24);
		if (
			length > blockBytes + 1024 ||
			entry.readUInt32LE(12) > blockBytes ||
			offset + length !== prefix.bytes
		)
			throw new Error("SEEK_BLOCK_BOUNDS");
		const handle = await open(live, "r");
		let raw: Buffer;
		try {
			const encoded = Buffer.allocUnsafe(length);
			await readExact(handle, encoded, offset);
			raw =
				header.codec === "gzip"
					? gunzipSync(encoded, { maxOutputLength: blockBytes })
					: encoded;
		} finally {
			await handle.close();
		}
		if (checksum(raw) !== entry.readUInt32LE(28))
			throw new Error("SEEK_BLOCK_CHECKSUM");
		if (raw[raw.length - 1] !== 10) return null;
		return {
			raw,
			offset,
			rows: Number(entry.readBigUInt64LE(0)) - 1,
			blocks: header.blocks - 1,
		};
	} finally {
		await directory.close();
	}
};

export const fileStamp = async (path: string): Promise<string> => {
	const s = await stat(path, { bigint: true });
	return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
};

// ctime changes on rename on some systems. Inode, size and mtime identify a
// staged immutable primary file both before and after journal publication.
export const contentStamp = async (handle: FileHandle): Promise<string> => {
	const s = await handle.stat({ bigint: true });
	return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`;
};

export const pathContentStamp = async (path: string): Promise<string> => {
	const s = await stat(path, { bigint: true });
	return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`;
};

export const readExact = async (
	handle: FileHandle,
	buffer: Buffer,
	position: number,
): Promise<void> => {
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesRead } = await handle.read(
			buffer,
			offset,
			buffer.length - offset,
			position + offset,
		);
		if (!bytesRead) throw new Error("SEEK_DIRECTORY_TRUNCATED");
		offset += bytesRead;
	}
};

export const writeExact = async (
	handle: FileHandle,
	buffer: Buffer,
	position: number,
): Promise<void> => {
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesWritten } = await handle.write(
			buffer,
			offset,
			buffer.length - offset,
			position + offset,
		);
		if (!bytesWritten) throw new Error("SEEK_DIRECTORY_SHORT_WRITE");
		offset += bytesWritten;
	}
};

export const encodeHeader = (value: object): Buffer => {
	const json = Buffer.from(JSON.stringify(value));
	if (json.length > HEADER - 8) throw new Error("SEEK_HEADER_TOO_LARGE");
	const buffer = Buffer.alloc(HEADER);
	buffer.writeUInt32LE(json.length);
	buffer.writeUInt32LE(checksum(json), 4);
	json.copy(buffer, 8);
	return buffer;
};

export const decodeHeader = (buffer: Buffer): any => {
	const size = buffer.readUInt32LE(0);
	if (size > HEADER - 8) throw new Error("SEEK_HEADER_INVALID");
	const json = buffer.subarray(8, 8 + size);
	if (checksum(json) !== buffer.readUInt32LE(4))
		throw new Error("SEEK_HEADER_CHECKSUM");
	return JSON.parse(json.toString("utf8"));
};

/** Fixed-size raw blocks may split oversized cells, including UTF-8 sequences. */
export const prepareSeekable = async (
	tmp: string,
	live: string,
	blockBytes = DEFAULT_BLOCK_BYTES,
	prefix?: AppendPrefix,
	consumeBytes?: (bytes: number) => void,
): Promise<[string, string]> => {
	if (![64, 128, 256].some((n) => n * 1024 === blockBytes))
		throw new Error("INVALID_BLOCK_SIZE");
	const dataTmp = `${tmp}.blocks`;
	const directoryTmp = `${tmp}.seek`;
	const reuse = await appendBase(live, prefix, blockBytes);
	try {
		if (reuse) {
			await copyFile(live, dataTmp);
			await copyFile(`${live}.seek`, directoryTmp);
		}
	} catch (error) {
		await unlink(dataTmp).catch(() => {});
		await unlink(directoryTmp).catch(() => {});
		throw error;
	}
	const data = await open(dataTmp, reuse ? "a+" : "wx");
	let directory: FileHandle;
	try {
		directory = await open(directoryTmp, reuse ? "r+" : "wx");
	} catch (error) {
		await data.close();
		await unlink(dataTmp).catch(() => {});
		throw error;
	}
	const compressed = live.endsWith(".gz");
	const source = createReadStream(tmp, {
		highWaterMark: 64 * 1024,
		start: reuse ? prefix?.bytes : 0,
	});
	const input = compressed ? source.pipe(createGunzip()) : source;
	let offset = reuse?.offset ?? 0,
		rows = reuse?.rows ?? 0,
		blocks = reuse?.blocks ?? 0,
		used = 0,
		partial = false;
	const raw = Buffer.allocUnsafe(blockBytes);
	const flush = async () => {
		if (!used) return;
		const bytes = raw.subarray(0, used);
		const encoded = compressed ? gzipSync(bytes) : bytes;
		const entry = Buffer.alloc(ENTRY);
		entry.writeBigUInt64LE(BigInt(rows + 1), 0);
		let lines = 0;
		for (let i = bytes.indexOf(10); i !== -1; i = bytes.indexOf(10, i + 1))
			lines++;
		entry.writeUInt32LE(lines, 8);
		entry.writeUInt32LE(used, 12);
		entry.writeBigUInt64LE(BigInt(offset), 16);
		entry.writeUInt32LE(encoded.length, 24);
		entry.writeUInt32LE(checksum(bytes), 28);
		entry.writeUInt32LE(checksum(entry.subarray(0, 32)), 32);
		await data.writeFile(encoded);
		await writeExact(directory, entry, HEADER + blocks * ENTRY);
		offset += encoded.length;
		rows += lines;
		blocks++;
		used = 0;
	};
	try {
		if (reuse) {
			await data.truncate(offset);
			await directory.truncate(HEADER + blocks * ENTRY);
		} else await directory.writeFile(Buffer.alloc(HEADER));
		const consume = async (bytes: Buffer) => {
			consumeBytes?.(bytes.length);
			if (bytes.length) partial = bytes[bytes.length - 1] !== 10;
			let consumed = 0;
			while (consumed < bytes.length) {
				const take = Math.min(blockBytes - used, bytes.length - consumed);
				bytes.copy(raw, used, consumed, consumed + take);
				used += take;
				consumed += take;
				if (used === blockBytes) await flush();
			}
		};
		if (reuse) await consume(reuse.raw);
		for await (const chunk of input) await consume(chunk as Buffer);
		await flush();
		await writeExact(
			directory,
			encodeHeader({
				v: 1,
				kind: "column-blocks",
				codec: compressed ? "gzip" : "raw",
				stamp: await contentStamp(data),
				blockBytes,
				blocks,
				rows: rows + Number(partial),
				entry: ENTRY,
			}),
			0,
		);
		await data.close();
		await directory.close();
		await rename(dataTmp, tmp);
		return [directoryTmp, `${live}.seek`];
	} catch (error) {
		await data.close().catch(() => {});
		await directory.close().catch(() => {});
		await unlink(dataTmp).catch(() => {});
		await unlink(directoryTmp).catch(() => {});
		throw error;
	} finally {
		input.destroy();
		if (input !== source) source.destroy();
	}
};

/** null means a legacy/missing/stale derived directory: use the legacy reader. */
export const readSeekable = async (
	path: string,
	wanted: number[],
): Promise<Map<number, string> | null> => {
	if (!wanted.length) return new Map();
	let directory: FileHandle;
	try {
		directory = await open(`${path}.seek`, "r");
	} catch (error: any) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
	let data: FileHandle | undefined;
	try {
		data = await open(path, "r");
		const stamp = await contentStamp(data);
		const headerBytes = Buffer.alloc(HEADER);
		await readExact(directory, headerBytes, 0);
		const header = decodeHeader(headerBytes);
		if (
			header.v !== 1 ||
			header.kind !== "column-blocks" ||
			header.stamp !== stamp ||
			header.entry !== ENTRY ||
			!Number.isSafeInteger(header.blocks) ||
			header.blocks < 0 ||
			!Number.isSafeInteger(header.rows) ||
			header.rows < 0 ||
			header.blockBytes < 64 * 1024 ||
			header.blockBytes > MAX_BLOCK_BYTES ||
			(await directory.stat()).size !== HEADER + ENTRY * header.blocks
		)
			return null;
		// Dense batches are cheaper as a streaming scan. This is based on
		// directory fan-out, not key contents; point reads always stay seekable.
		if (wanted.length >= 64 && wanted.length >= header.blocks / 2) return null;
		const resources = resourcesFor(dirname(dirname(path)));
		const entry = async (block: number) => {
			if (block < 0 || block >= header.blocks)
				throw new Error("SEEK_ENTRY_BOUNDS");
			const pageNumber = Math.floor(block / 128);
			const key = `${path}:${stamp}:directory:${pageNumber}`;
			let page = resources.get<Buffer>(key);
			if (!page) {
				page = Buffer.allocUnsafe(
					Math.min(128, header.blocks - pageNumber * 128) * ENTRY,
				);
				await readExact(directory, page, HEADER + pageNumber * 128 * ENTRY);
				resources.set(key, page, page.length + 256);
			}
			const start = (block % 128) * ENTRY;
			const bytes = page.subarray(start, start + ENTRY);
			if (checksum(bytes.subarray(0, 32)) !== bytes.readUInt32LE(32))
				throw new Error("SEEK_ENTRY_CHECKSUM");
			return {
				first: Number(bytes.readBigUInt64LE(0)),
				lines: bytes.readUInt32LE(8),
				raw: bytes.readUInt32LE(12),
				offset: Number(bytes.readBigUInt64LE(16)),
				length: bytes.readUInt32LE(24),
				crc: bytes.readUInt32LE(28),
			};
		};
		const block = async (index: number) => {
			const meta = await entry(index);
			if (
				meta.raw > header.blockBytes ||
				meta.length > header.blockBytes + 1024 ||
				meta.offset < 0 ||
				!Number.isSafeInteger(meta.offset)
			)
				throw new Error("SEEK_BLOCK_BOUNDS");
			const key = `${path}:${stamp}:block:${index}`;
			let bytes = resources.get<Buffer>(key);
			if (!bytes) {
				const encoded = Buffer.allocUnsafe(meta.length);
				await readExact(data as FileHandle, encoded, meta.offset);
				bytes =
					header.codec === "gzip"
						? gunzipSync(encoded, { maxOutputLength: header.blockBytes })
						: encoded;
				if (bytes.length !== meta.raw || checksum(bytes) !== meta.crc)
					throw new Error("SEEK_BLOCK_CHECKSUM");
				resources.set(key, bytes, bytes.length + 256);
			}
			return { bytes, meta };
		};
		const result = new Map<number, string>();
		for (const row of new Set(wanted)) {
			if (!Number.isSafeInteger(row) || row < 1 || row > header.rows) continue;
			// Find the earliest block which could contain this row. A block
			// ending mid-cell can include one more row than its newline count.
			let lo = 0,
				hi = header.blocks;
			while (lo < hi) {
				const mid = Math.floor((lo + hi) / 2);
				const meta = await entry(mid);
				if (meta.first + meta.lines >= row) hi = mid;
				else lo = mid + 1;
			}
			let currentRow = (await entry(lo)).first;
			const fragments: Buffer[] = [];
			let complete = false;
			for (let index = lo; index < header.blocks && !complete; index++) {
				const { bytes } = await block(index);
				let start = 0;
				for (
					let end = bytes.indexOf(10);
					end !== -1;
					end = bytes.indexOf(10, start)
				) {
					if (currentRow === row) {
						fragments.push(bytes.subarray(start, end));
						complete = true;
						break;
					}
					currentRow++;
					start = end + 1;
				}
				if (!complete && currentRow === row)
					fragments.push(bytes.subarray(start));
			}
			if (complete || fragments.length)
				result.set(row, Buffer.concat(fragments).toString("utf8"));
		}
		return result;
	} finally {
		await directory.close();
		await data?.close();
	}
};
