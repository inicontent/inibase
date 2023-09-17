import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
  readdirSync,
  unlinkSync,
  renameSync,
} from "fs";
import { join, parse } from "path";
import { createDecipheriv, createCipheriv, scryptSync } from "crypto";
import Utils from "./utils";
import File from "./file";

export { File, Utils };

export type Data = {
  id?: number | string;
  [key: string]: any;
  [id: number]: any;
  created_at?: Date;
  updated_at?: Date;
};

export type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "email"
  | "url"
  | "table"
  | "object"
  | "password"
  | "array";
type Field =
  | {
      id?: string | number | null | undefined;
      key: string;
      type: Exclude<FieldType, "array" | "object">;
      required?: boolean;
    }
  | {
      id?: string | number | null | undefined;
      key: string;
      type: "array";
      required?: boolean;
      children: FieldType | FieldType[] | Schema;
    }
  | {
      id?: string | number | null | undefined;
      key: string;
      type: "object";
      required?: boolean;
      children: Schema;
    };

export type Schema = Field[];

export interface Options {
  page?: number;
  per_page?: number;
  columns?: string[];
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
  total_items?: number;
  total_pages?: number;
} & Options;

export type Criteria =
  | {
      [logic in "and" | "or"]?: Criteria;
    }
  | {
      [key: string]: string | number | boolean | Criteria;
    }
  | null;

export default class Inibase {
  public database: string;
  public databasePath: string;
  public cache: Map<string, string>;
  public pageInfoArray: Record<string, Record<string, number>>;
  public pageInfo: pageInfo;

  constructor(databaseName: string, mainFolder: string = "/") {
    this.database = databaseName;
    this.databasePath = join(mainFolder, databaseName);
    this.cache = new Map<string, any>();
    this.pageInfoArray = {};
    this.pageInfo = { page: 1, per_page: 15 };
  }

  private throwError(
    code: string,
    variable?:
      | string
      | number
      | (string | number)[]
      | Record<string, string | number>,
    language: string = "en"
  ): Error {
    const errorMessages: Record<string, Record<string, string>> = {
      en: {
        NO_SCHEMA: "NO_SCHEMA: {variable}",
        NO_ITEMS: "NO_ITEMS: {variable}",
        INVALID_ID: "INVALID_ID: {variable}",
        INVALID_TYPE: "INVALID_TYPE: {variable}",
        REQUIRED: "REQUIRED: {variable}",
        NO_DATA: "NO_DATA: {variable}",
        INVALID_OPERATOR: "INVALID_OPERATOR: {variable}",
        PARAMETERS: "PARAMETERS: {variable}",
      },
      // Add more languages and error messages as needed
    };

    let errorMessage = errorMessages[language][code] || code;
    if (variable) {
      if (
        typeof variable === "string" ||
        typeof variable === "number" ||
        Array.isArray(variable)
      )
        errorMessage = errorMessage.replaceAll(
          `{variable}`,
          Array.isArray(variable) ? variable.join(", ") : (variable as string)
        );
      else
        Object.keys(variable).forEach(
          (variableKey) =>
            (errorMessage = errorMessage.replaceAll(
              `{${variableKey}}`,
              variable[variableKey].toString()
            ))
        );
    }
    return new Error(errorMessage);
  }

  public encodeID(id: number, secretKey?: string | number): string {
    if (!secretKey) secretKey = this.databasePath;

    const salt = scryptSync(secretKey.toString(), "salt", 32),
      cipher = createCipheriv("aes-256-cbc", salt, salt.subarray(0, 16));

    return cipher.update(id.toString(), "utf8", "hex") + cipher.final("hex");
  }

  public decodeID(input: string, secretKey?: string | number): number {
    if (!secretKey) secretKey = this.databasePath;
    const salt = scryptSync(secretKey.toString(), "salt", 32),
      decipher = createDecipheriv("aes-256-cbc", salt, salt.subarray(0, 16));
    return Number(
      decipher.update(input as string, "hex", "utf8") + decipher.final("utf8")
    );
  }

  public isValidID(input: any): boolean {
    return Array.isArray(input)
      ? input.every(this.isValidID)
      : typeof input === "string" && input.length === 32;
  }

  public validateData(
    data: Data | Data[],
    schema: Schema,
    skipRequiredField: boolean = false
  ): void {
    if (Utils.isArrayOfObjects(data))
      for (const single_data of data as Data[])
        this.validateData(single_data, schema, skipRequiredField);
    else if (!Array.isArray(data)) {
      const validateFieldType = (
        value: any,
        field: Field | FieldType | FieldType[]
      ): boolean => {
        if (Array.isArray(field))
          return field.some((item) => validateFieldType(value, item));
        switch (typeof field === "string" ? field : field.type) {
          case "string":
            return value === null || typeof value === "string";
          case "number":
            return value === null || typeof value === "number";
          case "boolean":
            return (
              value === null ||
              typeof value === "boolean" ||
              value === "true" ||
              value === "false"
            );
          case "date":
            return value === null || value instanceof Date;
          case "object":
            return (
              value === null ||
              (typeof value === "object" &&
                !Array.isArray(value) &&
                value !== null)
            );
          case "array":
            return (
              value === null ||
              (Array.isArray(value) &&
                value.every((item) => validateFieldType(item, field)))
            );
          case "email":
            return (
              value === null ||
              (typeof value === "string" &&
                /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
            );
          case "url":
            return (
              value === null ||
              (typeof value === "string" &&
                (value[0] === "#" ||
                  /^((https?|www):\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]+(\/[^\s]*)?$/.test(
                    value
                  )))
            );
          case "table":
            // feat: check if id exists
            if (Array.isArray(value))
              return (
                typeof field !== "string" &&
                field.type === "table" &&
                ((Utils.isArrayOfObjects(value) &&
                  value.every(
                    (element) =>
                      element.hasOwnProperty("id") &&
                      this.isValidID((element as Data).id)
                  )) ||
                  value.every(Utils.isNumber) ||
                  this.isValidID(value))
              );
            else if (Utils.isObject(value))
              return (
                value.hasOwnProperty("id") && this.isValidID((value as Data).id)
              );
            else return Utils.isNumber(value) || this.isValidID(value);
          default:
            return true;
        }
      };
      for (const field of schema) {
        if (data.hasOwnProperty(field.key)) {
          if (!validateFieldType(data[field.key], field))
            throw this.throwError("INVALID_TYPE", field.key);
          if (
            (field.type === "array" || field.type === "object") &&
            field.children &&
            Utils.isArrayOfObjects(field.children)
          )
            this.validateData(
              data[field.key],
              field.children as Schema,
              skipRequiredField
            );
        } else if (field.required && !skipRequiredField)
          throw this.throwError("REQUIRED", field.key);
      }
    }
  }

  public setTableSchema(tableName: string, schema: Schema): void {
    const encodeSchema = (schema: Schema) => {
        let RETURN: any[][] = [],
          index = 0;
        for (const field of schema) {
          if (!RETURN[index]) RETURN[index] = [];
          RETURN[index].push(
            field.id ? this.decodeID(field.id as string) : null
          );
          RETURN[index].push(field.key ?? null);
          RETURN[index].push(field.required ?? null);
          RETURN[index].push(field.type ?? null);
          RETURN[index].push(
            (field.type === "array" || field.type === "object") &&
              field.children &&
              Utils.isArrayOfObjects(field.children)
              ? encodeSchema(field.children as Schema) ?? null
              : null
          );
          index++;
        }
        return RETURN;
      },
      addIdToSchema = (schema: Schema, oldIndex: number = 0) =>
        schema.map((field) => {
          if (
            (field.type === "array" || field.type === "object") &&
            Utils.isArrayOfObjects(field.children)
          ) {
            if (!field.id) {
              oldIndex++;
              field = { ...field, id: this.encodeID(oldIndex) };
            } else oldIndex = this.decodeID(field.id as string);
            field.children = addIdToSchema(field.children as Schema, oldIndex);
            oldIndex += field.children.length;
          } else if (field.id) oldIndex = this.decodeID(field.id as string);
          else {
            oldIndex++;
            field = { ...field, id: this.encodeID(oldIndex) };
          }
          return field;
        }),
      findLastIdNumber = (schema: Schema): number => {
        const lastField = schema[schema.length - 1];
        if (lastField) {
          if (
            (lastField.type === "array" || lastField.type === "object") &&
            Utils.isArrayOfObjects(lastField.children)
          )
            return findLastIdNumber(lastField.children as Schema);
          else return this.decodeID(lastField.id as string);
        } else return 0;
      };

    // remove id from schema
    schema = schema.filter((field) => field.key !== "id");
    schema = addIdToSchema(schema, findLastIdNumber(schema));
    const TablePath = join(this.databasePath, tableName),
      TableSchemaPath = join(TablePath, "schema.inib");
    if (!existsSync(TablePath)) mkdirSync(TablePath, { recursive: true });
    if (existsSync(TableSchemaPath)) {
      // update columns files names based on field id
      const schemaToIdsPath = (schema: any, prefix = "") => {
          let RETURN: any = {};
          for (const field of schema) {
            if (field.children && Utils.isArrayOfObjects(field.children)) {
              Utils.deepMerge(
                RETURN,
                schemaToIdsPath(
                  field.children,
                  (prefix ?? "") +
                    field.key +
                    (field.type === "array" ? ".*." : ".")
                )
              );
            } else if (this.isValidID(field.id))
              RETURN[this.decodeID(field.id)] = File.encodeFileName(
                (prefix ?? "") + field.key,
                "inib"
              );
          }
          return RETURN;
        },
        findChangedProperties = (
          obj1: Record<string, string>,
          obj2: Record<string, string>
        ): Record<string, string> | null => {
          const result: Record<string, string> = {};

          for (const key1 in obj1) {
            if (obj2.hasOwnProperty(key1) && obj1[key1] !== obj2[key1]) {
              result[obj1[key1]] = obj2[key1];
            }
          }

          return Object.keys(result).length ? result : null;
        },
        replaceOldPathes = findChangedProperties(
          schemaToIdsPath(this.getTableSchema(tableName)),
          schemaToIdsPath(schema)
        );
      if (replaceOldPathes) {
        for (const [oldPath, newPath] of Object.entries(replaceOldPathes))
          if (existsSync(join(TablePath, oldPath)))
            renameSync(join(TablePath, oldPath), join(TablePath, newPath));
      }
    }

    writeFileSync(
      join(TablePath, "schema.inib"),
      JSON.stringify(encodeSchema(schema))
    );
  }

  public getTableSchema(tableName: string): Schema | undefined {
    const decodeSchema = (encodedSchema: any) => {
        return encodedSchema.map((field: any) =>
          Array.isArray(field[0])
            ? decodeSchema(field)
            : Object.fromEntries(
                Object.entries({
                  id: this.encodeID(field[0]),
                  key: field[1],
                  required: field[2],
                  type: field[3],
                  children: field[4]
                    ? Array.isArray(field[4])
                      ? decodeSchema(field[4])
                      : field[4]
                    : null,
                }).filter(([_, v]) => v != null)
              )
        );
      },
      TableSchemaPath = join(this.databasePath, tableName, "schema.inib");
    if (!existsSync(TableSchemaPath)) return undefined;
    if (!this.cache.has(TableSchemaPath)) {
      const TableSchemaPathContent = readFileSync(TableSchemaPath);
      this.cache.set(
        TableSchemaPath,
        TableSchemaPathContent
          ? decodeSchema(JSON.parse(TableSchemaPathContent.toString()))
          : ""
      );
    }
    return [
      { id: this.encodeID(0), key: "id", type: "number", required: true },
      ...(this.cache.get(TableSchemaPath) as unknown as Schema),
    ];
  }

  public getField(keyPath: string, schema: Schema | Field): Field | null {
    for (const key of keyPath.split(".")) {
      if (key === "*") continue;
      const foundItem = (schema as Schema).find((item) => item.key === key);
      if (!foundItem) return null;
      schema =
        (foundItem.type === "array" || foundItem.type === "object") &&
        foundItem.children &&
        Utils.isArrayOfObjects(foundItem.children)
          ? (foundItem.children as Schema)
          : foundItem;
    }
    return schema as Field;
  }

  public formatData(
    data: Data | Data[],
    schema: Schema,
    formatOnlyAvailiableKeys?: boolean
  ): Data | Data[] {
    if (Utils.isArrayOfObjects(data)) {
      return data.map((single_data: Data) =>
        this.formatData(single_data, schema)
      );
    } else if (!Array.isArray(data)) {
      let RETURN: Data = {};
      for (const field of schema) {
        if (!data.hasOwnProperty(field.key)) {
          RETURN[field.key] = this.getDefaultValue(field);
          continue;
        }
        if (formatOnlyAvailiableKeys && !data.hasOwnProperty(field.key))
          continue;

        if (field.type === "array" || field.type === "object") {
          if (field.children)
            if (typeof field.children === "string") {
              if (field.type === "array" && field.children === "table") {
                if (Array.isArray(data[field.key])) {
                  if (Utils.isArrayOfObjects(data[field.key])) {
                    if (
                      data[field.key].every(
                        (item: any) =>
                          item.hasOwnProperty("id") &&
                          (this.isValidID(item.id) || Utils.isNumber(item.id))
                      )
                    )
                      data[field.key].map((item: any) =>
                        Utils.isNumber(item.id)
                          ? parseFloat(item.id)
                          : this.decodeID(item.id)
                      );
                  } else if (
                    this.isValidID(data[field.key]) ||
                    Utils.isNumber(data[field.key])
                  )
                    RETURN[field.key] = data[field.key].map(
                      (item: number | string) =>
                        Utils.isNumber(item)
                          ? parseFloat(item as string)
                          : this.decodeID(item as string)
                    );
                } else if (this.isValidID(data[field.key]))
                  RETURN[field.key] = [this.decodeID(data[field.key])];
                else if (Utils.isNumber(data[field.key]))
                  RETURN[field.key] = [parseFloat(data[field.key])];
              } else if (data.hasOwnProperty(field.key))
                RETURN[field.key] = data[field.key];
            } else if (Utils.isArrayOfObjects(field.children))
              RETURN[field.key] = this.formatData(
                data[field.key],
                field.children as Schema,
                formatOnlyAvailiableKeys
              );
        } else if (field.type === "table") {
          if (Utils.isObject(data[field.key])) {
            if (
              data[field.key].hasOwnProperty("id") &&
              (this.isValidID(data[field.key].id) ||
                Utils.isNumber(data[field.key]))
            )
              RETURN[field.key] = Utils.isNumber(data[field.key].id)
                ? parseFloat(data[field.key].id)
                : this.decodeID(data[field.key].id);
          } else if (
            this.isValidID(data[field.key]) ||
            Utils.isNumber(data[field.key])
          )
            RETURN[field.key] = Utils.isNumber(data[field.key])
              ? parseFloat(data[field.key])
              : this.decodeID(data[field.key]);
        } else if (field.type === "password")
          RETURN[field.key] =
            data[field.key].length === 161
              ? data[field.key]
              : Utils.hashPassword(data[field.key]);
        else RETURN[field.key] = data[field.key];
      }
      return RETURN;
    } else return [];
  }

  private getDefaultValue(field: Field): any {
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
          : [];
      case "object":
        return Utils.combineObjects(
          field.children.map((f) => ({ [f.key]: this.getDefaultValue(f) }))
        );
      case "boolean":
        return false;
      default:
        return null;
    }
  }

  public joinPathesContents(
    mainPath: string,
    data: Data | Data[]
  ): { [key: string]: string[] } {
    const CombineData = (data: Data | Data[], prefix?: string) => {
      let RETURN: Record<
        string,
        string | boolean | number | null | (string | boolean | number | null)[]
      > = {};

      if (Utils.isArrayOfObjects(data))
        RETURN = Utils.combineObjects(
          (data as Data[]).map((single_data) => CombineData(single_data))
        );
      else {
        for (const [key, value] of Object.entries(data)) {
          if (Utils.isObject(value))
            Object.assign(RETURN, CombineData(value, `${key}.`));
          else if (Array.isArray(value)) {
            if (Utils.isArrayOfObjects(value))
              Object.assign(
                RETURN,
                CombineData(
                  Utils.combineObjects(value),
                  (prefix ?? "") + key + ".*."
                )
              );
            else
              RETURN[(prefix ?? "") + key] = Utils.encode(value) as
                | boolean
                | number
                | string
                | null;
          } else
            RETURN[(prefix ?? "") + key] = Utils.encode(value) as
              | boolean
              | number
              | string
              | null;
        }
      }
      return RETURN;
    };
    const addPathToKeys = (obj: Record<string, any>, path: string) => {
      const newObject: Record<string, any> = {};

      for (const key in obj)
        newObject[join(path, File.encodeFileName(key, "inib"))] = obj[key];

      return newObject;
    };
    return addPathToKeys(CombineData(data), mainPath);
  }

  public async get(
    tableName: string,
    where?: string | number | (string | number)[] | Criteria,
    options: Options = {
      page: 1,
      per_page: 15,
    },
    onlyLinesNumbers?: boolean
  ): Promise<Data | Data[] | number[] | null> {
    if (!options.columns) options.columns = [];
    else if (
      options.columns.length &&
      !(options.columns as string[]).includes("id")
    )
      options.columns.push("id");
    if (!options.page) options.page = 1;
    if (!options.per_page) options.per_page = 15;
    let RETURN!: Data | Data[] | null;
    let schema = this.getTableSchema(tableName);
    if (!schema) throw this.throwError("NO_SCHEMA", tableName);
    const filterSchemaByColumns = (schema: Schema, columns: string[]): Schema =>
      schema
        .map((field) => {
          if (columns.includes(field.key)) return field;
          if (
            (field.type === "array" || field.type === "object") &&
            Utils.isArrayOfObjects(field.children) &&
            columns.filter((column) =>
              column.startsWith(
                field.key + (field.type === "array" ? ".*." : ".")
              )
            ).length
          ) {
            field.children = filterSchemaByColumns(
              field.children as Schema,
              columns
                .filter((column) =>
                  column.startsWith(
                    field.key + (field.type === "array" ? ".*." : ".")
                  )
                )
                .map((column) =>
                  column.replace(
                    field.key + (field.type === "array" ? ".*." : "."),
                    ""
                  )
                )
            );
            return field;
          }
          return null;
        })
        .filter((i) => i) as Schema;
    if (options.columns.length)
      schema = filterSchemaByColumns(schema, options.columns);

    const getItemsFromSchema = async (
      path: string,
      schema: Schema,
      linesNumber: number[],
      prefix?: string
    ): Promise<Data> => {
      let RETURN: Data = {};
      for (const field of schema) {
        if (
          (field.type === "array" || field.type === "object") &&
          field.children
        ) {
          if (field.children === "table") {
            if (options.columns)
              options.columns = (options.columns as string[])
                .filter((column) => column.includes(`${field.key}.*.`))
                .map((column) => column.replace(`${field.key}.*.`, ""));
            for await (const [index, value] of Object.entries(
              (await File.get(
                join(
                  path,
                  File.encodeFileName((prefix ?? "") + field.key, "inib")
                ),
                field.type,
                linesNumber
              )) ?? {}
            )) {
              if (!RETURN[index]) RETURN[index] = {};
              RETURN[index][field.key] = value
                ? await this.get(field.key, value as number, options)
                : this.getDefaultValue(field);
            }
          } else if (Utils.isArrayOfObjects(field.children)) {
            Object.entries(
              (await getItemsFromSchema(
                path,
                field.children as Schema,
                linesNumber,
                (prefix ?? "") +
                  field.key +
                  (field.type === "array" ? ".*." : ".")
              )) ?? {}
            ).forEach(([index, item]) => {
              if (!RETURN[index]) RETURN[index] = {};
              RETURN[index][field.key] = item;
            });
          }
        } else if (field.type === "table") {
          if (
            existsSync(join(this.databasePath, field.key)) &&
            existsSync(
              join(
                path,
                File.encodeFileName((prefix ?? "") + field.key, "inib")
              )
            )
          ) {
            if (options.columns)
              options.columns = (options.columns as string[])
                .filter(
                  (column) =>
                    column.includes(`${field.key}.`) &&
                    !column.includes(`${field.key}.*.`)
                )
                .map((column) => column.replace(`${field.key}.`, ""));
            for await (const [index, value] of Object.entries(
              (await File.get(
                join(
                  path,
                  File.encodeFileName((prefix ?? "") + field.key, "inib")
                ),
                "number",
                linesNumber
              )) ?? {}
            )) {
              if (!RETURN[index]) RETURN[index] = {};
              RETURN[index][field.key] = value
                ? await this.get(field.key, value as number, options)
                : this.getDefaultValue(field);
            }
          }
        } else if (
          existsSync(
            join(path, File.encodeFileName((prefix ?? "") + field.key, "inib"))
          )
        ) {
          Object.entries(
            (await File.get(
              join(
                path,
                File.encodeFileName((prefix ?? "") + field.key, "inib")
              ),
              field.type,
              linesNumber
            )) ?? {}
          ).forEach(([index, item]) => {
            if (!RETURN[index]) RETURN[index] = {};
            RETURN[index][field.key] = item ?? this.getDefaultValue(field);
          });
        }
      }
      return RETURN;
    };
    if (!where) {
      // Display all data
      RETURN = Object.values(
        await getItemsFromSchema(
          join(this.databasePath, tableName),
          schema,
          Array.from(
            { length: options.per_page },
            (_, index) =>
              ((options.page as number) - 1) * (options.per_page as number) +
              index +
              1
          )
        )
      );
    } else if (this.isValidID(where) || Utils.isNumber(where)) {
      let Ids = where as string | number | (string | number)[];
      if (!Array.isArray(Ids)) Ids = [Ids];
      const idFilePath = join(this.databasePath, tableName, "id.inib");
      if (!existsSync(idFilePath)) throw this.throwError("NO_ITEMS", tableName);
      const [lineNumbers, countItems] = await File.search(
        idFilePath,
        "number",
        "[]",
        Utils.isNumber(Ids)
          ? Ids.map((id) => parseFloat(id as string))
          : Ids.map((id) => this.decodeID(id as string)),
        undefined,
        Ids.length
      );
      if (!lineNumbers || !Object.keys(lineNumbers).length)
        throw this.throwError(
          "INVALID_ID",
          where as number | string | (number | string)[]
        );
      RETURN = Object.values(
        (await getItemsFromSchema(
          join(this.databasePath, tableName),
          schema,
          Object.keys(lineNumbers).map(Number)
        )) ?? {}
      );
      if (RETURN.length && !Array.isArray(where)) RETURN = RETURN[0];
    } else if (typeof where === "object" && !Array.isArray(where)) {
      // Criteria
      const FormatObjectCriteriaValue = (
        value: string
      ): [ComparisonOperator, string | number | boolean | null] => {
        switch (value[0]) {
          case ">":
          case "<":
          case "[":
            return ["=", "]", "*"].includes(value[1])
              ? [
                  value.slice(0, 2) as ComparisonOperator,
                  value.slice(2) as string | number,
                ]
              : [
                  value.slice(0, 1) as ComparisonOperator,
                  value.slice(1) as string | number,
                ];
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
                  value.slice(0, 1) as ComparisonOperator,
                  value.slice(1) as string | number,
                ];
          case "=":
          case "*":
            return [
              value.slice(0, 1) as ComparisonOperator,
              value.slice(1) as string | number,
            ];
          default:
            return ["=", value];
        }
      };

      const applyCriteria = async (
        criteria?: Criteria,
        allTrue?: boolean
      ): Promise<Data | null> => {
        let RETURN: Data = {};
        if (!criteria) return null;
        if (criteria.and && typeof criteria.and === "object") {
          const searchResult = await applyCriteria(criteria.and, true);
          if (searchResult) {
            RETURN = Utils.deepMerge(
              RETURN,
              Object.fromEntries(
                Object.entries(searchResult).filter(
                  ([_k, v], _i) =>
                    Object.keys(v).length ===
                    Object.keys(criteria.and ?? {}).length
                )
              )
            );
            delete criteria.and;
          } else return null;
        }

        if (criteria.or && typeof criteria.or === "object") {
          const searchResult = await applyCriteria(criteria.or);
          delete criteria.or;
          if (searchResult) RETURN = Utils.deepMerge(RETURN, searchResult);
        }

        let index = -1;
        for (const [key, value] of Object.entries(criteria)) {
          index++;
          if (
            allTrue &&
            index > 0 &&
            (!Object.keys(RETURN).length ||
              Object.values(RETURN).every(
                (item) => Object.keys(item).length >= index
              ))
          )
            break;
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
          if (typeof value === "object") {
            if (value?.or && Array.isArray(value.or)) {
              const searchCriteria = value.or
                .map(
                  (
                    single_or
                  ): [ComparisonOperator, string | number | boolean | null] =>
                    typeof single_or === "string"
                      ? FormatObjectCriteriaValue(single_or)
                      : ["=", single_or]
                )
                .filter((a) => a) as [ComparisonOperator, string | number][];
              if (searchCriteria.length > 0) {
                searchOperator = searchCriteria.map(
                  (single_or) => single_or[0]
                );
                searchComparedAtValue = searchCriteria.map(
                  (single_or) => single_or[1]
                );
                searchLogicalOperator = "or";
              }
              delete value.or;
            }
            if (value?.and && Array.isArray(value.and)) {
              const searchCriteria = value.and
                .map(
                  (
                    single_and
                  ): [ComparisonOperator, string | number | boolean | null] =>
                    typeof single_and === "string"
                      ? FormatObjectCriteriaValue(single_and)
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
              delete value.and;
            }
          } else if (Array.isArray(value)) {
            const searchCriteria = value
              .map(
                (
                  single
                ): [ComparisonOperator, string | number | boolean | null] =>
                  typeof single === "string"
                    ? FormatObjectCriteriaValue(single)
                    : ["=", single]
              )
              .filter((a) => a) as [ComparisonOperator, string | number][];
            if (searchCriteria.length > 0) {
              searchOperator = searchCriteria.map((single) => single[0]);
              searchComparedAtValue = searchCriteria.map((single) => single[1]);
              searchLogicalOperator = "and";
            }
          } else if (typeof value === "string") {
            const ComparisonOperatorValue = FormatObjectCriteriaValue(value);
            if (ComparisonOperatorValue) {
              searchOperator = ComparisonOperatorValue[0];
              searchComparedAtValue = ComparisonOperatorValue[1];
            }
          } else {
            searchOperator = "=";
            searchComparedAtValue = value;
          }
          if (searchOperator && searchComparedAtValue) {
            const [searchResult, totlaItems] = await File.search(
              join(
                this.databasePath,
                tableName,
                File.encodeFileName(key, "inib")
              ),
              this.getField(key, schema as Schema)?.type ?? "string",
              searchOperator,
              searchComparedAtValue,
              searchLogicalOperator,
              options.per_page,
              (options.page as number) - 1 * (options.per_page as number) + 1,
              true
            );
            if (searchResult) {
              RETURN = Utils.deepMerge(RETURN, searchResult);
              if (!this.pageInfoArray[key]) this.pageInfoArray[key] = {};
              this.pageInfoArray[key].total_items = totlaItems;
            }
          }
        }
        return Object.keys(RETURN).length > 0 ? RETURN : null;
      };

      RETURN = await applyCriteria(where);
      if (RETURN) {
        if (onlyLinesNumbers) return Object.keys(RETURN).map(Number);
        const alreadyExistsColumns = Object.keys(Object.values(RETURN)[0]).map(
            (key) => File.decodeFileName(parse(key).name)
          ),
          greatestColumnTotalItems = alreadyExistsColumns.reduce(
            (maxItem: string, currentItem: string) =>
              this.pageInfoArray[currentItem]?.total_items ||
              (0 > (this.pageInfoArray[maxItem]?.total_items || 0) &&
                this.pageInfoArray[currentItem].total_items)
                ? currentItem
                : maxItem,
            ""
          );
        if (greatestColumnTotalItems)
          this.pageInfo = {
            ...(({ columns, ...restOFOptions }) => restOFOptions)(options),
            ...this.pageInfoArray[greatestColumnTotalItems],
            total_pages: Math.ceil(
              this.pageInfoArray[greatestColumnTotalItems].total_items /
                options.per_page
            ),
          };
        RETURN = Object.values(
          Utils.deepMerge(
            await getItemsFromSchema(
              join(this.databasePath, tableName),
              schema.filter(
                (field) => !alreadyExistsColumns.includes(field.key)
              ),
              Object.keys(RETURN).map(Number)
            ),
            RETURN
          )
        );
      }
    }
    return RETURN
      ? Utils.isArrayOfObjects(RETURN)
        ? (RETURN as Data[]).map((data: Data) => {
            data.id = this.encodeID(data.id as number);
            return data;
          })
        : {
            ...(RETURN as Data),
            id: this.encodeID((RETURN as Data).id as number),
          }
      : null;
  }

  public async post(
    tableName: string,
    data: Data | Data[]
  ): Promise<Data | Data[] | null> {
    const schema = this.getTableSchema(tableName);
    let RETURN: Data | Data[] | null | undefined;
    if (!schema) throw this.throwError("NO_SCHEMA", tableName);
    const idFilePath = join(this.databasePath, tableName, "id.inib");
    let last_id = existsSync(idFilePath)
      ? Number(Object.values(await File.get(idFilePath, "number", -1))[0])
      : 0;
    if (Utils.isArrayOfObjects(data))
      (data as Data[]).forEach((single_data, index) => {
        if (!RETURN) RETURN = [];
        RETURN[index] = (({ id, updated_at, created_at, ...rest }) => rest)(
          single_data
        );
        RETURN[index].id = ++last_id;
        RETURN[index].created_at = new Date();
      });
    else {
      RETURN = (({ id, updated_at, created_at, ...rest }) => rest)(
        data as Data
      );
      RETURN.id = ++last_id;
      RETURN.created_at = new Date();
    }
    if (!RETURN) throw this.throwError("NO_DATA");
    this.validateData(RETURN, schema);
    RETURN = this.formatData(RETURN, schema);
    const pathesContents = this.joinPathesContents(
      join(this.databasePath, tableName),
      RETURN
    );
    for (const [path, content] of Object.entries(pathesContents))
      appendFileSync(
        path,
        (Array.isArray(content) ? content.join("\n") : content ?? "") + "\n",
        "utf8"
      );
    return Utils.isArrayOfObjects(RETURN)
      ? RETURN.map((data: Data) => {
          data.id = this.encodeID(data.id as number);
          return data;
        })
      : { ...RETURN, id: this.encodeID((RETURN as Data).id as number) };
  }

  public async put(
    tableName: string,
    data: Data | Data[],
    where?: number | string | (number | string)[] | Criteria
  ) {
    const schema = this.getTableSchema(tableName);
    if (!schema) throw this.throwError("NO_SCHEMA", tableName);
    this.validateData(data, schema, true);
    data = this.formatData(data, schema, true);
    if (!where) {
      if (Utils.isArrayOfObjects(data)) {
        if (
          !(data as Data[]).every(
            (item) => item.hasOwnProperty("id") && this.isValidID(item.id)
          )
        )
          throw this.throwError("INVALID_ID");
        await this.put(
          tableName,
          data,
          (data as Data[]).map((item) => item.id)
        );
      } else if (data.hasOwnProperty("id")) {
        if (!this.isValidID((data as Data).id))
          throw this.throwError("INVALID_ID", (data as Data).id);
        await this.put(
          tableName,
          data,
          this.decodeID((data as Data).id as string)
        );
      } else {
        const pathesContents = this.joinPathesContents(
          join(this.databasePath, tableName),
          Utils.isArrayOfObjects(data)
            ? (data as Data[]).map((item) => ({
                ...item,
                updated_at: new Date(),
              }))
            : { ...data, updated_at: new Date() }
        );
        for (const [path, content] of Object.entries(pathesContents))
          await File.replace(path, content);
      }
    } else if (this.isValidID(where)) {
      let Ids = where as string | string[];
      if (!Array.isArray(Ids)) Ids = [Ids];
      const idFilePath = join(this.databasePath, tableName, "id.inib");
      if (!existsSync(idFilePath)) throw this.throwError("NO_ITEMS", tableName);
      const [lineNumbers, countItems] = await File.search(
        idFilePath,
        "number",
        "[]",
        Ids.map((id) => this.decodeID(id)),
        undefined,
        Ids.length
      );
      if (!lineNumbers || !Object.keys(lineNumbers).length)
        throw this.throwError("INVALID_ID");
      await this.put(tableName, data, Object.keys(lineNumbers).map(Number));
    } else if (Utils.isNumber(where)) {
      // where in this case, is the line(s) number(s) and not id(s)
      const pathesContents = Object.fromEntries(
        Object.entries(
          this.joinPathesContents(
            join(this.databasePath, tableName),
            Utils.isArrayOfObjects(data)
              ? (data as Data[]).map((item) => ({
                  ...item,
                  updated_at: new Date(),
                }))
              : { ...data, updated_at: new Date() }
          )
        ).map(([key, value]) => [
          key,
          ([...(Array.isArray(where) ? where : [where])] as number[]).reduce(
            (obj, key, index) => ({
              ...obj,
              [key]: Array.isArray(value) ? value[index] : value,
            }),
            {}
          ),
        ])
      );
      for (const [path, content] of Object.entries(pathesContents))
        await File.replace(path, content);
    } else if (typeof where === "object" && !Array.isArray(where)) {
      const lineNumbers = this.get(tableName, where, undefined, true);
      if (!lineNumbers || !Array.isArray(lineNumbers) || !lineNumbers.length)
        throw this.throwError("NO_ITEMS", tableName);
      await this.put(tableName, data, lineNumbers);
    } else throw this.throwError("PARAMETERS", tableName);
  }

  public async delete(
    tableName: string,
    where?: number | string | (number | string)[] | Criteria
  ) {
    const schema = this.getTableSchema(tableName);
    if (!schema) throw this.throwError("NO_SCHEMA", tableName);
    if (!where) {
      const files = readdirSync(join(this.databasePath, tableName));
      if (files.length) {
        for (const file in files.filter(
          (fileName: string) => fileName !== "schema.inib"
        ))
          unlinkSync(join(this.databasePath, tableName, file));
      }
    } else if (this.isValidID(where)) {
      let Ids = where as string | string[];
      if (!Array.isArray(Ids)) Ids = [Ids];
      const idFilePath = join(this.databasePath, tableName, "id.inib");
      if (!existsSync(idFilePath)) throw this.throwError("NO_ITEMS", tableName);
      const [lineNumbers, countItems] = await File.search(
        idFilePath,
        "number",
        "[]",
        Ids.map((id) => this.decodeID(id)),
        undefined,
        Ids.length
      );
      if (!lineNumbers || !Object.keys(lineNumbers).length)
        throw this.throwError("INVALID_ID");
      await this.delete(tableName, Object.keys(lineNumbers).map(Number));
    } else if (Utils.isNumber(where)) {
      const files = readdirSync(join(this.databasePath, tableName));
      if (files.length) {
        for (const file in files.filter(
          (fileName: string) => fileName !== "schema.inib"
        ))
          await File.remove(
            join(this.databasePath, tableName, file),
            where as number | number[]
          );
      }
    } else if (typeof where === "object" && !Array.isArray(where)) {
      const lineNumbers = this.get(tableName, where, undefined, true);
      if (!lineNumbers || !Array.isArray(lineNumbers) || !lineNumbers.length)
        throw this.throwError("NO_ITEMS", tableName);
      await this.delete(tableName, lineNumbers);
    } else throw this.throwError("PARAMETERS", tableName);
  }
}
