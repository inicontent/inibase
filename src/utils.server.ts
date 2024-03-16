import type { ComparisonOperator, FieldType, Schema } from "./index.js";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  type Cipher,
  type Decipher,
  createHash,
} from "node:crypto";
import {
  detectFieldType,
  isArrayOfObjects,
  isNumber,
  isPassword,
  isValidID,
} from "./utils.js";
import { promisify } from "node:util";
import { exec as execAsync } from "node:child_process";

export const exec = promisify(execAsync);

/**
 * Generates a hashed password using SHA-256.
 *
 * @param password - The plain text password to hash.
 * @returns A string containing the salt and the hashed password, separated by a colon.
 */
export const hashPassword = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256")
    .update(password + salt)
    .digest("hex");
  return `${salt}:${hash}`;
};

/**
 * Compares a hashed password with an input password to verify a match.
 *
 * @param hashedPassword - The hashed password, containing both the salt and the hash, separated by a colon.
 * @param inputPassword - The plain text input password to compare against the hashed password.
 * @returns A boolean indicating whether the input password matches the hashed password.
 */
export const comparePassword = (
  hashedPassword: string,
  inputPassword: string
) => {
  const [salt, originalHash] = hashedPassword.split(":");
  const inputHash = createHash("sha256")
    .update(inputPassword + salt)
    .digest("hex");
  return inputHash === originalHash;
};

/**
 * Encodes an ID using AES-256-CBC encryption.
 *
 * @param id - The ID to encode, either a number or a string.
 * @param secretKeyOrSalt - The secret key or salt for encryption, can be a string, number, or Buffer.
 * @returns The encoded ID as a hexadecimal string.
 */
export const encodeID = (
  id: number | string,
  secretKeyOrSalt: string | number | Buffer
): string => {
  let cipher: Cipher;

  if (Buffer.isBuffer(secretKeyOrSalt))
    cipher = createCipheriv(
      "aes-256-cbc",
      secretKeyOrSalt,
      secretKeyOrSalt.subarray(0, 16)
    );
  else {
    const salt = scryptSync(
      secretKeyOrSalt.toString(),
      (process.env.INIBASE_SECRET ?? "inibase") + "_salt",
      32
    );
    cipher = createCipheriv("aes-256-cbc", salt, salt.subarray(0, 16));
  }

  return cipher.update(id.toString(), "utf8", "hex") + cipher.final("hex");
};

/**
 * Decodes an encrypted ID using AES-256-CBC decryption.
 *
 * @param input - The encrypted ID as a hexadecimal string.
 * @param secretKeyOrSalt - The secret key or salt used for decryption, can be a string, number, or Buffer.
 * @returns The decoded ID as a number.
 */

export const decodeID = (
  input: string,
  secretKeyOrSalt: string | number | Buffer
): number => {
  let decipher: Decipher;

  if (Buffer.isBuffer(secretKeyOrSalt))
    decipher = createDecipheriv(
      "aes-256-cbc",
      secretKeyOrSalt,
      secretKeyOrSalt.subarray(0, 16)
    );
  else {
    const salt = scryptSync(
      secretKeyOrSalt.toString(),
      (process.env.INIBASE_SECRET ?? "inibase") + "_salt",
      32
    );
    decipher = createDecipheriv("aes-256-cbc", salt, salt.subarray(0, 16));
  }

  return Number(
    decipher.update(input as string, "hex", "utf8") + decipher.final("utf8")
  );
};

// Function to recursively flatten an array of objects and their nested children
const _flattenSchema = (
  schema: Schema,
  secretKeyOrSalt: string | number | Buffer
): number[] => {
  const result: number[] = [];

  for (const field of schema) {
    if (field.id)
      result.push(
        typeof field.id === "number"
          ? field.id
          : decodeID(field.id, secretKeyOrSalt)
      );

    if (field.children && isArrayOfObjects(field.children))
      result.push(..._flattenSchema(field.children, secretKeyOrSalt));
  }

  return result;
};

/**
 * Finds the last ID number in a schema, potentially decoding it if encrypted.
 *
 * @param schema - The schema to search, defined as an array of schema objects.
 * @param secretKeyOrSalt - The secret key or salt for decoding an encrypted ID, can be a string, number, or Buffer.
 * @returns The last ID number in the schema, decoded if necessary.
 */
export const findLastIdNumber = (
  schema: Schema,
  secretKeyOrSalt: string | number | Buffer
): number => Math.max(..._flattenSchema(schema, secretKeyOrSalt));

/**
 * Adds or updates IDs in a schema, encoding them using a provided secret key or salt.
 *
 * @param schema - The schema to update, defined as an array of schema objects.
 * @param oldIndex - The starting index for generating new IDs, defaults to 0.
 * @param secretKeyOrSalt - The secret key or salt for encoding IDs, can be a string, number, or Buffer.
 * @param encodeIDs - If true, IDs will be encoded, else they will remain as numbers.
 * @returns The updated schema with encoded IDs.
 */
export const addIdToSchema = (
  schema: Schema,
  oldIndex: number = 0,
  secretKeyOrSalt: string | number | Buffer,
  encodeIDs?: boolean
) =>
  schema.map((field) => {
    if (!field.id) {
      oldIndex++;
      field.id = encodeIDs ? encodeID(oldIndex, secretKeyOrSalt) : oldIndex;
    } else {
      if (isValidID(field.id)) {
        oldIndex = decodeID(field.id, secretKeyOrSalt);
        if (!encodeIDs) field.id = oldIndex;
      } else {
        oldIndex = field.id;
        if (encodeIDs) field.id = encodeID(field.id, secretKeyOrSalt);
      }
    }
    if (
      (field.type === "array" || field.type === "object") &&
      isArrayOfObjects(field.children)
    ) {
      field.children = addIdToSchema(
        field.children,
        oldIndex,
        secretKeyOrSalt,
        encodeIDs
      );
      oldIndex += field.children.length;
    }
    return field;
  });

export const encodeSchemaID = (
  schema: Schema,
  secretKeyOrSalt: string | number | Buffer
): Schema =>
  schema.map((field) => ({
    ...field,
    id: isNumber(field.id) ? encodeID(field.id, secretKeyOrSalt) : field.id,
    ...(field.children
      ? isArrayOfObjects(field.children)
        ? {
            children: encodeSchemaID(field.children as Schema, secretKeyOrSalt),
          }
        : { children: field.children as any }
      : {}),
  }));

export const hashString = (str: string): string =>
  createHash("sha256").update(str).digest("hex");

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
export const compare = (
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
  // Determine the field type if it's an array of potential types.
  if (Array.isArray(fieldType)) {
    fieldType = detectFieldType(String(originalValue), fieldType);
  }

  // Handle comparisons involving arrays.
  if (Array.isArray(comparedAtValue) && !["[]", "![]"].includes(operator)) {
    return comparedAtValue.some((comparedAtValueSingle) =>
      compare(operator, originalValue, comparedAtValueSingle, fieldType)
    );
  }

  // Switch statement for different comparison operators.
  switch (operator) {
    // Equal (Case Insensitive for strings, specific handling for passwords and booleans).
    case "=":
      return isEqual(originalValue, comparedAtValue, fieldType);

    // Not Equal.
    case "!=":
      return !isEqual(originalValue, comparedAtValue, fieldType);

    // Greater Than.
    case ">":
      return (
        originalValue !== null &&
        comparedAtValue !== null &&
        originalValue > comparedAtValue
      );

    // Less Than.
    case "<":
      return (
        originalValue !== null &&
        comparedAtValue !== null &&
        originalValue < comparedAtValue
      );

    // Greater Than or Equal.
    case ">=":
      return (
        originalValue !== null &&
        comparedAtValue !== null &&
        originalValue >= comparedAtValue
      );

    // Less Than or Equal.
    case "<=":
      return (
        originalValue !== null &&
        comparedAtValue !== null &&
        originalValue <= comparedAtValue
      );

    // Array Contains (equality check for arrays).
    case "[]":
      return isArrayEqual(originalValue, comparedAtValue);

    // Array Does Not Contain.
    case "![]":
      return !isArrayEqual(originalValue, comparedAtValue);

    // Wildcard Match (using regex pattern).
    case "*":
      return isWildcardMatch(originalValue, comparedAtValue);

    // Not Wildcard Match.
    case "!*":
      return !isWildcardMatch(originalValue, comparedAtValue);

    // Unsupported operator.
    default:
      throw new Error(`Unsupported operator: ${operator}`);
  }
};

/**
 * Helper function to check equality based on the field type.
 *
 * @param originalValue - The original value.
 * @param comparedAtValue - The value to compare against.
 * @param fieldType - Type of the field.
 * @returns boolean - Result of the equality check.
 */
export const isEqual = (
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
  fieldType?: FieldType | FieldType[]
): boolean => {
  // Switch based on the field type for specific handling.
  switch (fieldType) {
    // Password comparison.
    case "password":
      return isPassword(originalValue) && typeof comparedAtValue === "string"
        ? comparePassword(originalValue, comparedAtValue)
        : false;

    // Boolean comparison.
    case "boolean":
      return Number(originalValue) === Number(comparedAtValue);

    // Default comparison.
    default:
      return originalValue === comparedAtValue;
  }
};

/**
 * Helper function to check array equality.
 *
 * @param originalValue - The original value.
 * @param comparedAtValue - The value to compare against.
 * @returns boolean - Result of the array equality check.
 */
export const isArrayEqual = (
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
    | (string | number | boolean | null)[]
): boolean => {
  return (
    (Array.isArray(originalValue) &&
      Array.isArray(comparedAtValue) &&
      originalValue.some((v) => comparedAtValue.includes(v))) ||
    (Array.isArray(originalValue) &&
      !Array.isArray(comparedAtValue) &&
      originalValue.includes(comparedAtValue)) ||
    (!Array.isArray(originalValue) &&
      Array.isArray(comparedAtValue) &&
      comparedAtValue.includes(originalValue)) ||
    (!Array.isArray(originalValue) &&
      !Array.isArray(comparedAtValue) &&
      comparedAtValue === originalValue)
  );
};

/**
 * Helper function to check wildcard pattern matching using regex.
 *
 * @param originalValue - The original value.
 * @param comparedAtValue - The value with wildcard pattern.
 * @returns boolean - Result of the wildcard pattern matching.
 */
export const isWildcardMatch = (
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
    | (string | number | boolean | null)[]
): boolean => {
  const wildcardPattern = `^${(String(comparedAtValue).includes("%")
    ? String(comparedAtValue)
    : "%" + String(comparedAtValue) + "%"
  ).replace(/%/g, ".*")}$`;
  return new RegExp(wildcardPattern, "i").test(String(originalValue));
};

export default class UtilsServer {
  static encodeID = encodeID;
  static decodeID = decodeID;
  static hashPassword = hashPassword;
  static comparePassword = comparePassword;
  static findLastIdNumber = findLastIdNumber;
  static addIdToSchema = addIdToSchema;
  static hashString = hashString;
  static exec = exec;
  static compare = compare;
  static isEqual = isEqual;
  static isArrayEqual = isArrayEqual;
  static isWildcardMatch = isWildcardMatch;
  static encodeSchemaID = encodeSchemaID;
}
