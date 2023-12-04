import { type Schema } from "./index.js";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  type Cipher,
  type Decipher,
  createHash,
} from "node:crypto";
import Utils from "./utils.js";

export const hashPassword = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256")
    .update(password + salt)
    .digest("hex");
  return `${salt}:${hash}`;
};

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

export const findLastIdNumber = (
  schema: Schema,
  secretKeyOrSalt: string | number | Buffer
): number => {
  const lastField = schema[schema.length - 1];
  if (lastField) {
    if (
      (lastField.type === "array" || lastField.type === "object") &&
      Utils.isArrayOfObjects(lastField.children)
    )
      return findLastIdNumber(lastField.children as Schema, secretKeyOrSalt);
    else if (lastField.id)
      return Utils.isValidID(lastField.id)
        ? decodeID(lastField.id as string, secretKeyOrSalt)
        : lastField.id;
  }
  return 0;
};

export const addIdToSchema = (
  schema: Schema,
  oldIndex: number = 0,
  secretKeyOrSalt: string | number | Buffer
) =>
  schema.map((field) => {
    if (!field.id) {
      oldIndex++;
      field.id = encodeID(oldIndex, secretKeyOrSalt);
    } else {
      if (!Utils.isNumber(field.id))
        oldIndex = decodeID(field.id, secretKeyOrSalt);
      else {
        oldIndex = field.id;
        field.id = encodeID(field.id, secretKeyOrSalt);
      }
    }
    if (
      (field.type === "array" || field.type === "object") &&
      Utils.isArrayOfObjects(field.children)
    ) {
      field.children = addIdToSchema(
        field.children as Schema,
        oldIndex,
        secretKeyOrSalt
      );
      oldIndex += field.children.length;
    }
    return field;
  });

export default class UtilsServer {
  static encodeID = encodeID;
  static decodeID = decodeID;
  static hashPassword = hashPassword;
  static comparePassword = comparePassword;
  static findLastIdNumber = findLastIdNumber;
  static addIdToSchema = addIdToSchema;
}
