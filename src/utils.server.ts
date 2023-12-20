import { type Schema } from './index.js';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  type Cipher,
  type Decipher,
  createHash,
} from 'node:crypto';
import { isArrayOfObjects, isNumber, isValidID } from './utils.js';

/**
 * Generates a hashed password using SHA-256.
 *
 * @param password - The plain text password to hash.
 * @returns A string containing the salt and the hashed password, separated by a colon.
 */
export const hashPassword = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  const hash = createHash('sha256')
    .update(password + salt)
    .digest('hex');
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
  const [salt, originalHash] = hashedPassword.split(':');
  const inputHash = createHash('sha256')
    .update(inputPassword + salt)
    .digest('hex');
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
      'aes-256-cbc',
      secretKeyOrSalt,
      secretKeyOrSalt.subarray(0, 16)
    );
  else {
    const salt = scryptSync(
      secretKeyOrSalt.toString(),
      (process.env.INIBASE_SECRET ?? 'inibase') + '_salt',
      32
    );
    cipher = createCipheriv('aes-256-cbc', salt, salt.subarray(0, 16));
  }

  return cipher.update(id.toString(), 'utf8', 'hex') + cipher.final('hex');
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
      'aes-256-cbc',
      secretKeyOrSalt,
      secretKeyOrSalt.subarray(0, 16)
    );
  else {
    const salt = scryptSync(
      secretKeyOrSalt.toString(),
      (process.env.INIBASE_SECRET ?? 'inibase') + '_salt',
      32
    );
    decipher = createDecipheriv('aes-256-cbc', salt, salt.subarray(0, 16));
  }

  return Number(
    decipher.update(input as string, 'hex', 'utf8') + decipher.final('utf8')
  );
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
): number => {
  const lastField = schema[schema.length - 1];
  if (lastField) {
    if (
      (lastField.type === 'array' || lastField.type === 'object') &&
      isArrayOfObjects(lastField.children)
    )
      return findLastIdNumber(lastField.children as Schema, secretKeyOrSalt);
    else if (lastField.id)
      return isValidID(lastField.id)
        ? decodeID(lastField.id as string, secretKeyOrSalt)
        : lastField.id;
  }
  return 0;
};

/**
 * Adds or updates IDs in a schema, encoding them using a provided secret key or salt.
 *
 * @param schema - The schema to update, defined as an array of schema objects.
 * @param oldIndex - The starting index for generating new IDs, defaults to 0.
 * @param secretKeyOrSalt - The secret key or salt for encoding IDs, can be a string, number, or Buffer.
 * @returns The updated schema with encoded IDs.
 */
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
      if (!isNumber(field.id)) oldIndex = decodeID(field.id, secretKeyOrSalt);
      else {
        oldIndex = field.id;
        field.id = encodeID(field.id, secretKeyOrSalt);
      }
    }
    if (
      (field.type === 'array' || field.type === 'object') &&
      isArrayOfObjects(field.children)
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
