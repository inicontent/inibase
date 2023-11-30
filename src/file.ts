import { open, rename, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { ComparisonOperator, FieldType } from "./index.js";
import { detectFieldType, isArrayOfArrays, isNumber } from "./utils.js";

import { encodeID, comparePassword } from "./utils.server.js";

const doesSupportReadLines = () => {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  return major > 18 || (major === 18 && minor >= 11);
};

export const isExists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const delimiters = [",", "|", "&", "$", "#", "@", "^", "%", ":", "!", ";"];

const secureString = (input: string | number | boolean | null) => {
  if (["true", "false"].includes(String(input))) return input ? 1 : 0;
  return typeof input === "string"
    ? decodeURIComponent(input)
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll(",", "%2C")
        .replaceAll("|", "%7C")
        .replaceAll("&", "%26")
        .replaceAll("$", "%24")
        .replaceAll("#", "%23")
        .replaceAll("@", "%40")
        .replaceAll("^", "%5E")
        .replaceAll("%", "%25")
        .replaceAll(":", "%3A")
        .replaceAll("!", "%21")
        .replaceAll(";", "%3B")
        .replaceAll("\n", "\\n")
        .replaceAll("\r", "\\r")
    : input;
};
const secureArray = (arr_str: any[] | any): any[] | any =>
  Array.isArray(arr_str) ? arr_str.map(secureArray) : secureString(arr_str);
const joinMultidimensionalArray = (
  arr: any[] | any[][],
  delimiter_index = 0
): string => {
  delimiter_index++;
  if (isArrayOfArrays(arr))
    arr = arr.map((ar: any[]) =>
      joinMultidimensionalArray(ar, delimiter_index)
    );
  delimiter_index--;
  return arr.join(delimiters[delimiter_index]);
};

export const encode = (
  input:
    | string
    | number
    | boolean
    | null
    | (string | number | boolean | null)[],
  secretKey?: string | Buffer
) => {
  return Array.isArray(input)
    ? joinMultidimensionalArray(secureArray(input))
    : secureString(input);
};

const unSecureString = (input: string) =>
  decodeURIComponent(input)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("%2C", ",")
    .replaceAll("%7C", "|")
    .replaceAll("%26", "&")
    .replaceAll("%24", "$")
    .replaceAll("%23", "#")
    .replaceAll("%40", "@")
    .replaceAll("%5E", "^")
    .replaceAll("%25", "%")
    .replaceAll("%3A", ":")
    .replaceAll("%21", "!")
    .replaceAll("%3B", ";")
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r") || null;
const unSecureArray = (arr_str: any[] | any): any[] | any =>
  Array.isArray(arr_str) ? arr_str.map(unSecureArray) : unSecureString(arr_str);
const reverseJoinMultidimensionalArray = (
  joinedString: string | any[] | any[][]
): any | any[] | any[][] => {
  const reverseJoinMultidimensionalArrayHelper = (
    arr: any | any[] | any[][],
    delimiter: string
  ) =>
    Array.isArray(arr)
      ? arr.map((ar: any) =>
          reverseJoinMultidimensionalArrayHelper(ar, delimiter)
        )
      : arr.split(delimiter);

  const availableDelimiters = delimiters.filter((delimiter) =>
    joinedString.includes(delimiter)
  );
  for (const delimiter of availableDelimiters) {
    joinedString = Array.isArray(joinedString)
      ? reverseJoinMultidimensionalArrayHelper(joinedString, delimiter)
      : joinedString.split(delimiter);
  }
  return joinedString;
};
const decodeHelper = (
  value: string | number | any[],
  fieldType?: FieldType | FieldType[],
  fieldChildrenType?: FieldType | FieldType[],
  secretKey?: string | Buffer
) => {
  if (Array.isArray(value) && fieldType !== "array")
    return value.map((v) =>
      decodeHelper(v, fieldType, fieldChildrenType, secretKey)
    );
  switch (fieldType as FieldType) {
    case "table":
    case "number":
      return isNumber(value) ? Number(value) : null;
    case "boolean":
      return typeof value === "string" ? value === "true" : Boolean(value);
    case "array":
      if (!Array.isArray(value)) return [value];

      if (fieldChildrenType)
        return value.map(
          (v) =>
            decode(
              v,
              Array.isArray(fieldChildrenType)
                ? detectFieldType(v, fieldChildrenType)
                : fieldChildrenType,
              undefined,
              secretKey
            ) as string | number | boolean | null
        );
      else return value;
    case "id":
      return isNumber(value) ? encodeID(value as number, secretKey) : value;
    default:
      return value;
  }
};

export const decode = (
  input: string | null | number,
  fieldType?: FieldType | FieldType[],
  fieldChildrenType?: FieldType | FieldType[],
  secretKey?: string | Buffer
): string | number | boolean | null | (string | number | null | boolean)[] => {
  if (!fieldType) return null;
  if (input === null || input === "") return null;
  if (Array.isArray(fieldType))
    fieldType = detectFieldType(String(input), fieldType);
  return decodeHelper(
    typeof input === "string"
      ? input.includes(",")
        ? unSecureArray(reverseJoinMultidimensionalArray(input))
        : unSecureString(input)
      : input,
    fieldType,
    fieldChildrenType,
    secretKey
  );
};

export const get = async (
  filePath: string,
  lineNumbers?: number | number[],
  fieldType?: FieldType | FieldType[],
  fieldChildrenType?: FieldType | FieldType[],
  secretKey?: string | Buffer
): Promise<
  [
    Record<
      number,
      | string
      | number
      | boolean
      | (string | number | boolean | (string | number | boolean)[])[]
    > | null,
    number
  ]
> => {
  const fileHandle = await open(filePath, "r"),
    rl = doesSupportReadLines()
      ? fileHandle.readLines({ autoClose: false })
      : createInterface({
          input: fileHandle.createReadStream({ autoClose: false }),
          crlfDelay: Infinity,
        });
  let lines: Map<
      number,
      | string
      | number
      | boolean
      | (string | number | boolean | (string | number | boolean)[] | null)[]
      | null
    > = new Map(),
    lineCount = 0;

  if (!lineNumbers) {
    for await (const line of rl)
      lineCount++,
        lines.set(
          lineCount,
          decode(line, fieldType, fieldChildrenType, secretKey)
        );
  } else if (lineNumbers === -1) {
    let lastLine: string;
    for await (const line of rl) lineCount++, (lastLine = line);
    if (lastLine)
      lines.set(
        lineCount,
        decode(lastLine, fieldType, fieldChildrenType, secretKey)
      );
  } else {
    let lineNumbersArray = new Set(
      Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]
    );
    for await (const line of rl) {
      lineCount++;
      if (!lineNumbersArray.has(lineCount)) continue;
      lines.set(
        lineCount,
        decode(line, fieldType, fieldChildrenType, secretKey)
      );
      lineNumbersArray.delete(lineCount);
      if (!lineNumbersArray.size) break;
    }
  }
  await fileHandle.close();
  return [lines.size ? Object.fromEntries(lines) : null, lineCount];
};

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
    | Map<number, string | number | boolean | (string | number | boolean)[]>
) => {
  if (await isExists(filePath)) {
    const fileHandle = await open(filePath, "r"),
      rl = doesSupportReadLines()
        ? fileHandle.readLines({ autoClose: false })
        : createInterface({
            input: fileHandle.createReadStream({ autoClose: false }),
            crlfDelay: Infinity,
          }),
      fileTempPath = `${filePath.replace(".inib", "")}-${Date.now()}.tmp`,
      fileTempHandle = await open(fileTempPath, "w+"),
      writeStream = fileTempHandle.createWriteStream({ autoClose: false });
    if (typeof replacements === "object" && !Array.isArray(replacements)) {
      if (!(replacements instanceof Map))
        replacements = new Map(Object.entries(replacements));
      let lineCount = 0;
      for await (const line of rl) {
        lineCount++;
        writeStream.write(
          (replacements.has(lineCount.toString() as any)
            ? replacements.get(lineCount.toString() as any)
            : line) + "\n"
        );
      }
      const newLinesNumbers = new Set(
        [...replacements.keys()].filter((num) => num > lineCount)
      );

      if (newLinesNumbers.size) {
        if (Math.min(...newLinesNumbers) - lineCount - 1 > 1)
          writeStream.write(
            "\n".repeat(Math.min(...newLinesNumbers) - lineCount - 1)
          );
        for (const newLineNumber of newLinesNumbers)
          writeStream.write(
            replacements.get(newLineNumber.toString() as any) + "\n"
          );
      }
    } else for await (const _line of rl) writeStream.write(replacements + "\n");

    // writeStream.end(async () => await rename(fileTempPath, filePath));
    await fileHandle.close();
    await fileTempHandle.close();
    await rename(fileTempPath, filePath);
  } else if (typeof replacements === "object" && !Array.isArray(replacements)) {
    if (!(replacements instanceof Map))
      replacements = new Map(Object.entries(replacements));
    await writeFile(
      filePath,
      (Math.min(...replacements.keys()) - 1 > 1
        ? "\n".repeat(Math.min(...replacements.keys()) - 1)
        : "") +
        [...new Map([...replacements].sort(([a], [b]) => a - b)).values()].join(
          "\n"
        ) +
        "\n"
    );
  }
};

export const append = async (
  filePath: string,
  data: string | number | (string | number)[],
  startsAt: number = 1
): Promise<void> => {
  const doesFileExists = await isExists(filePath);
  const fileHandle = await open(filePath, "a"),
    writeStream = fileHandle.createWriteStream({ autoClose: false });

  if (doesFileExists) {
    const currentNumberOfLines = await count(filePath);
    if (startsAt - currentNumberOfLines - 1 > 0)
      writeStream.write("\n".repeat(startsAt - currentNumberOfLines - 1));

    if (Array.isArray(data)) {
      for (const input of data) writeStream.write(input + "\n");
    } else writeStream.write(data + "\n");
  } else {
    if (startsAt - 1 > 0) writeStream.write("\n".repeat(startsAt - 1));
    if (Array.isArray(data)) {
      for (const input of data) writeStream.write(input + "\n");
    } else writeStream.write(data + "\n");
  }
  await fileHandle.close();
};

export const remove = async (
  filePath: string,
  linesToDelete: number | number[]
): Promise<void> => {
  let lineCount = 0;

  const linesToDeleteArray = new Set(
      Array.isArray(linesToDelete) ? linesToDelete : [linesToDelete]
    ),
    fileHandle = await open(filePath, "r"),
    rl = doesSupportReadLines()
      ? fileHandle.readLines({ autoClose: false })
      : createInterface({
          input: fileHandle.createReadStream({ autoClose: false }),
          crlfDelay: Infinity,
        }),
    fileTempPath = `${filePath.replace(".inib", "")}-${Date.now()}.tmp`,
    fileTempHandle = await open(fileTempPath, "w+"),
    writeStream = fileTempHandle.createWriteStream({ autoClose: false });

  for await (const line of rl) {
    lineCount++;
    if (!linesToDeleteArray.has(lineCount)) writeStream.write(`${line}\n`);
  }

  // writeStream.end(async () => await rename(fileTempPath, filePath));
  await fileHandle.close();
  await fileTempHandle.close();
  await rename(fileTempPath, filePath);
};

export const count = async (filePath: string): Promise<number> => {
  let lineCount = 0;
  const fileHandle = await open(filePath, "r"),
    rl = doesSupportReadLines()
      ? fileHandle.readLines({ autoClose: false })
      : createInterface({
          input: fileHandle.createReadStream({ autoClose: false }),
          crlfDelay: Infinity,
        });
  for await (const line of rl) lineCount++;

  await fileHandle.close();
  return lineCount;
};

const handleComparisonOperator = (
  operator: ComparisonOperator,
  originalValue:
    | string
    | number
    | boolean
    | null
    | (string | number | boolean | null)[],
  comparedAtValue:
    | string
    | number
    | boolean
    | null
    | (string | number | boolean | null)[],
  fieldType?: FieldType | FieldType[],
  fieldChildrenType?: FieldType | FieldType[]
): boolean => {
  if (Array.isArray(fieldType))
    fieldType = detectFieldType(String(originalValue), fieldType);
  if (Array.isArray(comparedAtValue) && !["[]", "![]"].includes(operator))
    return comparedAtValue.some((comparedAtValueSingle) =>
      handleComparisonOperator(
        operator,
        originalValue,
        comparedAtValueSingle,
        fieldType
      )
    );
  // check if not array or object // it can't be array or object!
  switch (operator) {
    case "=":
      switch (fieldType) {
        case "password":
          return typeof originalValue === "string" &&
            typeof comparedAtValue === "string"
            ? comparePassword(originalValue, comparedAtValue)
            : false;
        case "boolean":
          return Number(originalValue) - Number(comparedAtValue) === 0;
        default:
          return originalValue === comparedAtValue;
      }
    case "!=":
      return !handleComparisonOperator(
        "=",
        originalValue,
        comparedAtValue,
        fieldType
      );
    case ">":
      return originalValue > comparedAtValue;
    case "<":
      return originalValue < comparedAtValue;
    case ">=":
      return originalValue >= comparedAtValue;
    case "<=":
      return originalValue <= comparedAtValue;
    case "[]":
      return (
        (Array.isArray(originalValue) &&
          Array.isArray(comparedAtValue) &&
          originalValue.some(comparedAtValue.includes)) ||
        (Array.isArray(originalValue) &&
          !Array.isArray(comparedAtValue) &&
          originalValue.includes(comparedAtValue)) ||
        (!Array.isArray(originalValue) &&
          Array.isArray(comparedAtValue) &&
          comparedAtValue.includes(originalValue))
      );
    case "![]":
      return !handleComparisonOperator(
        "[]",
        originalValue,
        comparedAtValue,
        fieldType
      );
    case "*":
      return new RegExp(
        `^${(String(comparedAtValue).includes("%")
          ? String(comparedAtValue)
          : "%" + String(comparedAtValue) + "%"
        ).replace(/%/g, ".*")}$`,
        "i"
      ).test(String(originalValue));
    case "!*":
      return !handleComparisonOperator(
        "*",
        originalValue,
        comparedAtValue,
        fieldType
      );
    default:
      throw new Error(operator);
  }
};

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
      string | number | boolean | (string | number | boolean | null)[] | null
    > | null,
    number
  ]
> => {
  let RETURN: Map<
      number,
      string | number | boolean | null | (string | number | boolean | null)[]
    > = new Map(),
    lineCount = 0,
    foundItems = 0;

  const fileHandle = await open(filePath, "r"),
    rl = doesSupportReadLines()
      ? fileHandle.readLines({ autoClose: false })
      : createInterface({
          input: fileHandle.createReadStream({ autoClose: false }),
          crlfDelay: Infinity,
        });

  for await (const line of rl) {
    lineCount++;
    const decodedLine = decode(line, fieldType, fieldChildrenType, secretKey);
    if (
      (Array.isArray(operator) &&
        Array.isArray(comparedAtValue) &&
        ((logicalOperator &&
          logicalOperator === "or" &&
          operator.some((single_operator, index) =>
            handleComparisonOperator(
              single_operator,
              decodedLine,
              comparedAtValue[index],
              fieldType
            )
          )) ||
          operator.every((single_operator, index) =>
            handleComparisonOperator(
              single_operator,
              decodedLine,
              comparedAtValue[index],
              fieldType
            )
          ))) ||
      (!Array.isArray(operator) &&
        handleComparisonOperator(
          operator,
          decodedLine,
          comparedAtValue,
          fieldType
        ))
    ) {
      foundItems++;
      if (offset && foundItems < offset) continue;
      if (limit && foundItems > limit)
        if (readWholeFile) continue;
        else break;
      RETURN.set(lineCount, decodedLine);
    }
  }

  await fileHandle.close();

  return foundItems
    ? [Object.fromEntries(RETURN), readWholeFile ? foundItems : foundItems - 1]
    : [null, 0];
};

export const sum = async (
  filePath: string,
  lineNumbers?: number | number[]
): Promise<number> => {
  const fileHandle = await open(filePath, "r"),
    rl = doesSupportReadLines()
      ? fileHandle.readLines({ autoClose: false })
      : createInterface({
          input: fileHandle.createReadStream({ autoClose: false }),
          crlfDelay: Infinity,
        });
  let sum = 0;

  if (lineNumbers) {
    let lineCount = 0;
    let lineNumbersArray = new Set(
      Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]
    );

    for await (const line of rl) {
      lineCount++;
      if (!lineNumbersArray.has(lineCount)) continue;
      sum += +decode(line, "number");
      lineNumbersArray.delete(lineCount);
      if (!lineNumbersArray.size) break;
    }
  } else for await (const line of rl) sum += +decode(line, "number");

  return sum;
};

export const max = async (
  filePath: string,
  lineNumbers?: number | number[]
): Promise<number> => {
  const fileHandle = await open(filePath, "r"),
    rl = doesSupportReadLines()
      ? fileHandle.readLines({ autoClose: false })
      : createInterface({
          input: fileHandle.createReadStream({ autoClose: false }),
          crlfDelay: Infinity,
        });
  let max = 0;

  if (lineNumbers) {
    let lineCount = 0;

    let lineNumbersArray = new Set(
      Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]
    );
    for await (const line of rl) {
      lineCount++;
      if (!lineNumbersArray.has(lineCount)) continue;
      const lineContentNum = +decode(line, "number");
      if (lineContentNum > max) max = lineContentNum;
      lineNumbersArray.delete(lineCount);
      if (!lineNumbersArray.size) break;
    }
  } else
    for await (const line of rl) {
      const lineContentNum = +decode(line, "number");
      if (lineContentNum > max) max = lineContentNum;
    }

  return max;
};

export const min = async (
  filePath: string,
  lineNumbers?: number | number[]
): Promise<number> => {
  const fileHandle = await open(filePath, "r"),
    rl = doesSupportReadLines()
      ? fileHandle.readLines({ autoClose: false })
      : createInterface({
          input: fileHandle.createReadStream({ autoClose: false }),
          crlfDelay: Infinity,
        });

  let min = 0;

  if (lineNumbers) {
    let lineCount = 0;

    let lineNumbersArray = new Set(
      Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]
    );
    for await (const line of rl) {
      lineCount++;
      if (!lineNumbersArray.has(lineCount)) continue;
      const lineContentNum = +decode(line, "number");
      if (lineContentNum < min) min = lineContentNum;
      lineNumbersArray.delete(lineCount);
      if (!lineNumbersArray.size) break;
    }
  } else
    for await (const line of rl) {
      const lineContentNum = +decode(line, "number");
      if (lineContentNum < min) min = lineContentNum;
    }

  return min;
};

export const sort = async (
  filePath: string,
  sortDirection: 1 | -1 | "asc" | "desc",
  lineNumbers?: number | number[],
  _lineNumbersPerChunk: number = 100000
): Promise<void> => {
  const fileHandle = await open(filePath, "r"),
    rl = doesSupportReadLines()
      ? fileHandle.readLines({ autoClose: false })
      : createInterface({
          input: fileHandle.createReadStream({ autoClose: false }),
          crlfDelay: Infinity,
        });
  let lineCount = 0;

  for await (const line of rl) lineCount++;
};

export default class File {
  static get = get;
  static remove = remove;
  static search = search;
  static replace = replace;
  static count = count;
  static encode = encode;
  static decode = decode;
  static isExists = isExists;
  static sum = sum;
  static min = min;
  static max = max;

  static append = append;
}
