import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, open, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import {
	decodeHeader,
	encodeHeader,
	pathContentStamp,
	readExact,
	writeExact,
} from "./seek.js";
import { checksum } from "./updatelog.js";

const HEADER = 256;
const ENTRY = 44;
const BUCKET = 16;
const hash = (key: string) =>
	createHash("sha256").update(key).digest().subarray(0, 16);

async function* cells(
	path: string,
	compressed: boolean,
	maxCellBytes = Infinity,
): AsyncGenerator<string> {
	const source = createReadStream(path);
	const input = compressed ? source.pipe(createGunzip()) : source;
	if (Number.isFinite(maxCellBytes)) {
		let pieces: Buffer[] = [],
			length = 0;
		try {
			for await (const chunk of input) {
				const bytes = chunk as Buffer;
				let start = 0;
				for (;;) {
					const end = bytes.indexOf(10, start);
					const part = bytes.subarray(start, end < 0 ? bytes.length : end);
					length += part.length;
					if (length > maxCellBytes) throw new Error("AUTOMATIC_BUILD_BUDGET");
					pieces.push(part);
					if (end < 0) break;
					yield Buffer.concat(pieces, length)
						.toString("utf8")
						.replace(/\r$/, "");
					pieces = [];
					length = 0;
					start = end + 1;
				}
			}
			if (length)
				yield Buffer.concat(pieces, length).toString("utf8").replace(/\r$/, "");
		} finally {
			input.destroy();
			source.destroy();
		}
		return;
	}
	const lines = createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) yield line;
	} finally {
		lines.close();
		input.destroy();
		source.destroy();
	}
}

/** Immutable disk index, published in the same journal as its primary column. */
export const prepareKeyIndex = async (
	tmp: string,
	live: string,
	idTmp: string,
	idLive: string,
	maxCellBytes = Infinity,
): Promise<[string, string]> => {
	const indexTmp = `${tmp}.lookup`;
	const output = await open(indexTmp, "wx");
	const numeric = live === idLive;
	const idReader = numeric
		? undefined
		: cells(idTmp, idLive.endsWith(".gz"), maxCellBytes);
	let rows = 0,
		safe = true;
	try {
		const seek = await open(`${tmp}.seek`, "r");
		const headerBuffer = Buffer.alloc(HEADER);
		try {
			await readExact(seek, headerBuffer, 0);
		} finally {
			await seek.close();
		}
		const count = decodeHeader(headerBuffer).rows;
		const buckets = numeric
			? 0
			: Math.min(65536, 2 ** Math.ceil(Math.log2(Math.max(64, count / 2))));
		const heads = Buffer.alloc(buckets * BUCKET);
		await output.writeFile(Buffer.alloc(HEADER + heads.length));
		const buffer = Buffer.allocUnsafe(64 * 1024 - ((64 * 1024) % ENTRY));
		let used = 0;
		// Dense numeric ids are buffered; holes use positioned writes, not a Map.
		let numericStart = 0,
			numericNext = 0;
		const flush = async () => {
			if (!used) return;
			if (numeric)
				await writeExact(
					output,
					buffer.subarray(0, used),
					HEADER + numericStart * BUCKET,
				);
			else await output.writeFile(buffer.subarray(0, used));
			used = 0;
		};
		for await (const raw of cells(tmp, live.endsWith(".gz"), maxCellBytes)) {
			const idValue = numeric ? raw : (await idReader?.next())?.value;
			const id = Number(idValue);
			if (
				!Number.isSafeInteger(id) ||
				id < 0 ||
				id > Number.MAX_SAFE_INTEGER / BUCKET
			)
				throw new Error("INVALID_INTERNAL_ID");
			rows++;
			if (numeric) {
				if (used && id !== numericNext) await flush();
				if (!used) numericStart = id;
				if (used + BUCKET > buffer.length) {
					await flush();
					numericStart = id;
				}
				buffer.writeBigUInt64LE(BigInt(rows), used);
				buffer.writeUInt32LE(
					checksum(buffer.subarray(used, used + 8)),
					used + 8,
				);
				buffer.fill(0, used + 12, used + BUCKET);
				used += BUCKET;
				numericNext = id + 1;
			} else {
				if (raw.startsWith("[") || raw.startsWith("{")) safe = false;
				if (used + ENTRY > buffer.length) await flush();
				const digest = hash(raw);
				const bucket = digest.readUInt32LE(0) % buckets;
				digest.copy(buffer, used);
				buffer.writeBigUInt64LE(BigInt(id), used + 16);
				buffer.writeBigUInt64LE(BigInt(rows), used + 24);
				buffer.writeBigUInt64LE(
					heads.readBigUInt64LE(bucket * BUCKET),
					used + 32,
				);
				buffer.writeUInt32LE(
					checksum(buffer.subarray(used, used + 40)),
					used + 40,
				);
				heads.writeBigUInt64LE(BigInt(rows), bucket * BUCKET);
				used += ENTRY;
			}
		}
		await flush();
		for (let bucket = 0; bucket < buckets; bucket++)
			heads.writeUInt32LE(
				(checksum(heads.subarray(bucket * BUCKET, bucket * BUCKET + 8)) ^
					bucket) >>>
					0,
				bucket * BUCKET + 8,
			);
		if (idReader && !(await idReader.next()).done)
			throw new Error("INDEX_COLUMN_ALIGNMENT");
		if (rows !== count) throw new Error("INDEX_COLUMN_ALIGNMENT");
		await writeExact(
			output,
			encodeHeader({
				v: 1,
				kind: numeric ? "numeric-id" : "hash128",
				stamp: await pathContentStamp(tmp),
				idStamp: numeric ? undefined : await pathContentStamp(idTmp),
				idFile: idLive.slice(idLive.lastIndexOf("/") + 1),
				buckets,
				rows,
				safe,
				entry: numeric ? BUCKET : ENTRY,
			}),
			0,
		);
		if (heads.length) await writeExact(output, heads, HEADER);
		await output.close();
		return [indexTmp, `${live}.lookup`];
	} catch (error) {
		await output.close().catch(() => {});
		await unlink(indexTmp).catch(() => {});
		throw error;
	} finally {
		await idReader?.return(undefined);
	}
};

/** Hash collisions are candidates only; File.search always verifies the cell. */
export const lookupLines = async (
	path: string,
	patterns: string[],
	idPath?: string,
): Promise<number[] | null> => {
	let index: FileHandle;
	try {
		index = await open(`${path}.lookup`, "r");
	} catch (error: any) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
	try {
		const headerBuffer = Buffer.alloc(HEADER);
		await readExact(index, headerBuffer, 0);
		const header = decodeHeader(headerBuffer);
		if (
			!idPath &&
			typeof header.idFile === "string" &&
			!header.idFile.includes("/") &&
			!header.idFile.includes("..")
		)
			idPath = path.slice(0, path.lastIndexOf("/") + 1) + header.idFile;
		if (
			header.v !== 1 ||
			!header.safe ||
			header.stamp !== (await pathContentStamp(path)) ||
			(header.idStamp &&
				(!idPath || header.idStamp !== (await pathContentStamp(idPath))))
		)
			return null;
		const result: number[] = [];
		if (header.kind === "numeric-id") {
			if (header.entry !== BUCKET) return null;
			const size = (await index.stat()).size;
			const pointer = Buffer.alloc(BUCKET);
			for (const key of patterns) {
				const id = Number(key);
				if (
					!Number.isSafeInteger(id) ||
					id < 0 ||
					id > (size - HEADER - BUCKET) / BUCKET
				)
					continue;
				await readExact(index, pointer, HEADER + id * BUCKET);
				const line = Number(pointer.readBigUInt64LE());
				if (
					(line || pointer.readUInt32LE(8)) &&
					checksum(pointer.subarray(0, 8)) !== pointer.readUInt32LE(8)
				)
					throw new Error("INDEX_POINTER_CHECKSUM");
				if (line > 0 && line <= header.rows) result.push(line);
			}
		} else if (
			header.kind === "hash128" &&
			header.buckets > 0 &&
			header.buckets <= 65536
		) {
			if (
				header.entry !== ENTRY ||
				(await index.stat()).size !==
					HEADER + header.buckets * BUCKET + header.rows * ENTRY
			)
				return null;
			const pointer = Buffer.alloc(BUCKET),
				entry = Buffer.alloc(ENTRY);
			for (const key of patterns) {
				const digest = hash(key);
				const bucket = digest.readUInt32LE(0) % header.buckets;
				await readExact(index, pointer, HEADER + bucket * BUCKET);
				if (
					(checksum(pointer.subarray(0, 8)) ^ bucket) >>> 0 !==
					pointer.readUInt32LE(8)
				)
					throw new Error("INDEX_BUCKET_CHECKSUM");
				let current = Number(pointer.readBigUInt64LE());
				let visited = 0;
				while (current) {
					if (++visited > header.rows || current > header.rows)
						throw new Error("INDEX_CHAIN_CORRUPT");
					await readExact(
						index,
						entry,
						HEADER + header.buckets * BUCKET + (current - 1) * ENTRY,
					);
					if (checksum(entry.subarray(0, 40)) !== entry.readUInt32LE(40))
						throw new Error("INDEX_ENTRY_CHECKSUM");
					if (entry.subarray(0, 16).equals(digest))
						result.push(Number(entry.readBigUInt64LE(24)));
					const next = Number(entry.readBigUInt64LE(32));
					if (next >= current) throw new Error("INDEX_CHAIN_CORRUPT");
					current = next;
				}
			}
		} else return null;
		return Array.from(new Set(result)).sort((a, b) => a - b);
	} finally {
		await index.close();
	}
};
