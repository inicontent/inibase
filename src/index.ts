import { unlink, rename, mkdir, readdir } from "node:fs/promises";
import { existsSync, appendFileSync } from "node:fs";
import { join, parse } from "node:path";
import { scryptSync, randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";

import File from "./file.js";
import Utils from "./utils.js";
import UtilsServer from "./utils.server.js";
import Config from "./config.js";
import { inspect } from "node:util";
import Inison from "inison";

export interface Data {
  id?: number | string;
  [key: string]: any;
  createdAt?: number;
  updatedAt?: number;
}

export type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "email"
  | "url"
  | "table"
  | "object"
  | "array"
  | "password"
  | "html"
  | "ip"
  | "json"
  | "id";

type FieldDefault = {
  id?: string | number;
  key: string;
  required?: boolean;
};
type FieldStringType = {
  type: Exclude<FieldType, "array" | "object">;
  children?: never;
};
type FieldStringArrayType = {
  type: Array<Exclude<FieldType, "object">>;
  children?: never;
};
type FieldArrayType = {
  type: "array";
  children:
    | Exclude<FieldType, "array">
    | Array<Exclude<FieldType, "array">>
    | Schema;
};
type FieldArrayArrayType = {
  type: Array<"array" | Exclude<FieldType, "array" | "object">>;
  children:
    | Exclude<FieldType, "array" | "object">
    | Array<Exclude<FieldType, "array" | "object">>;
};
type FieldObjectType = {
  type: "object";
  children: Schema;
};

export type Field = FieldDefault &
  (
    | FieldStringType
    | FieldStringArrayType
    | FieldArrayArrayType
    | FieldObjectType
    | FieldArrayType
  );

export type Schema = Field[];

export interface Options {
  page?: number;
  perPage?: number;
  columns?: string[] | string;
  order?: Record<string, "asc" | "desc">;
}

export type ComparisonOperator =
  | "="
  | "!="
  | ">"
  | "<"
  | ">="
  | "<="
  | "*"
  | "!*"
  | "[]"
  | "![]";

type pageInfo = {
  total?: number;
  totalPages?: number;
} & Options;

export type Criteria =
  | ({
      [logic in "and" | "or"]?: Criteria | (string | number | boolean | null)[];
    } & {
      [key: string]: string | number | boolean | undefined | Criteria;
    })
  | null;

declare global {
  type Entries<T> = {
    [K in keyof T]: [K, T[K]];
  }[keyof T][];

  interface ObjectConstructor {
    entries<T extends object>(o: T): Entries<T>;
  }
}

export type ErrorCodes =
  | "FIELD_REQUIRED"
  | "NO_SCHEMA"
  | "NO_ITEMS"
  | "NO_RESULTS"
  | "INVALID_ID"
  | "INVALID_TYPE"
  | "INVALID_PARAMETERS";
export type ErrorLang = "en";

export default class Inibase {
  public folder: string;
  public database: string;
  public table: string | null;
  public pageInfo: Record<string, pageInfo>;
  private isThreadEnabled: boolean = false;
  private totalItems: Record<string, number>;
  public salt: Buffer;

  constructor(
    database: string,
    mainFolder: string = ".",
    _table: string | null = null,
    _totalItems: Record<string, number> = {},
    _pageInfo: Record<string, pageInfo> = {},
    _isThreadEnabled: boolean = false
  ) {
    this.database = database;
    this.folder = mainFolder;
    this.table = _table;
    this.totalItems = _totalItems;
    this.pageInfo = _pageInfo;
    this.isThreadEnabled = _isThreadEnabled;

    if (!existsSync(".env") || !process.env.INIBASE_SECRET) {
      this.salt = scryptSync(randomBytes(16), randomBytes(16), 32);
      appendFileSync(".env", `\nINIBASE_SECRET=${this.salt.toString("hex")}\n`);
    } else this.salt = Buffer.from(process.env.INIBASE_SECRET, "hex");
  }

  private throwError(
    code: ErrorCodes,
    variable?: string | number | (string | number)[],
    language: ErrorLang = "en"
  ): Error {
    const errorMessages: Record<ErrorLang, Record<ErrorCodes, string>> = {
      en: {
        FIELD_REQUIRED: "Field {variable} is required",
        NO_SCHEMA: "Table {variable} does't have a schema",
        NO_ITEMS: "Table {variable} is empty",
        NO_RESULTS: "No results found for table {variable}",
        INVALID_ID: "The given ID(s) is/are not valid(s)",
        INVALID_TYPE:
          "Expect {variable} to be {variable}, got {variable} instead",
        INVALID_PARAMETERS: "The given parameters are not valid",
      },
      // Add more languages and error messages as needed
    };

    let errorMessage = errorMessages[language][code];
    if (!errorMessage) return new Error("ERR");
    return new Error(
      variable
        ? Array.isArray(variable)
          ? errorMessage.replace(
              /\{variable\}/g,
              () => variable.shift()?.toString() ?? ""
            )
          : errorMessage.replaceAll(`{variable}`, `'${variable.toString()}'`)
        : errorMessage.replaceAll(`{variable}`, "")
    );
  }

  public async createWorker(
    functionName:
      | "get"
      | "post"
      | "put"
      | "delete"
      | "sum"
      | "min"
      | "max"
      | "sort",
    arg: any[]
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const worker = new Worker("./dist/index.thread.js", {
        workerData: {
          _constructor: [
            this.database,
            this.folder,
            this.table,
            this.totalItems,
            this.pageInfo,
            true, // enable Thread
          ],
          functionName,
          arg,
        },
      });
      worker.on("message", resolve);
      worker.on("error", reject);
    });
  }

  private _decodeIdFromSchema = (schema: Schema) =>
    schema.map((field) => {
      if (
        (field.type === "array" || field.type === "object") &&
        field.children &&
        Utils.isArrayOfObjects(field.children)
      )
        field.children = this._decodeIdFromSchema(field.children);
      if (field.id && !Utils.isNumber(field.id))
        field.id = UtilsServer.decodeID(field.id, this.salt);
      return field;
    });
  private _schemaToIdsPath = (schema: Schema, prefix = "") => {
    let RETURN: any = {};
    for (const field of schema)
      if (
        (field.type === "array" || field.type === "object") &&
        field.children &&
        Utils.isArrayOfObjects(field.children)
      ) {
        Utils.deepMerge(
          RETURN,
          this._schemaToIdsPath(
            field.children,
            (prefix ?? "") + field.key + "."
          )
        );
      } else if (Utils.isValidID(field.id))
        RETURN[UtilsServer.decodeID(field.id, this.salt)] =
          (prefix ?? "") + field.key + ".inib";

    return RETURN;
  };

  public async setTableSchema(
    tableName: string,
    schema: Schema
  ): Promise<void> {
    const tablePath = join(this.folder, this.database, tableName),
      tableSchemaPath = join(tablePath, "schema.json"),
      isTablePathExists = await File.isExists(tablePath);
    // remove id from schema
    schema = schema.filter(
      ({ key }) => !["id", "createdAt", "updatedAt"].includes(key)
    );
    schema = UtilsServer.addIdToSchema(
      schema,
      UtilsServer.findLastIdNumber(schema, this.salt),
      this.salt,
      isTablePathExists
    );
    if (!isTablePathExists) await mkdir(tablePath, { recursive: true });
    if (!(await File.isExists(join(tablePath, ".tmp"))))
      await mkdir(join(tablePath, ".tmp"));
    if (!(await File.isExists(join(tablePath, ".cache"))))
      await mkdir(join(tablePath, ".cache"));
    if (await File.isExists(tableSchemaPath)) {
      // update columns files names based on field id
      const replaceOldPathes = Utils.findChangedProperties(
        this._schemaToIdsPath((await this.getTableSchema(tableName)) ?? []),
        this._schemaToIdsPath(schema)
      );
      if (replaceOldPathes)
        await Promise.all(
          Object.entries(replaceOldPathes).map(async ([oldPath, newPath]) => {
            if (await File.isExists(join(tablePath, oldPath)))
              await rename(join(tablePath, oldPath), join(tablePath, newPath));
          })
        );
    }

    await File.write(
      join(tablePath, "schema.json"),
      JSON.stringify(
        isTablePathExists ? this._decodeIdFromSchema(schema) : schema,
        null,
        2
      ),
      true
    );
  }

  public async getTableSchema(tableName: string): Promise<Schema | undefined> {
    const tableSchemaPath = join(
      this.folder,
      this.database,
      tableName,
      "schema.json"
    );
    if (!(await File.isExists(tableSchemaPath))) return undefined;

    const schemaFile = await File.read(tableSchemaPath, true);

    if (!schemaFile) return undefined;
    const schema = JSON.parse(schemaFile),
      lastIdNumber = UtilsServer.findLastIdNumber(schema, this.salt);

    return [
      {
        id: UtilsServer.encodeID(0, this.salt),
        key: "id",
        type: "id",
        required: true,
      },
      ...UtilsServer.addIdToSchema(schema, lastIdNumber, this.salt, true),
      {
        id: UtilsServer.encodeID(lastIdNumber + 1, this.salt),
        key: "createdAt",
        type: "date",
        required: true,
      },
      {
        id: UtilsServer.encodeID(lastIdNumber + 2, this.salt),
        key: "updatedAt",
        type: "date",
        required: false,
      },
    ];
  }

  public async getSchemaWhenTableNotEmpty(
    tableName: string,
    schema?: Schema
  ): Promise<never | Schema> {
    const tablePath = join(this.folder, this.database, tableName);

    if (!schema) schema = await this.getTableSchema(tableName);

    if (!schema) throw this.throwError("NO_SCHEMA", tableName);

    if (!(await File.isExists(join(tablePath, "id.inib"))))
      throw this.throwError("NO_ITEMS", tableName);

    return schema;
  }

  static getField(keyPath: string, schema: Schema) {
    let RETURN: Field | Schema | null = null;
    const keyPathSplited = keyPath.split(".");
    for (const [index, key] of keyPathSplited.entries()) {
      const foundItem = schema.find((item) => item.key === key);
      if (!foundItem) return null;
      if (index === keyPathSplited.length - 1) RETURN = foundItem;
      if (
        (foundItem.type === "array" || foundItem.type === "object") &&
        foundItem.children &&
        Utils.isArrayOfObjects(foundItem.children)
      )
        RETURN = foundItem.children;
    }
    if (!RETURN) return null;
    return Utils.isArrayOfObjects(RETURN) ? RETURN[0] : RETURN;
  }

  private validateData(
    data: Data | Data[],
    schema: Schema,
    skipRequiredField: boolean = false
  ): void {
    if (Utils.isArrayOfObjects(data))
      for (const single_data of data as Data[])
        this.validateData(single_data, schema, skipRequiredField);
    else if (Utils.isObject(data)) {
      for (const field of schema) {
        if (
          !Object.hasOwn(data, field.key) &&
          field.required &&
          !skipRequiredField
        )
          throw this.throwError("FIELD_REQUIRED", field.key);
        if (
          Object.hasOwn(data, field.key) &&
          !field.required &&
          (data[field.key] === null || data[field.key] === undefined)
        )
          return;
        if (
          Object.hasOwn(data, field.key) &&
          !Utils.validateFieldType(
            data[field.key],
            field.type,
            (field.type === "array" || field.type === "object") &&
              field.children &&
              !Utils.isArrayOfObjects(field.children)
              ? field.children
              : undefined
          )
        )
          throw this.throwError("INVALID_TYPE", [
            field.key,
            Array.isArray(field.type) ? field.type.join(", ") : field.type,
            typeof data[field.key],
          ]);
        if (
          (field.type === "array" || field.type === "object") &&
          field.children &&
          Utils.isArrayOfObjects(field.children)
        )
          this.validateData(data[field.key], field.children, skipRequiredField);
      }
    }
  }

  private formatField(
    value: Data | number | string,
    field: Field,
    formatOnlyAvailiableKeys?: boolean
  ): Data | number | string | null;
  private formatField(
    value: (number | string | Data)[],
    field: Field,
    formatOnlyAvailiableKeys?: boolean
  ): (number | string | null | Data)[];
  private formatField(
    value: Data | number | string | (number | string | Data)[],
    field: Field,
    formatOnlyAvailiableKeys?: boolean
  ): Data | Data[] | number | string | null {
    if (Array.isArray(field.type))
      field.type = Utils.detectFieldType(value, field.type) ?? field.type[0];
    switch (field.type) {
      case "array":
        if (typeof field.children === "string") {
          if (field.children === "table") {
            if (Array.isArray(value)) {
              if (Utils.isArrayOfObjects(value)) {
                if (
                  value.every(
                    (item: any): item is Data =>
                      Object.hasOwn(item, "id") &&
                      (Utils.isValidID(item.id) || Utils.isNumber(item.id))
                  )
                )
                  value.map((item) =>
                    item.id
                      ? Utils.isNumber(item.id)
                        ? Number(item.id)
                        : UtilsServer.decodeID(item.id, this.salt)
                      : null
                  );
              } else if (
                (value as (number | string)[]).every(Utils.isValidID) ||
                (value as (number | string)[]).every(Utils.isNumber)
              )
                return (value as (number | string)[]).map((item) =>
                  Utils.isNumber(item)
                    ? Number(item)
                    : UtilsServer.decodeID(item, this.salt)
                );
            } else if (Utils.isValidID(value))
              return [UtilsServer.decodeID(value, this.salt)];
            else if (Utils.isNumber(value)) return [Number(value)];
          } else return Array.isArray(value) ? value : [value];
        } else if (Utils.isArrayOfObjects(field.children))
          return this.formatData(
            value as Data[],
            field.children as Schema,
            formatOnlyAvailiableKeys
          );
        else if (Array.isArray(field.children))
          return Array.isArray(value) ? value : [value];
        break;
      case "object":
        if (Utils.isArrayOfObjects(field.children))
          return this.formatData(
            value as Data,
            field.children as Schema,
            formatOnlyAvailiableKeys
          );
        break;
      case "table":
        if (Array.isArray(value)) value = value[0];
        if (Utils.isObject(value)) {
          if (
            Object.hasOwn(value, "id") &&
            (Utils.isValidID((value as Data).id) ||
              Utils.isNumber((value as Data).id))
          )
            return Utils.isNumber((value as Data).id)
              ? Number((value as Data).id)
              : UtilsServer.decodeID((value as Data).id as string, this.salt);
        } else if (Utils.isValidID(value) || Utils.isNumber(value))
          return Utils.isNumber(value)
            ? Number(value)
            : UtilsServer.decodeID(value, this.salt);
        break;
      case "password":
        if (Array.isArray(value)) value = value[0];
        return Utils.isPassword(value)
          ? value
          : UtilsServer.hashPassword(String(value));
      case "number":
        if (Array.isArray(value)) value = value[0];
        return Utils.isNumber(value) ? Number(value) : null;
      case "id":
        if (Array.isArray(value)) value = value[0];
        return Utils.isNumber(value)
          ? value
          : UtilsServer.decodeID(value as string, this.salt);
      case "json":
        return Inison.stringify(value);
      default:
        return value;
    }
    return null;
  }

  private formatData(
    data: Data,
    schema: Schema,
    formatOnlyAvailiableKeys?: boolean
  ): Data;
  private formatData(
    data: Data | Data[],
    schema: Schema,
    formatOnlyAvailiableKeys?: boolean
  ): Data[];
  private formatData(
    data: Data | Data[],
    schema: Schema,
    formatOnlyAvailiableKeys?: boolean
  ): Data | Data[] {
    this.validateData(data, schema, formatOnlyAvailiableKeys);

    if (Utils.isArrayOfObjects(data))
      return data.map((single_data: Data) =>
        this.formatData(single_data, schema, formatOnlyAvailiableKeys)
      );
    else if (Utils.isObject(data)) {
      let RETURN: Data = {};
      for (const field of schema) {
        if (!Object.hasOwn(data, field.key)) {
          if (formatOnlyAvailiableKeys || !field.required) continue;
          RETURN[field.key] = this.getDefaultValue(field);
          continue;
        }
        RETURN[field.key] = this.formatField(
          data[field.key],
          field,
          formatOnlyAvailiableKeys
        );
      }
      return RETURN;
    } else return [];
  }

  private getDefaultValue(field: Field): any {
    if (Array.isArray(field.type))
      return this.getDefaultValue({
        ...field,
        type: field.type.sort(
          (a: FieldType, b: FieldType) =>
            Number(b === "array") - Number(a === "array") ||
            Number(a === "string") - Number(b === "string") ||
            Number(a === "number") - Number(b === "number")
        )[0],
      } as Field);

    switch (field.type) {
      case "array":
        return Utils.isArrayOfObjects(field.children)
          ? [
              this.getDefaultValue({
                ...field,
                type: "object",
                children: field.children as Schema,
              }),
            ]
          : null;
      case "object":
        return Utils.combineObjects(
          field.children.map((f: Field) => ({
            [f.key]: this.getDefaultValue(f),
          }))
        );
      case "boolean":
        return false;
      default:
        return null;
    }
  }

  private _combineObjectsToArray = (input: any[]) =>
    input.reduce((result, current) => {
      for (const [key, value] of Object.entries(current))
        if (!result[key]) result[key] = [value];
        else result[key].push(value);

      return result;
    }, {});
  private _CombineData = (_data: Data | Data[], prefix?: string) => {
    let RETURN: Record<
      string,
      string | boolean | number | null | (string | boolean | number | null)[]
    > = {};
    if (Utils.isArrayOfObjects(_data))
      RETURN = this._combineObjectsToArray(
        _data.map((single_data) => this._CombineData(single_data))
      );
    else
      for (const [key, value] of Object.entries(_data)) {
        if (Utils.isObject(value))
          Object.assign(RETURN, this._CombineData(value, `${key}.`));
        else if (Utils.isArrayOfObjects(value)) {
          Object.assign(
            RETURN,
            this._CombineData(
              this._combineObjectsToArray(value),
              (prefix ?? "") + key + "."
            )
          );
        } else if (
          Utils.isArrayOfArrays(value) &&
          value.every(Utils.isArrayOfObjects)
        )
          Object.assign(
            RETURN,
            this._CombineData(
              this._combineObjectsToArray(
                value.map(this._combineObjectsToArray)
              ),
              (prefix ?? "") + key + "."
            )
          );
        else RETURN[(prefix ?? "") + key] = File.encode(value);
      }

    return RETURN;
  };
  private _addPathToKeys = (obj: Record<string, any>, path: string) => {
    const newObject: Record<string, any> = {};

    for (const key in obj) newObject[join(path, key + ".inib")] = obj[key];

    return newObject;
  };
  public joinPathesContents(
    mainPath: string,
    data: Data | Data[]
  ): { [key: string]: string[] } {
    return this._addPathToKeys(this._CombineData(data), mainPath);
  }

  private _getItemsFromSchemaHelper(
    RETURN: Record<number, Data>,
    item: Data,
    index: number,
    field: Field
  ) {
    if (Utils.isObject(item)) {
      if (!RETURN[index]) RETURN[index] = {};
      if (!RETURN[index][field.key]) RETURN[index][field.key] = [];
      for (const child_field of (field.children as Schema).filter(
        (children) =>
          children.type === "array" && Utils.isArrayOfObjects(children.children)
      )) {
        if (Utils.isObject(item[child_field.key])) {
          Object.entries(item[child_field.key]).forEach(([key, value]) => {
            for (let _i = 0; _i < value.length; _i++) {
              if (
                (Array.isArray(value[_i]) && Utils.isArrayOfNulls(value[_i])) ||
                value[_i] === null
              )
                continue;

              if (!RETURN[index][field.key][_i])
                RETURN[index][field.key][_i] = {};
              if (!RETURN[index][field.key][_i][child_field.key])
                RETURN[index][field.key][_i][child_field.key] = [];

              if (!Array.isArray(value[_i])) {
                if (!RETURN[index][field.key][_i][child_field.key][0])
                  RETURN[index][field.key][_i][child_field.key][0] = {};
                RETURN[index][field.key][_i][child_field.key][0][key] =
                  value[_i];
              } else {
                value[_i].forEach((_element: any, _index: number) => {
                  // Recursive call
                  this._getItemsFromSchemaHelper(
                    RETURN[index][field.key][_i][child_field.key][_index],
                    _element,
                    _index,
                    child_field
                  );

                  // Perform property assignments
                  if (!RETURN[index][field.key][_i][child_field.key][_index])
                    RETURN[index][field.key][_i][child_field.key][_index] = {};
                  RETURN[index][field.key][_i][child_field.key][_index][key] =
                    _element;
                });
              }
            }
          });
        }
      }
    }
  }
  private async getItemsFromSchema(
    tableName: string,
    schema: Schema,
    linesNumber: number[],
    options: Options,
    prefix?: string
  ) {
    const tablePath = join(this.folder, this.database, tableName);
    let RETURN: Record<number, Data> = {};
    await Promise.all(
      schema.map(async (field) => {
        if (
          (field.type === "array" ||
            (Array.isArray(field.type) && field.type.includes("array"))) &&
          field.children
        ) {
          if (Utils.isArrayOfObjects(field.children)) {
            if (
              field.children.filter(
                (children) =>
                  children.type === "array" &&
                  Utils.isArrayOfObjects(children.children)
              ).length
            ) {
              // one of children has array field type and has children array of object = Schema
              Object.entries(
                (await this.getItemsFromSchema(
                  tableName,
                  (field.children as Schema).filter(
                    (children) =>
                      children.type === "array" &&
                      Utils.isArrayOfObjects(children.children)
                  ),
                  linesNumber,
                  options,
                  (prefix ?? "") + field.key + "."
                )) ?? {}
              ).forEach(([index, item]) => {
                this._getItemsFromSchemaHelper(RETURN, item, index, field);
              });

              field.children = field.children.filter(
                (children) =>
                  children.type !== "array" ||
                  !Utils.isArrayOfObjects(children.children)
              );
            }

            Object.entries(
              (await this.getItemsFromSchema(
                tableName,
                field.children,
                linesNumber,
                options,
                (prefix ?? "") + field.key + "."
              )) ?? {}
            ).forEach(([index, item]) => {
              if (!RETURN[index]) RETURN[index] = {};
              if (Utils.isObject(item)) {
                if (!Utils.isArrayOfNulls(Object.values(item))) {
                  if (RETURN[index][field.key])
                    Object.entries(item).forEach(([key, value], _index) => {
                      for (let _index = 0; _index < value.length; _index++)
                        if (RETURN[index][field.key][_index])
                          Object.assign(RETURN[index][field.key][_index], {
                            [key]: value[_index],
                          });
                        else
                          RETURN[index][field.key][_index] = {
                            [key]: value[_index],
                          };
                    });
                  else if (
                    Object.values(item).every(
                      (_i) => Utils.isArrayOfArrays(_i) || Array.isArray(_i)
                    ) &&
                    prefix
                  )
                    RETURN[index][field.key] = item;
                  else {
                    RETURN[index][field.key] = [];
                    Object.entries(item).forEach(([key, value]) => {
                      for (let _i = 0; _i < value.length; _i++) {
                        if (
                          value[_i] === null ||
                          (Array.isArray(value[_i]) &&
                            Utils.isArrayOfNulls(value[_i]))
                        )
                          continue;

                        if (!RETURN[index][field.key][_i])
                          RETURN[index][field.key][_i] = {};
                        RETURN[index][field.key][_i][key] = value[_i];
                      }
                    });
                  }
                } else RETURN[index][field.key] = null;
              } else RETURN[index][field.key] = item;
            });
          } else if (
            field.children === "table" ||
            (Array.isArray(field.type) && field.type.includes("table")) ||
            (Array.isArray(field.children) && field.children.includes("table"))
          ) {
            if (
              (await File.isExists(
                join(this.folder, this.database, field.key)
              )) &&
              (await File.isExists(
                join(tablePath, (prefix ?? "") + field.key + ".inib")
              ))
            ) {
              if (options.columns)
                options.columns = (options.columns as string[])
                  .filter((column) => column.includes(`${field.key}.`))
                  .map((column) => column.replace(`${field.key}.`, ""));

              const items = await File.get(
                join(tablePath, (prefix ?? "") + field.key + ".inib"),
                linesNumber,
                field.type,
                field.children,
                this.salt
              );

              if (items)
                await Promise.allSettled(
                  Object.entries(items).map(async ([index, item]) => {
                    if (!RETURN[index]) RETURN[index] = {};
                    RETURN[index][field.key] = item
                      ? await this.get(field.key, item as number, options)
                      : this.getDefaultValue(field);
                  })
                );
            }
          } else if (
            await File.isExists(
              join(tablePath, (prefix ?? "") + field.key + ".inib")
            )
          ) {
            const items = await File.get(
              join(tablePath, (prefix ?? "") + field.key + ".inib"),
              linesNumber,
              field.type,
              (field as any)?.children,
              this.salt
            );

            if (items)
              for (const [index, item] of Object.entries(items)) {
                if (!RETURN[index]) RETURN[index] = {};
                RETURN[index][field.key] = item ?? this.getDefaultValue(field);
              }
          }
        } else if (field.type === "object") {
          for await (const [index, item] of Object.entries(
            (await this.getItemsFromSchema(
              tableName,
              field.children as Schema,
              linesNumber,
              options,
              (prefix ?? "") + field.key + "."
            )) ?? {}
          )) {
            if (!RETURN[index]) RETURN[index] = {};
            if (Utils.isObject(item)) {
              if (!Object.values(item).every((i) => i === null))
                RETURN[index][field.key] = item;
              else RETURN[index][field.key] = null;
            } else RETURN[index][field.key] = null;
          }
        } else if (field.type === "table") {
          if (
            (await File.isExists(
              join(this.folder, this.database, field.key)
            )) &&
            (await File.isExists(
              join(tablePath, (prefix ?? "") + field.key + ".inib")
            ))
          ) {
            if (options.columns)
              options.columns = (options.columns as string[])
                .filter(
                  (column) =>
                    column.includes(`${field.key}.`) &&
                    !column.includes(`${field.key}.`)
                )
                .map((column) => column.replace(`${field.key}.`, ""));
            const items = await File.get(
              join(tablePath, (prefix ?? "") + field.key + ".inib"),
              linesNumber,
              "number",
              undefined,
              this.salt
            );

            if (items)
              await Promise.allSettled(
                Object.entries(items).map(async ([index, item]) => {
                  if (!RETURN[index]) RETURN[index] = {};
                  RETURN[index][field.key] = item
                    ? await this.get(field.key, item as number, options)
                    : this.getDefaultValue(field);
                })
              );
          }
        } else if (
          await File.isExists(
            join(tablePath, (prefix ?? "") + field.key + ".inib")
          )
        ) {
          const items = await File.get(
            join(tablePath, (prefix ?? "") + field.key + ".inib"),
            linesNumber,
            field.type,
            (field as any)?.children,
            this.salt
          );

          if (items)
            for (const [index, item] of Object.entries(items)) {
              if (!RETURN[index]) RETURN[index] = {};
              RETURN[index][field.key] = item ?? this.getDefaultValue(field);
            }
          else
            RETURN = Object.fromEntries(
              Object.entries(RETURN).map(([index, data]) => [
                index,
                { ...data, [field.key]: this.getDefaultValue(field) },
              ])
            );
        }
      })
    );
    return RETURN;
  }

  private async applyCriteria(
    tableName: string,
    schema: Schema,
    options: Options,
    criteria?: Criteria,
    allTrue?: boolean
  ): Promise<[Record<number, Data> | null, Set<number> | null]> {
    const tablePath = join(this.folder, this.database, tableName);

    let RETURN: Record<number, Data> = {},
      RETURN_LineNumbers = null;
    if (!criteria) return [null, null];
    if (criteria.and && Utils.isObject(criteria.and)) {
      const [searchResult, lineNumbers] = await this.applyCriteria(
        tableName,
        schema,
        options,
        criteria.and as Criteria,
        true
      );
      if (searchResult) {
        RETURN = Utils.deepMerge(
          RETURN,
          Object.fromEntries(
            Object.entries(searchResult).filter(
              ([_k, v], _i) =>
                Object.keys(v).length === Object.keys(criteria.and ?? {}).length
            )
          )
        );
        delete criteria.and;
        RETURN_LineNumbers = lineNumbers;
      } else return [null, null];
    }

    if (criteria.or && Utils.isObject(criteria.or)) {
      const [searchResult, lineNumbers] = await this.applyCriteria(
        tableName,
        schema,
        options,
        criteria.or as Criteria,
        false
      );
      delete criteria.or;
      if (searchResult) {
        RETURN = Utils.deepMerge(RETURN, searchResult);
        RETURN_LineNumbers = lineNumbers;
      }
    }

    if (Object.keys(criteria).length > 0) {
      if (allTrue === undefined) allTrue = true;

      let index = -1;
      for await (const [key, value] of Object.entries(criteria)) {
        const field = Inibase.getField(key, schema);
        index++;
        let searchOperator:
            | ComparisonOperator
            | ComparisonOperator[]
            | undefined = undefined,
          searchComparedAtValue:
            | string
            | number
            | boolean
            | null
            | (string | number | boolean | null)[]
            | undefined = undefined,
          searchLogicalOperator: "and" | "or" | undefined = undefined;
        if (Utils.isObject(value)) {
          if (
            (value as Criteria)?.or &&
            Array.isArray((value as Criteria)?.or)
          ) {
            const searchCriteria = (
              (value as Criteria)?.or as (string | number | boolean)[]
            )
              .map(
                (
                  single_or
                ): [
                  ComparisonOperator,
                  string | number | boolean | null | (string | number | null)[]
                ] =>
                  typeof single_or === "string"
                    ? Utils.FormatObjectCriteriaValue(single_or)
                    : ["=", single_or]
              )
              .filter((a) => a) as [ComparisonOperator, string | number][];
            if (searchCriteria.length > 0) {
              searchOperator = searchCriteria.map((single_or) => single_or[0]);
              searchComparedAtValue = searchCriteria.map(
                (single_or) => single_or[1]
              );
              searchLogicalOperator = "or";
            }
            delete (value as Criteria)?.or;
          }
          if (
            (value as Criteria)?.and &&
            Array.isArray((value as Criteria)?.and)
          ) {
            const searchCriteria = (
              (value as Criteria)?.and as (string | number | boolean)[]
            )
              .map(
                (
                  single_and
                ): [
                  ComparisonOperator,
                  string | number | boolean | null | (string | number | null)[]
                ] =>
                  typeof single_and === "string"
                    ? Utils.FormatObjectCriteriaValue(single_and)
                    : ["=", single_and]
              )
              .filter((a) => a) as [ComparisonOperator, string | number][];
            if (searchCriteria.length > 0) {
              searchOperator = searchCriteria.map(
                (single_and) => single_and[0]
              );
              searchComparedAtValue = searchCriteria.map(
                (single_and) => single_and[1]
              );
              searchLogicalOperator = "and";
            }
            delete (value as Criteria)?.and;
          }
        } else if (Array.isArray(value)) {
          const searchCriteria = value
            .map(
              (
                single
              ): [
                ComparisonOperator,
                string | number | boolean | null | (string | number | null)[]
              ] =>
                typeof single === "string"
                  ? Utils.FormatObjectCriteriaValue(single)
                  : ["=", single]
            )
            .filter((a) => a) as [ComparisonOperator, string | number][];
          if (searchCriteria.length > 0) {
            searchOperator = searchCriteria.map((single) => single[0]);
            searchComparedAtValue = searchCriteria.map((single) => single[1]);
            searchLogicalOperator = "and";
          }
        } else if (typeof value === "string") {
          const ComparisonOperatorValue =
            Utils.FormatObjectCriteriaValue(value);
          if (ComparisonOperatorValue) {
            searchOperator = ComparisonOperatorValue[0];
            searchComparedAtValue = ComparisonOperatorValue[1];
          }
        } else {
          searchOperator = "=";
          searchComparedAtValue = value as number | boolean;
        }
        const [searchResult, totalLines, linesNumbers] = await File.search(
          join(tablePath, key + ".inib"),
          searchOperator ?? "=",
          searchComparedAtValue ?? null,
          searchLogicalOperator,
          field?.type,
          (field as any)?.children,
          options.perPage,
          (options.page as number) - 1 * (options.perPage as number) + 1,
          true,
          this.salt
        );

        if (searchResult) {
          RETURN = Utils.deepMerge(
            RETURN,
            Object.fromEntries(
              Object.entries(searchResult).map(([id, value]) => [
                id,
                {
                  [key]: value,
                },
              ])
            )
          );
          this.totalItems[tableName + "-" + key] = totalLines;
          RETURN_LineNumbers = linesNumbers;
        }

        if (allTrue && index > 0) {
          if (!Object.keys(RETURN).length) RETURN = {};
          RETURN = Object.fromEntries(
            Object.entries(RETURN).filter(
              ([_index, item]) => Object.keys(item).length > index
            )
          );
          if (!Object.keys(RETURN).length) RETURN = {};
        }
      }
    }

    return [Object.keys(RETURN).length ? RETURN : null, RETURN_LineNumbers];
  }

  private _filterSchemaByColumns(schema: Schema, columns: string[]): Schema {
    return schema
      .map((field) => {
        if (columns.some((column) => column.startsWith("!")))
          return columns.includes("!" + field.key) ? null : field;
        if (columns.includes(field.key) || columns.includes("*")) return field;

        if (
          (field.type === "array" || field.type === "object") &&
          Utils.isArrayOfObjects(field.children) &&
          columns.filter(
            (column) =>
              column.startsWith(field.key + ".") ||
              column.startsWith("!" + field.key + ".")
          ).length
        ) {
          field.children = this._filterSchemaByColumns(
            field.children,
            columns
              .filter(
                (column) =>
                  column.startsWith(field.key + ".") ||
                  column.startsWith("!" + field.key + ".")
              )
              .map((column) => column.replace(field.key + ".", ""))
          );
          return field;
        }
        return null;
      })
      .filter((i) => i) as Schema;
  }

  public async clearCache(tablePath: string) {
    await Promise.all(
      (await readdir(join(tablePath, ".cache")))
        ?.filter((fileName: string) => fileName !== "pagination.inib")
        .map(async (file) => unlink(join(tablePath, ".cache", file)))
    );
  }

  get(
    tableName: string,
    where?: string | number | (string | number)[] | Criteria | undefined,
    options?: Options | undefined,
    onlyOne?: true,
    onlyLinesNumbers?: undefined,
    tableSchema?: Schema,
    skipIdColumn?: boolean
  ): Promise<Data | null>;
  get(
    tableName: string,
    where?: string | number | (string | number)[] | Criteria | undefined,
    options?: Options | undefined,
    onlyOne?: boolean | undefined,
    onlyLinesNumbers?: true,
    tableSchema?: Schema,
    skipIdColumn?: boolean
  ): Promise<number[]>;
  public async get(
    tableName: string,
    where?: string | number | (string | number)[] | Criteria,
    options: Options = {
      page: 1,
      perPage: 15,
    },
    onlyOne?: boolean,
    onlyLinesNumbers?: boolean,
    tableSchema?: Schema,
    skipIdColumn?: boolean
  ): Promise<Data[] | Data | number[] | null> {
    const tablePath = join(this.folder, this.database, tableName);

    // Ensure options.columns is an array
    if (options.columns) {
      options.columns = Array.isArray(options.columns)
        ? options.columns
        : [options.columns];

      if (
        !skipIdColumn &&
        options.columns.length &&
        !options.columns.includes("id")
      )
        options.columns.push("id");
    }

    // Default values for page and perPage
    options.page = options.page || 1;
    options.perPage = options.perPage || 15;

    let RETURN!: Data | Data[] | null;
    let schema = await this.getSchemaWhenTableNotEmpty(tableName, tableSchema);

    if (options.columns && options.columns.length)
      schema = this._filterSchemaByColumns(schema, options.columns as string[]);

    if (!where) {
      // Display all data
      RETURN = Object.values(
        await this.getItemsFromSchema(
          tableName,
          schema,
          Array.from(
            { length: options.perPage },
            (_, index) =>
              ((options.page as number) - 1) * (options.perPage as number) +
              index +
              1
          ),
          options
        )
      );
      if (
        Config.isCacheEnabled &&
        (await File.isExists(join(tablePath, ".cache", "pagination.inib")))
      )
        this.totalItems[tableName + "-*"] = Number(
          (
            await File.read(join(tablePath, ".cache", "pagination.inib"), true)
          ).split(",")[1]
        );
      else {
        let [lastId, totalItems] = await File.get(
          join(tablePath, "id.inib"),
          -1,
          "number",
          undefined,
          this.salt,
          true
        );
        if (lastId) lastId = Number(Object.keys(lastId)![0] ?? 0) as any;

        this.totalItems[tableName + "-*"] = totalItems;

        if (Config.isCacheEnabled)
          await File.write(
            join(tablePath, ".cache", "pagination.inib"),
            `${lastId},${totalItems}`,
            true
          );
      }
    } else if (
      (Array.isArray(where) && where.every(Utils.isNumber)) ||
      Utils.isNumber(where)
    ) {
      // "where" in this case, is the line(s) number(s) and not id(s)
      let lineNumbers = where as number | number[];
      if (!Array.isArray(lineNumbers)) lineNumbers = [lineNumbers];

      // useless
      if (onlyLinesNumbers) return lineNumbers;

      RETURN = Object.values(
        (await this.getItemsFromSchema(
          tableName,
          schema,
          lineNumbers,
          options
        )) ?? {}
      );

      if (!this.totalItems[tableName + "-*"])
        this.totalItems[tableName + "-*"] = lineNumbers.length;

      if (RETURN && RETURN.length && !Array.isArray(where))
        RETURN = (RETURN as Data[])[0];
    } else if (
      (Array.isArray(where) && where.every(Utils.isValidID)) ||
      Utils.isValidID(where)
    ) {
      let Ids = where as string | number | (string | number)[];
      if (!Array.isArray(Ids)) Ids = [Ids];
      const [lineNumbers, countItems] = await File.search(
        join(tablePath, "id.inib"),
        "[]",
        Ids.map((id) =>
          Utils.isNumber(id) ? Number(id) : UtilsServer.decodeID(id, this.salt)
        ),
        undefined,
        "number",
        undefined,
        Ids.length,
        0,
        !this.totalItems[tableName + "-*"],
        this.salt
      );
      if (!lineNumbers) throw this.throwError("NO_RESULTS", tableName);

      if (onlyLinesNumbers)
        return Object.keys(lineNumbers).length
          ? Object.keys(lineNumbers).map(Number)
          : null;

      RETURN = Object.values(
        (await this.getItemsFromSchema(
          tableName,
          schema,
          Object.keys(lineNumbers).map(Number),
          options
        )) ?? {}
      );

      if (!this.totalItems[tableName + "-*"])
        this.totalItems[tableName + "-*"] = countItems;

      if (RETURN && RETURN.length && !Array.isArray(where))
        RETURN = (RETURN as Data[])[0];
    } else if (Utils.isObject(where)) {
      let cachedFilePath = "";
      // Criteria
      if (Config.isCacheEnabled)
        cachedFilePath = join(
          tablePath,
          ".cache",
          `${UtilsServer.hashString(inspect(where, { sorted: true }))}.inib`
        );

      if (Config.isCacheEnabled && (await File.isExists(cachedFilePath))) {
        const cachedItems = (await File.read(cachedFilePath, true)).split(",");
        this.totalItems[tableName + "-*"] = cachedItems.length;
        if (onlyLinesNumbers) return cachedItems.map(Number);

        return this.get(
          tableName,
          cachedItems
            .slice(
              ((options.page as number) - 1) * options.perPage,
              (options.page as number) * options.perPage
            )
            .map(Number),
          options,
          undefined,
          undefined,
          schema
        );
      } else {
        let linesNumbers;
        [RETURN, linesNumbers] = await this.applyCriteria(
          tableName,
          schema,
          options,
          where as Criteria
        );
        if (RETURN && linesNumbers) {
          if (onlyLinesNumbers) return Object.keys(RETURN).map(Number);
          const alreadyExistsColumns = Object.keys(Object.values(RETURN)[0]);

          RETURN = Object.values(
            Utils.deepMerge(
              RETURN,
              await this.getItemsFromSchema(
                tableName,
                schema.filter(({ key }) => !alreadyExistsColumns.includes(key)),
                Object.keys(RETURN).map(Number),
                options
              )
            )
          );
          if (Config.isCacheEnabled)
            await File.write(
              cachedFilePath,
              Array.from(linesNumbers).join(","),
              true
            );
        }
      }
    }

    if (
      !RETURN ||
      (Utils.isObject(RETURN) && !Object.keys(RETURN).length) ||
      (Array.isArray(RETURN) && !RETURN.length)
    )
      return null;

    const greatestTotalItems =
      this.totalItems[tableName + "-*"] ??
      Math.max(
        ...Object.entries(this.totalItems)
          .filter(([k]) => k.startsWith(tableName + "-"))
          .map(([, v]) => v)
      );

    this.pageInfo[tableName] = {
      ...(({ columns, ...restOfOptions }) => restOfOptions)(options),
      perPage: Array.isArray(RETURN) ? RETURN.length : 1,
      totalPages: Math.ceil(greatestTotalItems / options.perPage),
      total: greatestTotalItems,
    };

    return onlyOne && Array.isArray(RETURN) ? RETURN[0] : RETURN;
  }

  post(
    tableName: string,
    data: Data | Data[],
    options?: Options,
    returnPostedData?: boolean
  ): Promise<void | null>;
  post(
    tableName: string,
    data: Data,
    options: Options | undefined,
    returnPostedData: true
  ): Promise<Data | null>;
  post(
    tableName: string,
    data: Data[],
    options: Options | undefined,
    returnPostedData: true
  ): Promise<Data[] | null>;
  public async post(
    tableName: string,
    data: Data | Data[],
    options?: Options,
    returnPostedData?: boolean
  ): Promise<Data | Data[] | null | void> {
    if (!options)
      options = {
        page: 1,
        perPage: 15,
      };
    const tablePath = join(this.folder, this.database, tableName),
      schema = await this.getTableSchema(tableName);

    if (!schema) throw this.throwError("NO_SCHEMA", tableName);

    if (!returnPostedData) returnPostedData = false;
    let RETURN: Data | Data[] | null | undefined;

    const keys = UtilsServer.hashString(
      Object.keys(Array.isArray(data) ? data[0] : data).join(".")
    );

    let lastId = 0,
      totalItems = 0,
      renameList: string[][] = [];
    try {
      await File.lock(join(tablePath, ".tmp"), keys);

      if (await File.isExists(join(tablePath, "id.inib"))) {
        if (
          Config.isCacheEnabled &&
          (await File.isExists(join(tablePath, ".cache", "pagination.inib")))
        )
          [lastId, totalItems] = (
            await File.read(join(tablePath, ".cache", "pagination.inib"), true)
          )
            .split(",")
            .map(Number);
        else {
          let lastIdObj;
          [lastIdObj, totalItems] = await File.get(
            join(tablePath, "id.inib"),
            -1,
            "number",
            undefined,
            this.salt,
            true
          );
          if (lastIdObj) lastId = Number(Object.keys(lastIdObj)![0] ?? 0);
        }
      }

      if (Utils.isArrayOfObjects(data))
        RETURN = data.map(({ id, updatedAt, createdAt, ...rest }) => ({
          id: ++lastId,
          ...rest,
          createdAt: Date.now(),
        }));
      else
        RETURN = (({ id, updatedAt, createdAt, ...rest }) => ({
          id: ++lastId,
          ...rest,
          createdAt: Date.now(),
        }))(data);

      RETURN = this.formatData(RETURN, schema);

      const pathesContents = this.joinPathesContents(
        tablePath,
        Config.isReverseEnabled
          ? Array.isArray(RETURN)
            ? RETURN.toReversed()
            : RETURN
          : RETURN
      );
      await Promise.all(
        Object.entries(pathesContents).map(async ([path, content]) =>
          renameList.push(
            this.isThreadEnabled
              ? await File.createWorker("append", [path, content])
              : await File.append(path, content)
          )
        )
      );

      await Promise.all(
        renameList.map(async ([tempPath, filePath]) =>
          rename(tempPath, filePath)
        )
      );
      renameList = [];

      if (Config.isCacheEnabled) {
        await this.clearCache(tablePath);
        await File.write(
          join(tablePath, ".cache", "pagination.inib"),
          `${lastId},${
            totalItems + (Array.isArray(RETURN) ? RETURN.length : 1)
          }`,
          true
        );
      }

      if (returnPostedData)
        return this.get(
          tableName,
          Config.isReverseEnabled
            ? Array.isArray(RETURN)
              ? RETURN.map((_, index) => index + 1)
              : 1
            : Array.isArray(RETURN)
            ? RETURN.map((_, index) => totalItems - index)
            : totalItems,
          options,
          !Utils.isArrayOfObjects(data), // return only one item if data is not array of objects
          undefined,
          schema
        );
    } finally {
      if (renameList.length)
        await Promise.allSettled(
          renameList.map(async ([tempPath, _]) => unlink(tempPath))
        );
      await File.unlock(join(tablePath, ".tmp"), keys);
    }
  }

  put(
    tableName: string,
    data: Data | Data[],
    where?: number | string | (number | string)[] | Criteria,
    options?: Options,
    returnPostedData?: false
  ): Promise<void | null>;
  put(
    tableName: string,
    data: Data,
    where: number | string | (number | string)[] | Criteria | undefined,
    options: Options | undefined,
    returnPostedData: true
  ): Promise<Data | null>;
  put(
    tableName: string,
    data: Data[],
    where: number | string | (number | string)[] | Criteria | undefined,
    options: Options | undefined,
    returnPostedData: true
  ): Promise<Data[] | null>;
  public async put(
    tableName: string,
    data: Data | Data[],
    where?: number | string | (number | string)[] | Criteria,
    options: Options = {
      page: 1,
      perPage: 15,
    },
    returnPostedData?: boolean
  ): Promise<Data | Data[] | void | null> {
    let renameList: string[][] = [];
    const tablePath = join(this.folder, this.database, tableName),
      schema = await this.getSchemaWhenTableNotEmpty(tableName);

    data = this.formatData(data, schema, true);

    if (!where) {
      if (Utils.isArrayOfObjects(data)) {
        if (
          !data.every(
            (item) => Object.hasOwn(item, "id") && Utils.isValidID(item.id)
          )
        )
          throw this.throwError("INVALID_ID");
        return this.put(
          tableName,
          data,
          data
            .filter(({ id }) => id !== undefined)
            .map(({ id }) => id as string)
        );
      } else if (Object.hasOwn(data, "id")) {
        if (!Utils.isValidID(data.id))
          throw this.throwError("INVALID_ID", data.id);
        return this.put(tableName, data, data.id);
      } else {
        let totalItems: number;
        if (
          Config.isCacheEnabled &&
          (await File.isExists(join(tablePath, ".cache", "pagination.inib")))
        )
          totalItems = (
            await File.read(join(tablePath, ".cache", "pagination.inib"), true)
          )
            .split(",")
            .map(Number)[1];
        else totalItems = await File.count(join(tablePath, "id.inib"));

        const pathesContents = this.joinPathesContents(tablePath, {
          ...(({ id, ...restOfData }) => restOfData)(data as Data),
          updatedAt: Date.now(),
        });

        try {
          await File.lock(join(tablePath, ".tmp"));

          await Promise.all(
            Object.entries(pathesContents).map(async ([path, content]) =>
              renameList.push(
                this.isThreadEnabled
                  ? await File.createWorker("replace", [
                      path,
                      Utils.combineObjects(
                        [...Array(totalItems)].map((_, i) => ({
                          [`${i + 1}`]: content,
                        }))
                      ),
                    ])
                  : await File.replace(
                      path,
                      Utils.combineObjects(
                        [...Array(totalItems)].map((_, i) => ({
                          [`${i + 1}`]: content,
                        }))
                      )
                    )
              )
            )
          );

          await Promise.all(
            renameList.map(async ([tempPath, filePath]) =>
              rename(tempPath, filePath)
            )
          );

          if (Config.isCacheEnabled)
            await this.clearCache(join(tablePath, ".cache"));

          if (returnPostedData)
            return this.get(
              tableName,
              where as undefined,
              options,
              undefined,
              undefined,
              schema
            );
        } finally {
          if (renameList.length)
            await Promise.allSettled(
              renameList.map(async ([tempPath, _]) => unlink(tempPath))
            );
          await File.unlock(join(tablePath, ".tmp"));
        }
      }
    } else if (
      (Array.isArray(where) && where.every(Utils.isValidID)) ||
      Utils.isValidID(where)
    ) {
      const lineNumbers = await this.get(
        tableName,
        where,
        undefined,
        undefined,
        true,
        schema
      );
      return this.put(tableName, data, lineNumbers);
    } else if (
      (Array.isArray(where) && where.every(Utils.isNumber)) ||
      Utils.isNumber(where)
    ) {
      // "where" in this case, is the line(s) number(s) and not id(s)
      const pathesContents = Object.fromEntries(
        Object.entries(
          this.joinPathesContents(
            tablePath,
            Utils.isArrayOfObjects(data)
              ? data.map((item: any) => ({
                  ...item,
                  updatedAt: Date.now(),
                }))
              : { ...data, updatedAt: Date.now() }
          )
        ).map(([path, content]) => [
          path,
          ([...(Array.isArray(where) ? where : [where])] as number[]).reduce(
            (obj, lineNum, index) => ({
              ...obj,
              [lineNum]: Array.isArray(content) ? content[index] : content,
            }),
            {}
          ),
        ])
      );

      const keys = UtilsServer.hashString(
        Object.keys(pathesContents)
          .map((path) => path.replaceAll(".inib", ""))
          .join(".")
      );

      try {
        await File.lock(join(tablePath, ".tmp"), keys);

        await Promise.all(
          Object.entries(pathesContents).map(async ([path, content]) =>
            renameList.push(
              this.isThreadEnabled
                ? await File.createWorker("replace", [path, content])
                : await File.replace(path, content)
            )
          )
        );

        await Promise.all(
          renameList.map(async ([tempPath, filePath]) =>
            rename(tempPath, filePath)
          )
        );
        renameList = [];

        if (Config.isCacheEnabled) await this.clearCache(tablePath);

        if (returnPostedData)
          return this.get(
            tableName,
            where,
            options,
            !Array.isArray(where),
            undefined,
            schema
          ) as any;
      } finally {
        if (renameList.length)
          await Promise.allSettled(
            renameList.map(async ([tempPath, _]) => unlink(tempPath))
          );
        await File.unlock(join(tablePath, ".tmp"), keys);
      }
    } else if (Utils.isObject(where)) {
      const lineNumbers = await this.get(
        tableName,
        where,
        undefined,
        undefined,
        true,
        schema
      );
      return this.put(tableName, data, lineNumbers);
    } else throw this.throwError("INVALID_PARAMETERS");
  }

  delete(
    tableName: string,
    where?: number | string,
    _id?: string | string[]
  ): Promise<string | null>;
  delete(
    tableName: string,
    where?: (number | string)[] | Criteria,
    _id?: string | string[]
  ): Promise<string[] | null>;
  public async delete(
    tableName: string,
    where?: number | string | (number | string)[] | Criteria,
    _id?: string | string[]
  ): Promise<string | string[] | null> {
    let renameList: string[][] = [];

    const tablePath = join(this.folder, this.database, tableName),
      schema = await this.getSchemaWhenTableNotEmpty(tableName);

    if (!where) {
      try {
        await File.lock(join(tablePath, ".tmp"));
        await Promise.all(
          (await readdir(tablePath))
            ?.filter((fileName: string) => fileName.endsWith(".inib"))
            .map(async (file) => unlink(join(tablePath, file)))
        );

        if (Config.isCacheEnabled) await this.clearCache(tablePath);
      } finally {
        await File.unlock(join(tablePath, ".tmp"));
      }
      return "*";
    } else if (
      (Array.isArray(where) && where.every(Utils.isValidID)) ||
      Utils.isValidID(where)
    ) {
      const lineNumbers = await this.get(
        tableName,
        where,
        undefined,
        undefined,
        true,
        schema
      );
      return this.delete(tableName, lineNumbers, where);
    } else if (
      (Array.isArray(where) && where.every(Utils.isNumber)) ||
      Utils.isNumber(where)
    ) {
      // "where" in this case, is the line(s) number(s) and not id(s)
      const files = (await readdir(tablePath))?.filter((fileName: string) =>
        fileName.endsWith(".inib")
      );

      if (files.length) {
        if (!_id)
          _id = Object.entries(
            (await File.get(
              join(tablePath, "id.inib"),
              where,
              "number",
              undefined,
              this.salt
            )) ?? {}
          ).map(([_key, id]) => UtilsServer.encodeID(Number(id), this.salt));

        if (!_id.length) throw this.throwError("NO_RESULTS", tableName);

        try {
          await File.lock(join(tablePath, ".tmp"));

          await Promise.all(
            files.map(async (file) =>
              renameList.push(
                this.isThreadEnabled
                  ? await File.createWorker("remove", [
                      join(tablePath, file),
                      where,
                    ])
                  : await File.remove(join(tablePath, file), where)
              )
            )
          );

          await Promise.all(
            renameList.map(async ([tempPath, filePath]) =>
              rename(tempPath, filePath)
            )
          );

          if (Config.isCacheEnabled) {
            await this.clearCache(tablePath);
            if (
              await File.isExists(join(tablePath, ".cache", "pagination.inib"))
            ) {
              let [lastId, totalItems] = (
                await File.read(
                  join(tablePath, ".cache", "pagination.inib"),
                  true
                )
              )
                .split(",")
                .map(Number);

              await File.write(
                join(tablePath, ".cache", "pagination.inib"),
                `${lastId},${
                  totalItems - (Array.isArray(where) ? where.length : 1)
                }`,
                true
              );
            }
          }

          return Array.isArray(_id) && _id.length === 1 ? _id[0] : _id;
        } finally {
          if (renameList.length)
            await Promise.allSettled(
              renameList.map(async ([tempPath, _]) => unlink(tempPath))
            );
          await File.unlock(join(tablePath, ".tmp"));
        }
      }
    } else if (Utils.isObject(where)) {
      const lineNumbers = await this.get(
        tableName,
        where,
        undefined,
        undefined,
        true,
        schema
      );
      return this.delete(tableName, lineNumbers);
    } else throw this.throwError("INVALID_PARAMETERS");
    return null;
  }

  sum(
    tableName: string,
    columns: string,
    where?: number | string | (number | string)[] | Criteria
  ): Promise<number>;
  sum(
    tableName: string,
    columns: string[],
    where?: number | string | (number | string)[] | Criteria
  ): Promise<Record<string, number>>;
  public async sum(
    tableName: string,
    columns: string | string[],
    where?: number | string | (number | string)[] | Criteria
  ): Promise<number | Record<string, number>> {
    let RETURN: Record<string, number> = {};
    const tablePath = join(this.folder, this.database, tableName),
      schema = await this.getSchemaWhenTableNotEmpty(tableName);

    if (!Array.isArray(columns)) columns = [columns];
    for await (const column of columns) {
      const columnPath = join(tablePath, column + ".inib");
      if (await File.isExists(columnPath)) {
        if (where) {
          const lineNumbers = await this.get(
            tableName,
            where,
            undefined,
            undefined,
            true,
            schema
          );

          RETURN[column] = lineNumbers
            ? await File.sum(columnPath, lineNumbers)
            : 0;
        } else RETURN[column] = await File.sum(columnPath);
      }
    }
    return Array.isArray(columns) ? RETURN : Object.values(RETURN)[0];
  }

  max(
    tableName: string,
    columns: string,
    where?: number | string | (number | string)[] | Criteria
  ): Promise<number>;
  max(
    tableName: string,
    columns: string[],
    where?: number | string | (number | string)[] | Criteria
  ): Promise<Record<string, number>>;
  public async max(
    tableName: string,
    columns: string | string[],
    where?: number | string | (number | string)[] | Criteria
  ): Promise<number | Record<string, number>> {
    let RETURN: Record<string, number> = {};
    const tablePath = join(this.folder, this.database, tableName),
      schema = await this.getSchemaWhenTableNotEmpty(tableName);

    if (!Array.isArray(columns)) columns = [columns];
    for await (const column of columns) {
      const columnPath = join(tablePath, column + ".inib");
      if (await File.isExists(columnPath)) {
        if (where) {
          const lineNumbers = await this.get(
            tableName,
            where,
            undefined,
            undefined,
            true,
            schema
          );
          RETURN[column] = lineNumbers
            ? await File.max(columnPath, lineNumbers)
            : 0;
        } else RETURN[column] = await File.max(columnPath);
      }
    }
    return RETURN;
  }

  min(
    tableName: string,
    columns: string,
    where?: number | string | (number | string)[] | Criteria
  ): Promise<number>;
  min(
    tableName: string,
    columns: string[],
    where?: number | string | (number | string)[] | Criteria
  ): Promise<Record<string, number>>;
  public async min(
    tableName: string,
    columns: string | string[],
    where?: number | string | (number | string)[] | Criteria
  ): Promise<number | Record<string, number>> {
    let RETURN: Record<string, number> = {};
    const tablePath = join(this.folder, this.database, tableName),
      schema = await this.getSchemaWhenTableNotEmpty(tableName);

    if (!Array.isArray(columns)) columns = [columns];
    for await (const column of columns) {
      const columnPath = join(tablePath, column + ".inib");
      if (await File.isExists(columnPath)) {
        if (where) {
          const lineNumbers = await this.get(
            tableName,
            where,
            undefined,
            undefined,
            true,
            schema
          );
          RETURN[column] = lineNumbers
            ? await File.min(columnPath, lineNumbers)
            : 0;
        } else RETURN[column] = await File.min(columnPath);
      }
    }
    return RETURN;
  }

  public async sort(
    tableName: string,
    columns:
      | string
      | string[]
      | Record<string, 1 | -1 | "asc" | "ASC" | "desc" | "DESC">,
    where?: string | number | (string | number)[] | Criteria,
    options: Options = {
      page: 1,
      perPage: 15,
    }
  ) {
    // TO-DO: Cache Results based on "Columns and Sort Direction"
    const tablePath = join(this.folder, this.database, tableName),
      schema = await this.getSchemaWhenTableNotEmpty(tableName);

    // Default values for page and perPage
    options.page = options.page || 1;
    options.perPage = options.perPage || 15;

    let sortArray: [string, boolean][],
      isLineNumbers: boolean = true,
      keepItems: number[] = [];

    if (Utils.isObject(columns) && !Array.isArray(columns)) {
      // {name: "ASC", age: "DESC"}
      sortArray = Object.entries(columns).map(([key, value]) => [
        key,
        typeof value === "string" ? value.toLowerCase() === "asc" : value > 0,
      ]);
    } else {
      if (!Array.isArray(columns)) columns = [columns];
      sortArray = columns.map((column) => [column, true]);
    }

    let cacheKey = "";
    // Criteria
    if (Config.isCacheEnabled)
      cacheKey = UtilsServer.hashString(inspect(sortArray, { sorted: true }));

    if (where) {
      let lineNumbers = await this.get(
        tableName,
        where,
        undefined,
        undefined,
        true,
        schema
      );
      keepItems = Object.values(
        (await File.get(
          join(tablePath, "id.inib"),
          lineNumbers,
          "number",
          undefined,
          this.salt
        )) ?? {}
      ).map(Number);
      isLineNumbers = false;
      if (!keepItems.length) throw this.throwError("NO_RESULTS", tableName);
      keepItems = keepItems.slice(
        ((options.page as number) - 1) * (options.perPage as number),
        (options.page as number) * (options.perPage as number)
      );
    }

    if (!keepItems.length)
      keepItems = Array.from(
        { length: options.perPage },
        (_, index) =>
          ((options.page as number) - 1) * (options.perPage as number) +
          index +
          1
      );

    const filesPathes = [["id", true], ...sortArray].map((column) =>
      join(tablePath, `${column[0]}.inib`)
    );
    // Construct the paste command to merge files and filter lines by IDs
    const pasteCommand = `paste ${filesPathes.join(" ")}`;

    // Construct the sort command dynamically based on the number of files for sorting
    let index = 2;
    const sortColumns = sortArray
      .map(([key, ascending], i) => {
        const field = Inibase.getField(key, schema);
        if (field)
          return `-k${i + index},${i + index}${
            field.type === "number" ? "n" : ""
          }${!ascending ? "r" : ""}`;
        else return "";
      })
      .join(" ");
    const sortCommand = `sort ${sortColumns}`;

    // Construct the awk command to keep only the specified lines after sorting
    const awkCommand = isLineNumbers
      ? `awk '${keepItems.map((line) => `NR==${line}`).join(" || ")}'`
      : `awk 'NR==${keepItems[0]}${keepItems
          .map((num) => `||NR==${num}`)
          .join("")}'`;

    try {
      if (cacheKey) await File.lock(join(tablePath, ".tmp"), cacheKey);

      // Combine the commands
      // Execute the command synchronously
      const { stdout, stderr } = await UtilsServer.exec(
        Config.isCacheEnabled
          ? (await File.isExists(join(tablePath, ".cache", `${cacheKey}.inib`)))
            ? `${awkCommand} ${join(tablePath, ".cache", `${cacheKey}.inib`)}`
            : `${pasteCommand} | ${sortCommand} -o ${join(
                tablePath,
                ".cache",
                `${cacheKey}.inib`
              )} && ${awkCommand} ${join(
                tablePath,
                ".cache",
                `${cacheKey}.inib`
              )}`
          : `${pasteCommand} | ${sortCommand} | ${awkCommand}`,
        {
          encoding: "utf-8",
        }
      );

      // Parse the result and extract the specified lines
      const lines = stdout.trim().split("\n");
      const outputArray = lines.map((line) => {
        const splitedFileColumns = line.split("\t"); // Assuming tab-separated columns
        const outputObject: Record<string, any> = {};

        // Extract values for each file, including "id.inib"
        filesPathes.forEach((fileName, index) => {
          const Field = Inibase.getField(parse(fileName).name, schema);
          if (Field)
            outputObject[Field.key as string] = File.decode(
              splitedFileColumns[index],
              Field?.type,
              Field?.children as any,
              this.salt
            );
        });

        return outputObject;
      });
      const restOfColumns = await this.get(
        tableName,
        outputArray.map(({ id }) => id),
        options,
        undefined,
        undefined,
        schema,
        true
      );

      return restOfColumns
        ? outputArray.map((item, index) => ({
            ...item,
            ...restOfColumns[index],
          }))
        : outputArray;
    } finally {
      if (cacheKey) await File.unlock(join(tablePath, ".tmp"), cacheKey);
    }
  }
}
