/** Bounded external partitioning for an immutable on-disk linear-probe ID index. */
import { type FileHandle, open, unlink } from "node:fs/promises";
import { readExact, writeExact } from "./seek.js";
import { checksum } from "./updatelog.js";

const HEADER = 256;
export const ROW_SLOT_BYTES = 32;
const PAGE = 32768;
const SLOTS = PAGE / ROW_SLOT_BYTES;

export async function closeRowHandles(handles: FileHandle[]): Promise<void> {
	const results = await Promise.allSettled(
		handles.map((handle) => handle.close()),
	);
	for (const result of results)
		if (result.status === "rejected") throw result.reason;
}

export const rowBucket = (id: number, capacity: number) =>
	((Math.imul(id >>> 0, 0x9e3779b1) ^
		Math.imul(Math.floor(id / 4294967296), 0x85ebca6b)) >>>
		0) &
	(capacity - 1);

export const verifyRowSlot = (slot: Buffer, offset = 0) => {
	if (slot.readBigUInt64LE(offset) === 0n) {
		for (let i = offset; i < offset + ROW_SLOT_BYTES; i++)
			if (slot[i] !== 0) throw new Error("ROWPACK_SLOT_CHECKSUM");
		return;
	}
	if (
		checksum(slot.subarray(offset, offset + 24)) !==
		slot.readUInt32LE(offset + 24)
	)
		throw new Error("ROWPACK_SLOT_CHECKSUM");
};

export interface RowIndexStats {
	readBytes: number;
	writeBytes: number;
	readCalls: number;
	writeCalls: number;
	partitions: number;
	entries: number;
}

/** The caller synchronizes the final index before publication; spool files are private. */
export async function buildRowIndex(
	spool: string,
	index: FileHandle,
	capacity: number,
	expectedRows: number,
	hook?: () => void | Promise<void>,
): Promise<RowIndexStats> {
	const stats: RowIndexStats = {
		readBytes: 0,
		writeBytes: 0,
		readCalls: 0,
		writeCalls: 0,
		partitions: 0,
		entries: 0,
	};
	const read = async (handle: FileHandle, bytes: Buffer, offset: number) => {
		await readExact(handle, bytes, offset);
		stats.readBytes += bytes.length;
		stats.readCalls++;
	};
	const write = async (handle: FileHandle, bytes: Buffer, offset: number) => {
		await writeExact(handle, bytes, offset);
		stats.writeBytes += bytes.length;
		stats.writeCalls++;
	};
	// One reusable workspace for every recursion level, including pathological
	// hash distributions. No in-memory bucket lists or map of record locations.
	const workspace = Buffer.allocUnsafe(PAGE * 4);
	const input = workspace.subarray(0, PAGE);
	const output = [
		workspace.subarray(PAGE, PAGE * 2),
		workspace.subarray(PAGE * 2, PAGE * 3),
	];
	const page = workspace.subarray(PAGE * 3);
	let cached = -1,
		dirty = false,
		cachedBytes = 0,
		sequence = 0;
	const flushPage = async () => {
		if (dirty)
			await write(index, page.subarray(0, cachedBytes), HEADER + cached * PAGE);
		dirty = false;
	};
	const loadPage = async (number: number) => {
		if (cached === number) return;
		await flushPage();
		cachedBytes = Math.min(PAGE, capacity * ROW_SLOT_BYTES - number * PAGE);
		await read(index, page.subarray(0, cachedBytes), HEADER + number * PAGE);
		cached = number;
	};
	const insert = async (entry: Buffer) => {
		verifyRowSlot(entry);
		const key = entry.readBigUInt64LE(),
			id = Number(key - 1n);
		if (!key || !Number.isSafeInteger(id) || id < 0)
			throw new Error("ROWPACK_ID");
		let position = rowBucket(id, capacity);
		for (
			let probes = 0;
			probes < capacity;
			probes++, position = (position + 1) & (capacity - 1)
		) {
			if (cached !== Math.floor(position / SLOTS))
				await loadPage(Math.floor(position / SLOTS));
			const within = (position % SLOTS) * ROW_SLOT_BYTES;
			verifyRowSlot(page, within);
			const observed = page.readBigUInt64LE(within);
			if (observed === key) throw new Error("ROWPACK_DUPLICATE_ID");
			if (!observed) {
				entry.copy(page, within);
				dirty = true;
				stats.entries++;
				return;
			}
		}
		throw new Error("ROWPACK_INDEX_FULL");
	};
	const visit = async (sourceIndex: number, bit: number): Promise<number[]> => {
		const source = sourceIndex < 0 ? spool : `${spool}.part-${sourceIndex}`;
		const handles: FileHandle[] = [];
		const children = [sequence++, sequence++];
		let partitioned = false;
		try {
			const reader = await open(source, "r");
			handles.push(reader);
			const size = (await reader.stat()).size;
			if (size % ROW_SLOT_BYTES) throw new Error("ROWPACK_SPOOL_SIZE");
			if (source === spool && size !== expectedRows * ROW_SLOT_BYTES)
				throw new Error("ROWPACK_SPOOL_SIZE");
			if (size && bit >= Math.log2(SLOTS)) {
				const left = await open(`${spool}.part-${children[0]}`, "wx");
				handles.push(left);
				const right = await open(`${spool}.part-${children[1]}`, "wx");
				handles.push(right);
				const writers = [left, right],
					used = [0, 0],
					positions = [0, 0];
				const flush = async (side: number) => {
					if (!used[side]) return;
					await write(
						writers[side],
						output[side].subarray(0, used[side]),
						positions[side],
					);
					positions[side] += used[side];
					used[side] = 0;
				};
				for (let offset = 0; offset < size; offset += PAGE) {
					const length = Math.min(PAGE, size - offset);
					await read(reader, input.subarray(0, length), offset);
					for (let at = 0; at < length; at += ROW_SLOT_BYTES) {
						verifyRowSlot(input, at);
						const id = Number(input.readBigUInt64LE(at) - 1n);
						if (!Number.isSafeInteger(id) || id < 0)
							throw new Error("ROWPACK_ID");
						const side = (rowBucket(id, capacity) >>> bit) & 1;
						input.copy(output[side], used[side], at, at + ROW_SLOT_BYTES);
						used[side] += ROW_SLOT_BYTES;
						if (used[side] === PAGE) await flush(side);
					}
				}
				await flush(0);
				await flush(1);
				partitioned = true;
				stats.partitions++;
			} else {
				for (let offset = 0; offset < size; offset += PAGE) {
					const length = Math.min(PAGE, size - offset);
					await read(reader, input.subarray(0, length), offset);
					for (let at = 0; at < length; at += ROW_SLOT_BYTES)
						await insert(input.subarray(at, at + ROW_SLOT_BYTES));
				}
			}
		} finally {
			await closeRowHandles(handles);
		}
		await unlink(source);
		if (partitioned) {
			await hook?.();
		}
		return partitioned ? children : [];
	};
	// The work stack holds at most log2(capacity) number/bit pairs. Processing
	// each partition returns before its children, releasing closed handles and
	// closures rather than retaining them through recursive async frames.
	const pending = [{ source: -1, bit: Math.log2(capacity) - 1 }];
	while (pending.length) {
		const task = pending.pop();
		if (!task) break;
		const children = await visit(task.source, task.bit);
		for (let i = children.length - 1; i >= 0; i--)
			pending.push({ source: children[i], bit: task.bit - 1 });
	}
	if (stats.entries !== expectedRows) throw new Error("ROWPACK_ROW_COUNT");
	await flushPage();
	return stats;
}
