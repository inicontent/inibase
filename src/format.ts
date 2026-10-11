import { randomUUID } from "node:crypto";
import { readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import * as File from "./file.js";

/**
 * On-disk format marker for a table directory.
 *
 * Format 1 is the implicit legacy format (no `.format` file): base columns plus
 * pagination only. Format 2 opts the table into the append-only update log
 * written by `put` (see `updatelog.ts`).
 *
 * The marker is the single source of truth for "does this table have a log?".
 * It also carries the compatibility contract read by a later 3.7.1 detector:
 * `minReader` is the oldest engine that may open the table, `detector` the
 * release that hard-fails instead of silently mis-reading. `baseGen` is the
 * generation the base columns were last compacted at; it is bumped by
 * compaction (3.9) so a stale in-memory overlay can detect that its base moved
 * and rebuild instead of replaying frames that are already merged.
 */
export const FORMAT_FILE = ".format";

export interface TableFormat {
	format: number;
	log: boolean;
	baseGen: number;
	/** Oldest engine that may open the table, as written into the marker. */
	minReader?: string;
}

export const LEGACY_FORMAT: TableFormat = {
	format: 1,
	log: false,
	baseGen: 0,
};

export const CURRENT_FORMAT_VERSION = 2;
export const ENGINE_NAME = "inibase";
/** This build's engine version, compared against a marker's `minReader`. */
export const ENGINE_VERSION = "3.8.0";
/** Oldest reader that understands format 2. */
export const MIN_READER = "3.8.0";
/** Release expected to detect (and refuse) format 2 rather than mis-read it. */
export const DETECTOR = "3.7.1";

/** Compare dotted numeric versions: >0 when `a > b`, <0 when `a < b`, else 0. */
export const compareVersions = (a: string, b: string): number => {
	const pa = a.split(".");
	const pb = b.split(".");
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	return 0;
};

/**
 * Why this engine cannot open a marker, or null when it can.
 *
 * Refusing *before* any column is read keeps a newer-format table from being
 * silently mis-read as format 2 (or legacy). Two independent conditions:
 * a `format` above what this build writes, or a `minReader` above the running
 * engine version.
 */
export const unsupportedFormatReason = (format: TableFormat): string | null => {
	if (format.format > CURRENT_FORMAT_VERSION)
		return `format ${format.format} (this engine reads up to ${CURRENT_FORMAT_VERSION})`;
	if (format.minReader && compareVersions(format.minReader, ENGINE_VERSION) > 0)
		return `minReader ${format.minReader} (this engine is ${ENGINE_VERSION})`;
	return null;
};

const formatPath = (tablePath: string) => join(tablePath, FORMAT_FILE);

/**
 * Read a table's format marker. A missing or unreadable marker is legacy
 * (format 1), which keeps every pre-3.8 table byte-for-byte compatible.
 */
export const readFormat = async (tablePath: string): Promise<TableFormat> => {
	if (!(await File.isExists(formatPath(tablePath))))
		return { ...LEGACY_FORMAT };
	try {
		const raw = JSON.parse(await readFile(formatPath(tablePath), "utf8"));
		return {
			// Accept both the current `format` key and the earlier `version`
			// spelling so a marker written by any 3.8 prerelease still opens.
			format: Number(raw?.format ?? raw?.version) || LEGACY_FORMAT.format,
			log: raw?.log === true,
			baseGen: Number(raw?.baseGen) || 0,
			minReader: typeof raw?.minReader === "string" ? raw.minReader : undefined,
		};
	} catch {
		// A corrupt marker means we cannot trust "no log": refusing to write
		// over it is safer, but reading must still work, so treat as legacy and
		// let the write path surface UNSUPPORTED_FORMAT.
		return { ...LEGACY_FORMAT };
	}
};

/** The exact bytes of a format marker (shared by write and compaction commit). */
export const serializeFormat = (format: TableFormat): string =>
	`${JSON.stringify({
		engine: ENGINE_NAME,
		format: format.format,
		minReader: MIN_READER,
		detector: DETECTOR,
		layout: "append",
		log: format.log,
		baseGen: format.baseGen,
	})}\n`;

/**
 * Write (or replace) the format marker durably and atomically (§9): stage the
 * bytes in the table's `.tmp` dir, fsync the temp, rename it into place, then
 * fsync the table directory. A crash can therefore leave either the old marker
 * or the new one, never a partial file — a torn marker would read back as
 * legacy and silently drop the log.
 */
export const writeFormat = async (
	tablePath: string,
	format: TableFormat,
): Promise<void> => {
	const path = formatPath(tablePath);
	const tmp = join(tablePath, ".tmp", `${FORMAT_FILE}.${randomUUID()}`);
	try {
		await File.write(tmp, serializeFormat(format));
		await File.syncFile(tmp);
		await rename(tmp, path);
		await File.syncDir(tablePath);
	} catch (error) {
		await unlink(tmp).catch(() => {});
		throw error;
	}
};

/** Remove the marker (used when downgrading a table back to legacy). */
export const removeFormat = async (tablePath: string): Promise<void> => {
	const path = formatPath(tablePath);
	try {
		await unlink(path);
	} catch {
		// Already absent.
	}
};
