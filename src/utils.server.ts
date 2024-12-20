import { exec as execSync, execFile as execFileSync } from "node:child_process";
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	scryptSync,
} from "node:crypto";
import { gunzip as gunzipSync, gzip as gzipSync } from "node:zlib";
import { promisify } from "node:util";

import type { ComparisonOperator, Field, FieldType, Schema } from "./index.js";
import {
	detectFieldType,
	isArrayOfObjects,
	isNumber,
	isPassword,
	isValidID,
} from "./utils.js";
import RE2 from "re2";

export const exec = promisify(execSync);

export const execFile = promisify(execFileSync);

export const gzip = promisify(gzipSync);

export const gunzip = promisify(gunzipSync);

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
export const comparePassword = (hash: string, password: string) => {
	const [salt, originalHash] = hash.split(":");
	const inputHash = createHash("sha256")
		.update(password + salt)
		.digest("hex");
	return inputHash === originalHash;
};

// Cache for derived keys if using scrypt
const derivedKeyCache = new Map<string, Buffer>();

// Helper function to create cipher or decipher
const getKeyAndIv = (
	secretKeyOrSalt: string | number | Buffer,
): { key: Buffer; iv: Buffer } => {
	if (Buffer.isBuffer(secretKeyOrSalt)) {
		return { key: secretKeyOrSalt, iv: secretKeyOrSalt.subarray(0, 16) };
	}
	const cacheKey = secretKeyOrSalt.toString();
	let key = derivedKeyCache.get(cacheKey);

	if (!key) {
		key = scryptSync(cacheKey, `${INIBASE_SECRET}`, 32);
		derivedKeyCache.set(cacheKey, key); // Cache the derived key
	}

	return { key, iv: key.subarray(0, 16) };
};

// Ensure the environment variable is read once
const INIBASE_SECRET = process.env.INIBASE_SECRET ?? "inibase";

// Optimized encodeID
export const encodeID = (
	id: number | string,
	secretKeyOrSalt: string | number | Buffer,
): string => {
	const { key, iv } = getKeyAndIv(secretKeyOrSalt);
	const cipher = createCipheriv("aes-256-cbc", key, iv);

	return cipher.update(id.toString(), "utf8", "hex") + cipher.final("hex");
};

// Optimized decodeID
export const decodeID = (
	input: string,
	secretKeyOrSalt: string | number | Buffer,
): number => {
	const { key, iv } = getKeyAndIv(secretKeyOrSalt);
	const decipher = createDecipheriv("aes-256-cbc", key, iv);

	return Number(decipher.update(input, "hex", "utf8") + decipher.final("utf8"));
};

// Function to recursively flatten an array of objects and their nested children
export const extractIdsFromSchema = (
	schema: Schema,
	secretKeyOrSalt: string | number | Buffer,
): number[] => {
	const result: number[] = [];

	for (const field of schema) {
		if (field.id)
			result.push(
				typeof field.id === "number"
					? field.id
					: decodeID(field.id, secretKeyOrSalt),
			);

		if (field.children && isArrayOfObjects(field.children))
			result.push(...extractIdsFromSchema(field.children, secretKeyOrSalt));
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
	secretKeyOrSalt: string | number | Buffer,
): number => Math.max(...extractIdsFromSchema(schema, secretKeyOrSalt));

/**
 * Adds or updates IDs in a schema, encoding them using a provided secret key or salt.
 *
 * @param schema - The schema to update, defined as an array of schema objects.
 * @param startWithID - An object containing the starting ID for generating new IDs.
 * @param secretKeyOrSalt - The secret key or salt for encoding IDs, can be a string, number, or Buffer.
 * @param encodeIDs - If true, IDs will be encoded, else they will remain as numbers.
 * @returns The updated schema with encoded IDs.
 */
export const addIdToSchema = (
	schema: Schema,
	startWithID: { value: number },
	secretKeyOrSalt: string | number | Buffer,
	encodeIDs?: boolean,
) => {
	function _addIdToField(field: Field) {
		if (!field.id) {
			startWithID.value++;
			field.id = encodeIDs
				? encodeID(startWithID.value, secretKeyOrSalt)
				: startWithID.value;
		} else {
			if (isValidID(field.id)) {
				if (!encodeIDs) field.id = decodeID(field.id, secretKeyOrSalt);
			} else if (encodeIDs) field.id = encodeID(field.id, secretKeyOrSalt);
		}

		if (
			(field.type === "array" || field.type === "object") &&
			isArrayOfObjects(field.children)
		)
			field.children = _addIdToSchema(field.children);
		return field;
	}
	const _addIdToSchema = (schema: Schema) => schema.map(_addIdToField);

	return _addIdToSchema(schema);
};

export const encodeSchemaID = (
	schema: Schema,
	secretKeyOrSalt: string | number | Buffer,
): Schema =>
	schema.map((field) => ({
		...field,
		id: isNumber(field.id) ? encodeID(field.id, secretKeyOrSalt) : field.id,
		...(field.children
			? isArrayOfObjects(field.children)
				? {
						children: encodeSchemaID(field.children as Schema, secretKeyOrSalt),
					}
				: { children: field.children }
			: {}),
	}));

export const hashString = (str: string): string =>
	createHash("sha256").update(str).digest("hex");

/**
 * Evaluates a comparison between two values based on a specified operator and field types.
 *
 * @param operator - The comparison operator (e.g., '=', '!=', '>', '<', '>=', '<=', '[]', '![]', '*', '!*').
 * @param originalValue - The value to compare, can be a single value or an array of values.
 * @param comparedValue - The value or values to compare against.
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
	comparedValue:
		| string
		| number
		| boolean
		| null
		| (string | number | boolean | null)[],
	fieldType?: FieldType | FieldType[],
): boolean => {
	// Determine the field type if it's an array of potential types.
	if (Array.isArray(fieldType))
		fieldType = detectFieldType(String(originalValue), fieldType);

	// Handle comparisons involving arrays.
	if (Array.isArray(comparedValue) && !["[]", "![]"].includes(operator))
		return comparedValue.some((value) =>
			compare(operator, originalValue, value, fieldType),
		);

	// Switch statement for different comparison operators.
	switch (operator) {
		// Equal (Case Insensitive for strings, specific handling for passwords and booleans).
		case "=":
			return isEqual(originalValue, comparedValue, fieldType);

		// Not Equal.
		case "!=":
			return !isEqual(originalValue, comparedValue, fieldType);

		// Greater Than.
		case ">":
			return compareNonNullValues(
				originalValue,
				comparedValue,
				(a, b) => a > b,
			);

		// Less Than.
		case "<":
			return compareNonNullValues(
				originalValue,
				comparedValue,
				(a, b) => a < b,
			);

		// Greater Than or Equal.
		case ">=":
			return compareNonNullValues(
				originalValue,
				comparedValue,
				(a, b) => a >= b,
			);

		// Less Than or Equal.
		case "<=":
			return compareNonNullValues(
				originalValue,
				comparedValue,
				(a, b) => a <= b,
			);

		// Array Contains (equality check for arrays).
		case "[]":
			return isArrayEqual(originalValue, comparedValue);

		// Array Does Not Contain.
		case "![]":
			return !isArrayEqual(originalValue, comparedValue);

		// Wildcard Match (using regex pattern).
		case "*":
			return isWildcardMatch(originalValue, comparedValue);

		// Not Wildcard Match.
		case "!*":
			return !isWildcardMatch(originalValue, comparedValue);

		// Unsupported operator.
		default:
			throw new Error(`Unsupported operator: ${operator}`);
	}
};

/**
 * Helper function to handle non-null comparisons.
 */
const compareNonNullValues = (
	originalValue: any,
	comparedValue: any,
	comparator: (a: any, b: any) => boolean,
): boolean => {
	return (
		originalValue !== null &&
		comparedValue !== null &&
		comparator(originalValue, comparedValue)
	);
};

/**
 * Helper function to check equality based on the field type.
 *
 * @param originalValue - The original value.
 * @param comparedValue - The value to compare against.
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
	comparedValue:
		| string
		| number
		| boolean
		| null
		| (string | number | boolean | null)[],
	fieldType?: FieldType,
): boolean => {
	switch (fieldType) {
		case "password":
			return isPassword(originalValue) && typeof comparedValue === "string"
				? comparePassword(originalValue, comparedValue)
				: false;
		case "boolean":
			return Number(originalValue) === Number(comparedValue);
		default: {
			// Fast checks for null-like values
			const isOriginalNullLike =
				originalValue === null ||
				originalValue === undefined ||
				originalValue === "";
			const isComparedNullLike =
				comparedValue === null ||
				comparedValue === undefined ||
				comparedValue === "";

			// If both are null-like, treat as equivalent
			if (isOriginalNullLike && isComparedNullLike) return true;

			// Direct equality check for other cases
			return originalValue === comparedValue;
		}
	}
};

/**
 * Helper function to check array equality.
 *
 * @param originalValue - The original value.
 * @param comparedValue - The value to compare against.
 * @returns boolean - Result of the array equality check.
 */
export const isArrayEqual = (
	originalValue:
		| string
		| number
		| boolean
		| null
		| (string | number | boolean | null)[],
	comparedValue:
		| string
		| number
		| boolean
		| null
		| (string | number | boolean | null)[],
): boolean => {
	if (Array.isArray(originalValue) && Array.isArray(comparedValue))
		return originalValue.some((v) => comparedValue.includes(v));

	if (Array.isArray(originalValue))
		return originalValue.includes(
			comparedValue as string | number | boolean | null,
		);

	if (Array.isArray(comparedValue))
		return comparedValue.includes(originalValue);

	return originalValue == comparedValue;
};

/**
 * Helper function to check wildcard pattern matching using regex.
 *
 * @param originalValue - The original value.
 * @param comparedValue - The value with wildcard pattern.
 * @returns boolean - Result of the wildcard pattern matching.
 */
export const isWildcardMatch = (
	originalValue:
		| string
		| number
		| boolean
		| null
		| (string | number | boolean | null)[],
	comparedValue:
		| string
		| number
		| boolean
		| null
		| (string | number | boolean | null)[],
): boolean => {
	const comparedValueStr = String(comparedValue);
	const originalValueStr = String(originalValue);
	if (
		!comparedValueStr.includes("%") &&
		(comparedValueStr === originalValueStr ||
			comparedValueStr.toLowerCase() === originalValueStr.toLowerCase())
	)
		return true;
	const wildcardPattern = `^${(
		comparedValueStr.includes("%") ? comparedValueStr : `%${comparedValueStr}%`
	).replace(/%/g, ".*")}$`;
	return new RegExp(wildcardPattern, "i").test(originalValueStr);
};

const regexCache = new Map();

/**
 * Retrieves a cached compiled regex or compiles and caches a new one.
 *
 * This function checks if a given regex pattern is already compiled and cached.
 * If it is, the cached instance is returned. If not, the function attempts to compile
 * the regex using RE2, caches the compiled instance, and then returns it. If the pattern
 * is invalid, it returns a fallback object with a `test` method that always returns `false`.
 *
 * @param {string} pattern - The regex pattern to compile or retrieve from the cache.
 * @returns {RE2} - The compiled regex instance or a fallback object on error.
 */
export const getCachedRegex = (pattern: string): RE2 => {
	if (regexCache.has(pattern)) {
		return regexCache.get(pattern);
	}
	try {
		const compiledRegex = new RE2(pattern);
		regexCache.set(pattern, compiledRegex);
		return compiledRegex;
	} catch {
		return { test: (_str: string) => false } as any;
	}
};
