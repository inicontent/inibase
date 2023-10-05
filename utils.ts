import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createDecipheriv,
  createCipheriv,
} from "crypto";
import { FieldType } from ".";

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

export const isNumber = (input: any): boolean =>
  Array.isArray(input)
    ? input.every(isNumber)
    : !isNaN(parseFloat(input)) && !isNaN(input - 0);

export const isEmail = (input: any) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input));

export const isURL = (input: any) =>
  input[0] === "#" ||
  /^((https?|www):\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]+(\/[^\s]*)?$/.test(
    input
  );

export const isPassword = (input: any) => input.length === 161;

export const isDate = (input: any) =>
  !isNaN(Date.parse(String(input))) && Date.parse(String(input)) >= 0;

export const hashPassword = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  const buf = scryptSync(password, salt, 64);
  // return "161" length string
  return `${buf.toString("hex")}.${salt}`;
};

export const comparePassword = (
  storedPassword: string,
  suppliedPassword: string
) => {
  // split() returns array
  const [hashedPassword, salt] = storedPassword.split(".");
  // we need to pass buffer values to timingSafeEqual
  const hashedPasswordBuf = Buffer.from(hashedPassword, "hex");
  // we hash the new sign-in password
  const suppliedPasswordBuf = scryptSync(suppliedPassword, salt, 64);
  // compare the new supplied password with the stored hashed password
  return timingSafeEqual(hashedPasswordBuf, suppliedPasswordBuf);
};

export const encodeID = (id: number, secretKey: string | number): string => {
  const salt = scryptSync(secretKey.toString(), "salt", 32),
    cipher = createCipheriv("aes-256-cbc", salt, salt.subarray(0, 16));

  return cipher.update(id.toString(), "utf8", "hex") + cipher.final("hex");
};

export const decodeID = (input: string, secretKey: string | number): number => {
  const salt = scryptSync(secretKey.toString(), "salt", 32),
    decipher = createDecipheriv("aes-256-cbc", salt, salt.subarray(0, 16));
  return Number(
    decipher.update(input as string, "hex", "utf8") + decipher.final("utf8")
  );
};

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
  if (
    (input === "0" || input === "1" || input === "true" || input === "false") &&
    availableTypes.includes("boolean")
  )
    return "boolean";
  else if (Utils.isNumber(input)) {
    if (availableTypes.includes("table")) return "table";
    else if (availableTypes.includes("number")) return "number";
    else if (availableTypes.includes("date")) return "date";
  } else if (
    (Array.isArray(input) || input.includes(",")) &&
    availableTypes.includes("array")
  )
    return "array";
  else if (Utils.isEmail(input) && availableTypes.includes("email"))
    return "email";
  else if (Utils.isURL(input) && availableTypes.includes("url")) return "url";
  else if (Utils.isPassword(input) && availableTypes.includes("password"))
    return "password";
  else if (Utils.isDate(input) && availableTypes.includes("date"))
    return "date";
  else if (!Utils.isNumber(input) && availableTypes.includes("string"))
    return "string";
  else return undefined;
};

export default class Utils {
  static encodeID = encodeID;
  static decodeID = decodeID;
  static isNumber = isNumber;
  static isObject = isObject;
  static isEmail = isEmail;
  static isDate = isDate;
  static isURL = isURL;
  static isValidID = isValidID;
  static isPassword = isPassword;
  static hashPassword = hashPassword;
  static deepMerge = deepMerge;
  static combineObjects = combineObjects;
  static comparePassword = comparePassword;
  static isArrayOfObjects = isArrayOfObjects;
  static findChangedProperties = findChangedProperties;
  static detectFieldType = detectFieldType;
  static isArrayOfArrays = isArrayOfArrays;
}
