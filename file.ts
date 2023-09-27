import {
  createWriteStream,
  unlinkSync,
  renameSync,
  existsSync,
  createReadStream,
  WriteStream,
} from "fs";
import { open } from "fs/promises";
import { Interface, createInterface } from "readline";
import { parse } from "path";
import { ComparisonOperator, FieldType } from ".";
import Utils from "./utils";

const doesSupportReadLines = () => {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  return major >= 18 && minor >= 11;
};

export const encodeFileName = (fileName: string, extension?: string) => {
  return (
    fileName.replaceAll("%", "%25").replaceAll("*", "%") +
    (extension ? `.${extension}` : "")
  );
};

export const decodeFileName = (fileName: string) => {
  return fileName.replaceAll("%", "*").replaceAll("*25", "%");
};

export const encode = (
  input: string | number | boolean | null | (string | number | boolean | null)[]
) => {
  const secureString = (input: string | number | boolean | null) => {
    if (["true", "false"].includes((input ?? "").toString()))
      return input ? 1 : 0;
    return typeof input === "string"
      ? decodeURIComponent(input)
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll(",", "%2C")
          .replaceAll("\n", "\\n")
          .replaceAll("\r", "\\r")
      : input;
  };
  return Array.isArray(input)
    ? input.map(secureString).join(",")
    : secureString(input);
};

export const decode = (
  input: string | null | number,
  fieldType?: FieldType
): string | number | boolean | null | (string | number | null | boolean)[] => {
  const unSecureString = (input: string) =>
    decodeURIComponent(input)
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("%2C", ",")
      .replaceAll("\\n", "\n")
      .replaceAll("\\r", "\r") || null;

  if (input === null || input === "") return null;
  if (!isNaN(Number(input)) && isFinite(Number(input)))
    return fieldType === "boolean" ? Boolean(Number(input)) : Number(input);
  return (input as string).includes(",")
    ? (input as string).split(",").map(unSecureString)
    : unSecureString(input as string);
};

export const get = async (
  filePath: string,
  fieldType?: FieldType,
  lineNumbers?: number | number[]
) => {
  let rl: Interface;
  if (doesSupportReadLines()) rl = (await open(filePath)).readLines();
  else
    rl = createInterface({
      input: createReadStream(filePath),
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
      lineCount++, (lines[lineCount] = decode(line, fieldType));
  } else if (lineNumbers === -1) {
    let lastLine;
    for await (const line of rl) lineCount++, (lastLine = line);
    if (lastLine) lines = { [lineCount]: decode(lastLine, fieldType) };
  } else {
    let lineNumbersArray = [
      ...(Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]),
    ];
    for await (const line of rl) {
      lineCount++;
      if (!lineNumbersArray.includes(lineCount)) continue;
      const indexOfLineCount = lineNumbersArray.indexOf(lineCount);
      lines[lineCount] = decode(line, fieldType);
      lineNumbersArray[indexOfLineCount] = 0;
      if (!lineNumbersArray.filter((lineN) => lineN !== 0).length) break;
    }
  }

  return lines ?? null;
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
) => {
  if (existsSync(filePath)) {
    let rl: Interface, writeStream: WriteStream;
    if (doesSupportReadLines()) {
      const file = await open(filePath, "w+");
      rl = file.readLines();
      writeStream = file.createWriteStream();
    } else {
      rl = createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
      });
      writeStream = createWriteStream(filePath);
    }
    if (typeof replacements === "object" && !Array.isArray(replacements)) {
      let lineCount = 0;
      for await (const line of rl) {
        lineCount++;
        writeStream.write(
          (lineCount in replacements ? encode(replacements[lineCount]) : line) +
            "\n"
        );
      }
    } else
      for await (const _line of rl)
        writeStream.write(encode(replacements) + "\n");

    writeStream.end();
  } else if (typeof replacements === "object" && !Array.isArray(replacements)) {
    let writeStream: WriteStream;
    if (doesSupportReadLines())
      writeStream = (await open(filePath, "w")).createWriteStream();
    else writeStream = createWriteStream(filePath);
    const largestLinesNumbers =
      Math.max(...Object.keys(replacements).map(Number)) + 1;
    for (let lineCount = 1; lineCount < largestLinesNumbers; lineCount++) {
      writeStream.write(
        (lineCount in replacements ? encode(replacements[lineCount]) : "") +
          "\n"
      );
    }
    writeStream.end();
  }
};

export const remove = async (
  filePath: string,
  linesToDelete: number | number[]
): Promise<void> => {
  let lineCount = 0;

  const tempFilePath = `${filePath}.tmp`,
    linesToDeleteArray = [
      ...(Array.isArray(linesToDelete) ? linesToDelete : [linesToDelete]),
    ];

  let rl: Interface, writeStream: WriteStream;
  if (doesSupportReadLines()) {
    rl = (await open(filePath)).readLines();
    writeStream = (await open(tempFilePath, "w+")).createWriteStream();
  } else {
    rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });
    writeStream = createWriteStream(tempFilePath);
  }

  for await (const line of rl) {
    lineCount++;
    if (!linesToDeleteArray.includes(lineCount)) {
      writeStream.write(`${line}\n`);
    }
  }
  writeStream.end();
  writeStream.on("finish", () => {
    unlinkSync(filePath); // Remove the original file
    renameSync(tempFilePath, filePath); // Rename the temp file to the original file name
  });
};

export const count = async (filePath: string): Promise<number> => {
  let lineCount = 0,
    rl: Interface;
  if (doesSupportReadLines()) rl = (await open(filePath)).readLines();
  else
    rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });

  for await (const line of rl) lineCount++;

  return lineCount;
};

export const search = async (
  filePath: string,
  fieldType: FieldType,
  operator: ComparisonOperator | ComparisonOperator[],
  comparedAtValue:
    | string
    | number
    | boolean
    | null
    | (string | number | boolean | null)[],
  logicalOperator?: "and" | "or",
  limit?: number,
  offset?: number,
  readWholeFile?: boolean
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
    value:
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
    fieldType: FieldType
  ): boolean => {
    // check if not array or object
    switch (operator) {
      case "=":
        switch (fieldType) {
          case "password":
            return typeof value === "string" &&
              typeof comparedAtValue === "string"
              ? Utils.comparePassword(value, comparedAtValue)
              : false;
          case "boolean":
            return Number(value) - Number(comparedAtValue) === 0;
          default:
            return value === comparedAtValue;
        }
      case "!=":
        return !handleComparisonOperator(
          "=",
          value,
          comparedAtValue,
          fieldType
        );
      case ">":
        return (
          value !== null && comparedAtValue !== null && value > comparedAtValue
        );
      case "<":
        return (
          value !== null && comparedAtValue !== null && value < comparedAtValue
        );
      case ">=":
        return (
          value !== null && comparedAtValue !== null && value >= comparedAtValue
        );
      case "<=":
        return (
          value !== null && comparedAtValue !== null && value <= comparedAtValue
        );
      case "[]":
        return (
          (Array.isArray(value) &&
            Array.isArray(comparedAtValue) &&
            value.some(comparedAtValue.includes)) ||
          (Array.isArray(value) &&
            !Array.isArray(comparedAtValue) &&
            value.includes(comparedAtValue)) ||
          (!Array.isArray(value) &&
            Array.isArray(comparedAtValue) &&
            comparedAtValue.includes(value))
        );
      case "![]":
        return !handleComparisonOperator(
          "[]",
          value,
          comparedAtValue,
          fieldType
        );
      case "*":
        return (
          value !== null &&
          comparedAtValue !== null &&
          new RegExp(
            `^${comparedAtValue.toString().replace(/%/g, ".*")}$`,
            "i"
          ).test(value.toString())
        );
      case "!*":
        return !handleComparisonOperator(
          "*",
          value,
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
  let rl: Interface;
  if (doesSupportReadLines()) rl = (await open(filePath)).readLines();
  else
    rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });

  const columnName = decodeFileName(parse(filePath).name);

  for await (const line of rl) {
    lineCount++;
    const decodedLine = decode(line, fieldType);
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
};

export default class File {
  static get = get;
  static remove = remove;
  static search = search;
  static replace = replace;
  static count = count;
  static encode = encode;
  static decode = decode;
  static encodeFileName = encodeFileName;
  static decodeFileName = decodeFileName;
}
