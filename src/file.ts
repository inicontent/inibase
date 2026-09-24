import { AsyncLocalStorage } from "node:async_hooks";
import type { WriteStream } from "node:fs";
import {
	access,
	appendFile,
	copyFile,
	type FileHandle,
	constants as fsConstants,
	open,
	readFile,
	stat,
	unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { Transform, type Transform as TransformType } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import Inison from "inison";
import {
	type ComparisonOperator,
	type Field,
	type FieldType,
	globalConfig,
} from "./index.js";
import { recover } from "./journal.js";
import {
	detectFieldType,
	isArrayOfObjects,
	isNumber,
	isObject,
	isStringified,
	isValidID,
} from "./utils.js";
import {
	compare,
	decodeID,
	encodeID,
	exec,
	gunzip,
	gzip,
} from "./utils.server.js";

// Locks older than this are candidates for removal. Same-host locks are only
// stolen when the recorded owner PID is provably dead; foreign-host locks fall
// back to this TTL (NFS has no reliable cross-host liveness check).
const DEFAULT_LOCK_TTL_MS = Number(process.env.INIBASE_LOCK_TTL_MS ?? 60_000);

// Durability knob: `full` (default) fsyncs every temp file, journal entry and
// directory touch before acknowledging a mutation. `none` skips all fsync
// calls but keeps the write-ahead journal protocol unchanged, so a *process*
// crash (page cache survives) still recovers atomically — only power-loss
// durability is lost. The ACID claim documented in the README holds at `full`.
const DURABILITY = process.env.INIBASE_DURABILITY ?? "full";
export const DURABLE = DURABILITY !== "none";

/** fsync a handle, or no-op when `INIBASE_DURABILITY=none` is set. */
const maybeSync = async (handle: FileHandle): Promise<void> => {
	if (DURABLE) await handle.sync();
};

const LOCK_RETRY_MS = 13;

// Per-process reentrancy: the same process may acquire the same lock file
// multiple times (e.g. post() -> get() -> sort-cache). Depth 1 is a real
// filesystem acquisition; deeper acquisitions just bump the counter.
const lockDepths = new Map<string, number>();
// In-process serialization: sibling tasks (e.g. two concurrent HTTP requests
// posting to the same table) must QUEUE behind the holder instead of passing
// straight through the depth counter. That bypass is exactly what let
// concurrent writers share the fixed `.tmp/<column>` staging path and race the
// pagination rename (diverged column files, duplicate ids, lost rows in the
// Sep-2026 pteam incident). Reentrancy from the *same* logical task (post() ->
// get() -> ensureTableRecovered re-lock, transaction flows) still bumps the
// depth without touching the filesystem, proven by the AsyncLocalStorage
// context recorded at acquisition time.
const lockReleaseWaiters = new Map<string, Set<() => void>>();
const lockOwners = new Map<string, Set<unknown>>();
// Upper bound on in-process wait time: converts a wedged or undetectable
// holder into a visible error instead of a silent hang. 0 disables it.
const LOCK_WAIT_TIMEOUT_MS = Number(
	process.env.INIBASE_LOCK_WAIT_TIMEOUT_MS ?? 120_000,
);
const lockContext = new AsyncLocalStorage<Set<unknown>>();

// Resolve once the holder releases so the waiter can re-race for the lock.
const waitForLockRelease = (resolvedPath: string) =>
	new Promise<void>((resolveWaiter, rejectWaiter) => {
		let waiters = lockReleaseWaiters.get(resolvedPath);
		if (!waiters) {
			waiters = new Set();
			lockReleaseWaiters.set(resolvedPath, waiters);
		}
		let timer: NodeJS.Timeout | null = null;
		const wake = (error?: Error) => {
			waiters.delete(wake);
			if (timer) clearTimeout(timer);
			error ? rejectWaiter(error) : resolveWaiter();
		};
		waiters.add(wake);
		if (LOCK_WAIT_TIMEOUT_MS > 0)
			timer = setTimeout(
				() => wake(new Error(`LOCK_WAIT_TIMEOUT: ${resolvedPath}`)),
				LOCK_WAIT_TIMEOUT_MS,
			);
	});

// The AsyncLocalStorage store of this task chain (created on first acquire).
const currentLockStore = () => {
	let store = lockContext.getStore();
	if (!store) {
		store = new Set();
		lockContext.enterWith(store);
	}
	return store;
};
/**
 * Run `fn` with a per-logical-task lock-owner store on its AsyncLocalStorage
 * context. Every await continuation below `fn` then shares that store, so
 * nested/reentrant acquisitions (put/delete id->line recursion, journal
 * recovery re-locks, transaction flows) see the SAME store the outermost
 * acquisition recorded as owner.
 *
 * Do NOT replace this with an enterWith() from inside lock(): that store is
 * created in lock()'s own frame and (a) never propagates back to the caller's
 * await continuation — every recursion then waits on its OWN lock until the
 * watchdog (LOCK_WAIT_TIMEOUT) — and (b) can leak into sibling tasks, which
 * then pass the writer lock as "reentrant" and re-race the Sep-2026 commit
 * interleave (ENOENT renames, duplicate ids). `run()` gives clean per-op
 * isolation and correct same-chain propagation.
 */
export const runWithLockStore = <T>(fn: () => T): T => {
	if (lockContext.getStore()) return fn();
	const store = new Set();
	return lockContext.run(store, fn);
};

// True when this task already owns the lock (depth > 0 and the recorded owner
// context is this task's context). Bumps the depth and returns.
const isReentrant = (resolvedPath: string) => {
	if (!lockDepths.get(resolvedPath)) return false;
	if (lockOwners.get(resolvedPath) !== lockContext.getStore()) return false;
	lockDepths.set(resolvedPath, lockDepths.get(resolvedPath)! + 1);
	return true;
};

const notifyLockReleased = (resolvedPath: string) => {
	const waiters = lockReleaseWaiters.get(resolvedPath);
	if (!waiters) return;
	lockReleaseWaiters.delete(resolvedPath);
	for (const wake of waiters) wake();
};

const lockFilePathFor = (folderPath: string, prefix?: string) =>
	join(folderPath, `${prefix ?? ""}.locked`);

/**
 * State of the lock's recorded owner, used to decide when a lock may be
 * stolen (see `stealableLock`).
 */
type LockOwnerState = "alive" | "dead" | "unknown";

const lockOwnerState = async (
	lockFilePath: string,
): Promise<LockOwnerState> => {
	try {
		const metadata = JSON.parse(await readFile(lockFilePath, "utf8")) as {
			pid?: number;
			host?: string;
		};
		if (typeof metadata.pid === "number" && metadata.host === hostname()) {
			try {
				process.kill(metadata.pid, 0);
			} catch (error: any) {
				return error?.code === "ESRCH" ? "dead" : "unknown";
			}
			return "alive";
		}
	} catch {
		// No/invalid metadata (e.g. crash between create and metadata write).
	}
	return "unknown"; // foreign host or unparsable metadata
};

/**
 * A lock may be stolen when its owner is provably dead on this host
 * (immediately — a same-host crash must not wedge writers or block crash
 * recovery) or, for foreign/unknown owners where no liveness check exists
 * (e.g. NFS), once the recorded lock is older than the TTL.
 */
const stealableLock = async (
	lockFilePath: string,
	mtimeMs: number,
	ttl: number,
): Promise<boolean> => {
	const state = await lockOwnerState(lockFilePath);
	if (state === "alive") return false;
	if (state === "dead") return true;
	return Date.now() - mtimeMs > ttl;
};

export const lock = async (
	folderPath: string,
	prefix?: string,
	ttl: number = DEFAULT_LOCK_TTL_MS,
): Promise<void> => {
	const lockFilePath = lockFilePathFor(folderPath, prefix);
	const resolvedPath = resolve(lockFilePath);

	for (;;) {
		// Same logical task already holds it -> reentrant depth bump.
		if (isReentrant(resolvedPath)) return;
		// A different in-process task holds it -> wait for the release, then
		// re-race for the filesystem lock like any process.
		if (lockDepths.get(resolvedPath)) {
			await waitForLockRelease(resolvedPath);
			continue;
		}
		try {
			const lockFile = await open(lockFilePath, "wx");
			try {
				await lockFile.writeFile(
					JSON.stringify({
						pid: process.pid,
						host: hostname(),
						startedAt: Date.now(),
					}),
				);
				await maybeSync(lockFile);
			} finally {
				await lockFile.close();
			}
			// The global (prefix-less) lock is the writer lock: run crash
			// recovery for this table while we exclusively hold it. Locked
			// calls with a prefix are read-side helpers (e.g. sort cache) and
			// must never roll back an in-flight transaction.
			if (!prefix) {
				try {
					await recover(folderPath);
				} catch {
					// Recovery is best-effort at lock time; reads retry on
					// torn state, writers re-check before mutating.
				}
			}
			lockDepths.set(resolvedPath, 1);
			lockOwners.set(resolvedPath, currentLockStore());
			return;
		} catch (error: any) {
			const message = String(error?.message ?? error);
			if (message.split(":")[0] !== "EEXIST") throw error;

			const lockStat = await stat(lockFilePath).catch(() => null);
			// Someone else released the lock between our failed open and the
			// stat: retry immediately instead of counting down the TTL.
			if (!lockStat) continue;

			if (await stealableLock(lockFilePath, lockStat.mtimeMs, ttl)) {
				await unlink(lockFilePath).catch(() => {});
			}

			await new Promise<void>((resolvePromise) =>
				setTimeout(() => resolvePromise(), LOCK_RETRY_MS),
			);
		}
	}
};

/**
 * Non-blocking lock acquisition (used by the read path and the open-time
 * recovery sweep). Returns true when the lock was acquired (running crash
 * recovery for prefix-less locks, exactly like `lock`), false when another
 * process holds it. A single stale-lock steal (dead same-host owner, or aged
 * foreign/unknown owner) is attempted so a crashed owner can't wedge readers
 * behind it forever.
 */
export const tryLock = async (
	folderPath: string,
	prefix?: string,
	ttl: number = DEFAULT_LOCK_TTL_MS,
): Promise<boolean> => {
	const lockFilePath = lockFilePathFor(folderPath, prefix);
	const resolvedPath = resolve(lockFilePath);

	if (isReentrant(resolvedPath)) return true;
	if (lockDepths.get(resolvedPath)) return false; // held by another in-process task: non-blocking

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const lockFile = await open(lockFilePath, "wx");
			try {
				await lockFile.writeFile(
					JSON.stringify({
						pid: process.pid,
						host: hostname(),
						startedAt: Date.now(),
					}),
				);
				await maybeSync(lockFile);
			} finally {
				await lockFile.close();
			}
			if (!prefix) {
				try {
					await recover(folderPath);
				} catch {
					// Best-effort at lock time, mirroring `lock`.
				}
			}
			lockDepths.set(resolvedPath, 1);
			lockOwners.set(resolvedPath, currentLockStore());
			return true;
		} catch (error: any) {
			if (String(error?.message ?? error).split(":")[0] !== "EEXIST")
				throw error;

			const lockStat = await stat(lockFilePath).catch(() => null);
			if (!lockStat) continue; // released between open and stat

			if (
				attempt === 0 &&
				(await stealableLock(lockFilePath, lockStat.mtimeMs, ttl))
			)
				await unlink(lockFilePath).catch(() => {});
			else return false; // genuinely held -> don't wait
		}
	}
	return false;
};

export const unlock = async (folderPath: string, prefix?: string) => {
	const lockFilePath = lockFilePathFor(folderPath, prefix);
	const resolvedPath = resolve(lockFilePath);
	const depth = lockDepths.get(resolvedPath);
	if (depth && depth > 1) {
		lockDepths.set(resolvedPath, depth - 1);
		return;
	}
	lockDepths.delete(resolvedPath);
	lockOwners.delete(resolvedPath);
	try {
		await unlink(lockFilePath);
	} catch {
		// Already released (stolen by a foreign-host stealer or cleaned up).
	}
	// Wake in-process waiters so they re-race for the released lock.
	notifyLockReleased(resolvedPath);
};

export const write = async (filePath: string, data: any) => {
	const handle = await open(filePath, "w");
	try {
		await handle.writeFile(filePath.endsWith(".gz") ? await gzip(data) : data);
		await maybeSync(handle);
	} finally {
		await handle.close();
	}
};

/**
 * fsync an existing file. Used to flush temp files (written via streams or
 * shell pipelines) before they are renamed into place.
 */
export const syncFile = async (filePath: string) => {
	let handle: FileHandle | null = null;
	try {
		handle = await open(filePath, "r+");
		await maybeSync(handle);
	} catch {
		// Unsupported filesystem/platform: best effort.
	} finally {
		await handle?.close();
	}
};

/**
 * fsync a directory so that renames performed inside it are durable.
 */
export const syncDir = async (dirPath: string) => {
	let handle: FileHandle | null = null;
	try {
		handle = await open(dirPath, "r");
		await maybeSync(handle);
	} catch {
		// Directory fsync is not supported on every platform/filesystem.
	} finally {
		await handle?.close();
	}
};

export const read = async (filePath: string) =>
	filePath.endsWith(".gz")
		? (await gunzip(await readFile(filePath, "utf8"))).toString()
		: await readFile(filePath, "utf8");

export function escapeShellPath(filePath: string) {
	// Resolve the path to avoid relative path issues
	const resolvedPath = resolve(filePath);

	// Escape double quotes and special shell characters
	return `"${resolvedPath.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * Unique-per-operation staging path: concurrent writers must never share the
 * `.tmp/<column>` file. The fixed name let sibling operations clobber each
 * other's in-progress temp and publish a temp that only contained one writer's
 * content (column files following different winners -> diverged line counts).
 * A pid + per-process counter suffix keeps every temp private; each pair is
 * carried through the rename list and the journal, so commit/rollback/recovery
 * still know exactly which files to move.
 */
let tempSeq = 0;
const tempPathFor = (filePath: string) =>
	filePath.replace(
		/([^/]+)\/?$/,
		`.tmp/$1.${process.pid}-${(tempSeq++).toString(36)}`,
	);

const _pipeline = async (
	filePath: string,
	rl: Interface,
	writeStream: WriteStream,
	transform: TransformType,
): Promise<void> => {
	if (filePath.endsWith(".gz"))
		await pipeline(rl, transform, createGzip(), writeStream);
	else await pipeline(rl, transform, writeStream);
};

/**
 * Creates a readline interface for a given file handle.
 *
 * @param fileHandle - The file handle from which to create a read stream.
 * @returns A readline.Interface instance configured with the provided file stream.
 */
const createReadLineInternface = (filePath: string, fileHandle: FileHandle) =>
	createInterface({
		input: filePath.endsWith(".gz")
			? fileHandle.createReadStream().pipe(createGunzip())
			: fileHandle.createReadStream(),
		crlfDelay: Number.POSITIVE_INFINITY,
	});

/**
 * Checks if a file or directory exists at the specified path.
 *
 * @param path - The path to the file or directory.
 * @returns A Promise that resolves to true if the file/directory exists, false otherwise.
 */
export const isExists = async (path: string) => {
	try {
		await access(path, fsConstants.R_OK | fsConstants.W_OK);
		return true;
	} catch {
		return false;
	}
};

/**
 * Secures input by encoding/escaping characters.
 *
 * @param input - String, number, boolean, or null.
 * @returns Encoded string for true/false, special characters in strings, or original input.
 */
const secureString = (
	input: string | number | boolean | null,
): string | number | boolean | null => {
	if (["true", "false"].includes(String(input))) return input ? 1 : 0;

	if (typeof input !== "string") {
		if (input === null || input === undefined) return "";
		return input;
	}

	let decodedInput = null;
	try {
		decodedInput = decodeURIComponent(input);
	} catch (_error) {
		decodedInput = decodeURIComponent(
			input.replace(/%(?![0-9][0-9a-fA-F]+)/g, ""),
		);
	}

	// Replace characters using a single regular expression.
	return decodedInput.replace(/\r\n|\r|\n/g, "\\n");
};

/**
 * Encodes the input using 'secureString' and 'Inison.stringify' functions.
 * If the input is an array, it is first secured and then joined into a string.
 * If the input is a single value, it is directly secured.
 *
 * @param input - A value or array of values (string, number, boolean, null).
 * @returns The secured and/or joined string.
 */
export const encode = (
	input:
		| string
		| number
		| boolean
		| null
		| (string | number | boolean | null)[],
): string | number | boolean | null =>
	Array.isArray(input)
		? input.every(
				(_input) =>
					_input === null ||
					_input === undefined ||
					_input === "" ||
					(typeof _input === "string" && isStringified(_input)),
			)
			? `[${input.join(",")}]`
			: Inison.stringify(input)
		: secureString(input);

/**
 * Reverses the encoding done by 'secureString'. Replaces encoded characters with their original symbols.
 *
 * @param input - Encoded string.
 * @returns Decoded string or null if input is empty.
 */
const unSecureString = (input: string): string | number | null => {
	if (isNumber(input))
		return String(input).at(0) === "0" ? input : Number(input);

	// Fast path: the common case has no `\n` escape sequence, so avoid
	// allocating a replacement string (and a fresh RegExp) per cell.
	if (typeof input === "string")
		return input.includes("\\n")
			? input.replaceAll("\\n", "\n") || null
			: input;

	return null;
};

/**
 * Decodes a value based on specified field types and optional secret key.
 * Handles different data types and structures, including nested arrays.
 *
 * @param value - The value to be decoded, can be string, number, or array.
 * @param field - Field object config.
 * @returns Decoded value, transformed according to the specified field type(s).
 */
const decodeHelper = (
	value: string | number | any[] | null | undefined,
	field: Field & { databasePath?: string },
): any => {
	if (Array.isArray(value) && field.type !== "array")
		return value.map((v) => decodeHelper(v, field));
	switch (field.type) {
		case "number":
			return isNumber(value) ? Number(value) : null;
		case "boolean":
			return typeof value === "string" ? value === "true" : Boolean(value);
		case "array":
			if (!Array.isArray(value)) value = [value];

			if (field.children && !isArrayOfObjects(field.children))
				return value.map((v) =>
					decode(v, {
						...field,
						type: Array.isArray(field.children)
							? (detectFieldType(v, field.children as FieldType[]) ??
								(field.children[0] as FieldType))
							: (field.children as FieldType),
					}),
				);
			break;
		case "table":
		case "id":
			return isNumber(value) &&
				(!field.table ||
					!field.databasePath ||
					!globalConfig[field.databasePath].tables?.get(field.table)?.config
						.decodeID)
				? encodeID(value)
				: value;
		default:
			return value;
	}
};

/**
 * Decodes the input based on the specified field type(s) and an optional secret key.
 * Handles different formats of input, including strings, numbers, and their array representations.
 *
 * @param input - The input to be decoded, can be a string, number, or null.
 * @param field - Field object config.
 * @returns Decoded value as a string, number, boolean, or array of these, or null if no fieldType or input is null/empty.
 */
export const decode = (
	input: string | null | number,
	field: Field & { databasePath?: string },
):
	| string
	| number
	| boolean
	| null
	| undefined
	| (string | number | null | boolean)[] => {
	if (input === null || input === "") return undefined;

	// Detect the fieldType based on the input and the provided array of possible types.
	// Decode the input using the decodeHelper function.
	let value: any = input;
	if (typeof input === "string") {
		if (isStringified(input)) {
			try {
				value = Inison.unstringify(input);
			} catch {
				// The stored string merely *starts with* `{` or `[`
				// (e.g. a template binding like `{{item.username}}`
				// or a literal like `{hello world`) but is not valid
				// Inison. Treat it as a plain string so a single row
				// never breaks reads of the whole file/table.
				value = unSecureString(input);
			}
		} else value = unSecureString(input);
	}
	return decodeHelper(
		value,
		Array.isArray(field.type)
			? {
					...field,
					type:
						detectFieldType(String(input), field.type) ??
						(field.type[0] as FieldType),
				}
			: field,
	);
};

export function _groupIntoRanges(arr: number[], action: "p" | "d" = "p") {
	if (arr.length === 0) return [];

	arr.sort((a, b) => a - b); // Ensure the array is sorted
	const ranges = [];
	let start = arr[0];
	let end = arr[0];

	for (let i = 1; i < arr.length; i++) {
		if (arr[i] === end + 1) {
			// Continue the range
			end = arr[i];
		} else {
			// End the current range and start a new one
			ranges.push(start === end ? `${start}` : `${start},${end}`);
			start = arr[i];
			end = arr[i];
		}
	}

	// Push the last range
	ranges.push(start === end ? `${start}` : `${start},${end}`);
	return ranges.map((range) => `${range}${action}`).join(";");
}

/**
 * Asynchronously reads and decodes data from a file at specified line numbers.
 * Decodes each line based on specified field types and an optional secret key.
 *
 * @param filePath - Path of the file to be read.
 * @param lineNumbers - Optional line number(s) to read from the file. If -1, reads the last line.
 * @param field - Field object config.
 * @param readWholeFile - Optional Flag to indicate whether to continue reading the file after reaching the limit.
 * @returns Promise resolving to a tuple:
 *   1. Record of line numbers and their decoded content or null if no lines are read.
 *   2. Total count of lines processed.
 */
export function get(
	filePath: string,
	lineNumbers?: number | number[],
	field?: Field & { databasePath?: string },
	readWholeFile?: false,
): Promise<Record<
	number,
	| string
	| number
	| boolean
	| null
	| undefined
	| (string | number | boolean | (string | number | boolean)[] | null)[]
> | null>;
export function get(
	filePath: string,
	lineNumbers: undefined | number | number[],
	field: undefined | (Field & { databasePath?: string }),
	readWholeFile: true,
): Promise<
	[
		Record<
			number,
			| string
			| number
			| boolean
			| null
			| undefined
			| (string | number | boolean | (string | number | boolean)[] | null)[]
		> | null,
		number,
	]
>;
export async function get(
	filePath: string,
	lineNumbers?: number | number[],
	field?: Field & { databasePath?: string },
	readWholeFile = false,
): Promise<
	| Record<
			number,
			| string
			| number
			| boolean
			| null
			| undefined
			| (string | number | boolean | (string | number | boolean)[] | null)[]
	  >
	| null
	| [
			Record<
				number,
				| string
				| number
				| boolean
				| null
				| undefined
				| (string | number | boolean | (string | number | boolean)[] | null)[]
			> | null,
			number,
	  ]
> {
	let fileHandle = null;

	try {
		fileHandle = await open(filePath, "r");
		const rl = createReadLineInternface(filePath, fileHandle);
		const lines: Record<
			number,
			| string
			| number
			| boolean
			| null
			| undefined
			| (string | number | boolean | (string | number | boolean)[] | null)[]
		> = {};
		let linesCount = 0;
		const config: Field & { databasePath?: string } = field ?? {
			key: "BLABLA",
			type: "string",
		};

		if (!lineNumbers) {
			for await (const line of rl) {
				linesCount++;
				lines[linesCount] = decode(line, config);
			}
		} else if (lineNumbers === -1) {
			const escapedFilePath = escapeShellPath(filePath);
			const command = filePath.endsWith(".gz")
				? `gunzip -c ${escapedFilePath} | sed -n '$p'`
				: `sed -n '$p' ${escapedFilePath}`;
			const foundedLine = (await exec(command)).stdout.trimEnd();
			if (foundedLine) lines[linesCount] = decode(foundedLine, config);
		} else {
			lineNumbers = Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers];
			if (lineNumbers.some(Number.isNaN))
				throw new Error("UNVALID_LINE_NUMBERS");
			if (readWholeFile) {
				const lineNumbersArray = new Set(lineNumbers);
				for await (const line of rl) {
					linesCount++;
					if (!lineNumbersArray.has(linesCount)) continue;
					lines[linesCount] = decode(line, config);
					lineNumbersArray.delete(linesCount);
				}
				return [lines, linesCount];
			}

			const escapedFilePath = escapeShellPath(filePath);
			const command = filePath.endsWith(".gz")
				? `gunzip -c ${escapedFilePath} | sed -n '${_groupIntoRanges(lineNumbers)}'`
				: `sed -n '${_groupIntoRanges(lineNumbers)}' ${escapedFilePath}`;
			const foundedLines = (await exec(command)).stdout.trimEnd().split("\n");

			let index = 0;
			for (const line of foundedLines) {
				lines[lineNumbers[index]] = decode(line, config);
				index++;
			}
		}
		return lines;
	} finally {
		// Ensure that file handles are closed, even if an error occurred
		await fileHandle?.close();
	}
}

/**
 * Asynchronously replaces specific lines in a file based on the provided replacements map or string.
 *
 * @param filePath - Path of the file to modify.
 * @param replacements - Map of line numbers to replacement values, or a single replacement value for all lines.
 *   Can be a string, number, boolean, null, array of these types, or a Record/Map of line numbers to these types.
 * @returns Promise<string[]>
 *
 * Note: If the file doesn't exist and replacements is an object, it creates a new file with the specified replacements.
 */
export const replace = async (
	filePath: string,
	replacements:
		| string
		| number
		| boolean
		| null
		| (string | number | boolean | null)[]
		| Record<
				number,
				string | boolean | number | null | (string | boolean | number | null)[]
		  >,
	totalItems?: number,
): Promise<(string | null)[]> => {
	const fileTempPath = tempPathFor(filePath);
	const isReplacementsObject = isObject(replacements);
	const isReplacementsLineNumbered =
		isReplacementsObject && !Number.isNaN(Number(Object.keys(replacements)[0]));
	if (await isExists(filePath)) {
		if (isReplacementsLineNumbered) {
			let fileHandle = null;
			let fileTempHandle: FileHandle | null = null;
			try {
				let linesCount = 0;
				fileHandle = await open(filePath, "r");
				fileTempHandle = await open(fileTempPath, "w");
				const writeStream = fileTempHandle.createWriteStream();
				const rl = createReadLineInternface(filePath, fileHandle);

				await _pipeline(
					filePath,
					rl,
					writeStream,
					new Transform({
						transform(line, _, callback) {
							linesCount++;
							const replacement = isReplacementsObject
								? Object.hasOwn(replacements, linesCount)
									? replacements[linesCount]
									: line
								: replacements;
							return callback(null, `${replacement}\n`);
						},
						flush(callback) {
							const remainingReplacementsKeys = Object.keys(replacements)
								.map(Number)
								.toSorted((a, b) => a - b)
								.filter((lineNumber) => lineNumber > linesCount);

							if (remainingReplacementsKeys.length)
								this.push(
									"\n".repeat(remainingReplacementsKeys[0] - linesCount - 1) +
										remainingReplacementsKeys
											.map((lineNumber, index) =>
												index === 0 ||
												lineNumber -
													(remainingReplacementsKeys[index - 1] - 1) ===
													0
													? replacements[lineNumber]
													: "\n".repeat(
															lineNumber -
																remainingReplacementsKeys[index - 1] -
																1,
														) + replacements[lineNumber],
											)
											.join("\n"),
								);
							callback();
						},
					}),
				);
				return [fileTempPath, filePath];
			} catch {
				return [fileTempPath, null];
			} finally {
				// Ensure that file handles are closed, even if an error occurred
				await fileHandle?.close();
				await fileTempHandle?.close();
			}
		} else {
			const escapedFilePath = escapeShellPath(filePath);
			const escapedFileTempPath = escapeShellPath(fileTempPath);
			const sedCommand = `sed -e s/.*/${replacements}/ -e /^$/s/^/${replacements}/ ${escapedFilePath}`;
			const command = filePath.endsWith(".gz")
				? `gunzip -c ${escapedFilePath} | ${sedCommand} | gzip > ${escapedFileTempPath}`
				: `${sedCommand} > ${escapedFileTempPath}`;
			try {
				await exec(command);
				return [fileTempPath, filePath];
			} catch {
				return [fileTempPath, null];
			}
		}
	} else if (isReplacementsObject) {
		try {
			if (isReplacementsLineNumbered) {
				const replacementsKeys = Object.keys(replacements)
					.map(Number)
					.toSorted((a, b) => a - b);

				await write(
					fileTempPath,
					// First-write for a compressed column: see append() — the
					// unique temp path hides the ".gz" suffix from write().
					filePath.endsWith(".gz")
						? await gzip(
								`${
									"\n".repeat(replacementsKeys[0] - 1) +
									replacementsKeys
										.map((lineNumber, index) =>
											index === 0 ||
											lineNumber - replacementsKeys[index - 1] - 1 === 0
												? replacements[lineNumber]
												: "\n".repeat(
														lineNumber - replacementsKeys[index - 1] - 1,
													) + replacements[lineNumber],
										)
										.join("\n")
								}\n`,
							)
						: `${
								"\n".repeat(replacementsKeys[0] - 1) +
								replacementsKeys
									.map((lineNumber, index) =>
										index === 0 ||
										lineNumber - replacementsKeys[index - 1] - 1 === 0
											? replacements[lineNumber]
											: "\n".repeat(
													lineNumber - replacementsKeys[index - 1] - 1,
												) + replacements[lineNumber],
									)
									.join("\n")
							}\n`,
				);
			} else {
				if (!totalItems) throw new Error("INVALID_PARAMETERS");
				await write(
					fileTempPath,
					// First-write for a compressed column: see append().
					filePath.endsWith(".gz")
						? await gzip(`${`${replacements}\n`.repeat(totalItems)}\n`)
						: `${`${replacements}\n`.repeat(totalItems)}\n`,
				);
			}
			return [fileTempPath, filePath];
		} catch {
			return [fileTempPath, null];
		}
	}
	return [];
};

/**
 * Asynchronously appends data to the end of a file.
 *
 * @param filePath - Path of the file to append to.
 * @param data - Data to append. Can be a string, number, or an array of strings/numbers.
 * @returns Promise<string[]>. Modifies the file by appending data.
 *
 */
export const append = async (
	filePath: string,
	data: string | number | (string | number)[],
): Promise<(string | null)[]> => {
	const fileTempPath = tempPathFor(filePath);
	try {
		if (await isExists(filePath)) {
			await copyFile(filePath, fileTempPath);
			if (!filePath.endsWith(".gz")) {
				await appendFile(
					fileTempPath,
					`${Array.isArray(data) ? data.join("\n") : data}\n`,
				);
			} else {
				const escapedFileTempPath = escapeShellPath(fileTempPath);
				await exec(
					`echo '${(Array.isArray(data) ? data.join("\n") : data)
						.toString()
						.replace(/'/g, "\\'")}' | gzip - >> ${escapedFileTempPath}`,
				);
			}
		} else
			await write(
				fileTempPath,
				// Unique temp paths no longer end with the original extension
				// (.tmp/<col>.<pid>-<seq>), so write()'s suffix check can't
				// gzip a first-write for a compressed column. Do it here.
				filePath.endsWith(".gz")
					? await gzip(
							`${Array.isArray(data) ? data.join("\n") : data}\n`,
						)
					: `${Array.isArray(data) ? data.join("\n") : data}\n`,
			);
		return [fileTempPath, filePath];
	} catch {
		return [fileTempPath, null];
	}
};

/**
 * Asynchronously prepends data to the beginning of a file.
 *
 * @param filePath - Path of the file to append to.
 * @param data - Data to append. Can be a string, number, or an array of strings/numbers.
 * @returns Promise<string[]>. Modifies the file by appending data.
 *
 */
export const prepend = async (
	filePath: string,
	data: string | number | (string | number)[],
): Promise<(string | null)[]> => {
	const fileTempPath = tempPathFor(filePath);
	if (await isExists(filePath)) {
		if (!filePath.endsWith(".gz")) {
			let fileHandle = null;
			let fileTempHandle = null;
			try {
				fileHandle = await open(filePath, "r");
				fileTempHandle = await open(fileTempPath, "w");
				const rl = createReadLineInternface(filePath, fileHandle);
				let isAppended = false;

				await _pipeline(
					filePath,
					rl,
					fileTempHandle.createWriteStream(),
					new Transform({
						transform(line, _, callback) {
							if (!isAppended) {
								isAppended = true;
								return callback(
									null,
									`${Array.isArray(data) ? data.join("\n") : data}\n${`${line}\n`}`,
								);
							}
							return callback(null, `${line}\n`);
						},
					}),
				);
			} catch {
				return [fileTempPath, null];
			} finally {
				// Ensure that file handles are closed, even if an error occurred
				await fileHandle?.close();
				await fileTempHandle?.close();
			}
		} else {
			const fileChildTempPath = `${tempPathFor(filePath)}.child`;
			try {
				await write(
					fileChildTempPath,
					`${Array.isArray(data) ? data.join("\n") : data}\n`,
				);

				const escapedFilePath = escapeShellPath(filePath);
				const escapedFileTempPath = escapeShellPath(fileTempPath);
				const escapedFileChildTempPath = escapeShellPath(fileChildTempPath);

				await exec(
					`cat ${escapedFileChildTempPath} ${escapedFilePath} > ${escapedFileTempPath}`,
				);
			} catch {
				return [fileTempPath, null];
			} finally {
				await unlink(fileChildTempPath);
			}
		}
	} else {
		try {
			await write(
				fileTempPath,
				// First-write for a compressed column: see append() — the
				// unique temp path hides the ".gz" suffix from write().
				filePath.endsWith(".gz")
					? await gzip(
							`${Array.isArray(data) ? data.join("\n") : data}\n`,
						)
					: `${Array.isArray(data) ? data.join("\n") : data}\n`,
			);
		} catch {
			return [fileTempPath, null];
		}
	}
	return [fileTempPath, filePath];
};

/**
 * Asynchronously removes specified lines from a file.
 *
 * @param filePath - Path of the file from which lines are to be removed.
 * @param linesToDelete - A single line number or an array of line numbers to be deleted.
 * @returns Promise<string[]>. Modifies the file by removing specified lines.
 *
 * Note: Creates a temporary file during the process and replaces the original file with it after removing lines.
 */
export const remove = async (
	filePath: string,
	linesToDelete: number | number[],
): Promise<(string | null)[]> => {
	linesToDelete = Array.isArray(linesToDelete)
		? linesToDelete.map(Number)
		: [Number(linesToDelete)];

	if (linesToDelete.some(Number.isNaN)) throw new Error("UNVALID_LINE_NUMBERS");

	const fileTempPath = tempPathFor(filePath);
	try {
		const escapedFilePath = escapeShellPath(filePath);
		const escapedFileTempPath = escapeShellPath(fileTempPath);

		const command = filePath.endsWith(".gz")
			? `gunzip -c ${escapedFilePath} | sed '${_groupIntoRanges(linesToDelete, "d")}' | gzip > ${escapedFileTempPath}`
			: `sed '${_groupIntoRanges(linesToDelete, "d")}' ${escapedFilePath} > ${escapedFileTempPath}`;
		await exec(command);

		return [fileTempPath, filePath];
	} catch {
		return [fileTempPath, null];
	}
};

/**
 * Field types whose on-disk bytes equal the encoded query value (identity or
 * canonical numeric/id transforms), making a native whole-line equality search safe.
 */
const EQUALS_FAST_TYPES = new Set([
	"string",
	"text",
	"textarea",
	"html",
	"url",
	"email",
	"number",
	"date",
	"timestamp",
	"time",
	"id",
	"table",
]);

/**
 * True when the query value is, or looks like, a number. Such values alias across
 * several raw byte forms under `decode` (e.g. "123", "0123", "1e3"), so the exact
 * native match would silently drop legitimate lines -> fall back to the JS reader.
 */
const looksNumeric = (value: string | number | boolean | null): boolean =>
	typeof value === "number" ||
	(typeof value === "string" && value !== "" && isNumber(value));

const shellQuote = (str: unknown): string =>
	`'${String(str).replace(/'/g, `'\\''`)}'`;

/**
 * Computes the exact on-disk byte strings a native `grep -x -F` must match for a
 * `=` (equality) search so that every matched line decodes to one of the compared
 * values. Returns the pattern array, or null when the search cannot be handled by
 * the fast path (caller then falls back to the JS readline scan).
 */
function buildEqualsPatterns(
	comparedAtValue:
		| string
		| number
		| boolean
		| null
		| (string | number | boolean | null)[],
	field: Field,
): string[] | null {
	const values = Array.isArray(comparedAtValue)
		? comparedAtValue
		: [comparedAtValue];
	if (!values.length) return null;

	const patterns: string[] = [];
	for (const value of values) {
		if (value === null || value === undefined || value === "") return null; // null-like values -> readline path

		const type = field.type as string;
		if (type === "id" || type === "table") {
			let forms: string[];
			if (isValidID(value)) forms = [value, String(decodeID(value) ?? value)];
			else if (
				typeof value === "number" ||
				(typeof value === "string" && isNumber(value))
			)
				forms = [String(Number(value))];
			else forms = [value as unknown as string];

			for (const form of [...new Set(forms)]) {
				let valid = false;
				try {
					valid = compare(
						"=",
						decode(form, field) ?? null,
						value,
						type as FieldType,
					);
				} catch {
					valid = false;
				}
				if (!valid) return null;
				patterns.push(form);
			}
		} else if (
			type === "number" ||
			type === "date" ||
			type === "timestamp" ||
			type === "time"
		) {
			const form = String(Number(value));
			let valid = false;
			try {
				valid = compare(
					"=",
					decode(form, field) ?? null,
					value,
					type as FieldType,
				);
			} catch {
				valid = false;
			}
			if (!valid) return null;
			patterns.push(form);
		} else {
			// scalar string-like field types
			if (looksNumeric(value)) return null; // numeric aliasing -> readline path

			const raw = String(value);
			if (
				raw === "null" ||
				raw === "undefined" ||
				raw.startsWith("{") ||
				raw.startsWith("[")
			)
				return null;

			let encoded: string | number | boolean | null;
			try {
				encoded = encode(value);
			} catch {
				return null;
			}
			const form = String(encoded);
			let valid = false;
			try {
				valid = compare(
					"=",
					decode(form, field) ?? null,
					value,
					type as FieldType,
				);
			} catch {
				valid = false;
			}
			if (!valid) return null;
			patterns.push(form);
		}
	}
	return [...new Set(patterns)];
}

/**
 * Native whole-line equality search (`grep -a -n -x -F`). Returns the same tuple
 * shape as `search`, or null when the fast path could not be used/verified safely
 * (in which case the caller should fall back to the JS readline scan).
 */
async function searchEqualsNative(
	filePath: string,
	patterns: string[],
	field: Field,
	searchIn: Set<number> | undefined,
	comparedAtValue:
		| string
		| number
		| boolean
		| null
		| (string | number | boolean | null)[],
	limit?: number,
	offset?: number,
	readWholeFile?: boolean,
): Promise<
	| [
			Record<
				number,
				| string
				| number
				| boolean
				| null
				| undefined
				| (string | number | boolean | null)[]
			> | null,
			number,
			Set<number> | null,
	  ]
	| null
> {
	const totalPatternSize =
		patterns.reduce((acc, pattern) => acc + String(pattern).length, 0) +
		patterns.length * 8;
	if (totalPatternSize > 32_768 || patterns.length > 1024) return null;

	if (searchIn?.size) {
		for (const lineNumber of searchIn) {
			if (lineNumber < 0) return null; // exclusion ranges -> readline path
		}
	}

	const source = filePath.endsWith(".gz")
		? `gunzip -c ${escapeShellPath(filePath)}`
		: `cat ${escapeShellPath(filePath)}`;

	// Column files whose lines start with "[" or "{" are array/object-encoded
	// (decode() eagerly unstringifies them), so a native whole-line grep could
	// silently miss matches that live inside those containers. Detect such lines
	// up front; when any are present, fall back to the JS reader.
	let probe = "";
	try {
		({ stdout: probe } = await exec(
			`LC_ALL=C ${source} | LC_ALL=C grep -a -m 1 -E '^[[{]'`,
			{ maxBuffer: 1024 * 1024 * 4 },
		));
	} catch (err: any) {
		if (Number(err?.code) !== 1) return null; // probe failure -> readline fallback
	}
	if (probe) return null;

	const command = `LC_ALL=C ${source} | LC_ALL=C grep -a -n -x -F ${patterns
		.map((pattern) => `-e ${shellQuote(pattern)}`)
		.join(" ")}`;

	let stdout: string;
	try {
		({ stdout } = await exec(command, { maxBuffer: 1024 * 1024 * 256 }));
	} catch (err: any) {
		if (Number(err?.code) === 1) return [null, 0, null]; // grep: no matches
		return null; // native failure -> readline fallback
	}

	const rawLines = stdout ? stdout.trimEnd().split("\n") : [];
	let matched: [number, string][] = [];
	for (const line of rawLines) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;
		const lineNumber = Number(line.slice(0, colonIndex));
		if (!Number.isInteger(lineNumber) || lineNumber < 1) continue;
		matched.push([lineNumber, line.slice(colonIndex + 1)]);
	}

	if (searchIn?.size)
		matched = matched.filter(([lineNumber]) => searchIn.has(lineNumber));

	const linesNumbers: Set<number> = new Set();
	const matchingLines: Record<
		number,
		| string
		| number
		| boolean
		| null
		| undefined
		| (string | number | boolean | null)[]
	> = {};
	let processed = 0;
	let finalTotal: number | null = null;
	for (const [lineNumber, raw] of matched) {
		processed++;
		linesNumbers.add(lineNumber);

		if (offset && processed < offset) continue;
		if (limit && processed > limit + (offset ? offset - 1 : 0)) {
			if (readWholeFile) continue;
			finalTotal = processed;
			break;
		}

		const decodedLine = decode(raw, field);
		// Defensive verification: the raw line must decode to one of the compared
		// values (guaranteed by construction, kept as a safety net).
		const verifies = Array.isArray(comparedAtValue)
			? comparedAtValue.some((value) =>
					compare("=", decodedLine ?? null, value, field.type),
				)
			: compare("=", decodedLine ?? null, comparedAtValue, field.type);
		if (!verifies) return null;

		matchingLines[lineNumber] = decodedLine;
	}

	const total = finalTotal ?? processed;
	return total ? [matchingLines, total, linesNumbers] : [null, 0, null];
}

/**
 * Asynchronously searches a file for lines matching specified criteria, using comparison and logical operators.
 *
 * @param filePath - Path of the file to search.
 * @param operator - Comparison operator(s) for evaluation (e.g., '=', '!=', '>', '<').
 * @param comparedAtValue - Value(s) to compare each line against.
 * @param logicalOperator - Optional logical operator ('and' or 'or') for combining multiple comparisons.
 * @param field - Field object config.
 * @param limit - Optional limit on the number of results to return.
 * @param offset - Optional offset to start returning results from.
 * @param readWholeFile - Flag to indicate whether to continue reading the file after reaching the limit.
 * @returns Promise resolving to a tuple:
 *   1. Record of line numbers and their content that match the criteria or null if none.
 *   2. The count of found items or processed items based on the 'readWholeFile' flag.
 *
 * Note: Decodes each line for comparison and can handle complex queries with multiple conditions.
 */
export const search = async (
	filePath: string,
	operator: ComparisonOperator | ComparisonOperator[],
	comparedAtValue:
		| string
		| number
		| boolean
		| null
		| (string | number | boolean | null)[],
	logicalOperator?: "and" | "or",
	searchIn?: Set<number>,
	field?: Field & { databasePath?: string },
	limit?: number,
	offset?: number,
	readWholeFile?: boolean,
): Promise<
	[
		Record<
			number,
			| string
			| number
			| boolean
			| null
			| undefined
			| (string | number | boolean | null)[]
		> | null,
		number,
		Set<number> | null,
	]
> => {
	// Native fast path for exact-equality searches (whole-line `grep -x -F`).
	if (
		operator === "=" &&
		!Array.isArray(operator) &&
		!logicalOperator &&
		comparedAtValue !== null &&
		comparedAtValue !== undefined &&
		typeof field?.type === "string" &&
		EQUALS_FAST_TYPES.has(field.type)
	) {
		const patterns = buildEqualsPatterns(comparedAtValue, field);
		if (patterns) {
			const fastResult = await searchEqualsNative(
				filePath,
				patterns,
				field,
				searchIn,
				comparedAtValue,
				limit,
				offset,
				readWholeFile,
			);
			if (fastResult) return fastResult;
		}
	}

	// Initialize a Map to store the matching lines with their line numbers.
	const matchingLines: Record<
		number,
		| string
		| number
		| boolean
		| null
		| undefined
		| (string | number | boolean | null)[]
	> = {};

	// Initialize counters for line number, found items, and processed items.
	let linesCount = 0;
	const linesNumbers: Set<number> = new Set();

	let fileHandle = null;

	const config: Field & { databasePath?: string } = field ?? {
		key: "BLABLA",
		type: "string",
	};

	const meetsConditions = (value: any) =>
		(Array.isArray(operator) &&
			Array.isArray(comparedAtValue) &&
			((logicalOperator === "or" &&
				operator.some((single_operator, index) =>
					compare(single_operator, value, comparedAtValue[index], config.type),
				)) ||
				operator.every((single_operator, index) =>
					compare(single_operator, value, comparedAtValue[index], config.type),
				))) ||
		(!Array.isArray(operator) &&
			compare(operator, value, comparedAtValue, config.type));

	try {
		// Open the file for reading.
		fileHandle = await open(filePath, "r");
		// Create a Readline interface to read the file line by line.
		const rl = createReadLineInternface(filePath, fileHandle);

		// Iterate through each line in the file.
		for await (const line of rl) {
			// Increment the line count for each line.
			linesCount++;

			// Search only in provided linesNumbers
			if (
				searchIn?.size &&
				(!searchIn.has(linesCount) || searchIn.has(-linesCount))
			)
				continue;

			// Decode the line for comparison.
			const decodedLine = decode(line, config);

			// Check if the line meets the specified conditions based on comparison and logical operators.
			const doesMeetCondition =
				(Array.isArray(decodedLine) &&
					operator !== "=" &&
					decodedLine.flat().some(meetsConditions)) ||
				meetsConditions(decodedLine);

			// If the line meets the conditions, process it.
			if (doesMeetCondition) {
				// Increment the found items counter.
				linesNumbers.add(linesCount);

				// Check if the line should be skipped based on the offset.
				if (offset && linesNumbers.size < offset) continue;

				// Check if the limit has been reached.
				if (limit && linesNumbers.size > limit + (offset ? offset - 1 : 0)) {
					if (readWholeFile) continue;
					break;
				}

				// Store the decoded line in the result object.
				matchingLines[linesCount] = decodedLine;
			}
		}

		// Convert the Map to an object using Object.fromEntries and return the result.
		return linesNumbers.size
			? [matchingLines, linesNumbers.size, linesNumbers]
			: [null, 0, null];
	} catch {
		return [null, 0, null];
	} finally {
		// Close the file handle in the finally block to ensure it is closed even if an error occurs.
		await fileHandle?.close();
	}
};
/**
 * Reads the file once and returns either the sum, average, min or max of the
 * (optionally-selected) numeric lines.
 *
 * @param filePath   Absolute path of the column file (may be .gz-compressed).
 * @param wanted     Metric to compute: "sum" (default), "avg", "min" or "max".
 * @param lineNumbers Specific line-number(s) to restrict the scan to.
 *
 * @returns Promise<number>  The requested metric, or 0 if no numeric value found.
 */
async function reduceNumbers(
	filePath: string,
	wanted: "sum" | "avg" | "min" | "max" = "sum",
	lineNumbers?: number | number[],
): Promise<number> {
	/* optional subset */
	const filter = lineNumbers
		? new Set(Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers])
		: null;

	/* running aggregators */
	let sum = 0;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	let processed = 0; // count of numeric lines we actually used
	let seen = 0; // count of filtered lines we have visited
	let line = 0;

	const fh = await open(filePath, "r");
	const rl = createReadLineInternface(filePath, fh);

	try {
		for await (const txt of rl) {
			line++;

			/* skip unwanted lines */
			if (filter && !filter.has(line)) continue;

			const num = Number(decode(txt, { key: "BLABLA", type: "number" }));
			if (Number.isNaN(num)) continue;

			processed++;

			if (wanted === "sum" || wanted === "avg") {
				sum += num;
			} else if (wanted === "min") {
				if (num < min) min = num;
			} else if (wanted === "max") {
				if (num > max) max = num;
			}

			/* early break when we have consumed all requested lines */
			if (filter && ++seen === filter.size) break;
		}
	} finally {
		await fh.close();
	}

	if (processed === 0) return 0; // nothing numeric found

	return wanted === "sum"
		? sum
		: wanted === "avg"
			? sum / processed
			: wanted === "min"
				? min
				: max;
}

/* Optional convenience wrappers (signatures unchanged) */
export const sum = (fp: string, ln?: number | number[]) =>
	reduceNumbers(fp, "sum", ln);

export const avg = (fp: string, ln?: number | number[]) =>
	reduceNumbers(fp, "avg", ln);

export const min = (fp: string, ln?: number | number[]) =>
	reduceNumbers(fp, "min", ln);

export const max = (fp: string, ln?: number | number[]) =>
	reduceNumbers(fp, "max", ln);

export const getFileDate = (path: string) =>
	stat(path)
		.then((s) => s.mtime || s.birthtime)
		.catch(() => new Date());
