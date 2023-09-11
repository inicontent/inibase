import { FieldType } from ".";

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

  if (input === null) return null;
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
  obj != null && obj.constructor.name === "Object";

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

export const isNumber = (input: any): boolean =>
  Array.isArray(input)
    ? input.every(isNumber)
    : !isNaN(parseFloat(input)) && !isNaN(input - 0);

export default class Utils {
  static encode = encode;
  static decode = decode;
  static isNumber = isNumber;
  static isObject = isObject;
  static deepMerge = deepMerge;
  static isArrayOfObjects = isArrayOfObjects;
}
