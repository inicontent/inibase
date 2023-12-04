import {
  unlink,
  rename,
  readFile,
  writeFile,
  mkdir,
  readdir,
} from "node:fs/promises";
import { join, parse } from "node:path";
import { scryptSync } from "node:crypto";
import File from "./file.js";
import Utils from "./utils.js";
import UtilsServer from "./utils.server.js";

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
  | "id";
type FieldDefault = {
  id?: string | number | null | undefined;
  key: string;
  required?: boolean;
  children?: any;
};
type FieldStringType = {
  type: Exclude<FieldType, "array" | "object">;
};
type FieldStringArrayType = {
  type: Exclude<FieldType, "array" | "object">[];
};
type FieldArrayType = {
  type: "array";
  children: FieldType | FieldType[] | Schema;
};
type FieldArrayArrayType = {
  type: ["array", ...FieldType[]];
  children: FieldType | FieldType[];
};
type FieldObjectType = {
  type: "object";
  children: Schema;
};
// if "type" is array, make "array" at first place, and "number" & "string" at last place of the array
export type Field = FieldDefault &
  (
    | FieldStringType
    | FieldStringArrayType
    | FieldObjectType
    | FieldArrayType
    | FieldArrayArrayType
  );

export type Schema = Field[];

export interface Options {
  page?: number;
  per_page?: number;
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
  total_pages?: number;
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

export default class Inibase {
  public folder: string;
  public database: string;
  public table: string;
  public pageInfo: pageInfo;
  private cache: Map<string, string>;
  private totalItems: Record<string, number>;
  public salt: Buffer;

  constructor(database: string, mainFolder: string = ".") {
    this.database = database;
    this.folder = mainFolder;
    this.table = null;
    this.cache = new Map<string, any>();
    this.totalItems = {};
    this.pageInfo = { page: 1, per_page: 15 };
    this.salt = scryptSync(
      process.env.INIBASE_SECRET ?? "inibase",
      (process.env.INIBASE_SECRET ?? "inibase") + "_salt",
      32
    );
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
        FIELD_REQUIRED: "REQUIRED: {variable}",
        NO_SCHEMA: "NO_SCHEMA: {variable}",
        NO_ITEMS: "NO_ITEMS: {variable}",
        NO_DATA: "NO_DATA: {variable}",
        INVALID_ID: "INVALID_ID: {variable}",
        INVALID_TYPE: "INVALID_TYPE: {variable}",
        INVALID_OPERATOR: "INVALID_OPERATOR: {variable}",
        INVALID_PARAMETERS: "PARAMETERS: {variable}",
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

  public async setTableSchema(
    tableName: string,
    schema: Schema
  ): Promise<void> {
    const decodeIdFromSchema = (schema: Schema) =>
      schema.map((field) => {
        if (field.children && Utils.isArrayOfObjects(field.children))
          field.children = decodeIdFromSchema(field.children as Schema);
        if (!Utils.isNumber(field.id))
          field.id = UtilsServer.decodeID(field.id, this.salt);
        return field;
      });
    // remove id from schema
    schema = schema.filter(
      ({ key }) => !["id", "createdAt", "updatedAt"].includes(key)
    );
    schema = UtilsServer.addIdToSchema(
      schema,
      UtilsServer.findLastIdNumber(schema, this.salt),
      this.salt
    );
    const TablePath = join(this.folder, this.database, tableName),
      TableSchemaPath = join(TablePath, "schema.json");
    if (!(await File.isExists(TablePath)))
      await mkdir(TablePath, { recursive: true });
    if (await File.isExists(TableSchemaPath)) {
      // update columns files names based on field id
      const schemaToIdsPath = (schema: Schema, prefix = "") => {
          let RETURN: any = {};
          for (const field of schema)
            if (field.children && Utils.isArrayOfObjects(field.children)) {
              Utils.deepMerge(
                RETURN,
                schemaToIdsPath(
                  field.children as Schema,
                  (prefix ?? "") + field.key + "."
                )
              );
            } else if (Utils.isValidID(field.id))
              RETURN[UtilsServer.decodeID(field.id, this.salt)] =
                (prefix ?? "") + field.key + ".inib";

          return RETURN;
        },
        replaceOldPathes = Utils.findChangedProperties(
          schemaToIdsPath(await this.getTableSchema(tableName)),
          schemaToIdsPath(schema)
        );
      if (replaceOldPathes)
        for await (const [oldPath, newPath] of Object.entries(replaceOldPathes))
          if (await File.isExists(join(TablePath, oldPath)))
            await rename(join(TablePath, oldPath), join(TablePath, newPath));
    }

    await writeFile(
      join(TablePath, "schema.json"),
      JSON.stringify(decodeIdFromSchema(schema))
    );
  }

  public async getTableSchema(tableName: string): Promise<Schema | undefined> {
    const TableSchemaPath = join(
      this.folder,
      this.database,
      tableName,
      "schema.json"
    );
    if (!(await File.isExists(TableSchemaPath))) return undefined;

    if (!this.cache.has(TableSchemaPath))
      this.cache.set(TableSchemaPath, await readFile(TableSchemaPath, "utf8"));

    if (!this.cache.get(TableSchemaPath)) return undefined;
    const schema = JSON.parse(this.cache.get(TableSchemaPath)),
      lastIdNumber = UtilsServer.findLastIdNumber(schema, this.salt);

    return [
      {
        id: UtilsServer.encodeID(0, this.salt),
        key: "id",
        type: "id",
        required: true,
      },
      ...UtilsServer.addIdToSchema(schema, lastIdNumber, this.salt),
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

  public getField<Property extends keyof Field | "children">(
    keyPath: string,
    schema: Schema | Field,
    property?: Property
  ) {
    const keyPathSplited = keyPath.split(".");
    for (const [index, key] of keyPathSplited.entries()) {
      if (key === "*") continue;
      const foundItem = (schema as Schema).find((item) => item.key === key);
      if (!foundItem) return null;
      if (index === keyPathSplited.length - 1) schema = foundItem;
      if (
        (foundItem.type === "array" || foundItem.type === "object") &&
        foundItem.children &&
        Utils.isArrayOfObjects(foundItem.children)
      )
        schema = foundItem.children as Schema;
    }
    if (property) {
      switch (property) {
        case "type":
          return (schema as Field).type;
        case "children":
          return (
            schema as
              | (Field & FieldObjectType)
              | FieldArrayType
              | FieldArrayArrayType
          ).children;

        default:
          return (schema as Field)[property as keyof Field];
      }
    } else return schema as Field;
  }

  public validateData(
    data: Data | Data[],
    schema: Schema,
    skipRequiredField: boolean = false
  ): void {
    if (Utils.isArrayOfObjects(data))
      for (const single_data of data as Data[])
        this.validateData(single_data, schema, skipRequiredField);
    else if (Utils.isObject(data)) {
      for (const { key, type, required, children } of schema) {
        if (!data.hasOwnProperty(key) && required && !skipRequiredField)
          throw this.throwError("FIELD_REQUIRED", key);
        if (
          data.hasOwnProperty(key) &&
          !Utils.validateFieldType(
            data[key],
            type,
            children && !Utils.isArrayOfObjects(children) ? children : undefined
          )
        )
          throw this.throwError("INVALID_TYPE", key);
        if (
          (type === "array" || type === "object") &&
          children &&
          Utils.isArrayOfObjects(children)
        )
          this.validateData(data[key], children as Schema, skipRequiredField);
      }
    }
  }

  public formatData<dataType extends Data | Data[]>(
    data: dataType,
    schema: Schema,
    formatOnlyAvailiableKeys?: boolean
  ): dataType extends Data ? Data : Data[] {
    this.validateData(data, schema, formatOnlyAvailiableKeys);

    const formatField = (
      value: Data | number | string | (number | string | Data)[],
      field: Field
    ): Data | Data[] | number | string => {
      if (Array.isArray(field.type))
        field.type = Utils.detectFieldType(value, field.type);
      switch (field.type) {
        case "array":
          if (!Array.isArray(value)) value = [value];
          if (typeof field.children === "string") {
            if (field.type === "array" && field.children === "table") {
              if (Array.isArray(value)) {
                if (Utils.isArrayOfObjects(value)) {
                  if (
                    value.every(
                      (item: any): item is Data =>
                        item.hasOwnProperty("id") &&
                        (Utils.isValidID(item.id) || Utils.isNumber(item.id))
                    )
                  )
                    value.map((item) =>
                      Utils.isNumber(item.id)
                        ? Number(item.id)
                        : UtilsServer.decodeID(item.id, this.salt)
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
            } else if (data.hasOwnProperty(field.key)) return value;
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
              (value as Data).hasOwnProperty("id") &&
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
          return typeof value === "string" && value.length === 161
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
        default:
          return value;
      }
      return null;
    };

    if (Utils.isArrayOfObjects(data))
      return data.map((single_data: Data) =>
        this.formatData(single_data, schema, formatOnlyAvailiableKeys)
      );
    else if (Utils.isObject(data)) {
      let RETURN: Data = {};
      for (const field of schema) {
        if (!data.hasOwnProperty(field.key)) {
          if (formatOnlyAvailiableKeys || !field.required) continue;
          RETURN[field.key] = this.getDefaultValue(field);
          continue;
        }
        RETURN[field.key] = formatField(data[field.key], field);
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
          : [];
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

  private joinPathesContents(
    mainPath: string,
    data: Data | Data[]
  ): Record<string, Record<number, any> | any> {
    return Utils.isArrayOfObjects(data)
      ? Utils.combineObjects(
          data.map((single_data) =>
            this.joinPathesContents(mainPath, single_data)
          )
        )
      : Object.fromEntries(
          Object.entries(Utils.objectToDotNotation(data)).map(
            ([key, value]) => [
              join(mainPath, key + ".inib"),
              File.encode(value, this.salt),
            ]
          )
        );
  }

  private async getItemsFromSchema(
    tableName: string,
    schema: Schema,
    linesNumber: number[],
    options: Options,
    prefix?: string
  ) {
    const path = join(this.folder, this.database, tableName);
    let RETURN: Record<number, Data> = {};
    for await (const field of schema) {
      if (
        (field.type === "array" ||
          (Array.isArray(field.type) &&
            (field.type as any).includes("array"))) &&
        field.children
      ) {
        if (Utils.isArrayOfObjects(field.children)) {
          if (
            (field.children as Schema).filter(
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
              if (Utils.isObject(item)) {
                if (!RETURN[index]) RETURN[index] = {};
                if (!RETURN[index][field.key]) RETURN[index][field.key] = [];
                for (const child_field of (field.children as Schema).filter(
                  (children) =>
                    children.type === "array" &&
                    Utils.isArrayOfObjects(children.children)
                )) {
                  if (Utils.isObject(item[child_field.key])) {
                    Object.entries(item[child_field.key]).forEach(
                      ([key, value]) => {
                        if (!Utils.isArrayOfArrays(value))
                          value = value.map((_value: any) =>
                            child_field.type === "array" ? [[_value]] : [_value]
                          );

                        for (let _i = 0; _i < value.length; _i++) {
                          if (Utils.isArrayOfNulls(value[_i])) continue;

                          if (!RETURN[index][field.key][_i])
                            RETURN[index][field.key][_i] = {};
                          if (!RETURN[index][field.key][_i][child_field.key])
                            RETURN[index][field.key][_i][child_field.key] = [];
                          value[_i].forEach(
                            (_element: any, _index: string | number) => {
                              if (
                                !RETURN[index][field.key][_i][child_field.key][
                                  _index
                                ]
                              )
                                RETURN[index][field.key][_i][child_field.key][
                                  _index
                                ] = {};
                              RETURN[index][field.key][_i][child_field.key][
                                _index
                              ][key] = _element;
                            }
                          );
                        }
                      }
                    );
                  }
                }
              }
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
              field.children as Schema,
              linesNumber,
              options,
              (prefix ?? "") + field.key + "."
            )) ?? {}
          ).forEach(([index, item]) => {
            if (!RETURN[index]) RETURN[index] = {};
            if (Utils.isObject(item)) {
              if (!Object.values(item).every((i) => i === null)) {
                if (RETURN[index][field.key]) {
                  Object.entries(item).forEach(([key, value], _index) => {
                    RETURN[index][field.key] = RETURN[index][field.key].map(
                      (_obj: any, _i: string | number) => ({
                        ..._obj,
                        [key]: value[_i],
                      })
                    );
                  });
                } else if (
                  Object.values(item).every(
                    (_i) => Utils.isArrayOfArrays(_i) || Array.isArray(_i)
                  )
                )
                  RETURN[index][field.key] = item;
                else {
                  RETURN[index][field.key] = [];
                  Object.entries(item).forEach(([key, value]) => {
                    for (let _i = 0; _i < value.length; _i++) {
                      if (
                        value[_i] === null ||
                        (Array.isArray(value[_i]) &&
                          value[_i].every((_item) => _item === null))
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
          (Array.isArray(field.children) && field.children.includes("table"))
        ) {
          if (options.columns)
            options.columns = (options.columns as string[])
              .filter((column) => column.includes(`${field.key}.`))
              .map((column) => column.replace(`${field.key}.`, ""));
          const [items, total_lines] = await File.get(
            join(path, (prefix ?? "") + field.key + ".inib"),
            linesNumber,
            field.type,
            field.children,
            this.salt
          );

          this.totalItems[tableName + "-" + field.key] = total_lines;
          for await (const [index, item] of Object.entries(items)) {
            if (!RETURN[index]) RETURN[index] = {};
            RETURN[index][field.key] = item
              ? await this.get(field.key, item as number, options)
              : this.getDefaultValue(field);
          }
        } else if (
          await File.isExists(join(path, (prefix ?? "") + field.key + ".inib"))
        ) {
          const [items, total_lines] = await File.get(
            join(path, (prefix ?? "") + field.key + ".inib"),
            linesNumber,
            field.type,
            (field as any)?.children,
            this.salt
          );

          this.totalItems[tableName + "-" + field.key] = total_lines;
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
          (await File.isExists(join(this.folder, this.database, field.key))) &&
          (await File.isExists(
            join(path, (prefix ?? "") + field.key + ".inib")
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
          const [items, total_lines] = await File.get(
            join(path, (prefix ?? "") + field.key + ".inib"),
            linesNumber,
            "number",
            undefined,
            this.salt
          );
          this.totalItems[tableName + "-" + field.key] = total_lines;
          for await (const [index, item] of Object.entries(items)) {
            if (!RETURN[index]) RETURN[index] = {};
            RETURN[index][field.key] = item
              ? await this.get(field.key, item as number, options)
              : this.getDefaultValue(field);
          }
        }
      } else if (
        await File.isExists(join(path, (prefix ?? "") + field.key + ".inib"))
      ) {
        const [items, total_lines] = await File.get(
          join(path, (prefix ?? "") + field.key + ".inib"),
          linesNumber,
          field.type,
          (field as any)?.children,
          this.salt
        );

        this.totalItems[tableName + "-" + field.key] = total_lines;
        for (const [index, item] of Object.entries(items)) {
          if (!RETURN[index]) RETURN[index] = {};
          RETURN[index][field.key] = item ?? this.getDefaultValue(field);
        }
      }
    }
    return RETURN;
  }

  private FormatObjectCriteriaValue(
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

  private async applyCriteria(
    tableName: string,
    schema: Schema,
    options: Options,
    criteria?: Criteria,
    allTrue?: boolean
  ): Promise<Record<number, Data> | null> {
    let RETURN: Record<number, Data> = {};
    if (!criteria) return null;
    if (criteria.and && Utils.isObject(criteria.and)) {
      const searchResult = await this.applyCriteria(
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
      } else return null;
    }

    if (criteria.or && Utils.isObject(criteria.or)) {
      const searchResult = await this.applyCriteria(
        tableName,
        schema,
        options,
        criteria.or as Criteria,
        false
      );
      delete criteria.or;
      if (searchResult) RETURN = Utils.deepMerge(RETURN, searchResult);
    }

    if (Object.keys(criteria).length > 0) {
      if (allTrue === undefined) allTrue = true;

      let index = -1;
      for await (const [key, value] of Object.entries(criteria)) {
        const field = this.getField(key, schema as Schema) as Field;
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
            Array.isArray((value as Criteria).or)
          ) {
            const searchCriteria = (
              (value as Criteria).or as (string | number | boolean)[]
            )
              .map(
                (
                  single_or
                ): [
                  ComparisonOperator,
                  string | number | boolean | null | (string | number | null)[]
                ] =>
                  typeof single_or === "string"
                    ? this.FormatObjectCriteriaValue(single_or)
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
            delete (value as Criteria).or;
          }
          if (
            (value as Criteria)?.and &&
            Array.isArray((value as Criteria).and)
          ) {
            const searchCriteria = (
              (value as Criteria).and as (string | number | boolean)[]
            )
              .map(
                (
                  single_and
                ): [
                  ComparisonOperator,
                  string | number | boolean | null | (string | number | null)[]
                ] =>
                  typeof single_and === "string"
                    ? this.FormatObjectCriteriaValue(single_and)
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
            delete (value as Criteria).and;
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
                  ? this.FormatObjectCriteriaValue(single)
                  : ["=", single]
            )
            .filter((a) => a) as [ComparisonOperator, string | number][];
          if (searchCriteria.length > 0) {
            searchOperator = searchCriteria.map((single) => single[0]);
            searchComparedAtValue = searchCriteria.map((single) => single[1]);
            searchLogicalOperator = "and";
          }
        } else if (typeof value === "string") {
          const ComparisonOperatorValue = this.FormatObjectCriteriaValue(value);
          if (ComparisonOperatorValue) {
            searchOperator = ComparisonOperatorValue[0];
            searchComparedAtValue = ComparisonOperatorValue[1];
          }
        } else {
          searchOperator = "=";
          searchComparedAtValue = value as number | boolean;
        }
        const [searchResult, total_lines] = await File.search(
          join(this.folder, this.database, tableName, key + ".inib"),
          searchOperator,
          searchComparedAtValue,
          searchLogicalOperator,
          field?.type,
          (field as any)?.children,
          options.per_page,
          (options.page as number) - 1 * (options.per_page as number) + 1,
          true,
          this.salt
        );
        if (searchResult) {
          RETURN = Utils.deepMerge(RETURN, searchResult);
          this.totalItems[tableName + "-" + key] = total_lines;
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

    return Object.keys(RETURN).length ? RETURN : null;
  }

  get(
    tableName: string,
    where?: string | number | (string | number)[] | Criteria | undefined,
    options?: Options | undefined,
    onlyOne?: true,
    onlyLinesNumbers?: undefined
  ): Promise<Data | null>;
  get(
    tableName: string,
    where?: string | number | (string | number)[] | Criteria | undefined,
    options?: Options | undefined,
    onlyOne?: boolean | undefined,
    onlyLinesNumbers?: true
  ): Promise<number[] | null>;
  public async get(
    tableName: string,
    where?: string | number | (string | number)[] | Criteria,
    options: Options = {
      page: 1,
      per_page: 15,
    },
    onlyOne?: boolean,
    onlyLinesNumbers?: boolean
  ): Promise<Data[] | Data | number[] | null> {
    if (!options.columns) options.columns = [];
    else if (!Array.isArray(options.columns))
      options.columns = [options.columns];
    if (options.columns.length && !(options.columns as string[]).includes("id"))
      options.columns.push("id");
    if (!options.page) options.page = 1;
    if (!options.per_page) options.per_page = 15;
    let RETURN!: Data | Data[] | null;
    let schema = await this.getTableSchema(tableName);
    if (!schema) throw this.throwError("NO_SCHEMA", tableName);
    const idFilePath = join(this.folder, this.database, tableName, "id.inib");
    if (!(await File.isExists(idFilePath))) return null;
    const filterSchemaByColumns = (schema: Schema, columns: string[]): Schema =>
      schema
        .map((field) => {
          if (columns.some((column) => column.startsWith("!")))
            return columns.includes("!" + field.key) ? null : field;
          if (columns.includes(field.key) || columns.includes("*"))
            return field;

          if (
            (field.type === "array" || field.type === "object") &&
            Utils.isArrayOfObjects(field.children) &&
            columns.filter(
              (column) =>
                column.startsWith(field.key + ".") ||
                column.startsWith("!" + field.key + ".")
            ).length
          ) {
            field.children = filterSchemaByColumns(
              field.children as Schema,
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
    if (options.columns.length)
      schema = filterSchemaByColumns(schema, options.columns);

    if (!where) {
      // Display all data
      RETURN = Object.values(
        await this.getItemsFromSchema(
          tableName,
          schema,
          Array.from(
            { length: options.per_page },
            (_, index) =>
              ((options.page as number) - 1) * (options.per_page as number) +
              index +
              1
          ),
          options
        )
      );
    } else if (
      (Array.isArray(where) &&
        (where.every(Utils.isValidID) || where.every(Utils.isNumber))) ||
      Utils.isValidID(where) ||
      Utils.isNumber(where)
    ) {
      let Ids = where as string | number | (string | number)[];
      if (!Array.isArray(Ids)) Ids = [Ids];
      const [lineNumbers, countItems] = await File.search(
        idFilePath,
        "[]",
        Ids.map((id) =>
          Utils.isNumber(id) ? Number(id) : UtilsServer.decodeID(id, this.salt)
        ),
        undefined,
        "number",
        undefined,
        Ids.length,
        0,
        false,
        this.salt
      );
      if (!lineNumbers)
        throw this.throwError(
          "INVALID_ID",
          where as number | string | (number | string)[]
        );

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
      if (RETURN.length && !Array.isArray(where)) RETURN = RETURN[0];
    } else if (Utils.isObject(where)) {
      // Criteria

      RETURN = await this.applyCriteria(
        tableName,
        schema,
        options,
        where as Criteria
      );
      if (RETURN) {
        if (onlyLinesNumbers) return Object.keys(RETURN).map(Number);
        const alreadyExistsColumns = Object.keys(Object.values(RETURN)[0]).map(
          (key) => parse(key).name
        );
        RETURN = Object.values(
          Utils.deepMerge(
            RETURN,
            await this.getItemsFromSchema(
              tableName,
              schema.filter(
                (field) => !alreadyExistsColumns.includes(field.key)
              ),
              Object.keys(RETURN).map(Number),
              options
            )
          )
        );
      }
    }
    if (
      !RETURN ||
      (Utils.isObject(RETURN) && !Object.keys(RETURN).length) ||
      (Array.isArray(RETURN) && !RETURN.length)
    )
      return null;

    const greatestTotalItems = Math.max(
      ...Object.entries(this.totalItems)
        .filter(([k]) => k.startsWith(tableName + "-"))
        .map(([, v]) => v)
    );
    this.pageInfo = {
      ...(({ columns, ...restOfOptions }) => restOfOptions)(options),
      total_pages: Math.ceil(greatestTotalItems / options.per_page),
      total: greatestTotalItems,
    };
    return onlyOne && Array.isArray(RETURN) ? RETURN[0] : RETURN;
  }

  post(
    tableName: string,
    data: Data | Data[],
    options: Options | undefined,
    returnPostedData?: false
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
    options: Options = {
      page: 1,
      per_page: 15,
    },
    returnPostedData: boolean = true
  ): Promise<Data | Data[] | null | void> {
    const schema = await this.getTableSchema(tableName);
    let RETURN: Data | Data[] | null | undefined;
    if (!schema) throw this.throwError("NO_SCHEMA", tableName);
    const idFilePath = join(this.folder, this.database, tableName, "id.inib");

    let [last_line_number, last_id] = (await File.isExists(idFilePath))
      ? (Object.entries(
          (await File.get(idFilePath, -1, "number", undefined, this.salt))[0] ??
            {}
        )[0]?.map(Number) as [number, number] | undefined) ?? [0, 0]
      : [0, 0];

    if (Utils.isArrayOfObjects(data))
      RETURN = data.map(({ id, updatedAt, createdAt, ...rest }) => ({
        id: ++last_id,
        ...rest,
        createdAt: Date.now(),
      }));
    else
      RETURN = (({ id, updatedAt, createdAt, ...rest }) => ({
        id: ++last_id,
        ...rest,
        createdAt: Date.now(),
      }))(data);

    if (!RETURN) throw this.throwError("NO_DATA");

    RETURN = this.formatData(RETURN, schema);
    const pathesContents = this.joinPathesContents(
      join(this.folder, this.database, tableName),
      RETURN
    );

    last_line_number += 1;

    for await (const [path, content] of Object.entries(pathesContents))
      await File.append(path, content, last_line_number);

    if (returnPostedData)
      return this.get(
        tableName,
        Utils.isArrayOfObjects(RETURN)
          ? RETURN.map((data: Data) => data.id)
          : ((RETURN as Data).id as number),
        options,
        !Utils.isArrayOfObjects(data) // return only one item if data is not array of objects
      );
  }

  put(
    tableName: string,
    data: Data | Data[],
    where?: number | string | (number | string)[] | Criteria | undefined,
    options?: Options | undefined,
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
      per_page: 15,
    },
    returnPostedData?: boolean
  ): Promise<Data | Data[] | void | null> {
    const schema = await this.getTableSchema(tableName);
    if (!schema) throw this.throwError("NO_SCHEMA", tableName);
    const idFilePath = join(this.folder, this.database, tableName, "id.inib");
    if (!(await File.isExists(idFilePath)))
      throw this.throwError("NO_ITEMS", tableName);
    data = this.formatData(data, schema, true);
    if (!where) {
      if (Utils.isArrayOfObjects(data)) {
        if (
          !data.every(
            (item: any) => item.hasOwnProperty("id") && Utils.isValidID(item.id)
          )
        )
          throw this.throwError("INVALID_ID");
        return this.put(
          tableName,
          data,
          data.map((item: { id: any }) => item.id)
        );
      } else if (data.hasOwnProperty("id")) {
        if (!Utils.isValidID((data as Data).id))
          throw this.throwError("INVALID_ID", (data as Data).id);
        return this.put(
          tableName,
          data,
          UtilsServer.decodeID((data as Data).id as string, this.salt)
        );
      } else {
        const pathesContents = this.joinPathesContents(
          join(this.folder, this.database, tableName),
          Utils.isArrayOfObjects(data)
            ? data.map((item: any) => ({
                ...(({ id, ...restOfData }) => restOfData)(item),
                updatedAt: Date.now(),
              }))
            : {
                ...(({ id, ...restOfData }) => restOfData)(data as Data),
                updatedAt: Date.now(),
              }
        );
        for await (const [path, content] of Object.entries(pathesContents))
          await File.replace(path, content);

        if (returnPostedData) return this.get(tableName, where, options) as any;
      }
    } else if (
      (Array.isArray(where) &&
        (where.every(Utils.isValidID) || where.every(Utils.isNumber))) ||
      Utils.isValidID(where) ||
      Utils.isNumber(where)
    ) {
      if (
        (Array.isArray(where) && where.every(Utils.isValidID)) ||
        Utils.isValidID(where)
      ) {
        const lineNumbers = await this.get(
          tableName,
          where,
          undefined,
          undefined,
          true
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
              join(this.folder, this.database, tableName),
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
        for await (const [path, content] of Object.entries(pathesContents))
          await File.replace(path, content);

        if (returnPostedData)
          return this.get(
            tableName,
            where,
            options,
            !Array.isArray(where)
          ) as any;
      }
    } else if (Utils.isObject(where)) {
      const lineNumbers = await this.get(
        tableName,
        where,
        undefined,
        undefined,
        true
      );
      if (!lineNumbers || !lineNumbers.length)
        throw this.throwError("NO_ITEMS", tableName);
      return this.put(tableName, data, lineNumbers);
    } else throw this.throwError("INVALID_PARAMETERS", tableName);
  }

  delete(
    tableName: string,
    where?: number | string,
    _id?: string | string[]
  ): Promise<string | null>;
  delete(
    tableName: string,
    where?: (number | string)[],
    _id?: string | string[]
  ): Promise<string[] | null>;
  public async delete(
    tableName: string,
    where?: number | string | (number | string)[] | Criteria,
    _id?: string | string[]
  ): Promise<string | string[] | null> {
    const schema = await this.getTableSchema(tableName);
    if (!schema) throw this.throwError("NO_SCHEMA", tableName);
    const idFilePath = join(this.folder, this.database, tableName, "id.inib");
    if (!(await File.isExists(idFilePath)))
      throw this.throwError("NO_ITEMS", tableName);
    if (!where) {
      const files = (
        await readdir(join(this.folder, this.database, tableName))
      )?.filter((fileName: string) => fileName.endsWith(".inib"));
      if (files.length)
        for await (const file of files)
          await unlink(join(this.folder, this.database, tableName, file));

      return "*";
    } else if (
      (Array.isArray(where) &&
        (where.every(Utils.isValidID) || where.every(Utils.isNumber))) ||
      Utils.isValidID(where) ||
      Utils.isNumber(where)
    ) {
      if (
        (Array.isArray(where) && where.every(Utils.isValidID)) ||
        Utils.isValidID(where)
      ) {
        const lineNumbers = await this.get(
          tableName,
          where,
          undefined,
          undefined,
          true
        );

        return this.delete(tableName, lineNumbers, where);
      } else if (
        (Array.isArray(where) && where.every(Utils.isNumber)) ||
        Utils.isNumber(where)
      ) {
        // "where" in this case, is the line(s) number(s) and not id(s)
        const files = (
          await readdir(join(this.folder, this.database, tableName))
        )?.filter((fileName: string) => fileName.endsWith(".inib"));

        if (files.length) {
          if (!_id)
            _id = Object.values(
              (
                await File.get(
                  join(this.folder, this.database, tableName, "id.inib"),
                  where,
                  "number",
                  undefined,
                  this.salt
                )
              )[0] ?? {}
            ).map((id) => UtilsServer.encodeID(Number(id), this.salt));

          if (!_id.length) throw this.throwError("NO_ITEMS", tableName);

          for await (const file of files)
            await File.remove(
              join(this.folder, this.database, tableName, file),
              where
            );
          return Array.isArray(_id) && _id.length === 1 ? _id[0] : _id;
        }
      }
    } else if (Utils.isObject(where)) {
      const lineNumbers = await this.get(
        tableName,
        where,
        undefined,
        undefined,
        true
      );
      if (!lineNumbers || !lineNumbers.length)
        throw this.throwError("NO_ITEMS", tableName);
      return this.delete(tableName, lineNumbers);
    } else throw this.throwError("INVALID_PARAMETERS", tableName);
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
    let RETURN: Record<string, number>;
    const schema = await this.getTableSchema(tableName);
    if (!schema) throw this.throwError("NO_SCHEMA", tableName);
    if (
      !(await File.isExists(
        join(this.folder, this.database, tableName, "id.inib")
      ))
    )
      throw this.throwError("NO_ITEMS", tableName);
    if (!Array.isArray(columns)) columns = [columns];
    for await (const column of columns) {
      const columnPath = join(
        this.folder,
        this.database,
        tableName,
        column + ".inib"
      );
      if (await File.isExists(columnPath)) {
        if (where) {
          const lineNumbers = await this.get(
            tableName,
            where,
            undefined,
            undefined,
            true
          );
          RETURN[column] = await File.sum(columnPath, lineNumbers);
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
    let RETURN: Record<string, number>;
    const schema = await this.getTableSchema(tableName);
    if (!schema) throw this.throwError("NO_SCHEMA", tableName);
    if (
      !(await File.isExists(
        join(this.folder, this.database, tableName, "id.inib")
      ))
    )
      throw this.throwError("NO_ITEMS", tableName);
    if (!Array.isArray(columns)) columns = [columns];
    for await (const column of columns) {
      const columnPath = join(
        this.folder,
        this.database,
        tableName,
        column + ".inib"
      );
      if (await File.isExists(columnPath)) {
        if (where) {
          const lineNumbers = await this.get(
            tableName,
            where,
            undefined,
            undefined,
            true
          );
          RETURN[column] = await File.max(columnPath, lineNumbers);
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
    let RETURN: Record<string, number>;
    const schema = await this.getTableSchema(tableName);
    if (!schema) throw this.throwError("NO_SCHEMA", tableName);
    if (
      !(await File.isExists(
        join(this.folder, this.database, tableName, "id.inib")
      ))
    )
      throw this.throwError("NO_ITEMS", tableName);
    if (!Array.isArray(columns)) columns = [columns];
    for await (const column of columns) {
      const columnPath = join(
        this.folder,
        this.database,
        tableName,
        column + ".inib"
      );
      if (await File.isExists(columnPath)) {
        if (where) {
          const lineNumbers = await this.get(
            tableName,
            where,
            undefined,
            undefined,
            true
          );
          RETURN[column] = await File.min(columnPath, lineNumbers);
        } else RETURN[column] = await File.min(columnPath);
      }
    }
    return RETURN;
  }
}
