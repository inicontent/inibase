import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { DatabaseResources } from "./resources.js";

export interface OverlayValue {
	cols: Record<string, unknown>;
	updatedAt?: number;
	deleted?: boolean;
}

const host = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);

/**
 * Rebuildable, process-private overlay. A sparse on-disk numeric-ID directory
 * points at the latest encoded value. No table-sized Map or replay buffer.
 * The durable update log is the only authority; these files need no fsync.
 */
export class DiskOverlay {
	readonly prefix: string;
	private readonly directory: string;
	private readonly values: string;
	private readonly keys: string;
	private ready: Promise<void> | undefined;
	private end = 0;
	size = 0;

	constructor(
		tablePath: string,
		private readonly resources: DatabaseResources,
	) {
		this.prefix = join(
			tablePath,
			".cache",
			`overlay-${host}-${process.pid}-${randomUUID()}`,
		);
		this.directory = `${this.prefix}.ids`;
		this.values = `${this.prefix}.values`;
		this.keys = `${this.prefix}.keys`;
	}

	private initialize(): Promise<void> {
		if (this.ready) return this.ready;
		this.ready = (async () => {
			const cache = join(this.prefix, "..");
			await mkdir(cache, { recursive: true });
			for (const name of await readdir(cache)) {
				const match = new RegExp(
					`^overlay-${host}-(\\d+)-[0-9a-f-]+\\.(?:ids|values|keys)$`,
				).exec(name);
				if (!match || Number(match[1]) === process.pid) continue;
				try {
					process.kill(Number(match[1]), 0);
				} catch (error: any) {
					if (error?.code === "ESRCH")
						await unlink(join(cache, name)).catch(() => {});
				}
			}
			for (const path of [this.directory, this.values, this.keys]) {
				const handle = await open(path, "wx");
				await handle.close();
			}
		})();
		return this.ready;
	}

	private offset(id: string | number): number {
		const number = Number(id);
		if (
			!Number.isSafeInteger(number) ||
			number < 0 ||
			number > Number.MAX_SAFE_INTEGER / 8
		)
			throw new Error(`INVALID_INTERNAL_ID: ${id}`);
		return number * 8;
	}

	private async pointer(id: string | number): Promise<number> {
		const offset = this.offset(id);
		const pageOffset = Math.floor(offset / 4096) * 4096;
		const key = `${this.prefix}:page:${pageOffset}`;
		let page = this.resources.get<Buffer>(key);
		if (!page) {
			page = Buffer.alloc(4096);
			await this.resources.file(this.directory, async (handle) => {
				await handle.read(page as Buffer, 0, 4096, pageOffset);
			});
			this.resources.set(key, page, 4096 + 256);
		}
		return Number(page.readBigUInt64LE(offset - pageOffset));
	}

	async get(id: string | number): Promise<OverlayValue | undefined> {
		await this.initialize();
		const key = `${this.prefix}:row:${id}`;
		const cached = this.resources.get<OverlayValue>(key);
		if (cached) return cached;
		const pointer = await this.pointer(id);
		if (!pointer) return undefined;
		return this.resources.file(this.values, async (handle) => {
			const header = Buffer.allocUnsafe(4);
			await handle.read(header, 0, 4, pointer - 1);
			const buffer = Buffer.allocUnsafe(header.readUInt32LE(0));
			let read = 0;
			while (read < buffer.length) {
				const { bytesRead } = await handle.read(
					buffer,
					read,
					buffer.length - read,
					pointer + 3 + read,
				);
				if (!bytesRead) throw new Error("OVERLAY_CACHE_TRUNCATED");
				read += bytesRead;
			}
			const { value } = JSON.parse(buffer.toString("utf8"));
			this.resources.set(key, value, buffer.length * 4 + 512);
			return value as OverlayValue;
		});
	}

	async set(id: string | number, value: OverlayValue): Promise<void> {
		await this.initialize();
		const exists = await this.pointer(id);
		const buffer = Buffer.from(JSON.stringify({ id: String(id), value }));
		const header = Buffer.allocUnsafe(4);
		header.writeUInt32LE(buffer.length);
		const start = this.end;
		await this.resources.file(
			this.values,
			async (handle) => {
				await handle.writeFile(Buffer.concat([header, buffer]));
			},
			"a+",
		);
		const pointer = Buffer.allocUnsafe(8);
		pointer.writeBigUInt64LE(BigInt(start + 1));
		if (!exists) {
			const key = Buffer.allocUnsafe(8);
			key.writeBigUInt64LE(BigInt(id));
			await this.resources.file(
				this.keys,
				(handle) => handle.writeFile(key),
				"a+",
			);
		}
		await this.resources.file(
			this.directory,
			async (directory) => {
				let written = 0;
				while (written < 8) {
					const { bytesWritten } = await directory.write(
						pointer,
						written,
						8 - written,
						this.offset(id) + written,
					);
					if (!bytesWritten) throw new Error("OVERLAY_CACHE_SHORT_WRITE");
					written += bytesWritten;
				}
			},
			"r+",
		);
		this.end = start + 4 + buffer.length;
		const offset = this.offset(id);
		const pageOffset = Math.floor(offset / 4096) * 4096;
		// A successful positional write updates the cached directory page too.
		// No page allocation is needed when it has already been evicted.
		this.resources
			.get<Buffer>(`${this.prefix}:page:${pageOffset}`)
			?.writeBigUInt64LE(BigInt(start + 1), offset - pageOffset);
		this.resources.set(
			`${this.prefix}:row:${id}`,
			value,
			buffer.length * 4 + 512,
		);
		if (!exists) this.size++;
	}

	async *entries(): AsyncGenerator<[string, OverlayValue]> {
		await this.initialize();
		const snapshot = this.size * 8;
		// A dense first-seen-ID stream avoids decoding obsolete values and avoids
		// scanning sparse holes for large IDs. No descriptor is pinned at yield.
		for (let position = 0; position < snapshot; position += 4096) {
			const keys = Buffer.allocUnsafe(Math.min(4096, snapshot - position));
			await this.resources.file(this.keys, async (handle) => {
				let read = 0;
				while (read < keys.length) {
					const { bytesRead } = await handle.read(
						keys,
						read,
						keys.length - read,
						position + read,
					);
					if (!bytesRead) throw new Error("OVERLAY_CACHE_TRUNCATED");
					read += bytesRead;
				}
			});
			for (let offset = 0; offset < keys.length; offset += 8) {
				const id = keys.readBigUInt64LE(offset).toString();
				const value = await this.get(id);
				if (!value) throw new Error("OVERLAY_CACHE_MISSING_VALUE");
				yield [id, value];
			}
		}
	}

	async clear(): Promise<void> {
		if (this.ready) await this.ready;
		if (!this.ready) return;
		for (const path of [this.directory, this.values, this.keys]) {
			await this.resources.releaseFile(path);
			await unlink(path).catch((error: any) => {
				if (error?.code !== "ENOENT") throw error;
			});
		}
		this.resources.dropPrefix(this.prefix);
		this.ready = undefined;
		this.end = 0;
		this.size = 0;
	}
}
