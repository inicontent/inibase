/** Internal mutable-kernel experiment. Not the public iniBase backend. */
import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import * as File from "./file.js";
import type { DatabaseResources } from "./resources.js";
import { decodeHeader, encodeHeader, readExact, writeExact } from "./seek.js";
import { checksum } from "./updatelog.js";

const HEADER = 256,
	NODE = 192,
	CHUNK = 32768,
	WORKING = 256 * 1024;
interface State {
	v: 1;
	kind: "rowstore";
	file: string;
	compression: boolean;
	root: number;
	end: number;
	rows: number;
	sequence: number;
}
export interface RowMutation {
	id: number;
	/** null is a tombstone; empty and oversized values are supported. */
	value: Buffer | AsyncIterable<Uint8Array> | null;
}
export type RowCommitPhase =
	| "appended"
	| "data-synced"
	| "manifest-synced"
	| "published";
const validID = (id: number) => {
	if (!Number.isSafeInteger(id) || id < 0) throw new Error("ROWSTORE_ID");
};
const nibble = (id: number, shift: number) => Math.floor(id / 2 ** shift) % 16;
const prefix = (id: number, shift: number) => Math.floor(id / 2 ** (shift + 4));
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const identity = (state: State) => ({
	v: 1,
	kind: "rowstore-data",
	file: state.file,
	compression: state.compression,
});
const syncDirectory = (directory: string, resources: DatabaseResources) =>
	resources.transientFile(directory, "r", (handle) => handle.sync());
const current = (
	directory: string,
	resources: DatabaseResources,
): Promise<State> =>
	resources.transientFile(
		join(directory, "CURRENT.rowstore"),
		"r",
		async (file) => {
			const bytes = Buffer.alloc(HEADER);
			await readExact(file, bytes, 0);
			const state = decodeHeader(bytes) as State;
			if (
				(await file.stat()).size !== HEADER ||
				state.v !== 1 ||
				state.kind !== "rowstore" ||
				!/^[a-f0-9-]{36}\.rows$/.test(state.file) ||
				typeof state.compression !== "boolean" ||
				![state.root, state.end, state.rows, state.sequence].every(integer) ||
				state.end < HEADER ||
				(state.root !== 0 &&
					(state.root < HEADER || state.root + NODE > state.end)) ||
				(state.root === 0 && state.rows !== 0)
			)
				throw new Error("ROWSTORE_MANIFEST");
			return state;
		},
	);
const publish = async (
	directory: string,
	state: State,
	resources: DatabaseResources,
	hook?: (phase: RowCommitPhase) => void | Promise<void>,
) => {
	const temporary = join(directory, `.rowstore-${randomUUID()}`);
	try {
		await resources.transientFile(temporary, "wx", async (file) => {
			await writeExact(file, encodeHeader(state), 0);
			await file.sync();
		});
		await hook?.("manifest-synced");
		await rename(temporary, join(directory, "CURRENT.rowstore"));
		await syncDirectory(directory, resources);
		await hook?.("published");
	} finally {
		await unlink(temporary).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
};

/** One bounded append buffer; readers of newly copied paths can use its bytes. */
class Appender {
	private buffer = Buffer.allocUnsafe(65536);
	private used = 0;
	private start: number;
	end: number;
	readonly baseEnd: number;
	constructor(
		private file: FileHandle,
		end: number,
	) {
		this.start = this.end = end;
		this.baseEnd = end;
	}
	/** Only unpublished nodes may be changed in place; old snapshots never reach them. */
	async overwrite(offset: number, bytes: Buffer) {
		if (offset < this.baseEnd || offset + bytes.length > this.end)
			throw new Error("ROWSTORE_OVERWRITE");
		if (offset >= this.start) bytes.copy(this.buffer, offset - this.start);
		else {
			await this.flush();
			await writeExact(this.file, bytes, offset);
		}
	}
	async flush() {
		if (this.used)
			await writeExact(
				this.file,
				this.buffer.subarray(0, this.used),
				this.start,
			);
		this.start = this.end;
		this.used = 0;
	}
	async append(bytes: Buffer): Promise<number> {
		const offset = this.end;
		if (!Number.isSafeInteger(offset + bytes.length))
			throw new Error("ROWSTORE_SIZE");
		for (let position = 0; position < bytes.length; ) {
			const take = Math.min(
				bytes.length - position,
				this.buffer.length - this.used,
			);
			bytes.copy(this.buffer, this.used, position, position + take);
			position += take;
			this.used += take;
			this.end += take;
			if (this.used === this.buffer.length) await this.flush();
		}
		return offset;
	}
	async read(offset: number, bytes: Buffer) {
		if (offset >= this.start && offset + bytes.length <= this.end)
			this.buffer.copy(
				bytes,
				0,
				offset - this.start,
				offset - this.start + bytes.length,
			);
		else {
			await this.flush();
			await readExact(this.file, bytes, offset);
		}
	}
}
interface Node {
	bytes: Buffer;
	id: number;
	shift: number;
	offset: number;
	deleted: boolean;
}
type Reader = (offset: number, bytes: Buffer) => Promise<void>;
const nodeAt = async (
	read: Reader,
	offset: number,
	end: number,
	below = 56,
): Promise<Node> => {
	if (!integer(offset) || offset < HEADER || offset + NODE > end)
		throw new Error("ROWSTORE_POINTER");
	const bytes = Buffer.alloc(NODE);
	await read(offset, bytes);
	const id = Number(bytes.readBigUInt64LE(8)),
		shift = bytes.readInt8(1);
	if (
		checksum(bytes.subarray(0, NODE - 4)) !== bytes.readUInt32LE(NODE - 4) ||
		!integer(id) ||
		(bytes[0] !== 1 && bytes[0] !== 2) ||
		(bytes[0] === 1
			? shift !== -1
			: shift < 0 || shift > 52 || shift % 4 !== 0 || shift >= below) ||
		bytes[2] > 1
	)
		throw new Error("ROWSTORE_INDEX");
	return { bytes, id, shift, offset, deleted: bytes[2] === 1 };
};
const appendNode = async (append: Appender, bytes: Buffer) => {
	bytes.writeUInt32LE(checksum(bytes.subarray(0, NODE - 4)), NODE - 4);
	return append.append(bytes);
};
const find = async (
	state: State,
	id: number,
	read: Reader,
): Promise<Node | null> => {
	let offset = state.root,
		below = 56;
	while (offset) {
		const node = await nodeAt(read, offset, state.end, below);
		if (node.shift < 0) return node.id === id ? node : null;
		if (prefix(id, node.shift) !== prefix(node.id, node.shift)) return null;
		offset = Number(
			node.bytes.readBigUInt64LE(32 + nibble(id, node.shift) * 8),
		);
		below = node.shift;
	}
	return null;
};
/** Compressed radix-16 tree: at most fourteen copied 192-byte nodes per mutation. */
const replace = async (
	root: number,
	id: number,
	leaf: number,
	append: Appender,
) => {
	const path: { node: Node; slot: number }[] = [];
	let offset = root,
		replacement = leaf,
		below = 56;
	while (offset) {
		const node = await nodeAt(
			(at, bytes) => append.read(at, bytes),
			offset,
			append.end,
			below,
		);
		let differing = 52;
		while (
			differing >= 0 &&
			nibble(node.id, differing) === nibble(id, differing)
		)
			differing -= 4;
		if (differing > node.shift) {
			const branch = Buffer.alloc(NODE);
			branch[0] = 2;
			branch.writeInt8(differing, 1);
			branch.writeBigUInt64LE(BigInt(id), 8);
			branch.writeBigUInt64LE(
				BigInt(offset),
				32 + nibble(node.id, differing) * 8,
			);
			branch.writeBigUInt64LE(BigInt(leaf), 32 + nibble(id, differing) * 8);
			replacement = await appendNode(append, branch);
			break;
		}
		if (node.shift < 0) break;
		const slot = 32 + nibble(id, node.shift) * 8;
		path.push({ node, slot });
		offset = Number(node.bytes.readBigUInt64LE(slot));
		below = node.shift;
	}
	for (let index = path.length - 1; index >= 0; index--) {
		const { node, slot } = path[index];
		node.bytes.writeBigUInt64LE(BigInt(replacement), slot);
		if (node.offset >= append.baseEnd) {
			node.bytes.writeUInt32LE(
				checksum(node.bytes.subarray(0, NODE - 4)),
				NODE - 4,
			);
			await append.overwrite(node.offset, node.bytes);
			replacement = node.offset;
		} else replacement = await appendNode(append, node.bytes);
	}
	return replacement;
};

export class RowStore {
	constructor(
		readonly directory: string,
		private resources: DatabaseResources,
	) {}
	private async locked<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(join(this.directory, ".tmp"), { recursive: true });
		return File.runWithIndependentLockStore(async () => {
			await File.lock(
				join(this.directory, ".tmp"),
				undefined,
				undefined,
				this.resources,
			);
			try {
				return await operation();
			} finally {
				await File.unlock(join(this.directory, ".tmp"));
			}
		});
	}
	async create(compression = true): Promise<void> {
		await this.locked(() =>
			this.resources.withWorking(4096, async () => {
				try {
					await current(this.directory, this.resources);
					throw new Error("ROWSTORE_EXISTS");
				} catch (error: any) {
					if (error.code !== "ENOENT") throw error;
				}
				const state: State = {
					v: 1,
					kind: "rowstore",
					file: `${randomUUID()}.rows`,
					compression,
					root: 0,
					end: HEADER,
					rows: 0,
					sequence: 0,
				};
				await this.resources.transientFile(
					join(this.directory, state.file),
					"wx",
					async (file) => {
						await writeExact(file, encodeHeader(identity(state)), 0);
						await file.sync();
					},
				);
				await syncDirectory(this.directory, this.resources);
				await publish(this.directory, state, this.resources);
			}),
		);
	}
	async snapshot(): Promise<RowSnapshot> {
		const state = await this.resources.withWorking(4096, () =>
			current(this.directory, this.resources),
		);
		await this.resources.withWorking(4096, () =>
			this.resources.file(join(this.directory, state.file), async (file) => {
				const header = Buffer.alloc(HEADER);
				await readExact(file, header, 0);
				if (
					JSON.stringify(decodeHeader(header)) !==
						JSON.stringify(identity(state)) ||
					(await file.stat()).size < state.end
				)
					throw new Error("ROWSTORE_GENERATION");
			}),
		);
		return new RowSnapshot(this.directory, state, this.resources);
	}
	async commit(
		mutations: AsyncIterable<RowMutation>,
		hook?: (phase: RowCommitPhase) => void | Promise<void>,
	): Promise<void> {
		await this.locked(() =>
			this.resources.withWorking(WORKING, async () => {
				const state = await current(this.directory, this.resources);
				if (state.sequence === Number.MAX_SAFE_INTEGER)
					throw new Error("ROWSTORE_SEQUENCE");
				const filePath = join(this.directory, state.file);
				// No rename/replacement of this append file: pooled readers keep valid snapshots.
				await this.resources.file(
					filePath,
					async (file) => {
						const header = Buffer.alloc(HEADER);
						await readExact(file, header, 0);
						if (
							JSON.stringify(decodeHeader(header)) !==
								JSON.stringify(identity(state)) ||
							(await file.stat()).size < state.end
						)
							throw new Error("ROWSTORE_GENERATION");
						// An unpublished append is never part of a reader's snapshot.
						await file.truncate(state.end);
						const append = new Appender(file, state.end),
							raw = Buffer.allocUnsafe(CHUNK);
						for await (const mutation of mutations) {
							validID(mutation.id);
							const previous = await find(
								{ ...state, end: append.end },
								mutation.id,
								(at, bytes) => append.read(at, bytes),
							);
							const start = append.end;
							let used = 0,
								length = 0;
							const flush = async () => {
								if (!used) return;
								const bytes = raw.subarray(0, used),
									encoded = state.compression
										? gzipSync(bytes, { memLevel: 4, windowBits: 14 })
										: bytes;
								const entry = Buffer.alloc(16);
								entry.writeUInt32LE(encoded.length);
								entry.writeUInt32LE(used, 4);
								entry.writeUInt32LE(checksum(bytes), 8);
								entry.writeUInt32LE(checksum(entry.subarray(0, 12)), 12);
								await append.append(entry);
								await append.append(encoded);
								used = 0;
							};
							if (mutation.value !== null) {
								const input = Buffer.isBuffer(mutation.value)
									? [mutation.value]
									: mutation.value;
								for await (const bytes of input) {
									if (!(bytes instanceof Uint8Array))
										throw new Error("ROWSTORE_VALUE");
									for (let position = 0; position < bytes.length; ) {
										const take = Math.min(
											CHUNK - used,
											bytes.length - position,
										);
										raw.set(bytes.subarray(position, position + take), used);
										position += take;
										used += take;
										length += take;
										if (!Number.isSafeInteger(length))
											throw new Error("ROWSTORE_SIZE");
										if (used === CHUNK) await flush();
									}
								}
								await flush();
							}
							const leaf = Buffer.alloc(NODE);
							leaf[0] = 1;
							leaf.writeInt8(-1, 1);
							leaf[2] = mutation.value === null ? 1 : 0;
							leaf.writeBigUInt64LE(BigInt(mutation.id), 8);
							leaf.writeBigUInt64LE(BigInt(start), 16);
							leaf.writeBigUInt64LE(BigInt(length), 24);
							leaf.writeBigUInt64LE(BigInt(append.end - start), 32);
							state.rows +=
								(mutation.value === null ? 0 : 1) -
								(previous && !previous.deleted ? 1 : 0);
							state.root = await replace(
								state.root,
								mutation.id,
								await appendNode(append, leaf),
								append,
							);
						}
						await append.flush();
						state.end = append.end;
						state.sequence++;
						await hook?.("appended");
						await file.sync();
						await hook?.("data-synced");
						await publish(this.directory, state, this.resources, hook);
					},
					"r+",
				);
			}),
		);
	}
}

export class RowSnapshot {
	constructor(
		private directory: string,
		private state: State,
		private resources: DatabaseResources,
	) {}
	get rows() {
		return this.state.rows;
	}
	get sequence() {
		return this.state.sequence;
	}
	private async locate(id: number) {
		validID(id);
		return this.resources.withWorking(4096, () =>
			this.resources.file(join(this.directory, this.state.file), (file) =>
				find(this.state, id, (at, bytes) => readExact(file, bytes, at)),
			),
		);
	}
	async has(id: number): Promise<boolean> {
		const node = await this.locate(id);
		return !!node && !node.deleted;
	}
	async *read(id: number): AsyncGenerator<Buffer> {
		const node = await this.locate(id);
		if (!node || node.deleted) return;
		let position = Number(node.bytes.readBigUInt64LE(16)),
			remaining = Number(node.bytes.readBigUInt64LE(24));
		const span = Number(node.bytes.readBigUInt64LE(32)),
			end = position + span;
		if (
			!integer(position) ||
			!integer(remaining) ||
			!integer(span) ||
			position < HEADER ||
			!integer(end) ||
			end > node.offset ||
			(remaining === 0 && span !== 0)
		)
			throw new Error("ROWSTORE_VALUE_BOUNDS");
		while (remaining) {
			const chunk = await this.resources.withWorking(WORKING, () =>
				this.resources.file(
					join(this.directory, this.state.file),
					async (file) => {
						if (position + 16 > end) throw new Error("ROWSTORE_CHUNK_BOUNDS");
						const entry = Buffer.alloc(16);
						await readExact(file, entry, position);
						const length = entry.readUInt32LE(),
							raw = entry.readUInt32LE(4);
						if (
							checksum(entry.subarray(0, 12)) !== entry.readUInt32LE(12) ||
							!length ||
							length > CHUNK + 1024 ||
							!raw ||
							raw > CHUNK ||
							raw > remaining ||
							position + 16 + length > end
						)
							throw new Error("ROWSTORE_CHUNK_BOUNDS");
						const encoded = Buffer.allocUnsafe(length);
						await readExact(file, encoded, position + 16);
						const bytes = this.state.compression
							? gunzipSync(encoded, { maxOutputLength: CHUNK })
							: encoded;
						if (
							bytes.length !== raw ||
							checksum(bytes) !== entry.readUInt32LE(8)
						)
							throw new Error("ROWSTORE_CHECKSUM");
						position += 16 + length;
						remaining -= raw;
						if (!remaining && position !== end)
							throw new Error("ROWSTORE_VALUE_BOUNDS");
						return bytes;
					},
				),
			);
			yield chunk; // Returned bytes belong to the caller, outside the engine budget.
		}
	}
}
