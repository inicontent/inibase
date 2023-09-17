import { FieldType } from ".";
import { scryptSync, randomBytes, timingSafeEqual } from "crypto";

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

export const isArrayOfObjects = (arr: any) => {
  return Array.isArray(arr) && (arr.length === 0 || arr.every(isObject));
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

export default class Utils {
  static encode = encode;
  static decode = decode;
  static isNumber = isNumber;
  static isObject = isObject;
  static deepMerge = deepMerge;
  static hashPassword = hashPassword;
  static combineObjects = combineObjects;
  static comparePassword = comparePassword;
  static isArrayOfObjects = isArrayOfObjects;
}
