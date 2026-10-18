import { type FileHandle, open } from "node:fs/promises";
import { resolve } from "node:path";

const integer = (value: string | undefined, fallback: number, min: number) => {
	if (value === undefined) return fallback;
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < min)
		throw new Error(`INVALID_MEMORY_CONFIGURATION: ${value}`);
	return number;
};

/** Shared across every instance opening the same database in this process. */
export class DatabaseResources {
	readonly limit = integer(
		process.env.INIBASE_MEMORY_BYTES,
		16 * 1024 * 1024,
		256 * 1024,
	);
	readonly handleLimit = integer(process.env.INIBASE_MAX_OPEN_FILES, 32, 4);
	private readonly cache = new Map<string, { value: unknown; bytes: number }>();
	private readonly handles = new Map<
		string,
		{ handle: FileHandle; users: number; flags: string }
	>();
	private readonly opening = new Map<string, Promise<FileHandle>>();
	private readonly waiters = new Set<() => void>();
	private used = 0;
	private peak = 0;
	private closed = false;
	private closing = 0;
	private working = 0;
	private peakAccounted = 0;
	private readonly memoryWaiters = new Set<() => void>();
	private maintenance: Promise<void> | undefined;
	private maintenanceRuns = 0;
	private maintenanceErrors = 0;
	private maintenanceError: string | undefined;

	get<T>(key: string): T | undefined {
		const entry = this.cache.get(key);
		if (!entry) return undefined;
		this.cache.delete(key);
		this.cache.set(key, entry);
		return entry.value as T;
	}

	set(key: string, value: unknown, bytes: number): void {
		this.delete(key);
		if (bytes > this.limit - this.working) return;
		while (this.used + this.working + bytes > this.limit) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.delete(oldest);
		}
		this.cache.set(key, { value, bytes });
		this.used += bytes;
		this.peak = Math.max(this.peak, this.used);
		this.peakAccounted = Math.max(this.peakAccounted, this.used + this.working);
	}

	/** Reserve before allocating. Concurrent maintenance shares the cache budget. */
	async withWorking<T>(bytes: number, fn: () => Promise<T>): Promise<T> {
		if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.limit)
			throw new Error("MEMORY_RESERVATION_TOO_LARGE");
		for (;;) {
			if (this.closed) throw new Error("DATABASE_RESOURCES_CLOSED");
			if (this.working + bytes <= this.limit) break;
			await new Promise<void>((resolve) => this.memoryWaiters.add(resolve));
		}
		while (this.used + this.working + bytes > this.limit) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.delete(oldest);
		}
		this.working += bytes;
		this.peakAccounted = Math.max(this.peakAccounted, this.used + this.working);
		try {
			return await fn();
		} finally {
			this.working -= bytes;
			for (const wake of this.memoryWaiters) wake();
			this.memoryWaiters.clear();
		}
	}

	/** One task for the entire database, no accumulating background queue. */
	tryMaintenance(fn: () => Promise<void>): boolean {
		if (this.closed || this.maintenance) return false;
		this.maintenance = Promise.resolve()
			.then(fn)
			.then(() => {
				this.maintenanceRuns++;
			})
			.catch((error) => {
				this.maintenanceErrors++;
				this.maintenanceError = String(error?.message ?? error).slice(0, 512);
			})
			.finally(() => {
				this.maintenance = undefined;
			});
		return true;
	}

	async drainMaintenance(): Promise<void> {
		await this.maintenance;
	}

	delete(key: string): void {
		const old = this.cache.get(key);
		if (old) this.used -= old.bytes;
		this.cache.delete(key);
	}

	dropPrefix(prefix: string): void {
		for (const key of this.cache.keys())
			if (key.startsWith(prefix)) this.delete(key);
	}

	private wake(): void {
		for (const wake of this.waiters) wake();
		this.waiters.clear();
	}

	/** Pinned handles cannot be evicted. Opening reservations count toward the cap. */
	async file<T>(
		path: string,
		fn: (handle: FileHandle) => Promise<T>,
		flags = "r",
	): Promise<T> {
		for (;;) {
			if (this.closed) throw new Error("DATABASE_RESOURCES_CLOSED");
			const entry = this.handles.get(path);
			if (entry) {
				if (flags !== "r" && entry.flags === "r") {
					await this.releaseFile(path);
					continue;
				}
				entry.users++;
				this.handles.delete(path);
				this.handles.set(path, entry);
				try {
					return await fn(entry.handle);
				} finally {
					entry.users--;
					this.wake();
				}
			}
			const opening = this.opening.get(path);
			if (opening) {
				await opening;
				continue;
			}
			if (
				this.handles.size + this.opening.size + this.closing >=
				this.handleLimit
			) {
				let removed = false;
				for (const [oldPath, old] of this.handles) {
					if (old.users) continue;
					this.handles.delete(oldPath);
					this.closing++;
					try {
						await old.handle.close();
					} finally {
						this.closing--;
						this.wake();
					}
					removed = true;
					break;
				}
				if (!removed) await new Promise<void>((done) => this.waiters.add(done));
				continue;
			}
			const pending = open(path, flags);
			this.opening.set(path, pending);
			try {
				const handle = await pending;
				this.handles.set(path, { handle, users: 0, flags });
			} finally {
				this.opening.delete(path);
				this.wake();
			}
		}
	}

	async releaseFile(path: string): Promise<void> {
		for (;;) {
			const entry = this.handles.get(path);
			if (!entry) return;
			if (entry.users) {
				await new Promise<void>((done) => this.waiters.add(done));
				continue;
			}
			this.handles.delete(path);
			this.closing++;
			try {
				await entry.handle.close();
			} finally {
				this.closing--;
				this.wake();
			}
			this.wake();
			return;
		}
	}

	stats() {
		return {
			limitBytes: this.limit,
			cacheBytes: this.used,
			peakCacheBytes: this.peak,
			workingBytes: this.working,
			peakAccountedBytes: this.peakAccounted,
			maintenanceActive: Boolean(this.maintenance),
			maintenanceRuns: this.maintenanceRuns,
			maintenanceErrors: this.maintenanceErrors,
			maintenanceLastError: this.maintenanceError,
			cachedEntries: this.cache.size,
			openFiles: this.handles.size + this.opening.size + this.closing,
			maxOpenFiles: this.handleLimit,
		};
	}

	async releaseIdleFiles(): Promise<void> {
		for (const [path, entry] of this.handles)
			if (!entry.users) await this.releaseFile(path);
	}

	async close(): Promise<void> {
		await this.drainMaintenance();
		for (const pending of this.opening.values()) await pending;
		for (const path of this.handles.keys()) await this.releaseFile(path);
		this.cache.clear();
		this.used = 0;
		this.closed = true;
		this.wake();
	}
}

const databases = new Map<string, DatabaseResources>();
const owners = new Map<string, number>();
export const resourcesFor = (databasePath: string): DatabaseResources => {
	const key = resolve(databasePath);
	let resources = databases.get(key);
	if (!resources) {
		resources = new DatabaseResources();
		databases.set(key, resources);
	}
	return resources;
};

export const registerDatabase = (path: string): DatabaseResources => {
	const key = resolve(path);
	owners.set(key, (owners.get(key) ?? 0) + 1);
	return resourcesFor(path);
};

export const releaseDatabase = async (path: string): Promise<void> => {
	const key = resolve(path);
	const count = (owners.get(key) ?? 1) - 1;
	if (count > 0) {
		owners.set(key, count);
		return;
	}
	owners.delete(key);
	const resources = databases.get(key);
	if (resources) {
		await resources.close();
		databases.delete(key);
	}
};
