import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createDecipheriv,
  createCipheriv,
  Cipher,
  Decipher,
} from "node:crypto";
import { Schema } from ".";
import { isArrayOfObjects, isValidID } from "./utils";

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

export const encodeID = (
  id: number,
  secretKey: string | number | Buffer
): string => {
  let cipher: Cipher, ret: string;

  if (Buffer.isBuffer(secretKey))
    cipher = createCipheriv(
      "aes-256-cbc",
      secretKey,
      secretKey.subarray(0, 16)
    );
  else {
    const salt = scryptSync(secretKey.toString(), "salt", 32);
    cipher = createCipheriv("aes-256-cbc", salt, salt.subarray(0, 16));
  }

  return cipher.update(id.toString(), "utf8", "hex") + cipher.final("hex");
};

export const decodeID = (
  input: string,
  secretKey: string | number | Buffer
): number => {
  let decipher: Decipher;

  if (Buffer.isBuffer(secretKey))
    decipher = createDecipheriv(
      "aes-256-cbc",
      secretKey,
      secretKey.subarray(0, 16)
    );
  else {
    const salt = scryptSync(secretKey.toString(), "salt", 32);
    decipher = createDecipheriv("aes-256-cbc", salt, salt.subarray(0, 16));
  }

  return Number(
    decipher.update(input as string, "hex", "utf8") + decipher.final("utf8")
  );
};

export const findLastIdNumber = (
  schema: Schema,
  secretKey: string | number | Buffer
): number => {
  const lastField = schema[schema.length - 1];
  if (lastField) {
    if (
      (lastField.type === "array" || lastField.type === "object") &&
      isArrayOfObjects(lastField.children)
    )
      return findLastIdNumber(lastField.children as Schema, secretKey);
    else if (lastField.id && isValidID(lastField.id))
      return decodeID(lastField.id as string, secretKey);
  }
  return 0;
};

export const addIdToSchema = (
  schema: Schema,
  oldIndex: number = 0,
  secretKey: string | number | Buffer
) =>
  schema.map((field) => {
    if (
      (field.type === "array" || field.type === "object") &&
      isArrayOfObjects(field.children)
    ) {
      if (!field.id) {
        oldIndex++;
        field = {
          ...field,
          id: encodeID(oldIndex, secretKey),
        };
      } else oldIndex = decodeID(field.id as string, secretKey);
      field.children = addIdToSchema(
        field.children as Schema,
        oldIndex,
        secretKey
      );
      oldIndex += field.children.length;
    } else if (field.id) oldIndex = decodeID(field.id as string, secretKey);
    else {
      oldIndex++;
      field = {
        ...field,
        id: encodeID(oldIndex, secretKey),
      };
    }
    return field;
  });

export default class Utils {
  static encodeID = encodeID;
  static decodeID = decodeID;
  static hashPassword = hashPassword;
  static comparePassword = comparePassword;
  static findLastIdNumber = findLastIdNumber;
  static addIdToSchema = addIdToSchema;
}
