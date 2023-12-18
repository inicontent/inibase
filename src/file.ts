import {
  FileHandle,
  open,
  rename,
  stat,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { ComparisonOperator, FieldType } from "./index.js";
import {
  detectFieldType,
  isArrayOfArrays,
  isNumber,
  isObject,
} from "./utils.js";
import { encodeID, comparePassword } from "./utils.server.js";

const readLineInternface = (fileHandle: FileHandle) => {
  return createInterface({
    input: fileHandle.createReadStream(),
    crlfDelay: Infinity,
  });
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
    ? decodeURIComponent(input.replace(/%(?![0-9][0-9a-fA-F]+)/g, ""))
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
  input
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
  ): any =>
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
): any => {
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
    case "id":
      return isNumber(value) && secretKey
        ? encodeID(value as number, secretKey)
        : value;
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
      | null
      | (string | number | boolean | (string | number | boolean)[] | null)[]
    > | null,
    number
  ]
> => {
  const fileHandle = await open(filePath, "r"),
    rl = readLineInternface(fileHandle);

  let lines: Map<
      number,
      | string
      | number
      | boolean
      | null
      | (string | number | boolean | (string | number | boolean)[] | null)[]
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
    let lastLine: string | null = null;
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
    let lineCount = 0;
    const fileHandle = await open(filePath, "r"),
      fileTempPath = `${filePath.replace(".inib", "")}-${Date.now()}.tmp`,
      fileTempHandle = await open(fileTempPath, "w"),
      rl = readLineInternface(fileHandle),
      writeStream = fileTempHandle.createWriteStream();

    if (isObject(replacements)) {
      if (!(replacements instanceof Map))
        replacements = new Map(Object.entries(replacements)) as Map<any, any>;
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

        for await (const newLineNumber of newLinesNumbers)
          writeStream.write(
            replacements.get(newLineNumber.toString() as any) + "\n"
          );
      }
    } else for await (const _line of rl) writeStream.write(replacements + "\n");

    await fileHandle.close();
    await fileTempHandle.close();
    await rename(fileTempPath, filePath);
  } else if (isObject(replacements)) {
    if (!(replacements instanceof Map))
      replacements = new Map(
        Object.entries(replacements).map(([key, value]) => [Number(key), value])
      ) as Map<any, any>;
    await writeFile(
      filePath,
      (Math.min(...replacements.keys()) - 1 > 1
        ? "\n".repeat(Math.min(...replacements.keys()) - 1)
        : "") +
        Array.from(
          new Map(
            [...replacements.entries()].sort(([keyA], [keyB]) => keyA - keyB)
          ).values()
        ).join("\n") +
        "\n"
    );
  }
};

export const append = async (
  filePath: string,
  data: string | number | (string | number)[],
  startsAt: number = 1
): Promise<void> => {
  let currentNumberOfLines = 0;
  const doesFileExists = await isExists(filePath);

  if (doesFileExists) currentNumberOfLines = await count(filePath);

  await appendFile(
    filePath,
    (currentNumberOfLines > 0
      ? startsAt - currentNumberOfLines - 1 > 0
        ? "\n".repeat(startsAt - currentNumberOfLines - 1)
        : ""
      : "") +
      (Array.isArray(data) ? data.join("\n") : data) +
      "\n"
  );
};

export const remove = async (
  filePath: string,
  linesToDelete: number | number[]
): Promise<void> => {
  let lineCount = 0;

  const fileHandle = await open(filePath, "r"),
    fileTempPath = `${filePath.replace(".inib", "")}-${Date.now()}.tmp`,
    fileTempHandle = await open(fileTempPath, "w"),
    linesToDeleteArray = new Set(
      Array.isArray(linesToDelete)
        ? linesToDelete.map(Number)
        : [Number(linesToDelete)]
    ),
    rl = readLineInternface(fileHandle),
    writeStream = fileTempHandle.createWriteStream();

  for await (const line of rl) {
    lineCount++;
    if (!linesToDeleteArray.has(lineCount)) writeStream.write(`${line}\n`);
  }
  await rename(fileTempPath, filePath);
  await fileTempHandle.close();
  await fileHandle.close();
};

export const count = async (filePath: string): Promise<number> => {
  // return Number((await exec(`wc -l < ${filePath}`)).stdout.trim());
  let lineCount = 0;

  const fileHandle = await open(filePath, "r"),
    rl = readLineInternface(fileHandle);

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
      return (
        originalValue !== null &&
        comparedAtValue !== null &&
        originalValue > comparedAtValue
      );
    case "<":
      return (
        originalValue !== null &&
        comparedAtValue !== null &&
        originalValue < comparedAtValue
      );
    case ">=":
      return (
        originalValue !== null &&
        comparedAtValue !== null &&
        originalValue >= comparedAtValue
      );
    case "<=":
      return (
        originalValue !== null &&
        comparedAtValue !== null &&
        originalValue <= comparedAtValue
      );
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
    rl = readLineInternface(fileHandle);

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
  let sum: number = 0;

  const fileHandle = await open(filePath, "r"),
    rl = readLineInternface(fileHandle);

  if (lineNumbers) {
    let lineCount = 0;
    let lineNumbersArray = new Set(
      Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]
    );

    for await (const line of rl) {
      lineCount++;
      if (!lineNumbersArray.has(lineCount)) continue;
      sum += +(decode(line, "number") ?? 0);
      lineNumbersArray.delete(lineCount);
      if (!lineNumbersArray.size) break;
    }
  } else for await (const line of rl) sum += +(decode(line, "number") ?? 0);

  await fileHandle.close();
  return sum;
};

export const max = async (
  filePath: string,
  lineNumbers?: number | number[]
): Promise<number> => {
  let max: number = 0;

  const fileHandle = await open(filePath, "r"),
    rl = readLineInternface(fileHandle);

  if (lineNumbers) {
    let lineCount = 0;

    let lineNumbersArray = new Set(
      Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]
    );
    for await (const line of rl) {
      lineCount++;
      if (!lineNumbersArray.has(lineCount)) continue;
      const lineContentNum = +(decode(line, "number") ?? 0);
      if (lineContentNum > max) max = lineContentNum;
      lineNumbersArray.delete(lineCount);
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

export const min = async (
  filePath: string,
  lineNumbers?: number | number[]
): Promise<number> => {
  let min: number = 0;

  const fileHandle = await open(filePath, "r"),
    rl = readLineInternface(fileHandle);

  if (lineNumbers) {
    let lineCount = 0;

    let lineNumbersArray = new Set(
      Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]
    );
    for await (const line of rl) {
      lineCount++;
      if (!lineNumbersArray.has(lineCount)) continue;
      const lineContentNum = +(decode(line, "number") ?? 0);
      if (lineContentNum < min) min = lineContentNum;
      lineNumbersArray.delete(lineCount);
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

export const sort = async (
  filePath: string,
  sortDirection: 1 | -1 | "asc" | "desc",
  lineNumbers?: number | number[],
  _lineNumbersPerChunk: number = 100000
): Promise<void> => {};

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
