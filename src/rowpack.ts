/**
 * Experimental immutable row pages, not yet the public DML backend.
 * Versioned generations have one row stream, one page directory and one disk
 * hash index. No resident row/ID map. Publication never removes an old generation.
 */
import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import * as File from "./file.js";
import type { DatabaseResources } from "./resources.js";
import { decodeHeader, encodeHeader, readExact, writeExact } from "./seek.js";
import { checksum } from "./updatelog.js";

const HEADER = 256,
	PAGE = 32768,
	ENTRY = 24,
	SLOT = 32;
const bucket = (id: number, capacity: number) =>
	((Math.imul(id >>> 0, 0x9e3779b1) ^
		Math.imul(Math.floor(id / 4294967296), 0x85ebca6b)) >>>
		0) &
	(capacity - 1);
interface Manifest {
	v: 1;
	kind: "rowpack";
	generation: string;
	rows: number;
	pages: number;
	rawBytes: number;
	capacity: number;
	compression: boolean;
	pageBytes: number;
}
export interface PackedRow {
	id: number;
	bytes: Buffer;
}
const validID = (id: number) => {
	if (!Number.isSafeInteger(id) || id < 0) throw new Error("ROWPACK_ID");
};
const verifySlot = (slot: Buffer) => {
	if (slot.readBigUInt64LE() === 0n) {
		if (slot.some((byte) => byte !== 0))
			throw new Error("ROWPACK_SLOT_CHECKSUM");
		return;
	}
	if (checksum(slot.subarray(0, 24)) !== slot.readUInt32LE(24))
		throw new Error("ROWPACK_SLOT_CHECKSUM");
};
const paths = (directory: string, generation: string) => ({
	data: join(directory, `${generation}.rows`),
	pages: join(directory, `${generation}.pages`),
	ids: join(directory, `${generation}.ids`),
});

/** Inputs are caller-owned bytes; output generations are durable before publication. */
export const buildRowPack = async (
	directory: string,
	records: AsyncIterable<PackedRow>,
	expectedRows: number,
	compression: boolean,
	resources: DatabaseResources,
	hook?: (
		phase: "files-synced" | "manifest-synced" | "published",
	) => void | Promise<void>,
): Promise<void> => {
	if (
		!Number.isSafeInteger(expectedRows) ||
		expectedRows < 0 ||
		expectedRows > 2 ** 28
	)
		throw new Error("ROWPACK_SIZE");
	await mkdir(join(directory, ".tmp"), { recursive: true });
	return File.runWithIndependentLockStore(async () => {
		await File.lock(join(directory, ".tmp"));
		try {
			await resources.withWorking(256 * 1024, async () => {
				const generation = randomUUID(),
					names = paths(directory, generation);
				const capacity =
					2 ** Math.ceil(Math.log2(Math.max(16, expectedRows * 2)));
				const handles: FileHandle[] = [];
				const manifestTmp = join(directory, `.manifest-${generation}`);
				let published = false;
				try {
					const data = await open(names.data, "wx+");
					handles.push(data);
					const pages = await open(names.pages, "wx+");
					handles.push(pages);
					const ids = await open(names.ids, "wx+");
					handles.push(ids);
					await data.writeFile(Buffer.alloc(HEADER));
					await pages.writeFile(Buffer.alloc(HEADER));
					await ids.truncate(HEADER + capacity * SLOT);
					const raw = Buffer.allocUnsafe(PAGE),
						slot = Buffer.alloc(SLOT);
					let used = 0,
						pageCount = 0,
						encodedOffset = HEADER,
						rawBytes = 0,
						count = 0;
					const flush = async () => {
						if (!used) return;
						const bytes = raw.subarray(0, used),
							encoded = compression
								? gzipSync(bytes, { level: 1, memLevel: 1 })
								: bytes;
						const entry = Buffer.alloc(ENTRY);
						entry.writeBigUInt64LE(BigInt(encodedOffset));
						entry.writeUInt32LE(encoded.length, 8);
						entry.writeUInt32LE(used, 12);
						entry.writeUInt32LE(checksum(bytes), 16);
						entry.writeUInt32LE(checksum(entry.subarray(0, 20)), 20);
						await writeExact(data, encoded, encodedOffset);
						await writeExact(pages, entry, HEADER + pageCount * ENTRY);
						encodedOffset += encoded.length;
						pageCount++;
						used = 0;
					};
					for await (const record of records) {
						validID(record.id);
						if (!Buffer.isBuffer(record.bytes) || !record.bytes.length)
							throw new Error("ROWPACK_VALUE");
						if (++count > expectedRows) throw new Error("ROWPACK_ROW_COUNT");
						let position = bucket(record.id, capacity),
							probes = 0;
						for (;;) {
							await readExact(ids, slot, HEADER + position * SLOT);
							verifySlot(slot);
							const key = slot.readBigUInt64LE();
							if (key === 0n) break;
							if (key === BigInt(record.id) + 1n)
								throw new Error("ROWPACK_DUPLICATE_ID");
							if (++probes >= capacity) throw new Error("ROWPACK_INDEX_FULL");
							position = (position + 1) & (capacity - 1);
						}
						slot.fill(0);
						slot.writeBigUInt64LE(BigInt(record.id) + 1n);
						slot.writeBigUInt64LE(BigInt(rawBytes), 8);
						slot.writeBigUInt64LE(BigInt(record.bytes.length), 16);
						slot.writeUInt32LE(checksum(slot.subarray(0, 24)), 24);
						await writeExact(ids, slot, HEADER + position * SLOT);
						for (let offset = 0; offset < record.bytes.length; ) {
							const take = Math.min(PAGE - used, record.bytes.length - offset);
							record.bytes.copy(raw, used, offset, offset + take);
							used += take;
							offset += take;
							rawBytes += take;
							if (used === PAGE) await flush();
						}
					}
					if (count !== expectedRows) throw new Error("ROWPACK_ROW_COUNT");
					await flush();
					const manifest: Manifest = {
						v: 1,
						kind: "rowpack",
						generation,
						rows: count,
						pages: pageCount,
						rawBytes,
						capacity,
						compression,
						pageBytes: PAGE,
					};
					const header = encodeHeader(manifest);
					for (const handle of handles) {
						await writeExact(handle, header, 0);
						await handle.sync();
					}
					await hook?.("files-synced");
					const marker = await open(manifestTmp, "wx");
					try {
						await marker.writeFile(header);
						await marker.sync();
					} finally {
						await marker.close();
					}
					// Persist immutable generation names before publishing their manifest.
					await File.syncDir(directory);
					await hook?.("manifest-synced");
					await rename(manifestTmp, join(directory, "CURRENT.rowpack"));
					published = true;
					await File.syncDir(directory);
					await hook?.("published");
				} finally {
					for (const handle of handles) await handle.close();
					if (!published) {
						for (const path of [...Object.values(names), manifestTmp])
							await unlink(path).catch((error) => {
								if (error?.code !== "ENOENT") throw error;
							});
					}
				}
			});
		} finally {
			await File.unlock(join(directory, ".tmp"));
		}
	});
};

/** Snapshot handle: immutable generation filenames make active readers safe. */
export class RowPack {
	private constructor(
		private readonly directory: string,
		private readonly manifest: Manifest,
		private readonly resources: DatabaseResources,
	) {}
	static async open(
		directory: string,
		resources: DatabaseResources,
	): Promise<RowPack> {
		// Never cache CURRENT: another process may have published a new generation.
		const handle = await open(join(directory, "CURRENT.rowpack"), "r");
		let manifest: Manifest;
		try {
			const header = Buffer.alloc(HEADER);
			await readExact(handle, header, 0);
			if ((await handle.stat()).size !== HEADER)
				throw new Error("ROWPACK_MANIFEST");
			manifest = decodeHeader(header);
		} finally {
			await handle.close();
		}
		if (
			manifest.v !== 1 ||
			manifest.kind !== "rowpack" ||
			!/^[-0-9a-f]{36}$/.test(manifest.generation) ||
			manifest.pageBytes !== PAGE ||
			typeof manifest.compression !== "boolean" ||
			!Number.isSafeInteger(manifest.rows) ||
			manifest.rows < 0 ||
			!Number.isSafeInteger(manifest.pages) ||
			manifest.pages < 0 ||
			!Number.isSafeInteger(manifest.rawBytes) ||
			manifest.rawBytes < 0 ||
			manifest.pages !== Math.ceil(manifest.rawBytes / PAGE) ||
			!Number.isSafeInteger(manifest.capacity) ||
			manifest.capacity < 16 ||
			manifest.capacity > 2 ** 29 ||
			(manifest.capacity & (manifest.capacity - 1)) !== 0 ||
			manifest.rows > manifest.capacity / 2
		)
			throw new Error("ROWPACK_MANIFEST");
		for (const [kind, path] of Object.entries(
			paths(directory, manifest.generation),
		)) {
			await resources.file(path, async (file) => {
				const header = Buffer.alloc(HEADER);
				await readExact(file, header, 0);
				const observed = decodeHeader(header);
				if (JSON.stringify(observed) !== JSON.stringify(manifest))
					throw new Error("ROWPACK_GENERATION");
				const size = (await file.stat()).size;
				if (
					(kind === "ids" && size !== HEADER + manifest.capacity * SLOT) ||
					(kind === "pages" && size !== HEADER + manifest.pages * ENTRY) ||
					(kind === "data" && size < HEADER)
				)
					throw new Error("ROWPACK_FILE_SIZE");
			});
		}
		return new RowPack(directory, manifest, resources);
	}
	get rows() {
		return this.manifest.rows;
	}
	private async location(
		id: number,
	): Promise<{ offset: number; length: number } | null> {
		validID(id);
		const { capacity, generation, rawBytes } = this.manifest,
			path = paths(this.directory, generation).ids;
		const slot = Buffer.alloc(SLOT);
		let position = bucket(id, capacity);
		for (
			let probes = 0;
			probes < capacity;
			probes++, position = (position + 1) & (capacity - 1)
		) {
			await this.resources.file(path, (handle) =>
				readExact(handle, slot, HEADER + position * SLOT),
			);
			verifySlot(slot);
			const key = slot.readBigUInt64LE();
			if (key === 0n) return null;
			if (key === BigInt(id) + 1n) {
				const offset = Number(slot.readBigUInt64LE(8)),
					length = Number(slot.readBigUInt64LE(16));
				if (
					!Number.isSafeInteger(offset) ||
					!Number.isSafeInteger(length) ||
					length < 1 ||
					offset + length > rawBytes
				)
					throw new Error("ROWPACK_LOCATION");
				return { offset, length };
			}
		}
		throw new Error("ROWPACK_INDEX_FULL");
	}
	/** Only yielded bytes belong to the caller; engine reads/decompression stay paged. */
	async *read(id: number): AsyncGenerator<Buffer> {
		const location = await this.location(id);
		if (!location) return;
		const names = paths(this.directory, this.manifest.generation);
		let position = location.offset,
			remaining = location.length;
		while (remaining) {
			const index = Math.floor(position / PAGE),
				within = position % PAGE;
			const chunk = await this.resources.withWorking(256 * 1024, async () => {
				const key = `${names.data}:page:${index}`;
				let bytes = this.resources.get<Buffer>(key);
				if (!bytes) {
					const entry = Buffer.alloc(ENTRY);
					await this.resources.file(names.pages, (handle) =>
						readExact(handle, entry, HEADER + index * ENTRY),
					);
					if (checksum(entry.subarray(0, 20)) !== entry.readUInt32LE(20))
						throw new Error("ROWPACK_PAGE_DIRECTORY");
					const offset = Number(entry.readBigUInt64LE()),
						length = entry.readUInt32LE(8),
						rawLength = entry.readUInt32LE(12);
					if (
						!Number.isSafeInteger(offset) ||
						offset < HEADER ||
						length > PAGE + 4096 ||
						!length ||
						!rawLength ||
						rawLength > PAGE
					)
						throw new Error("ROWPACK_PAGE_BOUNDS");
					const encoded = Buffer.allocUnsafe(length);
					await this.resources.file(names.data, (handle) =>
						readExact(handle, encoded, offset),
					);
					bytes = this.manifest.compression
						? gunzipSync(encoded, { maxOutputLength: PAGE })
						: encoded;
					if (
						bytes.length !== rawLength ||
						checksum(bytes) !== entry.readUInt32LE(16)
					)
						throw new Error("ROWPACK_PAGE_CHECKSUM");
					this.resources.set(key, bytes, bytes.length + 256);
				}
				const take = Math.min(remaining, bytes.length - within);
				if (take <= 0) throw new Error("ROWPACK_PAGE_BOUNDS");
				return Buffer.from(bytes.subarray(within, within + take));
			});
			remaining -= chunk.length;
			position += chunk.length;
			yield chunk;
		}
	}
}
