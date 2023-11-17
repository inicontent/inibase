import { FieldType, Data } from ".";
export const isArrayOfObjects = (arr: any) => {
  return Array.isArray(arr) && (arr.length === 0 || arr.every(isObject));
};
export const isArrayOfArrays = (arr: any) => {
  return Array.isArray(arr) && (arr.length === 0 || arr.every(Array.isArray));
};

export const isObject = (obj: any) =>
  obj != null &&
  (obj.constructor.name === "Object" ||
    (typeof obj === "object" && !Array.isArray(obj)));

export const deepMerge = (target: any, source: any): any => {
  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      if (source[key] instanceof Object && target[key] instanceof Object)
        target[key] = deepMerge(target[key], source[key]);
      else target[key] = source[key];
    }
  }
  return target;
};

export const combineObjects = (objectArray: Record<string, any>[]) => {
  const combinedValues: Record<string, any> = {};

  for (const obj of objectArray as any)
    for (const key in obj)
      if (!combinedValues.hasOwnProperty(key)) combinedValues[key] = obj[key];

  return combinedValues;
};

export const isNumber = (input: any | any[]): boolean =>
  Array.isArray(input)
    ? input.every(isNumber)
    : !isNaN(parseFloat(input)) && !isNaN(input - 0);

export const isEmail = (input: any) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input));

export const isURL = (input: any) => {
  if (typeof input !== "string") return false;
  if (
    input[0] === "#" ||
    input.startsWith("tel:") ||
    input.startsWith("mailto:")
  )
    return true;
  else if ("canParse" in URL) return URL.canParse(input);
  else {
    var pattern = new RegExp(
      "^(https?:\\/\\/)?" + // protocol
        "((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|" + // domain name
        "((\\d{1,3}\\.){3}\\d{1,3}))" + // OR ip (v4) address
        "(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*" + // port and path
        "(\\?[;&a-z\\d%_.~+=-]*)?" + // query string
        "(\\#[-a-z\\d_]*)?$",
      "i"
    ); // fragment locator
    return !!pattern.test(input);
  }
};

export const isHTML = (input: any) =>
  /<\/?\s*[a-z-][^>]*\s*>|(\&(?:[\w\d]+|#\d+|#x[a-f\d]+);)/g.test(input);

export const isString = (input: any) =>
  Object.prototype.toString.call(input) === "[object String]" &&
  !isNumber(input) &&
  !isBoolean(input) &&
  !isEmail(input) &&
  !isDate(input) &&
  !isURL(input) &&
  !isIP(input) &&
  !isHTML(input);

export const isIP = (input: any) =>
  /^(?:(?:^|\.)(?:2(?:5[0-5]|[0-4]\d)|1?\d?\d)){4}$/.test(input);

export const isBoolean = (input: any) =>
  typeof input === "boolean" ||
  input === "true" ||
  input === "false" ||
  input === true ||
  input === false;

export const isPassword = (input: any) => input.length === 161;

export const isDate = (input: any) =>
  !isNaN(Date.parse(String(input))) && Date.parse(String(input)) >= 0;

export const isValidID = (input: any): boolean => {
  return Array.isArray(input)
    ? input.every(isValidID)
    : typeof input === "string" && input.length === 32;
};

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
}
