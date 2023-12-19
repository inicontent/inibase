import {
  FileHandle,
  open,
  rename,
  stat,
  writeFile,
  appendFile,
} from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { ComparisonOperator, FieldType } from './index.js';
import {
  detectFieldType,
  isArrayOfArrays,
  isNumber,
  isObject,
} from './utils.js';
import { encodeID, comparePassword } from './utils.server.js';

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

const delimiters = [',', '|', '&', '$', '#', '@', '^', ':', '!', ';'];

/**
 * Secures input by encoding/escaping characters.
 *
 * @param input - String, number, boolean, or null.
 * @returns Encoded string for true/false, special characters in strings, or original input.
 */
const secureString = (input: string | number | boolean | null) => {
  if (['true', 'false'].includes(String(input))) return input ? 1 : 0;
  return typeof input === 'string'
    ? decodeURIComponent(input.replace(/%(?![0-9][0-9a-fA-F]+)/g, ''))
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll(',', '%2C')
        .replaceAll('|', '%7C')
        .replaceAll('&', '%26')
        .replaceAll('$', '%24')
        .replaceAll('#', '%23')
        .replaceAll('@', '%40')
        .replaceAll('^', '%5E')
        .replaceAll(':', '%3A')
        .replaceAll('!', '%21')
        .replaceAll(';', '%3B')
        .replaceAll('\n', '\\n')
        .replaceAll('\r', '\\r')
    : input;
};

/**
 * Secures each element in an array or a single value using secureString.
 *
 * @param arr_str - An array or a single value of any type.
 * @returns An array with each element secured, or a single secured value.
 */
const secureArray = (arr_str: any[] | any): any[] | any =>
  Array.isArray(arr_str) ? arr_str.map(secureArray) : secureString(arr_str);

/**
 * Joins elements of a multidimensional array into a string.
 *
 * @param arr - A multidimensional array or a single level array.
 * @param delimiter_index - Index for selecting delimiter, defaults to 0.
 * @returns Joined string of array elements with appropriate delimiters.
 */
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

/**
 * Encodes the input using 'secureString' and 'joinMultidimensionalArray' functions.
 * If the input is an array, it is first secured and then joined into a string.
 * If the input is a single value, it is directly secured.
 *
 * @param input - A value or array of values (string, number, boolean, null).
 * @param secretKey - Optional secret key for encoding, can be a string or Buffer.
 * @returns The secured and/or joined string.
 */
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

/**
 * Reverses the encoding done by 'secureString'. Replaces encoded characters with their original symbols.
 *
 * @param input - Encoded string.
 * @returns Decoded string or null if input is empty.
 */
const unSecureString = (input: string) =>
  input
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('%2C', ',')
    .replaceAll('%7C', '|')
    .replaceAll('%26', '&')
    .replaceAll('%24', '$')
    .replaceAll('%23', '#')
    .replaceAll('%40', '@')
    .replaceAll('%5E', '^')
    .replaceAll('%3A', ':')
    .replaceAll('%21', '!')
    .replaceAll('%3B', ';')
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\r') || null;

/**
 * Decodes each element in an array or a single value using unSecureString.
 *
 * @param arr_str - An array or a single value of any type.
 * @returns An array with each element decoded, or a single decoded value.
 */
const unSecureArray = (arr_str: any[] | any): any[] | any =>
  Array.isArray(arr_str) ? arr_str.map(unSecureArray) : unSecureString(arr_str);

/**
 * Reverses the process of 'joinMultidimensionalArray', splitting a string back into a multidimensional array.
 * It identifies delimiters used in the joined string and applies them recursively to reconstruct the original array structure.
 *
 * @param joinedString - A string, array, or multidimensional array.
 * @returns Original array structure before joining, or the input if no delimiters are found.
 */
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
  if (Array.isArray(value) && fieldType !== 'array')
    return value.map((v) =>
      decodeHelper(v, fieldType, fieldChildrenType, secretKey)
    );
  switch (fieldType as FieldType) {
    case 'table':
    case 'number':
      return isNumber(value) ? Number(value) : null;
    case 'boolean':
      return typeof value === 'string' ? value === 'true' : Boolean(value);
    case 'array':
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
    case 'id':
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
  if (input === null || input === '') return null;
  if (Array.isArray(fieldType))
    fieldType = detectFieldType(String(input), fieldType);
  return decodeHelper(
    typeof input === 'string'
      ? input.includes(',')
        ? unSecureArray(reverseJoinMultidimensionalArray(input))
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
  const fileHandle = await open(filePath, 'r'),
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

/**
 * Asynchronously replaces specific lines in a file based on the provided replacements map or string.
 *
 * @param filePath - Path of the file to modify.
 * @param replacements - Map of line numbers to replacement values, or a single replacement value for all lines.
 *   Can be a string, number, boolean, null, array of these types, or a Record/Map of line numbers to these types.
 * @returns void. The function modifies the file directly.
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
    | Map<number, string | number | boolean | (string | number | boolean)[]>
) => {
  if (await isExists(filePath)) {
    let lineCount = 0;
    const fileHandle = await open(filePath, 'r'),
      fileTempPath = `${filePath.replace('.inib', '')}-${Date.now()}.tmp`,
      fileTempHandle = await open(fileTempPath, 'w'),
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
            : line) + '\n'
        );
      }
      const newLinesNumbers = new Set(
        [...replacements.keys()].filter((num) => num > lineCount)
      );

      if (newLinesNumbers.size) {
        if (Math.min(...newLinesNumbers) - lineCount - 1 > 1)
          writeStream.write(
            '\n'.repeat(Math.min(...newLinesNumbers) - lineCount - 1)
          );

        for await (const newLineNumber of newLinesNumbers)
          writeStream.write(
            replacements.get(newLineNumber.toString() as any) + '\n'
          );
      }
    } else for await (const _line of rl) writeStream.write(replacements + '\n');

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
        ? '\n'.repeat(Math.min(...replacements.keys()) - 1)
        : '') +
        Array.from(
          new Map(
            [...replacements.entries()].sort(([keyA], [keyB]) => keyA - keyB)
          ).values()
        ).join('\n') +
        '\n'
    );
  }
};

/**
 * Asynchronously appends data to a file, starting from a specified line number.
 *
 * @param filePath - Path of the file to append to.
 * @param data - Data to append. Can be a string, number, or an array of strings/numbers.
 * @param startsAt - The line number to start appending from. Defaults to 1.
 * @returns Promise<void>. Modifies the file by appending data.
 *
 * Note: If the file exists, it calculates the current number of lines and appends accordingly.
 *       If the file doesn't exist, it creates a new one starting with the specified data.
 */
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
        ? '\n'.repeat(startsAt - currentNumberOfLines - 1)
        : ''
      : '') +
      (Array.isArray(data) ? data.join('\n') : data) +
      '\n'
  );
};

/**
 * Asynchronously removes specified lines from a file.
 *
 * @param filePath - Path of the file from which lines are to be removed.
 * @param linesToDelete - A single line number or an array of line numbers to be deleted.
 * @returns Promise<void>. Modifies the file by removing specified lines.
 *
 * Note: Creates a temporary file during the process and replaces the original file with it after removing lines.
 */
export const remove = async (
  filePath: string,
  linesToDelete: number | number[]
): Promise<void> => {
  let lineCount = 0;

  const fileHandle = await open(filePath, 'r'),
    fileTempPath = `${filePath.replace('.inib', '')}-${Date.now()}.tmp`,
    fileTempHandle = await open(fileTempPath, 'w'),
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
  let lineCount = 0;

  const fileHandle = await open(filePath, 'r'),
    rl = readLineInternface(fileHandle);

  for await (const line of rl) lineCount++;

  await fileHandle.close();
  return lineCount;
};

/**
 * Evaluates a comparison between two values based on a specified operator and field types.
 *
 * @param operator - The comparison operator (e.g., '=', '!=', '>', '<', '>=', '<=', '[]', '![]', '*', '!*').
 * @param originalValue - The value to compare, can be a single value or an array of values.
 * @param comparedAtValue - The value or values to compare against.
 * @param fieldType - Optional type of the field to guide comparison (e.g., 'password', 'boolean').
 * @param fieldChildrenType - Optional type for child elements in array inputs.
 * @returns boolean - Result of the comparison operation.
 *
 * Note: Handles various data types and comparison logic, including special handling for passwords and regex patterns.
 */
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
  if (Array.isArray(comparedAtValue) && !['[]', '![]'].includes(operator))
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
    case '=':
      switch (fieldType) {
        case 'password':
          return typeof originalValue === 'string' &&
            typeof comparedAtValue === 'string'
            ? comparePassword(originalValue, comparedAtValue)
            : false;
        case 'boolean':
          return Number(originalValue) - Number(comparedAtValue) === 0;
        default:
          return originalValue === comparedAtValue;
      }
    case '!=':
      return !handleComparisonOperator(
        '=',
        originalValue,
        comparedAtValue,
        fieldType
      );
    case '>':
      return (
        originalValue !== null &&
        comparedAtValue !== null &&
        originalValue > comparedAtValue
      );
    case '<':
      return (
        originalValue !== null &&
        comparedAtValue !== null &&
        originalValue < comparedAtValue
      );
    case '>=':
      return (
        originalValue !== null &&
        comparedAtValue !== null &&
        originalValue >= comparedAtValue
      );
    case '<=':
      return (
        originalValue !== null &&
        comparedAtValue !== null &&
        originalValue <= comparedAtValue
      );
    case '[]':
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
    case '![]':
      return !handleComparisonOperator(
        '[]',
        originalValue,
        comparedAtValue,
        fieldType
      );
    case '*':
      return new RegExp(
        `^${(String(comparedAtValue).includes('%')
          ? String(comparedAtValue)
          : '%' + String(comparedAtValue) + '%'
        ).replace(/%/g, '.*')}$`,
        'i'
      ).test(String(originalValue));
    case '!*':
      return !handleComparisonOperator(
        '*',
        originalValue,
        comparedAtValue,
        fieldType
      );
    default:
      throw new Error(operator);
  }
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
  logicalOperator?: 'and' | 'or',
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

  const fileHandle = await open(filePath, 'r'),
    rl = readLineInternface(fileHandle);

  for await (const line of rl) {
    lineCount++;
    const decodedLine = decode(line, fieldType, fieldChildrenType, secretKey);
    if (
      (Array.isArray(operator) &&
        Array.isArray(comparedAtValue) &&
        ((logicalOperator &&
          logicalOperator === 'or' &&
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

  const fileHandle = await open(filePath, 'r'),
    rl = readLineInternface(fileHandle);

  if (lineNumbers) {
    let lineCount = 0;
    let lineNumbersArray = new Set(
      Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]
    );

    for await (const line of rl) {
      lineCount++;
      if (!lineNumbersArray.has(lineCount)) continue;
      sum += +(decode(line, 'number') ?? 0);
      lineNumbersArray.delete(lineCount);
      if (!lineNumbersArray.size) break;
    }
  } else for await (const line of rl) sum += +(decode(line, 'number') ?? 0);

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

  const fileHandle = await open(filePath, 'r'),
    rl = readLineInternface(fileHandle);

  if (lineNumbers) {
    let lineCount = 0;

    let lineNumbersArray = new Set(
      Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]
    );
    for await (const line of rl) {
      lineCount++;
      if (!lineNumbersArray.has(lineCount)) continue;
      const lineContentNum = +(decode(line, 'number') ?? 0);
      if (lineContentNum > max) max = lineContentNum;
      lineNumbersArray.delete(lineCount);
      if (!lineNumbersArray.size) break;
    }
  } else
    for await (const line of rl) {
      const lineContentNum = +(decode(line, 'number') ?? 0);
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

  const fileHandle = await open(filePath, 'r'),
    rl = readLineInternface(fileHandle);

  if (lineNumbers) {
    let lineCount = 0;

    let lineNumbersArray = new Set(
      Array.isArray(lineNumbers) ? lineNumbers : [lineNumbers]
    );
    for await (const line of rl) {
      lineCount++;
      if (!lineNumbersArray.has(lineCount)) continue;
      const lineContentNum = +(decode(line, 'number') ?? 0);
      if (lineContentNum < min) min = lineContentNum;
      lineNumbersArray.delete(lineCount);
      if (!lineNumbersArray.size) break;
    }
  } else
    for await (const line of rl) {
      const lineContentNum = +(decode(line, 'number') ?? 0);
      if (lineContentNum < min) min = lineContentNum;
    }

  await fileHandle.close();
  return min;
};

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
  sortDirection: 1 | -1 | 'asc' | 'desc',
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
