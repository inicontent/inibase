import type { WriteStream } from "node:fs";
import {
	type FileHandle,
	access,
	appendFile,
	copyFile,
	constants as fsConstants,
	open,
	readFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Interface, createInterface } from "node:readline";
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
import {
	detectFieldType,
	isArrayOfObjects,
	isNumber,
	isObject,
	isStringified,
} from "./utils.js";
import { compare, encodeID, exec, gunzip, gzip } from "./utils.server.js";

export const lock = async (
	folderPath: string,
	prefix?: string,
): Promise<void> => {
	let lockFile = null;
	const lockFilePath = join(folderPath, `${prefix ?? ""}.locked`);
	try {
		lockFile = await open(lockFilePath, "wx");
		return;
	} catch ({ message }: any) {
		if (message.split(":")[0] === "EEXIST")
			return await new Promise<void>((resolve) =>
				setTimeout(() => resolve(lock(folderPath, prefix)), 13),
			);
	} finally {
		await lockFile?.close();
	}
};

export const unlock = async (folderPath: string, prefix?: string) => {
	try {
		await unlink(join(folderPath, `${prefix ?? ""}.locked`));
	} catch {}
};

export const write = async (filePath: string, data: any) => {
	await writeFile(filePath, filePath.endsWith(".gz") ? await gzip(data) : data);
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

	if (typeof input === "string") return input.replace(/\\n/g, "\n") || null;

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
	value: string | number | any[],
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
							? detectFieldType(v, field.children as FieldType[])
							: field.children,
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
): string | number | boolean | null | (string | number | null | boolean)[] => {
	if (input === null || input === "") return undefined;

	// Detect the fieldType based on the input and the provided array of possible types.
	if (Array.isArray(field.type))
		field.type = detectFieldType(String(input), field.type);

	// Decode the input using the decodeHelper function.
	return decodeHelper(
		typeof input === "string"
			? isStringified(input)
				? Inison.unstringify(input)
				: unSecureString(input)
			: input,
		field,
	);
};

function _groupIntoRanges(arr: number[], action: "p" | "d" = "p") {
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
			| (string | number | boolean | (string | number | boolean)[] | null)[]
		> = {};
		let linesCount = 0;

		if (!lineNumbers) {
			for await (const line of rl) {
				linesCount++;
				lines[linesCount] = decode(line, field);
			}
		} else if (lineNumbers == -1) {
			const escapedFilePath = escapeShellPath(filePath);
			const command = filePath.endsWith(".gz")
				? `zcat ${escapedFilePath} | sed -n '$p'`
				: `sed -n '$p' ${escapedFilePath}`;
			const foundedLine = (await exec(command)).stdout.trimEnd();
			if (foundedLine) lines[linesCount] = decode(foundedLine, field);
		} else {
			lineNumbers = Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers];
			if (lineNumbers.some(Number.isNaN))
				throw new Error("UNVALID_LINE_NUMBERS");
			if (readWholeFile) {
				const lineNumbersArray = new Set(lineNumbers);
				for await (const line of rl) {
					linesCount++;
					if (!lineNumbersArray.has(linesCount)) continue;
					lines[linesCount] = decode(line, field);
					lineNumbersArray.delete(linesCount);
				}
				return [lines, linesCount];
			}

			const escapedFilePath = escapeShellPath(filePath);
			const command = filePath.endsWith(".gz")
				? `zcat ${escapedFilePath} | sed -n '${_groupIntoRanges(lineNumbers)}'`
				: `sed -n '${_groupIntoRanges(lineNumbers)}' ${escapedFilePath}`;
			const foundedLines = (await exec(command)).stdout.trimEnd().split("\n");

			let index = 0;
			for (const line of foundedLines) {
				lines[lineNumbers[index]] = decode(line, field);
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
): Promise<string[]> => {
	const fileTempPath = filePath.replace(/([^/]+)\/?$/, ".tmp/$1");
	const isReplacementsObject = isObject(replacements);
	const isReplacementsLineNumbered =
		isReplacementsObject && !Number.isNaN(Number(Object.keys(replacements)[0]));
	if (await isExists(filePath)) {
		if (isReplacementsLineNumbered) {
			let fileHandle = null;
			let fileTempHandle: FileHandle = null;
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
				? `zcat ${escapedFilePath} | ${sedCommand} | gzip > ${escapedFileTempPath}`
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
					`${
						"\n".repeat(replacementsKeys[0] - 1) +
						replacementsKeys
							.map((lineNumber, index) =>
								index === 0 ||
								lineNumber - replacementsKeys[index - 1] - 1 === 0
									? replacements[lineNumber]
									: "\n".repeat(lineNumber - replacementsKeys[index - 1] - 1) +
										replacements[lineNumber],
							)
							.join("\n")
					}\n`,
				);
			} else {
				if (!totalItems) throw new Error("INVALID_PARAMETERS");
				await write(
					fileTempPath,
					`${`${replacements}\n`.repeat(totalItems)}\n`,
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
): Promise<string[]> => {
	const fileTempPath = filePath.replace(/([^/]+)\/?$/, ".tmp/$1");
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
				`${Array.isArray(data) ? data.join("\n") : data}\n`,
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
): Promise<string[]> => {
	const fileTempPath = filePath.replace(/([^/]+)\/?$/, ".tmp/$1");
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
			const fileChildTempPath = filePath.replace(/([^/]+)\/?$/, ".tmp/tmp_$1");
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
				`${Array.isArray(data) ? data.join("\n") : data}\n`,
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
): Promise<string[]> => {
	linesToDelete = Array.isArray(linesToDelete)
		? linesToDelete.map(Number)
		: [Number(linesToDelete)];

	if (linesToDelete.some(Number.isNaN)) throw new Error("UNVALID_LINE_NUMBERS");

	const fileTempPath = filePath.replace(/([^/]+)\/?$/, ".tmp/$1");
	try {
		const escapedFilePath = escapeShellPath(filePath);
		const escapedFileTempPath = escapeShellPath(fileTempPath);

		const command = filePath.endsWith(".gz")
			? `zcat ${escapedFilePath} | sed '${_groupIntoRanges(linesToDelete, "d")}' | gzip > ${escapedFileTempPath}`
			: `sed '${_groupIntoRanges(linesToDelete, "d")}' ${escapedFilePath} > ${escapedFileTempPath}`;
		await exec(command);

		return [fileTempPath, filePath];
	} catch {
		return [fileTempPath, null];
	}
};

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
			string | number | boolean | null | (string | number | boolean | null)[]
		> | null,
		number,
		Set<number> | null,
	]
> => {
	// Initialize a Map to store the matching lines with their line numbers.
	const matchingLines: Record<
		number,
		string | number | boolean | null | (string | number | boolean | null)[]
	> = {};

	// Initialize counters for line number, found items, and processed items.
	let linesCount = 0;
	const linesNumbers: Set<number> = new Set();

	let fileHandle = null;

	const meetsConditions = (value: any) =>
		(Array.isArray(operator) &&
			Array.isArray(comparedAtValue) &&
			((logicalOperator === "or" &&
				operator.some((single_operator, index) =>
					compare(single_operator, value, comparedAtValue[index], field.type),
				)) ||
				operator.every((single_operator, index) =>
					compare(single_operator, value, comparedAtValue[index], field.type),
				))) ||
		(!Array.isArray(operator) &&
			compare(operator, value, comparedAtValue, field.type));

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
			const decodedLine = decode(line, field);

			// Check if the line meets the specified conditions based on comparison and logical operators.
			const doesMeetCondition =
				(Array.isArray(decodedLine) &&
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
 * Reads the file once and returns either the sum, min or max of the
 * (optionally-selected) numeric lines.
 *
 * @param filePath   Absolute path of the column file (may be .gz-compressed).
 * @param wanted     Metric to compute: "sum" (default), "min" or "max".
 * @param lineNumbers Specific line-number(s) to restrict the scan to.
 *
 * @returns Promise<number>  The requested metric, or 0 if no numeric value found.
 */
async function reduceNumbers(
	filePath: string,
	wanted: "sum" | "min" | "max" = "sum",
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

			if (wanted === "sum") {
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

	return wanted === "sum" ? sum : wanted === "min" ? min : max;
}

/* Optional convenience wrappers (signatures unchanged) */
export const sum = (fp: string, ln?: number | number[]) =>
	reduceNumbers(fp, "sum", ln);

export const min = (fp: string, ln?: number | number[]) =>
	reduceNumbers(fp, "min", ln);

export const max = (fp: string, ln?: number | number[]) =>
	reduceNumbers(fp, "max", ln);

export const getFileDate = (path: string) =>
	stat(path)
		.then((s) => s.mtime || s.birthtime)
		.catch(() => new Date());
