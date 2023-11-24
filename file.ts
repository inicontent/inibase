import { createWriteStream } from "node:fs";
import { open, rename, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parse } from "node:path";
import { ComparisonOperator, FieldType } from ".";
import {
  detectFieldType,
  isArrayOfArrays,
  isNumber,
  encodeID,
  comparePassword,
} from "./utils";

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

export const encode = (
  input:
    | string
    | number
    | boolean
    | null
    | (string | number | boolean | null)[],
  secretKey?: string | Buffer
) => {
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
    },
    secureArray = (arr_str: any[] | any): any[] | any =>
      Array.isArray(arr_str) ? arr_str.map(secureArray) : secureString(arr_str),
    joinMultidimensionalArray = (
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
  return Array.isArray(input)
    ? joinMultidimensionalArray(secureArray(input))
    : secureString(input);
};

export const decode = (
  input: string | null | number,
  fieldType?: FieldType | FieldType[],
  fieldChildrenType?: FieldType | FieldType[],
  secretKey?: string | Buffer
): string | number | boolean | null | (string | number | null | boolean)[] => {
  if (!fieldType) return null;
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
        .replaceAll("\\r", "\r") || null,
    unSecureArray = (arr_str: any[] | any): any[] | any =>
      Array.isArray(arr_str)
        ? arr_str.map(unSecureArray)
        : unSecureString(arr_str),
    reverseJoinMultidimensionalArray = (
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
    },
    decodeHelper = (value: string | number | any[]) => {
      if (Array.isArray(value) && fieldType !== "array")
        return value.map(decodeHelper);
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
  if (input === null || input === "") return null;
  if (Array.isArray(fieldType))
    fieldType = detectFieldType(String(input), fieldType);
  return decodeHelper(
    typeof input === "string"
      ? input.includes(",")
        ? unSecureArray(reverseJoinMultidimensionalArray(input))
        : unSecureString(input)
      : input
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
  let fileHandle;
  try {
    fileHandle = await open(filePath, "r");
    const rl = doesSupportReadLines()
      ? fileHandle.readLines()
      : createInterface({
          input: fileHandle.createReadStream(),
          crlfDelay: Infinity,
        });
    let lines: Record<
        number,
        | string
        | number
        | boolean
        | (string | number | boolean | (string | number | boolean)[] | null)[]
        | null
      > = {},
      lineCount = 0;

    if (!lineNumbers) {
      for await (const line of rl)
        lineCount++,
          (lines[lineCount] = decode(
            line,
            fieldType,
            fieldChildrenType,
            secretKey
          ));
    } else if (lineNumbers === -1) {
      let lastLine: string;
      for await (const line of rl) lineCount++, (lastLine = line);
      if (lastLine)
        lines = {
          [lineCount]: decode(
            lastLine,
            fieldType,
            fieldChildrenType,
            secretKey
          ),
        };
    } else {
      let lineNumbersArray = [
        ...(Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]),
      ];
      for await (const line of rl) {
        lineCount++;
        if (!lineNumbersArray.includes(lineCount)) continue;
        lines[lineCount] = decode(
          line,
          fieldType,
          fieldChildrenType,
          secretKey
        );
        lineNumbersArray[lineNumbersArray.indexOf(lineCount)] = 0;
        if (!lineNumbersArray.filter((lineN) => lineN !== 0).length) break;
      }
    }

    return [lines ?? null, lineCount];
  } finally {
    await fileHandle?.close();
  }
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
      >,
  secretKey?: string | Buffer
) => {
  if (await isExists(filePath)) {
    let fileHandle;
    try {
      fileHandle = await open(filePath, "r");
      const tempFilePath = `${filePath.replace(".inib", "")}-${Date.now()}.tmp`,
        rl = doesSupportReadLines()
          ? fileHandle.readLines()
          : createInterface({
              input: fileHandle.createReadStream(),
              crlfDelay: Infinity,
            }),
        writeStream = createWriteStream(tempFilePath);

      if (typeof replacements === "object" && !Array.isArray(replacements)) {
        let lineCount = 0;
        for await (const line of rl) {
          lineCount++;
          writeStream.write(
            (lineCount in replacements
              ? encode(replacements[lineCount], secretKey)
              : line) + "\n"
          );
        }
        const newLinesNumber = Object.keys(replacements)
          .map(Number)
          .filter((num) => num > lineCount);

        if (newLinesNumber.length) {
          if (Math.min(...newLinesNumber) - lineCount - 1 > 1)
            writeStream.write(
              "\n".repeat(Math.min(...newLinesNumber) - lineCount - 1)
            );
          newLinesNumber.forEach((num) =>
            writeStream.write(encode(replacements[num], secretKey) + "\n")
          );
        }
      } else
        for await (const _line of rl)
          writeStream.write(encode(replacements, secretKey) + "\n");
      writeStream.end(async () => await rename(tempFilePath, filePath)); // Rename the temp file to the original file name
    } finally {
      await fileHandle?.close();
    }
  } else if (typeof replacements === "object" && !Array.isArray(replacements)) {
    await writeFile(
      filePath,
      Object.keys(replacements)
        .map(Number)
        .sort((a, b) => a - b)
        .map((num) => replacements[num])
        .join("\n") + "\n"
    );
  }
};

export const remove = async (
  filePath: string,
  linesToDelete: number | number[]
): Promise<void> => {
  let lineCount = 0;

  const tempFilePath = `${filePath.replace(".inib", "")}-${Date.now()}.tmp`,
    linesToDeleteArray = [
      ...(Array.isArray(linesToDelete) ? linesToDelete : [linesToDelete]),
    ];
  let fileHandle;
  try {
    fileHandle = await open(filePath, "r");
    const rl = doesSupportReadLines()
        ? fileHandle.readLines()
        : createInterface({
            input: fileHandle.createReadStream(),
            crlfDelay: Infinity,
          }),
      writeStream = createWriteStream(tempFilePath);

    for await (const line of rl) {
      lineCount++;
      if (!linesToDeleteArray.includes(lineCount)) {
        writeStream.write(`${line}\n`);
      }
    }
    writeStream.end(async () => await rename(tempFilePath, filePath)); // Rename the temp file to the original file name
  } finally {
    await fileHandle?.close();
  }
};

export const count = async (filePath: string): Promise<number> => {
  let lineCount = 0;
  let fileHandle;
  try {
    fileHandle = await open(filePath, "r");
    const rl = doesSupportReadLines()
      ? fileHandle.readLines()
      : createInterface({
          input: fileHandle.createReadStream(),
          crlfDelay: Infinity,
        });
    for await (const line of rl) lineCount++;

    return lineCount;
  } finally {
    await fileHandle?.close();
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
      Record<
        string,
        string | number | boolean | (string | number | boolean | null)[] | null
      >
    > | null,
    number
  ]
> => {
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

  let RETURN: Record<
      number,
      Record<
        string,
        string | number | boolean | null | (string | number | boolean | null)[]
      >
    > = {},
    lineCount = 0,
    foundItems = 0;
  let fileHandle;
  try {
    fileHandle = await open(filePath, "r");
    const rl = doesSupportReadLines()
      ? fileHandle.readLines()
      : createInterface({
          input: fileHandle.createReadStream(),
          crlfDelay: Infinity,
        });

    const columnName = parse(filePath).name;

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
        if (!RETURN[lineCount]) RETURN[lineCount] = {};
        RETURN[lineCount][columnName] = decodedLine;
      }
    }
    if (foundItems) {
      return [RETURN, readWholeFile ? foundItems : foundItems - 1];
    } else return [null, 0];
  } finally {
    await fileHandle?.close();
  }
};

export const sum = async (
  filePath: string,
  lineNumbers?: number | number[]
): Promise<number> => {
  let fileHandle;
  try {
    fileHandle = await open(filePath, "r");
    const rl = doesSupportReadLines()
      ? fileHandle.readLines()
      : createInterface({
          input: fileHandle.createReadStream(),
          crlfDelay: Infinity,
        });
    let sum = 0;

    if (lineNumbers) {
      let lineCount = 0;

      let lineNumbersArray = [
        ...(Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]),
      ];
      for await (const line of rl) {
        lineCount++;
        if (!lineNumbersArray.includes(lineCount)) continue;
        sum += +decode(line, "number");
        lineNumbersArray[lineNumbersArray.indexOf(lineCount)] = 0;
        if (!lineNumbersArray.filter((lineN) => lineN !== 0).length) break;
      }
    } else for await (const line of rl) sum += +decode(line, "number");

    return sum;
  } finally {
    await fileHandle?.close();
  }
};

export const max = async (
  filePath: string,
  lineNumbers?: number | number[]
): Promise<number> => {
  let fileHandle;
  try {
    fileHandle = await open(filePath, "r");
    const rl = doesSupportReadLines()
      ? fileHandle.readLines()
      : createInterface({
          input: fileHandle.createReadStream(),
          crlfDelay: Infinity,
        });
    let max = 0;

    if (lineNumbers) {
      let lineCount = 0;

      let lineNumbersArray = [
        ...(Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]),
      ];
      for await (const line of rl) {
        lineCount++;
        if (!lineNumbersArray.includes(lineCount)) continue;
        const lineContentNum = +decode(line, "number");
        if (lineContentNum > max) max = lineContentNum;
        lineNumbersArray[lineNumbersArray.indexOf(lineCount)] = 0;
        if (!lineNumbersArray.filter((lineN) => lineN !== 0).length) break;
      }
    } else
      for await (const line of rl) {
        const lineContentNum = +decode(line, "number");
        if (lineContentNum > max) max = lineContentNum;
      }

    return max;
  } finally {
    await fileHandle?.close();
  }
};

export const min = async (
  filePath: string,
  lineNumbers?: number | number[]
): Promise<number> => {
  let fileHandle;
  try {
    fileHandle = await open(filePath, "r");
    const rl = doesSupportReadLines()
      ? fileHandle.readLines()
      : createInterface({
          input: fileHandle.createReadStream(),
          crlfDelay: Infinity,
        });
    let min = 0;

    if (lineNumbers) {
      let lineCount = 0;

      let lineNumbersArray = [
        ...(Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]),
      ];
      for await (const line of rl) {
        lineCount++;
        if (!lineNumbersArray.includes(lineCount)) continue;
        const lineContentNum = +decode(line, "number");
        if (lineContentNum < min) min = lineContentNum;
        lineNumbersArray[lineNumbersArray.indexOf(lineCount)] = 0;
        if (!lineNumbersArray.filter((lineN) => lineN !== 0).length) break;
      }
    } else
      for await (const line of rl) {
        const lineContentNum = +decode(line, "number");
        if (lineContentNum < min) min = lineContentNum;
      }

    return min;
  } finally {
    await fileHandle?.close();
  }
};

export const sort = async (
  filePath: string,
  sortDirection: 1 | -1 | "asc" | "desc",
  lineNumbers?: number | number[],
  _lineNumbersPerChunk: number = 100000
): Promise<void> => {
  let fileHandle;
  try {
    fileHandle = await open(filePath, "r");
    const rl = doesSupportReadLines()
      ? fileHandle.readLines()
      : createInterface({
          input: fileHandle.createReadStream(),
          crlfDelay: Infinity,
        });
    let lineCount = 0;

    for await (const line of rl) {
      lineCount++;
    }
  } finally {
    await fileHandle?.close();
  }
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
}
