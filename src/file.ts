import {
  FileHandle,
  open,
  access,
  writeFile,
  readFile,
  constants as fsConstants,
  unlink,
  copyFile,
  appendFile,
} from "node:fs/promises";
import type { WriteStream } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { Transform, type Transform as TransformType } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip, gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { ComparisonOperator, FieldType } from "./index.js";
import { detectFieldType, isJSON, isNumber, isObject } from "./utils.js";
import { encodeID, compare } from "./utils.server.js";
import Config from "./config.js";
import Inison from "inison";

export const lock = async (
  folderPath: string,
  prefix?: string
): Promise<void> => {
  let lockFile,
    lockFilePath = join(folderPath, `${prefix ?? ""}.locked`);
  try {
    lockFile = await open(lockFilePath, "wx");
    return;
  } catch ({ message }: any) {
    if (message.split(":")[0] === "EEXIST")
      return await new Promise<any>((resolve, reject) =>
        setTimeout(() => resolve(lock(folderPath, prefix)), 13)
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

export const write = async (
  filePath: string,
  data: any,
  disableCompression: boolean = false
) => {
  await writeFile(
    filePath,
    Config.isCompressionEnabled && !disableCompression
      ? gzipSync(String(data))
      : String(data)
  );
};

export const read = async (
  filePath: string,
  disableCompression: boolean = false
) => {
  return Config.isCompressionEnabled && !disableCompression
    ? gunzipSync(await readFile(filePath)).toString()
    : (await readFile(filePath)).toString();
};

const _pipeline = async (
  rl: Interface,
  writeStream: WriteStream,
  transform: TransformType
): Promise<void> => {
  if (Config.isCompressionEnabled)
    await pipeline(rl, transform, createGzip(), writeStream);
  else await pipeline(rl, transform, writeStream);
};

/**
 * Creates a readline interface for a given file handle.
 *
 * @param fileHandle - The file handle from which to create a read stream.
 * @returns A readline.Interface instance configured with the provided file stream.
 */
const readLineInternface = (fileHandle: FileHandle) => {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  return major > 18 ||
    (major === 18 && minor >= 11 && !Config.isCompressionEnabled)
    ? fileHandle.readLines()
    : createInterface({
        input: Config.isCompressionEnabled
          ? fileHandle.createReadStream().pipe(createGunzip())
          : fileHandle.createReadStream(),
        crlfDelay: Infinity,
      });
};

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
  input: string | number | boolean | null
): string | number | boolean | null => {
  if (["true", "false"].includes(String(input))) return input ? 1 : 0;

  if (typeof input !== "string") return input;
  let decodedInput = null;
  try {
    decodedInput = decodeURIComponent(input);
  } catch (_error) {
    decodedInput = decodeURIComponent(
      input.replace(/%(?![0-9][0-9a-fA-F]+)/g, "")
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
  input: string | number | boolean | null | (string | number | boolean | null)[]
): string | number | boolean | null =>
  Array.isArray(input)
    ? input.every((_input) => typeof _input === "string" && isJSON(_input))
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
  if (isNumber(input)) return Number(input);

  if (typeof input === "string") return input.replace(/\n/g, "\\n") || null;

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
  fieldChildrenType?: FieldType | FieldType[],
  secretKey?: string | Buffer
): any => {
  if (Array.isArray(value) && fieldType !== "array")
    return value.map((v) =>
      decodeHelper(v, fieldType, fieldChildrenType, secretKey)
    );
  switch (fieldType as FieldType) {
    case "number":
      return isNumber(value) ? Number(value) : null;
    case "boolean":
      return typeof value === "string" ? value === "true" : Boolean(value);
    case "array":
      if (!Array.isArray(value)) return [value];

      if (fieldChildrenType)
        return fieldChildrenType
          ? value.map(
              (v) =>
                decode(
                  v,
                  Array.isArray(fieldChildrenType)
                    ? detectFieldType(v, fieldChildrenType)
                    : fieldChildrenType,
                  undefined,
                  secretKey
                ) as string | number | boolean | null
            )
          : value;
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
  fieldChildrenType?: FieldType | FieldType[],
  secretKey?: string | Buffer
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
        ? Inison.unstringify(input)
        : unSecureString(input)
      : input,
    fieldType,
    fieldChildrenType,
    secretKey
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
  fieldChildrenType?: FieldType | FieldType[],
  secretKey?: string | Buffer,
  readWholeFile?: false
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
  readWholeFile: true
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
    number
  ]
>;
export async function get(
  filePath: string,
  lineNumbers?: number | number[],
  fieldType?: FieldType | FieldType[],
  fieldChildrenType?: FieldType | FieldType[],
  secretKey?: string | Buffer,
  readWholeFile: boolean = false
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
      number
    ]
> {
  let fileHandle, rl;

  try {
    fileHandle = await open(filePath, "r");
    rl = readLineInternface(fileHandle);
    let lines: Record<
        number,
        | string
        | number
        | boolean
        | null
        | (string | number | boolean | (string | number | boolean)[] | null)[]
      > = {},
      linesCount = 0;

    if (!lineNumbers) {
      for await (const line of rl)
        linesCount++,
          (lines[linesCount] = decode(
            line,
            fieldType,
            fieldChildrenType,
            secretKey
          ));
    } else if (lineNumbers === -1) {
      let lastLine: string | null = null;
      for await (const line of rl) linesCount++, (lastLine = line);
      if (lastLine)
        lines[linesCount] = decode(
          lastLine,
          fieldType,
          fieldChildrenType,
          secretKey
        );
    } else {
      let lineNumbersArray = new Set(
        Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]
      );
      for await (const line of rl) {
        linesCount++;
        if (!lineNumbersArray.has(linesCount)) continue;
        lines[linesCount] = decode(
          line,
          fieldType,
          fieldChildrenType,
          secretKey
        );
        lineNumbersArray.delete(linesCount);
        if (!lineNumbersArray.size && !readWholeFile) break;
      }
    }
    return readWholeFile ? [lines, linesCount] : lines;
  } finally {
    // Ensure that file handles are closed, even if an error occurred
    rl?.close();
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
      >
): Promise<string[]> => {
  const fileTempPath = filePath.replace(/([^/]+)\/?$/, `.tmp/$1`);
  if (await isExists(filePath)) {
    let fileHandle, fileTempHandle, rl;
    try {
      let linesCount = 0;
      fileHandle = await open(filePath, "r");
      fileTempHandle = await open(fileTempPath, "w");
      rl = readLineInternface(fileHandle);

      await _pipeline(
        rl,
        fileTempHandle.createWriteStream(),
        new Transform({
          transform(line, encoding, callback) {
            linesCount++;
            const replacement = isObject(replacements)
              ? replacements.hasOwnProperty(linesCount)
                ? replacements[linesCount]
                : line
              : replacements;
            return callback(null, replacement + "\n");
          },
        })
      );

      return [fileTempPath, filePath];
    } finally {
      // Ensure that file handles are closed, even if an error occurred
      rl?.close();
      await fileHandle?.close();
      await fileTempHandle?.close();
    }
  } else if (isObject(replacements)) {
    let replacementsKeys = Object.keys(replacements)
      .map(Number)
      .toSorted((a, b) => a - b);

    await write(
      fileTempPath,
      "\n".repeat(replacementsKeys[0] - 1) +
        replacementsKeys
          .map((lineNumber, index) =>
            index === 0 || lineNumber - replacementsKeys[index - 1] - 1 === 0
              ? replacements[lineNumber]
              : "\n".repeat(lineNumber - replacementsKeys[index - 1] - 1) +
                replacements[lineNumber]
          )
          .join("\n") +
        "\n"
    );
    return [fileTempPath, filePath];
  }
  return [];
};

/**
 * Asynchronously appends data to the beginning of a file.
 *
 * @param filePath - Path of the file to append to.
 * @param data - Data to append. Can be a string, number, or an array of strings/numbers.
 * @returns Promise<string[]>. Modifies the file by appending data.
 *
 */
export const append = async (
  filePath: string,
  data: string | number | (string | number)[]
): Promise<string[]> => {
  const fileTempPath = filePath.replace(/([^/]+)\/?$/, `.tmp/$1`);
  if (await isExists(filePath)) {
    if (!Config.isReverseEnabled && !Config.isCompressionEnabled) {
      await copyFile(filePath, fileTempPath);
      await appendFile(
        fileTempPath,
        `${Array.isArray(data) ? data.join("\n") : data}\n`
      );
    } else {
      let fileHandle, fileTempHandle, rl;
      try {
        fileHandle = await open(filePath, "r");
        fileTempHandle = await open(fileTempPath, "w");
        rl = readLineInternface(fileHandle);
        let isAppended = false;

        await _pipeline(
          rl,
          fileTempHandle.createWriteStream(),
          new Transform({
            transform(line, encoding, callback) {
              if (!isAppended) {
                isAppended = true;
                return callback(
                  null,
                  `${Array.isArray(data) ? data.join("\n") : data}\n` +
                    (line.length ? `${line}\n` : "")
                );
              } else return callback(null, `${line}\n`);
            },
          })
        );
      } finally {
        // Ensure that file handles are closed, even if an error occurred
        rl?.close();
        await fileHandle?.close();
        await fileTempHandle?.close();
      }
    }
  } else
    await write(
      fileTempPath,
      `${Array.isArray(data) ? data.join("\n") : data}\n`,
      undefined
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
  linesToDelete: number | number[]
): Promise<string[]> => {
  let linesCount = 0,
    deletedCount = 0;

  const fileHandle = await open(filePath, "r"),
    fileTempPath = filePath.replace(/([^/]+)\/?$/, `.tmp/$1`),
    fileTempHandle = await open(fileTempPath, "w"),
    linesToDeleteArray = new Set(
      Array.isArray(linesToDelete)
        ? linesToDelete.map(Number)
        : [Number(linesToDelete)]
    ),
    rl = readLineInternface(fileHandle);

  await _pipeline(
    rl,
    fileTempHandle.createWriteStream(),
    new Transform({
      transform(line, encoding, callback) {
        linesCount++;
        if (linesToDeleteArray.has(linesCount)) {
          deletedCount++;
          return callback();
        } else return callback(null, `${line}\n`);
      },
      final(callback) {
        if (deletedCount === linesCount) this.push("\n");
        return callback();
      },
    })
  );

  await fileTempHandle.close();
  await fileHandle.close();
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
  fieldChildrenType?: FieldType | FieldType[],
  limit?: number,
  offset?: number,
  readWholeFile?: boolean,
  secretKey?: string | Buffer
): Promise<
  [
    Record<
      number,
      string | number | boolean | null | (string | number | boolean | null)[]
    > | null,
    number,
    Set<number> | null
  ]
> => {
  // Initialize a Map to store the matching lines with their line numbers.
  const matchingLines: Record<
    number,
    string | number | boolean | null | (string | number | boolean | null)[]
  > = {};

  // Initialize counters for line number, found items, and processed items.
  let linesCount = 0,
    foundItems = 0,
    linesNumbers: Set<number> = new Set();

  let fileHandle, rl;

  try {
    // Open the file for reading.
    fileHandle = await open(filePath, "r");
    // Create a Readline interface to read the file line by line.
    rl = readLineInternface(fileHandle);

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
                fieldType
              )
            )) ||
            operator.every((single_operator, index) =>
              compare(
                single_operator,
                decodedLine,
                comparedAtValue[index],
                fieldType
              )
            ))) ||
        (!Array.isArray(operator) &&
          compare(operator, decodedLine, comparedAtValue, fieldType));

      // If the line meets the conditions, process it.
      if (meetsConditions) {
        // Increment the found items counter.
        foundItems++;
        linesNumbers.add(linesCount);
        // Check if the line should be skipped based on the offset.
        if (offset && foundItems < offset) continue;

        // Check if the limit has been reached.
        if (limit && foundItems > limit)
          if (readWholeFile) continue;
          else break;

        // Store the decoded line in the result object.
        matchingLines[linesCount] = decodedLine;
      }
    }

    // Convert the Map to an object using Object.fromEntries and return the result.
    return foundItems
      ? [
          matchingLines,
          readWholeFile ? foundItems : foundItems - 1,
          linesNumbers.size ? linesNumbers : null,
        ]
      : [null, 0, null];
  } finally {
    // Close the file handle in the finally block to ensure it is closed even if an error occurs.
    rl?.close();
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
  // return Number((await exec(`wc -l < ${filePath}`)).stdout.trim());
  let linesCount = 0;
  if (await isExists(filePath)) {
    let fileHandle, rl;
    try {
      (fileHandle = await open(filePath, "r")),
        (rl = readLineInternface(fileHandle));

      for await (const line of rl) linesCount++;
    } finally {
      rl?.close();
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
  lineNumbers?: number | number[]
): Promise<number> => {
  let sum: number = 0;

  const fileHandle = await open(filePath, "r"),
    rl = readLineInternface(fileHandle);

  if (lineNumbers) {
    let linesCount = 0;
    let lineNumbersArray = new Set(
      Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]
    );

    for await (const line of rl) {
      linesCount++;
      if (!lineNumbersArray.has(linesCount)) continue;
      sum += +(decode(line, "number") ?? 0);
      lineNumbersArray.delete(linesCount);
      if (!lineNumbersArray.size) break;
    }
  } else for await (const line of rl) sum += +(decode(line, "number") ?? 0);

  await fileHandle.close();
  return sum;
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
  lineNumbers?: number | number[]
): Promise<number> => {
  let max: number = 0;

  const fileHandle = await open(filePath, "r"),
    rl = readLineInternface(fileHandle);

  if (lineNumbers) {
    let linesCount = 0;

    let lineNumbersArray = new Set(
      Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]
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

  await fileHandle.close();
  return max;
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
  lineNumbers?: number | number[]
): Promise<number> => {
  let min: number = 0;

  const fileHandle = await open(filePath, "r"),
    rl = readLineInternface(fileHandle);

  if (lineNumbers) {
    let linesCount = 0;

    let lineNumbersArray = new Set(
      Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]
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

  await fileHandle.close();
  return min;
};

export function createWorker(
  functionName:
    | "get"
    | "remove"
    | "search"
    | "replace"
    | "sum"
    | "min"
    | "max"
    | "append"
    | "count",
  arg: any[]
): Promise<any> {
  return new Promise(function (resolve, reject) {
    const worker = new Worker("./dist/file.thread.js", {
      workerData: { functionName, arg },
    });
    worker.on("message", (data) => {
      resolve(data);
    });
    worker.on("error", (msg) => {
      reject(`An error ocurred: ${msg}`);
    });
  });
}

/**
 * Asynchronously sorts the lines in a file in the specified direction.
 *
 * @param filePath - Path of the file to be sorted.
 * @param sortDirection - Direction for sorting: 1 or 'asc' for ascending, -1 or 'desc' for descending.
 * @param lineNumbers - Optional specific line numbers to sort. If not provided, sorts all lines.
 * @param _lineNumbersPerChunk - Optional parameter for handling large files, specifying the number of lines per chunk.
 * @returns Promise<void>. Modifies the file by sorting specified lines.
 *
 * Note: The sorting is applied either to the entire file or to the specified lines. Large files are handled in chunks.
 */
export const sort = async (
  filePath: string,
  sortDirection: 1 | -1 | "asc" | "desc",
  lineNumbers?: number | number[],
  _lineNumbersPerChunk: number = 100000
): Promise<void> => {
  // return Number((await exec(`wc -l < ${filePath}`)).stdout.trim());
};

export default class File {
  static get = get;
  static remove = remove;
  static search = search;
  static replace = replace;
  static encode = encode;
  static decode = decode;
  static isExists = isExists;
  static sum = sum;
  static min = min;
  static max = max;

  static append = append;
  static count = count;

  static write = write;
  static read = read;

  static lock = lock;
  static unlock = unlock;

  static createWorker = createWorker;
}
