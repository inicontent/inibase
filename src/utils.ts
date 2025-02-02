import type {
	ComparisonOperator,
	Data,
	Field,
	FieldType,
	Schema,
} from "./index.js";

/**
 * Type guard function to check if the input is an array of objects.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input is an array of objects, false otherwise.
 *
 * Note: Considers empty arrays and arrays where every element is an object.
 */
export const isArrayOfObjects = (input: unknown): input is Record<any, any>[] =>
	Array.isArray(input) && (input.length === 0 || input.every(isObject));

/**
 * Type guard function to check if the input is an array of arrays.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input is an array of arrays, false otherwise.
 *
 * Note: Considers empty arrays and arrays where every element is also an array.
 */
export const isArrayOfArrays = (input: unknown): input is any[][] =>
	Array.isArray(input) && input.length > 0 && input.every(Array.isArray);

/**
 * Type guard function to check if the input is an array of nulls or an array of arrays of nulls.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input is an array consisting entirely of nulls or arrays of nulls, false otherwise.
 *
 * Note: Recursively checks each element, allowing for nested arrays of nulls.
 */
export const isArrayOfNulls = (input: unknown): input is null[] | null[][] =>
	Array.isArray(input) &&
	input.every((_input: null) =>
		Array.isArray(_input)
			? isArrayOfNulls(_input)
			: _input === null || _input === 0 || _input === undefined,
	);

/**
 * Type guard function to check if the input is an object.
 *
 * @param obj - The value to be checked.
 * @returns boolean - True if the input is an object (excluding arrays), false otherwise.
 *
 * Note: Checks if the input is non-null and either has 'Object' as its constructor name or is of type 'object' without being an array.
 */
export const isObject = (object: unknown): object is Record<any, any> =>
	object != null &&
	((typeof object === "object" && !Array.isArray(object)) ||
		object.constructor?.name === "Object");

/**
 * Type guard function to check if the input is a number.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input is a number, false otherwise.
 *
 * Note: Validates that the input can be parsed as a float and that subtracting zero results in a number, ensuring it's a numeric value.
 */
export const isNumber = (input: unknown): input is number => {
	// Case 1: It's already a number (and not NaN/Infinity).
	if (typeof input === "number")
		return !Number.isNaN(input) && Number.isFinite(input);

	// Case 2: It's a string that can parse to a finite number.
	if (typeof input === "string") {
		const trimmed = input.trim();
		// Empty string or whitespace-only => not numeric
		if (!trimmed) return false;

		const parsed = Number(trimmed); // or parseFloat(trimmed)
		return !Number.isNaN(parsed) && Number.isFinite(parsed);
	}

	// Otherwise, not a numeric string or number
	return false;
};

// As a literal (no double-escaping).
const emailPattern =
	/^[A-Za-z0-9!#%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#%&'*+\/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/**
 * Checks if the input is a valid email format.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input matches the email format, false otherwise.
 *
 * Note: Uses a regular expression to validate the email format, ensuring it has parts separated by '@' and contains a domain with a period.
 */
export const isEmail = (input: unknown) =>
	typeof input === "string" && emailPattern.test(String(input));

const urlPattern = new RegExp(
	"^" +
		// Optional protocol
		"(https?:\\/\\/)?" +
		// domain name (with underscore allowed), localhost, or ipv4
		"((([a-z\\d_]([a-z\\d_\\-]*[a-z\\d_])*)\\.)+[a-z]{2,}|" +
		"localhost|" +
		"((\\d{1,3}\\.){3}\\d{1,3}))" +
		// optional port
		"(\\:\\d+)?" +
		// path
		"(\\/[-a-z\\d%_.~+]*)*" +
		// query string
		"(\\?[;&a-z\\d%_.~+=-]*)?" +
		// fragment
		"(\\#[-a-z\\d_]*)?$",
	"i",
);
/**
 * Checks if the input is a valid URL format.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input matches the URL format, false otherwise.
 *
 * Note: Validates URLs including protocols (http/https), domain names, IP addresses, ports, paths, query strings, and fragments.
 *       Also recognizes 'tel:' and 'mailto:' as valid URL formats, as well as strings starting with '#' without spaces.
 */
export const isURL = (input: unknown) => {
	if (typeof input !== "string") return false;
	if (
		(input[0] === "#" && !input.includes(" ")) ||
		input.startsWith("tel:") ||
		input.startsWith("mailto:") ||
		URL.canParse(input)
	)
		return true;

	return urlPattern.test(input);
};

const htmlPattern =
	/<([A-Za-z][A-Za-z0-9-]*)(\s+[A-Za-z-]+(\s*=\s*(?:".*?"|'.*?'|[^'">\s]+))?)*\s*>/;
/**
 * Checks if the input contains HTML tags or entities.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input contains HTML tags or entities, false otherwise.
 *
 * Note: Uses a regular expression to detect HTML tags (like <tag>) and entities (like &entity;).
 *       Recognizes both opening and closing tags, as well as self-closing tags.
 */
export const isHTML = (input: unknown) =>
	typeof input === "string" && htmlPattern.test(input);

/**
 * Type guard function to check if the input is a string, excluding strings that match specific formats (number, boolean, email, URL, IP).
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input is a string that doesn't match the specific formats, false otherwise.
 *
 * Note: Validates the input against being a number, boolean, email, URL, or IP address to ensure it's a general string.
 */
export const isString = (input: unknown): input is string =>
	Object.prototype.toString.call(input) === "[object String]" &&
	(!isNumber(input) || String(input).at(0) === "0");

const ipPattern =
	/^(?:(?:2(?:5[0-5]|[0-4]\d)|1?\d?\d)\.){3}(?:2(?:5[0-5]|[0-4]\d)|1?\d?\d)$/;
/**
 * Checks if the input is a valid IP address format.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input matches the IP address format, false otherwise.
 *
 * Note: Uses a regular expression to validate IP addresses, ensuring they consist of four octets, each ranging from 0 to 255.
 */
export const isIP = (input: unknown): input is string =>
	typeof input === "string" && ipPattern.test(input);

/**
 * Type guard function to check if the input is a boolean or a string representation of a boolean.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input is a boolean value or 'true'/'false' strings, false otherwise.
 *
 * Note: Recognizes both boolean literals (true, false) and their string representations ("true", "false").
 */
export const isBoolean = (input: unknown): input is boolean =>
	typeof input === "boolean" || input === "true" || input === "false";

/**
 * Type guard function to check if the input is a password based on a specific length criterion.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input is a string with a length of 161 characters, false otherwise.
 *
 * Note: Specifically checks for string length to determine if it matches the defined password length criterion.
 */
export const isPassword = (input: unknown): input is string =>
	typeof input === "string" && input.length === 97;

/**
 * Checks if the input can be converted to a valid date.
 *
 * @param input - The input to be checked, can be of any type.
 * @returns A boolean indicating whether the input is a valid date.
 */
export const isDate = (input: unknown): input is Date | number => {
	// Check if the input is null, undefined, or an empty string
	if (input == null || input === "") return false;

	// Convert to number and check if it's a valid number
	const numTimestamp = Number(input);
	// Check if the converted number is NaN or not finite
	if (Number.isNaN(numTimestamp) || !Number.isFinite(numTimestamp))
		return false;

	// Create a Date object from the timestamp
	const date = new Date(numTimestamp);
	// Check if the date is valid
	return date.getTime() === numTimestamp;
};

/**
 * Checks if the input is a valid ID.
 *
 * @param input - The input to be checked, can be of any type.
 * @returns A boolean indicating whether the input is a string representing a valid ID of length 32.
 */

export const isValidID = (input: unknown): input is string => {
	return typeof input === "string" && input.length === 32;
};

/**
 * Checks if a given string is a valid JSON.
 *
 * @param {string} input - The string to be checked.
 * @returns {boolean} Returns true if the string is valid JSON, otherwise false.
 */
export const isStringified = (input: unknown): boolean =>
	typeof input === "string" &&
	(input === "null" ||
		input === "undefined" ||
		input[0] === "{" ||
		input[0] === "[");

/**
 * Recursively merges properties from a source object into a target object. If a property exists in both, the source's value overwrites the target's.
 *
 * @param target - The target object to merge properties into.
 * @param source - The source object from which properties are merged.
 * @returns any - The modified target object with merged properties.
 *
 * Note: Performs a deep merge for nested objects. Non-object properties are directly overwritten.
 */
export const deepMerge = (target: any, source: any): any => {
	for (const key in source) {
		if (Object.hasOwn(source, key)) {
			if (isObject(source[key]) && isObject(target[key]))
				target[key] = deepMerge(target[key], source[key]);
			else if (source[key] !== null) target[key] = source[key];
		}
	}
	return target;
};

/**
 * Identifies and returns properties that have changed between two objects.
 *
 * @param obj1 - The first object for comparison, with string keys and values.
 * @param obj2 - The second object for comparison, with string keys and values.
 * @returns A record of changed properties with original values from obj1 and new values from obj2, or null if no changes are found.
 */
export const findChangedProperties = (
	obj1: Record<string, string>,
	obj2: Record<string, string>,
): Record<string, string> | null => {
	const result: Record<string, string> = {};

	for (const key1 in obj1)
		if (Object.hasOwn(obj2, key1) && obj1[key1] !== obj2[key1])
			result[obj1[key1]] = obj2[key1];

	return Object.keys(result).length ? result : null;
};

/**
 * Detects the field type of an input based on available types.
 *
 * @param input - The input whose field type is to be detected.
 * @param availableTypes - An array of potential field types to consider.
 * @returns The detected field type as a string, or undefined if no matching type is found.
 */
export const detectFieldType = (
	input: any,
	availableTypes: FieldType[],
): FieldType | undefined => {
	if (input !== null && input !== undefined)
		if (!Array.isArray(input)) {
			if (
				(input === "0" ||
					input === "1" ||
					input === "true" ||
					input === "false") &&
				availableTypes.includes("boolean")
			)
				return "boolean";
			if (isNumber(input)) {
				if (availableTypes.includes("table")) return "table";
				if (availableTypes.includes("date")) return "date";
				if (availableTypes.includes("number")) return "number";
				if (availableTypes.includes("string") && String(input).at(0) === "0")
					return "string";
			} else if (typeof input === "string") {
				if (availableTypes.includes("table") && isValidID(input))
					return "table";
				if (input.startsWith("[") && availableTypes.includes("array"))
					return "array";
				if (availableTypes.includes("email") && isEmail(input)) return "email";
				if (availableTypes.includes("url") && isURL(input)) return "url";
				if (availableTypes.includes("password") && isPassword(input))
					return "password";
				if (availableTypes.includes("json") && isStringified(input))
					return "json";
				if (availableTypes.includes("json") && isDate(input)) return "json";
				if (availableTypes.includes("string") && isString(input))
					return "string";
				if (availableTypes.includes("ip") && isIP(input)) return "ip";
			}
		} else return "array";

	return undefined;
};

export const isFieldType = (
	compareAtType: string | string[],
	fieldType?: FieldType | FieldType[],
	fieldChildrenType?: FieldType | FieldType[] | Schema,
) => {
	if (fieldType) {
		if (Array.isArray(fieldType)) {
			if (
				fieldType.some((type) =>
					Array.isArray(compareAtType)
						? compareAtType.includes(type)
						: compareAtType === type,
				)
			)
				return true;
		} else if (
			(Array.isArray(compareAtType) && compareAtType.includes(fieldType)) ||
			compareAtType === fieldType
		)
			return true;
	}
	if (fieldChildrenType) {
		if (Array.isArray(fieldChildrenType)) {
			if (!isArrayOfObjects(fieldChildrenType)) {
				if (
					fieldChildrenType.some((type) =>
						Array.isArray(compareAtType)
							? compareAtType.includes(type)
							: compareAtType === type,
					)
				)
					return true;
			}
		} else if (
			(Array.isArray(compareAtType) &&
				compareAtType.includes(fieldChildrenType)) ||
			compareAtType === fieldChildrenType
		)
			return true;
	}
	return false;
};

// Function to recursively flatten an array of objects and their nested children
export const flattenSchema = (schema: Schema, keepParents = false) => {
	const result: Schema = [];

	const _flattenHelper = (item: Field, parentKey: string) => {
		if (item.children && isArrayOfObjects(item.children)) {
			if (keepParents) result.push((({ children, ...rest }) => rest)(item));
			for (const child of item.children) _flattenHelper(child, item.key);
		} else
			result.push({
				...item,
				key: parentKey ? `${parentKey}.${item.key}` : item.key,
			});
	};
	for (const item of schema) _flattenHelper(item, "");

	return result;
};

export const filterSchema = (
	schema: Schema,
	callback: (arg0: Field) => boolean,
) =>
	schema.filter((field) => {
		if (field.children && isArrayOfObjects(field.children))
			field.children = filterSchema(field.children, callback);
		return callback(field);
	});

/**
 * Validates if the given value matches the specified field type(s).
 *
 * @param value - The value to be validated.
 * @param fieldType - The expected field type or an array of possible field types.
 * @param fieldChildrenType - Optional; the expected type(s) of children elements, used if the field type is an array.
 * @returns A boolean indicating whether the value matches the specified field type(s).
 */
export const validateFieldType = (
	value: any,
	fieldType: FieldType | FieldType[],
	fieldChildrenType?: FieldType | FieldType[],
): boolean => {
	if (value === null) return true;
	if (Array.isArray(fieldType)) {
		const detectedFieldType = detectFieldType(value, fieldType);
		if (!detectedFieldType) return false;
		fieldType = detectedFieldType;
	}
	if (fieldType === "array" && fieldChildrenType)
		return (
			Array.isArray(value) &&
			value.every((v: any) => {
				let _fieldChildrenType = fieldChildrenType;
				if (Array.isArray(_fieldChildrenType)) {
					const detectedFieldType = detectFieldType(v, _fieldChildrenType);
					if (!detectedFieldType) return false;
					_fieldChildrenType = detectedFieldType;
				}
				return validateFieldType(v, _fieldChildrenType);
			})
		);
	switch (fieldType) {
		case "string":
			return isString(value);
		case "password":
			return !Array.isArray(value) && !isObject(value); // accept
		case "number":
			return isNumber(value);
		case "html":
			return isHTML(value);
		case "ip":
			return isIP(value);
		case "boolean":
			return isBoolean(value);
		case "date":
			return isDate(value);
		case "object":
			return isObject(value);
		case "array":
			return Array.isArray(value);
		case "email":
			return isEmail(value);
		case "url":
			return isURL(value);
		case "table":
			// feat: check if id exists
			if (Array.isArray(value))
				return (
					(isArrayOfObjects(value) &&
						value.every(
							(element: Data) =>
								Object.hasOwn(element, "id") &&
								(isValidID(element.id) || isNumber(element.id)),
						)) ||
					value.every(isNumber) ||
					isValidID(value)
				);
			if (isObject(value))
				return (
					Object.hasOwn(value, "id") &&
					(isValidID((value as Data).id) || isNumber((value as Data).id))
				);
			return isNumber(value) || isValidID(value);
		case "id":
			return isNumber(value) || isValidID(value);
		case "json":
			return isStringified(value) || Array.isArray(value) || isObject(value);
		default:
			return false;
	}
};

export const FormatObjectCriteriaValue = (
	value: string,
): [
	ComparisonOperator,
	string | number | boolean | null | (string | number | null)[],
] => {
	switch (value[0]) {
		case ">":
		case "<":
			return value[1] === "="
				? [
						value.slice(0, 2) as ComparisonOperator,
						value.slice(2) as string | number,
					]
				: [
						value.slice(0, 1) as ComparisonOperator,
						value.slice(1) as string | number,
					];
		case "[":
			return value[1] === "]"
				? [
						value.slice(0, 2) as ComparisonOperator,
						(value.slice(2) as string | number).toString().split(","),
					]
				: ["[]", value.slice(1) as string | number];
		case "!":
			return ["=", "*"].includes(value[1])
				? [
						value.slice(0, 2) as ComparisonOperator,
						value.slice(2) as string | number,
					]
				: value[1] === "["
					? [
							value.slice(0, 3) as ComparisonOperator,
							value.slice(3) as string | number,
						]
					: [
							`${value.slice(0, 1)}=` as ComparisonOperator,
							value.slice(1) as string | number,
						];
		case "=":
			return [
				value.slice(0, 1) as ComparisonOperator,
				value.slice(1) as string | number,
			];
		case "*":
			return [
				value.slice(0, 1) as ComparisonOperator,
				value.slice(1) as string | number,
			];
		default:
			return ["=", value];
	}
};

/**
 * Get field from schema
 *
 * @export
 * @param {string} keyPath Support dot notation path
 * @param {Schema} schema
 */
export const getField = (keyPath: string, schema: Schema) => {
	let RETURN: Field | Schema | null = schema;
	const keyPathSplited = keyPath.split(".");
	for (const [index, key] of keyPathSplited.entries()) {
		if (!isArrayOfObjects(RETURN)) return null;
		const foundItem: Field | undefined = (RETURN as Schema).find(
			(item) => item.key === key,
		);
		if (!foundItem) return null;
		if (index === keyPathSplited.length - 1) RETURN = foundItem;
		if (
			(foundItem.type === "array" || foundItem.type === "object") &&
			foundItem.children &&
			isArrayOfObjects(foundItem.children)
		)
			RETURN = foundItem.children;
	}
	if (!RETURN) return null;
	return isArrayOfObjects(RETURN) ? RETURN[0] : RETURN;
};

/**
 * Override a schema field, key, type or other properties
 *
 * @export
 * @param {string} keyPath Support dot notation path
 * @param {Schema} schema
 * @param {(Omit<Field, "key" | "type"> & {
 * 		key?: string;
 * 		type?: FieldType | FieldType[];
 * 	})} field
 */
export const setField = (
	keyPath: string,
	schema: Schema,
	field: Omit<Field, "key" | "type"> & {
		key?: string;
		type?: FieldType | FieldType[];
	},
) => {
	const keyPathSplited = keyPath.split(".");
	for (const [index, key] of keyPathSplited.entries()) {
		const foundItem = schema.find((item) => item.key === key);
		if (!foundItem) return null;
		if (index === keyPathSplited.length - 1) {
			Object.assign(foundItem, field);
			return foundItem;
		}
		if (
			(foundItem.type === "array" || foundItem.type === "object") &&
			foundItem.children &&
			isArrayOfObjects(foundItem.children)
		)
			schema = foundItem.children as Schema;
	}
};

/**
 * Remove field from schema
 *
 * @export
 * @param {string} keyPath Support dot notation path
 * @param {Schema} schema
 */
export const unsetField = (keyPath: string, schema: Schema) => {
	const keyPathSplited = keyPath.split(".");
	let parent: any = null;
	let targetIndex: number | undefined;

	for (const [index, key] of keyPathSplited.entries()) {
		const foundItem = schema.find((item) => item.key === key);
		if (!foundItem) return null;
		if (index === keyPathSplited.length - 1) {
			if (parent) {
				if (Array.isArray(parent)) {
					if (targetIndex !== undefined) parent.splice(targetIndex, 1);
				} else delete parent[key];
			} else {
				const indexToRemove = schema.indexOf(foundItem);
				if (indexToRemove !== -1) schema.splice(indexToRemove, 1);
			}
			return foundItem;
		}
		if (
			(foundItem.type === "array" || foundItem.type === "object") &&
			foundItem.children &&
			isArrayOfObjects(foundItem.children)
		) {
			parent = foundItem.children;
			targetIndex = schema.indexOf(foundItem);
			schema = foundItem.children as Schema;
		} else {
			parent = foundItem;
			targetIndex = undefined;
		}
	}
};
