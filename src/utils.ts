import { type FieldType, type Data, ComparisonOperator } from "./index.js";

/**
 * Type guard function to check if the input is an array of objects.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input is an array of objects, false otherwise.
 *
 * Note: Considers empty arrays and arrays where every element is an object.
 */
export const isArrayOfObjects = (input: any): input is Record<any, any>[] =>
  Array.isArray(input) && (input.length === 0 || input.every(isObject));

/**
 * Type guard function to check if the input is an array of arrays.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input is an array of arrays, false otherwise.
 *
 * Note: Considers empty arrays and arrays where every element is also an array.
 */
export const isArrayOfArrays = (input: any): input is any[][] =>
  Array.isArray(input) && (input.length === 0 || input.every(Array.isArray));

/**
 * Type guard function to check if the input is an array of nulls or an array of arrays of nulls.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input is an array consisting entirely of nulls or arrays of nulls, false otherwise.
 *
 * Note: Recursively checks each element, allowing for nested arrays of nulls.
 */
export const isArrayOfNulls = (input: any): input is null[] | null[][] =>
  input.every((_input: null) =>
    Array.isArray(_input) ? isArrayOfNulls(_input) : _input === null
  );

/**
 * Type guard function to check if the input is an object.
 *
 * @param obj - The value to be checked.
 * @returns boolean - True if the input is an object (excluding arrays), false otherwise.
 *
 * Note: Checks if the input is non-null and either has 'Object' as its constructor name or is of type 'object' without being an array.
 */
export const isObject = (obj: any): obj is Record<any, any> =>
  obj != null &&
  (obj.constructor.name === "Object" ||
    (typeof obj === "object" && !Array.isArray(obj)));

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
    if (source.hasOwnProperty(key)) {
      if (isObject(source[key]) && isObject(target[key]))
        target[key] = deepMerge(target[key], source[key]);
      else target[key] = source[key];
    }
  }
  return target;
};

/**
 * Combines an array of objects into a single object. If the same key exists in multiple objects, the values are merged.
 *
 * @param arr - Array of objects to be combined.
 * @returns Record<string, any> - A single object with combined keys and values.
 *
 * Note: Handles nested objects by recursively combining them. Non-object values with the same key are merged into arrays.
 */
export const combineObjects = (
  arr: Record<string, any>[]
): Record<string, any> => {
  const result: Record<string, any> = {};

  for (const obj of arr) {
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        const existingValue = result[key];
        const newValue = obj[key];

        if (
          isObject(existingValue) &&
          isObject(newValue) &&
          existingValue !== null &&
          existingValue !== undefined &&
          newValue !== null &&
          newValue !== undefined
        ) {
          // If both values are objects, recursively combine them
          result[key] = combineObjects([existingValue, newValue]);
        } else {
          // If one or both values are not objects, overwrite the existing value
          result[key] =
            existingValue !== null && existingValue !== undefined
              ? Array.isArray(existingValue)
                ? Array.isArray(newValue)
                  ? [...existingValue, ...newValue]
                  : [...existingValue, newValue]
                : Array.isArray(newValue)
                ? [existingValue, ...newValue]
                : [existingValue, newValue]
              : newValue;
        }
      }
    }
  }

  return result;
};

/**
 * Type guard function to check if the input is a number.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input is a number, false otherwise.
 *
 * Note: Validates that the input can be parsed as a float and that subtracting zero results in a number, ensuring it's a numeric value.
 */
export const isNumber = (input: any): input is number =>
  !isNaN(parseFloat(input)) && !isNaN(input - 0);

/**
 * Checks if the input is a valid email format.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input matches the email format, false otherwise.
 *
 * Note: Uses a regular expression to validate the email format, ensuring it has parts separated by '@' and contains a domain with a period.
 */
export const isEmail = (input: any) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input));

/**
 * Checks if the input is a valid URL format.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input matches the URL format, false otherwise.
 *
 * Note: Validates URLs including protocols (http/https), domain names, IP addresses, ports, paths, query strings, and fragments.
 *       Also recognizes 'tel:' and 'mailto:' as valid URL formats, as well as strings starting with '#' without spaces.
 */
export const isURL = (input: any) => {
  if (typeof input !== "string") return false;
  if (
    (input[0] === "#" && !input.includes(" ")) ||
    input.startsWith("tel:") ||
    input.startsWith("mailto:")
  )
    return true;
  else {
    var pattern = new RegExp(
      "^(https?:\\/\\/)?" + // protocol
        "((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|" + // domain name
        "localhost|" + // OR localhost
        "((\\d{1,3}\\.){3}\\d{1,3}))" + // OR ip (v4) address
        "(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*" + // port and path
        "(\\?[;&a-z\\d%_.~+=-]*)?" + // query string
        "(\\#[-a-z\\d_]*)?$",
      "i"
    ); // fragment locator
    return !!pattern.test(input);
  }
};

/**
 * Checks if the input contains HTML tags or entities.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input contains HTML tags or entities, false otherwise.
 *
 * Note: Uses a regular expression to detect HTML tags (like <tag>) and entities (like &entity;).
 *       Recognizes both opening and closing tags, as well as self-closing tags.
 */
export const isHTML = (input: any) =>
  /<\/?\s*[a-z-][^>]*\s*>|(\&(?:[\w\d]+|#\d+|#x[a-f\d]+);)/g.test(input);

/**
 * Type guard function to check if the input is a string, excluding strings that match specific formats (number, boolean, email, URL, IP).
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input is a string that doesn't match the specific formats, false otherwise.
 *
 * Note: Validates the input against being a number, boolean, email, URL, or IP address to ensure it's a general string.
 */
export const isString = (input: any): input is string =>
  Object.prototype.toString.call(input) === "[object String]" &&
  [isNumber, isBoolean, isEmail, isURL, isIP].every((fn) => !fn(input));

/**
 * Checks if the input is a valid IP address format.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input matches the IP address format, false otherwise.
 *
 * Note: Uses a regular expression to validate IP addresses, ensuring they consist of four octets, each ranging from 0 to 255.
 */
export const isIP = (input: any) =>
  /^(?:(?:^|\.)(?:2(?:5[0-5]|[0-4]\d)|1?\d?\d)){4}$/.test(input);

/**
 * Type guard function to check if the input is a boolean or a string representation of a boolean.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input is a boolean value or 'true'/'false' strings, false otherwise.
 *
 * Note: Recognizes both boolean literals (true, false) and their string representations ("true", "false").
 */
export const isBoolean = (input: any): input is boolean =>
  typeof input === "boolean" ||
  input === "true" ||
  input === "false" ||
  input === true ||
  input === false;

/**
 * Type guard function to check if the input is a password based on a specific length criterion.
 *
 * @param input - The value to be checked.
 * @returns boolean - True if the input is a string with a length of 161 characters, false otherwise.
 *
 * Note: Specifically checks for string length to determine if it matches the defined password length criterion.
 */
export const isPassword = (input: any): input is string =>
  typeof input === "string" && input.length === 97;

/**
 * Checks if the input can be converted to a valid date.
 *
 * @param input - The input to be checked, can be of any type.
 * @returns A boolean indicating whether the input is a valid date.
 */
export const isDate = (input: any) =>
  !isNaN(new Date(input).getTime()) || !isNaN(Date.parse(input));

/**
 * Checks if the input is a valid ID.
 *
 * @param input - The input to be checked, can be of any type.
 * @returns A boolean indicating whether the input is a string representing a valid ID of length 32.
 */

export const isValidID = (input: any): input is string => {
  return typeof input === "string" && input.length === 32;
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
  obj2: Record<string, string>
): Record<string, string> | null => {
  const result: Record<string, string> = {};

  for (const key1 in obj1)
    if (obj2.hasOwnProperty(key1) && obj1[key1] !== obj2[key1])
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
  availableTypes: FieldType[]
): FieldType | undefined => {
  if (!Array.isArray(input)) {
    if (
      (input === "0" ||
        input === "1" ||
        input === "true" ||
        input === "false") &&
      availableTypes.includes("boolean")
    )
      return "boolean";
    else if (isNumber(input)) {
      if (availableTypes.includes("table")) return "table";
      else if (availableTypes.includes("date")) return "date";
      else if (availableTypes.includes("number")) return "number";
    } else if (availableTypes.includes("table") && isValidID(input))
      return "table";
    else if (input.includes(",") && availableTypes.includes("array"))
      return "array";
    else if (availableTypes.includes("email") && isEmail(input)) return "email";
    else if (availableTypes.includes("url") && isURL(input)) return "url";
    else if (availableTypes.includes("password") && isPassword(input))
      return "password";
    else if (availableTypes.includes("date") && isDate(input)) return "date";
    else if (availableTypes.includes("string") && isString(input))
      return "string";
    else if (availableTypes.includes("ip") && isIP(input)) return "ip";
  } else return "array";

  return undefined;
};

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
  fieldChildrenType?: FieldType | FieldType[]
): boolean => {
  if (value === null) return true;
  if (Array.isArray(fieldType))
    return detectFieldType(value, fieldType) !== undefined;
  if (fieldType === "array" && fieldChildrenType && Array.isArray(value))
    return value.some(
      (v) =>
        detectFieldType(
          v,
          Array.isArray(fieldChildrenType)
            ? fieldChildrenType
            : [fieldChildrenType]
        ) !== undefined
    );

  switch (fieldType) {
    case "string":
      return isString(value);
    case "password":
      return isNumber(value) || isString(value) || isPassword(value);
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
                element.hasOwnProperty("id") &&
                (isValidID(element.id) || isNumber(element.id))
            )) ||
          value.every(isNumber) ||
          isValidID(value)
        );
      else if (isObject(value))
        return (
          value.hasOwnProperty("id") &&
          (isValidID((value as Data).id) || isNumber((value as Data).id))
        );
      else return isNumber(value) || isValidID(value);
    case "id":
      return isNumber(value) || isValidID(value);
    default:
      return false;
  }
};

export function FormatObjectCriteriaValue(
  value: string,
  isParentArray: boolean = false
): [
  ComparisonOperator,
  string | number | boolean | null | (string | number | null)[]
] {
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
            (value.slice(0, 1) + "=") as ComparisonOperator,
            value.slice(1) as string | number,
          ];
    case "=":
      return isParentArray
        ? [
            value.slice(0, 1) as ComparisonOperator,
            value.slice(1) as string | number,
          ]
        : [
            value.slice(0, 1) as ComparisonOperator,
            (value.slice(1) + ",") as string,
          ];
    case "*":
      return [
        value.slice(0, 1) as ComparisonOperator,
        value.slice(1) as string | number,
      ];
    default:
      return ["=", value];
  }
}

export default class Utils {
  static isNumber = isNumber;
  static isObject = isObject;
  static isEmail = isEmail;
  static isDate = isDate;
  static isURL = isURL;
  static isValidID = isValidID;
  static isPassword = isPassword;
  static deepMerge = deepMerge;
  static combineObjects = combineObjects;
  static isArrayOfObjects = isArrayOfObjects;
  static findChangedProperties = findChangedProperties;
  static detectFieldType = detectFieldType;
  static isArrayOfArrays = isArrayOfArrays;
  static isBoolean = isBoolean;
  static isString = isString;
  static isHTML = isHTML;
  static isIP = isIP;
  static validateFieldType = validateFieldType;
  static isArrayOfNulls = isArrayOfNulls;
  static FormatObjectCriteriaValue = FormatObjectCriteriaValue;
}
