import type { WriteStream } from "node:fs";
import {
	type FileHandle,
	access,
	appendFile,
	copyFile,
	constants as fsConstants,
	open,
	readFile,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { type Interface, createInterface } from "node:readline";
import { Transform, type Transform as TransformType } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import Inison from "inison";
import type { ComparisonOperator, FieldType, Schema } from "./index.js";
import {
	detectFieldType,
	isArrayOfObjects,
	isJSON,
	isNumber,
	isObject,
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
	return decodedInput.replace(/\\n/g, "\n").replace(/\n/g, "\\n");
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
		? input.every((_input) => typeof _input === "string" && isJSON(_input))
			? `[${input.join(",")}]`
			: Inison.stringify(input as any)
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
 * @param fieldType - Optional type of the field to guide decoding (e.g., 'number', 'boolean').
 * @param fieldChildrenType - Optional type for children elements, used for arrays.
 * @param secretKey - Optional secret key for decoding, can be string or Buffer.
 * @returns Decoded value, transformed according to the specified field type(s).
 */
const decodeHelper = (
	value: string | number | any[],
	fieldType?: FieldType | FieldType[],
	fieldChildrenType?: FieldType | FieldType[] | Schema,
	secretKey?: string | Buffer,
): any => {
	if (Array.isArray(value) && fieldType !== "array")
		return value.map((v) =>
			decodeHelper(v, fieldType, fieldChildrenType, secretKey),
		);
	switch (fieldType as FieldType) {
		case "number":
			return isNumber(value) ? Number(value) : null;
		case "boolean":
			return typeof value === "string" ? value === "true" : Boolean(value);
		case "array":
			if (!Array.isArray(value)) return [value];

			if (fieldChildrenType && !isArrayOfObjects(fieldChildrenType))
				return fieldChildrenType
					? value.map(
							(v) =>
								decode(
									v,
									Array.isArray(fieldChildrenType)
										? detectFieldType(v, fieldChildrenType)
										: fieldChildrenType,
									undefined,
									secretKey,
								) as string | number | boolean | null,
						)
					: value;
			break;
		case "table":
		case "id":
			return isNumber(value) && secretKey
				? encodeID(value as number, secretKey)
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
 * @param fieldType - Optional type of the field to guide decoding (e.g., 'number', 'boolean').
 * @param fieldChildrenType - Optional type for child elements in array inputs.
 * @param secretKey - Optional secret key for decoding, can be a string or Buffer.
 * @returns Decoded value as a string, number, boolean, or array of these, or null if no fieldType or input is null/empty.
 */
export const decode = (
	input: string | null | number,
	fieldType?: FieldType | FieldType[],
	fieldChildrenType?: FieldType | FieldType[] | Schema,
	secretKey?: string | Buffer,
): string | number | boolean | null | (string | number | null | boolean)[] => {
	if (!fieldType) return null;
	if (input === null || input === "") return null;

	// Detect the fieldType based on the input and the provided array of possible types.
	if (Array.isArray(fieldType))
		fieldType = detectFieldType(String(input), fieldType);

	// Decode the input using the decodeHelper function.
	return decodeHelper(
		typeof input === "string"
			? isJSON(input)
				? (Inison.unstringify(input as any) as any)
				: unSecureString(input)
			: input,
		fieldType,
		fieldChildrenType,
		secretKey,
	);
};

/**
 * Asynchronously reads and decodes data from a file at specified line numbers.
 * Decodes each line based on specified field types and an optional secret key.
 *
 * @param filePath - Path of the file to be read.
 * @param lineNumbers - Optional line number(s) to read from the file. If -1, reads the last line.
 * @param fieldType - Optional type of the field to guide decoding (e.g., 'number', 'boolean').
 * @param fieldChildrenType - Optional type for child elements in array inputs.
 * @param secretKey - Optional secret key for decoding, can be a string or Buffer.
 * @returns Promise resolving to a tuple:
 *   1. Record of line numbers and their decoded content or null if no lines are read.
 *   2. Total count of lines processed.
 */
export function get(
	filePath: string,
	lineNumbers?: number | number[],
	fieldType?: FieldType | FieldType[],
	fieldChildrenType?: FieldType | FieldType[] | Schema,
	secretKey?: string | Buffer,
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
	fieldType: undefined | FieldType | FieldType[],
	fieldChildrenType: undefined | FieldType | FieldType[],
	secretKey: undefined | string | Buffer,
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
	fieldType?: FieldType | FieldType[],
	fieldChildrenType?: FieldType | FieldType[] | Schema,
	secretKey?: string | Buffer,
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
		const rl = createReadLineInternface(filePath, fileHandle),
			lines: Record<
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
				lines[linesCount] = decode(
					line,
					fieldType,
					fieldChildrenType,
					secretKey,
				);
			}
		} else if (lineNumbers == -1) {
			const command = filePath.endsWith(".gz")
					? `zcat ${filePath} | sed -n '$p'`
					: `sed -n '$p' ${filePath}`,
				foundedLine = (await exec(command)).stdout.trimEnd();
			if (foundedLine)
				lines[linesCount] = decode(
					foundedLine,
					fieldType,
					fieldChildrenType,
					secretKey,
				);
		} else {
			lineNumbers = Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers];
			if (lineNumbers.some(Number.isNaN))
				throw new Error("UNVALID_LINE_NUMBERS");
			if (readWholeFile) {
				const lineNumbersArray = new Set(lineNumbers);
				for await (const line of rl) {
					linesCount++;
					if (!lineNumbersArray.has(linesCount)) continue;
					lines[linesCount] = decode(
						line,
						fieldType,
						fieldChildrenType,
						secretKey,
					);
					lineNumbersArray.delete(linesCount);
				}
				return [lines, linesCount];
			}

			const command = filePath.endsWith(".gz")
					? `zcat ${filePath} | sed -n '${lineNumbers.join("p;")}p'`
					: `sed -n '${lineNumbers.join("p;")}p' ${filePath}`,
				foundedLines = (await exec(command)).stdout.trimEnd().split("\n");

			let index = 0;
			for (const line of foundedLines) {
				lines[lineNumbers[index]] = decode(
					line,
					fieldType,
					fieldChildrenType,
					secretKey,
				);
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
): Promise<string[]> => {
	const fileTempPath = filePath.replace(/([^/]+)\/?$/, ".tmp/$1");
	if (await isExists(filePath)) {
		let fileHandle = null;
		let fileTempHandle = null;
		try {
			let linesCount = 0;
			fileHandle = await open(filePath, "r");
			fileTempHandle = await open(fileTempPath, "w");
			const rl = createReadLineInternface(filePath, fileHandle);

			await _pipeline(
				filePath,
				rl,
				fileTempHandle.createWriteStream(),
				new Transform({
					transform(line, _, callback) {
						linesCount++;
						const replacement = isObject(replacements)
							? Object.hasOwn(replacements, linesCount)
								? replacements[linesCount]
								: line
							: replacements;
						return callback(null, `${replacement}\n`);
					},
				}),
			);

			return [fileTempPath, filePath];
		} finally {
			// Ensure that file handles are closed, even if an error occurred
			await fileHandle?.close();
			await fileTempHandle?.close();
		}
	} else if (isObject(replacements)) {
		const replacementsKeys = Object.keys(replacements)
			.map(Number)
			.toSorted((a, b) => a - b);

		await write(
			fileTempPath,
			`${
				"\n".repeat(replacementsKeys[0] - 1) +
				replacementsKeys
					.map((lineNumber, index) =>
						index === 0 || lineNumber - replacementsKeys[index - 1] - 1 === 0
							? replacements[lineNumber]
							: "\n".repeat(lineNumber - replacementsKeys[index - 1] - 1) +
								replacements[lineNumber],
					)
					.join("\n")
			}\n`,
		);
		return [fileTempPath, filePath];
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
	if (await isExists(filePath)) {
		await copyFile(filePath, fileTempPath);
		if (!filePath.endsWith(".gz")) {
			await appendFile(
				fileTempPath,
				`${Array.isArray(data) ? data.join("\n") : data}\n`,
			);
		} else {
			await exec(
				`echo $'${(Array.isArray(data) ? data.join("\n") : data)
					.toString()
					.replace(/'/g, "\\'")}' | gzip - >> ${fileTempPath}`,
			);
		}
	} else
		await write(
			fileTempPath,
			`${Array.isArray(data) ? data.join("\n") : data}\n`,
		);
	return [fileTempPath, filePath];
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
									`${Array.isArray(data) ? data.join("\n") : data}\n${
										line.length ? `${line}\n` : ""
									}`,
								);
							}
							return callback(null, `${line}\n`);
						},
					}),
				);
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
				await exec(`cat ${fileChildTempPath} ${filePath} > ${fileTempPath}`);
			} finally {
				await unlink(fileChildTempPath);
			}
		}
	} else
		await write(
			fileTempPath,
			`${Array.isArray(data) ? data.join("\n") : data}\n`,
		);
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

	const command = filePath.endsWith(".gz")
		? `zcat ${filePath} | sed "${linesToDelete.join(
				"d;",
			)}d" | gzip > ${fileTempPath}`
		: `sed "${linesToDelete.join("d;")}d" ${filePath} > ${fileTempPath}`;
	await exec(command);

	return [fileTempPath, filePath];
};

/**
 * Asynchronously searches a file for lines matching specified criteria, using comparison and logical operators.
 *
 * @param filePath - Path of the file to search.
 * @param operator - Comparison operator(s) for evaluation (e.g., '=', '!=', '>', '<').
 * @param comparedAtValue - Value(s) to compare each line against.
 * @param logicalOperator - Optional logical operator ('and' or 'or') for combining multiple comparisons.
 * @param fieldType - Optional type of the field to guide comparison.
 * @param fieldChildrenType - Optional type for child elements in array inputs.
 * @param limit - Optional limit on the number of results to return.
 * @param offset - Optional offset to start returning results from.
 * @param readWholeFile - Flag to indicate whether to continue reading the file after reaching the limit.
 * @param secretKey - Optional secret key for decoding, can be a string or Buffer.
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
	fieldType?: FieldType | FieldType[],
	fieldChildrenType?: FieldType | FieldType[] | Schema,
	limit?: number,
	offset?: number,
	readWholeFile?: boolean,
	secretKey?: string | Buffer,
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

	try {
		// Open the file for reading.
		fileHandle = await open(filePath, "r");
		// Create a Readline interface to read the file line by line.
		const rl = createReadLineInternface(filePath, fileHandle);

		// Iterate through each line in the file.
		for await (const line of rl) {
			// Increment the line count for each line.
			linesCount++;

			// Decode the line for comparison.
			const decodedLine = decode(line, fieldType, fieldChildrenType, secretKey);

			// Check if the line meets the specified conditions based on comparison and logical operators.
			const meetsConditions =
				(Array.isArray(operator) &&
					Array.isArray(comparedAtValue) &&
					((logicalOperator === "or" &&
						operator.some((single_operator, index) =>
							compare(
								single_operator,
								decodedLine,
								comparedAtValue[index],
								fieldType,
							),
						)) ||
						operator.every((single_operator, index) =>
							compare(
								single_operator,
								decodedLine,
								comparedAtValue[index],
								fieldType,
							),
						))) ||
				(!Array.isArray(operator) &&
					compare(operator, decodedLine, comparedAtValue, fieldType));

			// If the line meets the conditions, process it.
			if (meetsConditions) {
				// Increment the found items counter.
				linesNumbers.add(linesCount);
				// Check if the line should be skipped based on the offset.
				if (offset && linesNumbers.size < offset) continue;

				// Check if the limit has been reached.
				if (limit && linesNumbers.size > limit + (offset ?? 0)) {
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
	} finally {
		// Close the file handle in the finally block to ensure it is closed even if an error occurs.
		await fileHandle?.close();
	}
};

/**
 * Asynchronously counts the number of lines in a file.
 *
 * @param filePath - Path of the file to count lines in.
 * @returns Promise<number>. The number of lines in the file.
 *
 * Note: Reads through the file line by line to count the total number of lines.
 */
export const count = async (filePath: string): Promise<number> => {
	// Number((await exec(`wc -l < ${filePath}`)).stdout.trimEnd());
	let linesCount = 0;
	if (await isExists(filePath)) {
		let fileHandle = null;
		try {
			fileHandle = await open(filePath, "r");
			const rl = createReadLineInternface(filePath, fileHandle);

			for await (const _ of rl) linesCount++;
		} finally {
			await fileHandle?.close();
		}
	}
	return linesCount;
};

/**
 * Asynchronously calculates the sum of numerical values from specified lines in a file.
 *
 * @param filePath - Path of the file to read.
 * @param lineNumbers - Optional specific line number(s) to include in the sum. If not provided, sums all lines.
 * @returns Promise<number>. The sum of numerical values from the specified lines.
 *
 * Note: Decodes each line as a number using the 'decode' function. Non-numeric lines contribute 0 to the sum.
 */
export const sum = async (
	filePath: string,
	lineNumbers?: number | number[],
): Promise<number> => {
	let sum = 0,
		fileHandle = null;
	try {
		fileHandle = await open(filePath, "r");
		const rl = createReadLineInternface(filePath, fileHandle);

		if (lineNumbers) {
			let linesCount = 0;
			const lineNumbersArray = new Set(
				Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers],
			);

			for await (const line of rl) {
				linesCount++;
				if (!lineNumbersArray.has(linesCount)) continue;
				sum += +(decode(line, "number") ?? 0);
				lineNumbersArray.delete(linesCount);
				if (!lineNumbersArray.size) break;
			}
		} else for await (const line of rl) sum += +(decode(line, "number") ?? 0);

		return sum;
	} finally {
		await fileHandle?.close();
	}
};

/**
 * Asynchronously finds the maximum numerical value from specified lines in a file.
 *
 * @param filePath - Path of the file to read.
 * @param lineNumbers - Optional specific line number(s) to consider for finding the maximum value. If not provided, considers all lines.
 * @returns Promise<number>. The maximum numerical value found in the specified lines.
 *
 * Note: Decodes each line as a number using the 'decode' function. Considers only numerical values for determining the maximum.
 */
export const max = async (
	filePath: string,
	lineNumbers?: number | number[],
): Promise<number> => {
	let max = 0,
		fileHandle = null,
		rl = null;
	try {
		fileHandle = await open(filePath, "r");
		rl = createReadLineInternface(filePath, fileHandle);

		if (lineNumbers) {
			let linesCount = 0;

			const lineNumbersArray = new Set(
				Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers],
			);
			for await (const line of rl) {
				linesCount++;
				if (!lineNumbersArray.has(linesCount)) continue;
				const lineContentNum = +(decode(line, "number") ?? 0);
				if (lineContentNum > max) max = lineContentNum;
				lineNumbersArray.delete(linesCount);
				if (!lineNumbersArray.size) break;
			}
		} else
			for await (const line of rl) {
				const lineContentNum = +(decode(line, "number") ?? 0);
				if (lineContentNum > max) max = lineContentNum;
			}

		return max;
	} finally {
		await fileHandle?.close();
	}
};

/**
 * Asynchronously finds the minimum numerical value from specified lines in a file.
 *
 * @param filePath - Path of the file to read.
 * @param lineNumbers - Optional specific line number(s) to consider for finding the minimum value. If not provided, considers all lines.
 * @returns Promise<number>. The minimum numerical value found in the specified lines.
 *
 * Note: Decodes each line as a number using the 'decode' function. Considers only numerical values for determining the minimum.
 */
export const min = async (
	filePath: string,
	lineNumbers?: number | number[],
): Promise<number> => {
	let min = 0,
		fileHandle = null;
	try {
		fileHandle = await open(filePath, "r");
		const rl = createReadLineInternface(filePath, fileHandle);

		if (lineNumbers) {
			let linesCount = 0;

			const lineNumbersArray = new Set(
				Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers],
			);
			for await (const line of rl) {
				linesCount++;
				if (!lineNumbersArray.has(linesCount)) continue;
				const lineContentNum = +(decode(line, "number") ?? 0);
				if (lineContentNum < min) min = lineContentNum;
				lineNumbersArray.delete(linesCount);
				if (!lineNumbersArray.size) break;
			}
		} else
			for await (const line of rl) {
				const lineContentNum = +(decode(line, "number") ?? 0);
				if (lineContentNum < min) min = lineContentNum;
			}

		return min;
	} finally {
		await fileHandle?.close();
	}
};
