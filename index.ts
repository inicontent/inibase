import {
  unlink,
  rename,
  readFile,
  writeFile,
  appendFile,
  mkdir,
  readdir,
} from "fs/promises";
import { join, parse } from "path";
import Utils from "./utils";
import File from "./file";

export type Data = {
  id?: number | string;
  [key: string]: any;
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
      [logic in "and" | "or"]?: Criteria | (string | number | boolean | null)[];
    }
  | {
      [key: string]: string | number | boolean | Criteria;
    }
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
  public database: string;
  public databasePath: string;
  public cache: Map<string, string>;
  public pageInfoArray: Record<string, Record<string, number>>;
  public pageInfo: pageInfo;

  constructor(databaseName: string, mainFolder: string = ".") {
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

  private findLastIdNumber(schema: Schema): number {
    const lastField = schema[schema.length - 1];
    if (lastField) {
      if (
        (lastField.type === "array" || lastField.type === "object") &&
        Utils.isArrayOfObjects(lastField.children)
      )
        return this.findLastIdNumber(lastField.children as Schema);
      else if (lastField.id && Utils.isValidID(lastField.id))
        return Utils.decodeID(lastField.id as string, this.databasePath);
    }
    return 0;
  }

  public async setTableSchema(
    tableName: string,
    schema: Schema
  ): Promise<void> {
    const encodeSchema = (schema: Schema) => {
        let RETURN: any[][] = [],
          index = 0;
        for (const field of schema) {
          if (!RETURN[index]) RETURN[index] = [];
          RETURN[index].push(
            field.id
              ? Utils.decodeID(field.id as string, this.databasePath)
              : null
          );
          RETURN[index].push(field.key ?? null);
          RETURN[index].push(field.required ?? null);
          RETURN[index].push(field.type ?? null);
          RETURN[index].push(
            (field as any).children
              ? Utils.isArrayOfObjects((field as any).children)
                ? encodeSchema((field as any).children as Schema) ?? null
                : (field as any).children
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
              field = {
                ...field,
                id: Utils.encodeID(oldIndex, this.databasePath),
              };
            } else
              oldIndex = Utils.decodeID(field.id as string, this.databasePath);
            field.children = addIdToSchema(field.children as Schema, oldIndex);
            oldIndex += field.children.length;
          } else if (field.id)
            oldIndex = Utils.decodeID(field.id as string, this.databasePath);
          else {
            oldIndex++;
            field = {
              ...field,
              id: Utils.encodeID(oldIndex, this.databasePath),
            };
          }
          return field;
        });

    // remove id from schema
    schema = schema.filter(
      (field) => !["id", "created_at", "updated_at"].includes(field.key)
    );
    schema = addIdToSchema(schema, this.findLastIdNumber(schema));
    const TablePath = join(this.databasePath, tableName),
      TableSchemaPath = join(TablePath, "schema.inib");
    if (!(await File.isExists(TablePath)))
      await mkdir(TablePath, { recursive: true });
    if (await File.isExists(TableSchemaPath)) {
      // update columns files names based on field id
      const schemaToIdsPath = (schema: any, prefix = "") => {
          let RETURN: any = {};
          for (const field of schema)
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
            } else if (Utils.isValidID(field.id))
              RETURN[Utils.decodeID(field.id, this.databasePath)] =
                File.encodeFileName((prefix ?? "") + field.key, "inib");

          return RETURN;
        },
        replaceOldPathes = Utils.findChangedProperties(
          schemaToIdsPath(await this.getTableSchema(tableName)),
          schemaToIdsPath(schema)
        );
      if (replaceOldPathes)
        for (const [oldPath, newPath] of Object.entries(replaceOldPathes))
          if (await File.isExists(join(TablePath, oldPath)))
            await rename(join(TablePath, oldPath), join(TablePath, newPath));
    }

    await writeFile(
      join(TablePath, "schema.inib"),
      JSON.stringify(encodeSchema(schema))
    );
  }

  public async getTableSchema(tableName: string): Promise<Schema | undefined> {
    const decodeSchema = (encodedSchema: any) => {
        return encodedSchema.map((field: any) =>
          Array.isArray(field[0])
            ? decodeSchema(field)
            : Object.fromEntries(
                Object.entries({
                  id: Utils.encodeID(field[0], this.databasePath),
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
    if (!(await File.isExists(TableSchemaPath))) return undefined;
    if (!this.cache.has(TableSchemaPath)) {
      const TableSchemaPathContent = await readFile(TableSchemaPath, {
        encoding: "utf8",
      });
      this.cache.set(
        TableSchemaPath,
        TableSchemaPathContent
          ? decodeSchema(JSON.parse(TableSchemaPathContent.toString()))
          : ""
      );
    }
    const schema = this.cache.get(TableSchemaPath) as unknown as Schema,
      lastIdNumber = this.findLastIdNumber(schema);
    return [
      {
        id: Utils.encodeID(0, this.databasePath),
        key: "id",
        type: "number",
        required: true,
      },
      ...schema,
      {
        id: Utils.encodeID(lastIdNumber, this.databasePath),
        key: "created_at",
        type: "date",
        required: true,
      },
      {
        id: Utils.encodeID(lastIdNumber + 1, this.databasePath),
        key: "updated_at",
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
    const validateFieldType = (
      value: any,
      fieldType: FieldType | FieldType[],
      fieldChildrenType?: FieldType | FieldType[]
    ): boolean => {
      if (value === null) return true;
      if (Array.isArray(fieldType))
        return Utils.detectFieldType(value, fieldType) !== undefined;
      if (fieldType === "array" && fieldChildrenType && Array.isArray(value))
        return value.some(
          (v) =>
            Utils.detectFieldType(
              v,
              Array.isArray(fieldChildrenType)
                ? fieldChildrenType
                : [fieldChildrenType]
            ) !== undefined
        );

      switch (fieldType) {
        case "string":
          return Utils.isString(value);
        case "password":
          return (
            Utils.isNumber(value) ||
            Utils.isString(value) ||
            Utils.isPassword(value)
          );
        case "number":
          return Utils.isNumber(value);
        case "html":
          return Utils.isHTML(value);
        case "ip":
          return Utils.isIP(value);
        case "boolean":
          return Utils.isBoolean(value);
        case "date":
          return Utils.isDate(value);
        case "object":
          return Utils.isObject(value);
        case "array":
          return Array.isArray(value);
        case "email":
          return Utils.isEmail(value);
        case "url":
          return Utils.isURL(value);
        case "table":
          // feat: check if id exists
          if (Array.isArray(value))
            return (
              (Utils.isArrayOfObjects(value) &&
                value.every(
                  (element: Data) =>
                    element.hasOwnProperty("id") &&
                    (Utils.isValidID(element.id) || Utils.isNumber(element.id))
                )) ||
              value.every(Utils.isNumber) ||
              Utils.isValidID(value)
            );
          else if (Utils.isObject(value))
            return (
              value.hasOwnProperty("id") &&
              (Utils.isValidID((value as Data).id) ||
                Utils.isNumber((value as Data).id))
            );
          else return Utils.isNumber(value) || Utils.isValidID(value);
        case "id":
          return Utils.isNumber(value) || Utils.isValidID(value);
        default:
          return false;
      }
    };

    if (Utils.isArrayOfObjects(data))
      for (const single_data of data as Data[])
        this.validateData(single_data, schema, skipRequiredField);
    else if (Utils.isObject(data)) {
      for (const field of schema) {
        if (
          !data.hasOwnProperty(field.key) &&
          field.required &&
          !skipRequiredField
        )
          throw this.throwError("FIELD_REQUIRED", field.key);
        if (
          data.hasOwnProperty(field.key) &&
          !validateFieldType(
            data[field.key],
            field.type,
            (field as any)?.children &&
              !Utils.isArrayOfObjects((field as any)?.children)
              ? (field as any)?.children
              : undefined
          )
        )
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
      }
    }
  }

  public formatData(
    data: Data | Data[],
    schema: Schema,
    formatOnlyAvailiableKeys?: boolean
  ): Data | Data[] {
    const formatField = (
      value: any,
      field: Field
    ): Data | Data[] | number | string => {
      if (Array.isArray(field.type))
        field.type = Utils.detectFieldType(value, field.type);
      switch (field.type) {
        case "array":
          if (typeof field.children === "string") {
            if (field.type === "array" && field.children === "table") {
              if (Array.isArray(data[field.key])) {
                if (Utils.isArrayOfObjects(data[field.key])) {
                  if (
                    value.every(
                      (item: any) =>
                        item.hasOwnProperty("id") &&
                        (Utils.isValidID(item.id) || Utils.isNumber(item.id))
                    )
                  )
                    value.map((item: any) =>
                      Utils.isNumber(item.id)
                        ? Number(item.id)
                        : Utils.decodeID(item.id, this.databasePath)
                    );
                } else if (Utils.isValidID(value) || Utils.isNumber(value))
                  return value.map((item: number | string) =>
                    Utils.isNumber(item)
                      ? Number(item as string)
                      : Utils.decodeID(item as string, this.databasePath)
                  );
              } else if (Utils.isValidID(value))
                return [Utils.decodeID(value, this.databasePath)];
              else if (Utils.isNumber(value)) return [Number(value)];
            } else if (data.hasOwnProperty(field.key)) return value;
          } else if (Utils.isArrayOfObjects(field.children))
            return this.formatData(
              value,
              field.children as Schema,
              formatOnlyAvailiableKeys
            );
          else if (Array.isArray(field.children))
            return Array.isArray(value) ? value : [value];
          break;
        case "object":
          if (Utils.isArrayOfObjects(field.children))
            return this.formatData(
              value,
              field.children,
              formatOnlyAvailiableKeys
            );
          break;
        case "table":
          if (Utils.isObject(value)) {
            if (
              value.hasOwnProperty("id") &&
              (Utils.isValidID(value.id) || Utils.isNumber(value))
            )
              return Utils.isNumber(value.id)
                ? Number(value.id)
                : Utils.decodeID(value.id, this.databasePath);
          } else if (Utils.isValidID(value) || Utils.isNumber(value))
            return Utils.isNumber(value)
              ? Number(value)
              : Utils.decodeID(value, this.databasePath);
          break;
        case "password":
          return value.length === 161 ? value : Utils.hashPassword(value);
        case "number":
          return Utils.isNumber(value) ? Number(value) : null;
        case "id":
          return Utils.isNumber(value)
            ? Utils.encodeID(value, this.databasePath)
            : value;
        default:
          return value;
      }
      return null;
    };

    this.validateData(data, schema, formatOnlyAvailiableKeys);

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
    const CombineData = (_data: Data | Data[], prefix?: string) => {
      let RETURN: Record<
        string,
        string | boolean | number | null | (string | boolean | number | null)[]
      > = {};
      const combineObjectsToArray = (input: any[]) =>
        input.reduce(
          (r, c) => (
            Object.keys(c).map((k) => (r[k] = [...(r[k] || []), c[k]])), r
          ),
          {}
        );
      if (Utils.isArrayOfObjects(_data))
        RETURN = combineObjectsToArray(
          (_data as Data[]).map((single_data) => CombineData(single_data))
        );
      else {
        for (const [key, value] of Object.entries(_data as Data)) {
          if (Utils.isObject(value))
            Object.assign(RETURN, CombineData(value, `${key}.`));
          else if (Array.isArray(value)) {
            if (Utils.isArrayOfObjects(value)) {
              Object.assign(
                RETURN,
                CombineData(
                  combineObjectsToArray(value),
                  (prefix ?? "") + key + ".*."
                )
              );
            } else if (
              Utils.isArrayOfArrays(value) &&
              value.every(Utils.isArrayOfObjects)
            )
              Object.assign(
                RETURN,
                CombineData(
                  combineObjectsToArray(value.map(combineObjectsToArray)),
                  (prefix ?? "") + key + ".*."
                )
              );
            else
              RETURN[(prefix ?? "") + key] = File.encode(value) as
                | boolean
                | number
                | string
                | null;
          } else
            RETURN[(prefix ?? "") + key] = File.encode(value) as
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
    else if (!Array.isArray(options.columns))
      options.columns = [options.columns];
    if (options.columns.length && !(options.columns as string[]).includes("id"))
      options.columns.push("id");
    if (!options.page) options.page = 1;
    if (!options.per_page) options.per_page = 15;
    let RETURN!: Data | Data[] | null;
    let schema = await this.getTableSchema(tableName);
    if (!schema) throw this.throwError("NO_SCHEMA", tableName);
    const idFilePath = join(this.databasePath, tableName, "id.inib");
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

    const getItemsFromSchema = async (
      path: string,
      schema: Schema,
      linesNumber: number[],
      prefix?: string
    ) => {
      let RETURN: Record<number, Data> = {};
      for (const field of schema) {
        if (
          (field.type === "array" ||
            (Array.isArray(field.type) &&
              (field.type as any).includes("array"))) &&
          (field as FieldDefault & (FieldArrayType | FieldArrayArrayType))
            .children
        ) {
          if (
            Utils.isArrayOfObjects(
              (field as FieldDefault & (FieldArrayType | FieldArrayArrayType))
                .children
            )
          ) {
            if (
              (
                (field as FieldDefault & (FieldArrayType | FieldArrayArrayType))
                  .children as Schema
              ).filter(
                (children) =>
                  children.type === "array" &&
                  Utils.isArrayOfObjects(children.children)
              ).length
            ) {
              // one of children has array field type and has children array of object = Schema
              Object.entries(
                (await getItemsFromSchema(
                  path,
                  (
                    (
                      field as FieldDefault &
                        (FieldArrayType | FieldArrayArrayType)
                    ).children as Schema
                  ).filter(
                    (children) =>
                      children.type === "array" &&
                      Utils.isArrayOfObjects(children.children)
                  ),
                  linesNumber,
                  (prefix ?? "") + field.key + ".*."
                )) ?? {}
              ).forEach(([index, item]) => {
                if (Utils.isObject(item)) {
                  if (!RETURN[index]) RETURN[index] = {};
                  if (!RETURN[index][field.key]) RETURN[index][field.key] = [];
                  for (const child_field of (
                    (
                      field as FieldDefault &
                        (FieldArrayType | FieldArrayArrayType)
                    ).children as Schema
                  ).filter(
                    (children) =>
                      children.type === "array" &&
                      Utils.isArrayOfObjects(children.children)
                  )) {
                    if (Utils.isObject(item[child_field.key])) {
                      Object.entries(item[child_field.key]).forEach(
                        ([key, value]) => {
                          for (let _i = 0; _i < value.length; _i++) {
                            if (!RETURN[index][field.key][_i])
                              RETURN[index][field.key][_i] = {};
                            if (!RETURN[index][field.key][_i][child_field.key])
                              RETURN[index][field.key][_i][child_field.key] =
                                [];
                            value[_i].forEach((_element, _index) => {
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
                            });
                          }
                        }
                      );
                    }
                  }
                }
              });
              (
                field as FieldDefault & (FieldArrayType | FieldArrayArrayType)
              ).children = (
                (field as FieldDefault & (FieldArrayType | FieldArrayArrayType))
                  .children as Schema
              ).filter(
                (children) =>
                  children.type !== "array" ||
                  !Utils.isArrayOfObjects(children.children)
              );
            }
            Object.entries(
              (await getItemsFromSchema(
                path,
                (field as FieldDefault & (FieldArrayType | FieldArrayArrayType))
                  .children as Schema,
                linesNumber,
                (prefix ?? "") + field.key + ".*."
              )) ?? {}
            ).forEach(([index, item]) => {
              if (!RETURN[index]) RETURN[index] = {};
              if (Utils.isObject(item)) {
                if (!Object.values(item).every((i) => i === null)) {
                  if (RETURN[index][field.key])
                    Object.entries(item).forEach(([key, value], _index) => {
                      RETURN[index][field.key] = RETURN[index][field.key].map(
                        (_obj, _i) => ({ ..._obj, [key]: value[_i] })
                      );
                    });
                  else if (Object.values(item).every(Utils.isArrayOfArrays))
                    RETURN[index][field.key] = item;
                  else {
                    RETURN[index][field.key] = [];
                    Object.entries(item).forEach(([key, value]) => {
                      for (let _i = 0; _i < value.length; _i++) {
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
            (field as FieldDefault & (FieldArrayType | FieldArrayArrayType))
              .children === "table" ||
            (Array.isArray(
              (field as FieldDefault & (FieldArrayType | FieldArrayArrayType))
                .children
            ) &&
              (
                (field as FieldDefault & (FieldArrayType | FieldArrayArrayType))
                  .children as FieldType[]
              ).includes("table"))
          ) {
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
                linesNumber,
                field.type,
                (field as FieldDefault & (FieldArrayType | FieldArrayArrayType))
                  .children as FieldType | FieldType[]
              )) ?? {}
            )) {
              if (!RETURN[index]) RETURN[index] = {};
              RETURN[index][field.key] = value
                ? await this.get(field.key, value as number, options)
                : this.getDefaultValue(field);
            }
          } else if (
            await File.isExists(
              join(
                path,
                File.encodeFileName((prefix ?? "") + field.key, "inib")
              )
            )
          )
            Object.entries(
              (await File.get(
                join(
                  path,
                  File.encodeFileName((prefix ?? "") + field.key, "inib")
                ),
                linesNumber,
                field.type,
                (field as any)?.children
              )) ?? {}
            ).forEach(([index, item]) => {
              if (!RETURN[index]) RETURN[index] = {};
              RETURN[index][field.key] = item ?? this.getDefaultValue(field);
            });
        } else if (field.type === "object") {
          Object.entries(
            (await getItemsFromSchema(
              path,
              field.children as Schema,
              linesNumber,
              (prefix ?? "") + field.key + "."
            )) ?? {}
          ).forEach(([index, item]) => {
            if (!RETURN[index]) RETURN[index] = {};
            if (Utils.isObject(item)) {
              if (!Object.values(item).every((i) => i === null))
                RETURN[index][field.key] = item;
              else RETURN[index][field.key] = null;
            } else RETURN[index][field.key] = null;
          });
        } else if (field.type === "table") {
          if (
            (await File.isExists(join(this.databasePath, field.key))) &&
            (await File.isExists(
              join(
                path,
                File.encodeFileName((prefix ?? "") + field.key, "inib")
              )
            ))
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
                linesNumber,
                "number"
              )) ?? {}
            )) {
              if (!RETURN[index]) RETURN[index] = {};
              RETURN[index][field.key] = value
                ? await this.get(field.key, value as number, options)
                : this.getDefaultValue(field);
            }
          }
        } else if (
          await File.isExists(
            join(path, File.encodeFileName((prefix ?? "") + field.key, "inib"))
          )
        )
          Object.entries(
            (await File.get(
              join(
                path,
                File.encodeFileName((prefix ?? "") + field.key, "inib")
              ),
              linesNumber,
              field.type,
              (field as any)?.children
            )) ?? {}
          ).forEach(([index, item]) => {
            if (!RETURN[index]) RETURN[index] = {};
            RETURN[index][field.key] = item ?? this.getDefaultValue(field);
          });
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
    } else if (Utils.isValidID(where) || Utils.isNumber(where)) {
      let Ids = where as string | number | (string | number)[];
      if (!Array.isArray(Ids)) Ids = [Ids];
      const [lineNumbers, countItems] = await File.search(
        idFilePath,
        "[]",
        Utils.isNumber(Ids)
          ? Ids.map((id) => Number(id as string))
          : Ids.map((id) => Utils.decodeID(id as string, this.databasePath)),
        undefined,
        "number",
        undefined,
        Ids.length,
        0,
        false,
        this.databasePath
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
    } else if (Utils.isObject(where)) {
      // Criteria
      const FormatObjectCriteriaValue = (
        value: string,
        isParentArray: boolean = false
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
      };

      const applyCriteria = async (
        criteria?: Criteria,
        allTrue?: boolean
      ): Promise<Record<number, Data> | null> => {
        let RETURN: Record<number, Data> = {};
        if (!criteria) return null;
        if (criteria.and && Utils.isObject(criteria.and)) {
          const searchResult = await applyCriteria(
            criteria.and as Criteria,
            true
          );
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

        if (criteria.or && Utils.isObject(criteria.or)) {
          const searchResult = await applyCriteria(criteria.or as Criteria);
          delete criteria.or;
          if (searchResult) RETURN = Utils.deepMerge(RETURN, searchResult);
        }

        if (Object.keys(criteria).length > 0) {
          allTrue = true;
          let index = -1;
          for (const [key, value] of Object.entries(criteria)) {
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
                delete (value as Criteria).and;
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
                searchComparedAtValue = searchCriteria.map(
                  (single) => single[1]
                );
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
              searchComparedAtValue = value as number | boolean;
            }
            const [searchResult, totlaItems] = await File.search(
              join(
                this.databasePath,
                tableName,
                File.encodeFileName(key, "inib")
              ),
              searchOperator,
              searchComparedAtValue,
              searchLogicalOperator,
              field?.type,
              (field as any)?.children,
              options.per_page,
              (options.page as number) - 1 * (options.per_page as number) + 1,
              true,
              this.databasePath
            );
            if (searchResult) {
              RETURN = Utils.deepMerge(RETURN, searchResult);
              if (!this.pageInfoArray[key]) this.pageInfoArray[key] = {};
              this.pageInfoArray[key].total_items = totlaItems;
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
      };
      RETURN = await applyCriteria(where as Criteria);
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
            ...(({ columns, ...restOfOptions }) => restOfOptions)(options),
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
    if (
      !RETURN ||
      (Utils.isObject(RETURN) && !Object.keys(RETURN).length) ||
      (Array.isArray(RETURN) && !RETURN.length)
    )
      return null;
    return Utils.isArrayOfObjects(RETURN)
      ? (RETURN as Data[]).map((data: Data) => {
          data.id = Utils.encodeID(data.id as number, this.databasePath);
          return data;
        })
      : {
          ...(RETURN as Data),
          id: Utils.encodeID((RETURN as Data).id as number, this.databasePath),
        };
  }

  public async post(
    tableName: string,
    data: Data | Data[],
    options: Options = {
      page: 1,
      per_page: 15,
    }
  ): Promise<Data | Data[] | null> {
    const schema = await this.getTableSchema(tableName);
    let RETURN: Data | Data[] | null | undefined;
    if (!schema) throw this.throwError("NO_SCHEMA", tableName);
    const idFilePath = join(this.databasePath, tableName, "id.inib");
    let last_id = (await File.isExists(idFilePath))
      ? Number(Object.values(await File.get(idFilePath, -1, "number"))[0])
      : 0;
    if (Utils.isArrayOfObjects(data))
      (data as Data[]).forEach((single_data, index) => {
        if (!RETURN) RETURN = [];
        RETURN[index] = (({ id, updated_at, created_at, ...rest }) => ({
          id: ++last_id,
          ...rest,
          created_at: new Date(),
        }))(single_data);
      });
    else
      RETURN = (({ id, updated_at, created_at, ...rest }) => ({
        id: ++last_id,
        ...rest,
        created_at: new Date(),
      }))(data as Data);
    if (!RETURN) throw this.throwError("NO_DATA");
    RETURN = this.formatData(RETURN, schema);
    const pathesContents = this.joinPathesContents(
      join(this.databasePath, tableName),
      RETURN
    );
    for await (const [path, content] of Object.entries(pathesContents))
      await appendFile(
        path,
        (Array.isArray(content) ? content.join("\n") : content ?? "") + "\n"
      );

    return this.get(
      tableName,
      Utils.isArrayOfObjects(RETURN)
        ? RETURN.map((data: Data) => data.id)
        : ((RETURN as Data).id as number),
      options
    );
  }

  public async put(
    tableName: string,
    data: Data | Data[],
    where?: number | string | (number | string)[] | Criteria,
    options: Options = {
      page: 1,
      per_page: 15,
    }
  ): Promise<Data | Data[] | null> {
    const schema = await this.getTableSchema(tableName);
    if (!schema) throw this.throwError("NO_SCHEMA", tableName);
    const idFilePath = join(this.databasePath, tableName, "id.inib");
    if (!(await File.isExists(idFilePath)))
      throw this.throwError("NO_ITEMS", tableName);
    data = this.formatData(data, schema, true);
    if (!where) {
      if (Utils.isArrayOfObjects(data)) {
        if (
          !(data as Data[]).every(
            (item) => item.hasOwnProperty("id") && Utils.isValidID(item.id)
          )
        )
          throw this.throwError("INVALID_ID");
        return this.put(
          tableName,
          data,
          (data as Data[]).map((item) => item.id)
        );
      } else if (data.hasOwnProperty("id")) {
        if (!Utils.isValidID((data as Data).id))
          throw this.throwError("INVALID_ID", (data as Data).id);
        return this.put(
          tableName,
          data,
          Utils.decodeID((data as Data).id as string, this.databasePath)
        );
      } else {
        const pathesContents = this.joinPathesContents(
          join(this.databasePath, tableName),
          Utils.isArrayOfObjects(data)
            ? (data as Data[]).map((item) => ({
                ...(({ id, ...restOfData }) => restOfData)(item),
                updated_at: new Date(),
              }))
            : {
                ...(({ id, ...restOfData }) => restOfData)(data as Data),
                updated_at: new Date(),
              }
        );
        for (const [path, content] of Object.entries(pathesContents))
          await File.replace(path, content);
        return this.get(tableName, where, options);
      }
    } else if (Utils.isValidID(where)) {
      let Ids = where as string | string[];
      if (!Array.isArray(Ids)) Ids = [Ids];
      const [lineNumbers, countItems] = await File.search(
        idFilePath,
        "[]",
        Ids.map((id) => Utils.decodeID(id, this.databasePath)),
        undefined,
        "number",
        undefined,
        Ids.length,
        0,
        false,
        this.databasePath
      );
      if (!lineNumbers || !Object.keys(lineNumbers).length)
        throw this.throwError("INVALID_ID");
      return this.put(tableName, data, Object.keys(lineNumbers).map(Number));
    } else if (Utils.isNumber(where)) {
      // "where" in this case, is the line(s) number(s) and not id(s)
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
      return this.get(tableName, where, options);
    } else if (typeof where === "object" && !Array.isArray(where)) {
      const lineNumbers = this.get(tableName, where, undefined, true);
      if (!lineNumbers || !Array.isArray(lineNumbers) || !lineNumbers.length)
        throw this.throwError("NO_ITEMS", tableName);
      return this.put(tableName, data, lineNumbers);
    } else throw this.throwError("INVALID_PARAMETERS", tableName);
  }

  public async delete(
    tableName: string,
    where?: number | string | (number | string)[] | Criteria,
    _id?: string | string[]
  ): Promise<string | string[] | null> {
    const schema = await this.getTableSchema(tableName);
    if (!schema) throw this.throwError("NO_SCHEMA", tableName);
    const idFilePath = join(this.databasePath, tableName, "id.inib");
    if (!(await File.isExists(idFilePath)))
      throw this.throwError("NO_ITEMS", tableName);
    if (!where) {
      const files = await readdir(join(this.databasePath, tableName));
      if (files.length) {
        for (const file in files.filter(
          (fileName: string) => fileName !== "schema.inib"
        ))
          await unlink(join(this.databasePath, tableName, file));
      }
      return "*";
    } else if (Utils.isValidID(where)) {
      let Ids = where as string | string[];
      if (!Array.isArray(Ids)) Ids = [Ids];
      const [lineNumbers, countItems] = await File.search(
        idFilePath,
        "[]",
        Ids.map((id) => Utils.decodeID(id, this.databasePath)),
        undefined,
        "number",
        undefined,
        Ids.length,
        0,
        false,
        this.databasePath
      );
      if (!lineNumbers || !Object.keys(lineNumbers).length)
        throw this.throwError("INVALID_ID");
      return this.delete(
        tableName,
        Object.keys(lineNumbers).map(Number),
        where as string | string[]
      );
    } else if (Utils.isNumber(where)) {
      const files = await readdir(join(this.databasePath, tableName));
      if (files.length) {
        if (!_id)
          _id = Object.values(
            await File.get(
              join(this.databasePath, tableName, "id.inib"),
              where as number | number[],
              "number"
            )
          )
            .map(Number)
            .map((id) => Utils.encodeID(id, this.databasePath));
        for (const file of files.filter(
          (fileName: string) =>
            fileName.endsWith(".inib") && fileName !== "schema.inib"
        ))
          await File.remove(
            join(this.databasePath, tableName, file),
            where as number | number[]
          );
        return Array.isArray(_id) && _id.length === 1 ? _id[0] : _id;
      }
    } else if (typeof where === "object" && !Array.isArray(where)) {
      const lineNumbers = this.get(tableName, where, undefined, true);
      if (!lineNumbers || !Array.isArray(lineNumbers) || !lineNumbers.length)
        throw this.throwError("NO_ITEMS", tableName);
      return this.delete(tableName, lineNumbers);
    } else throw this.throwError("INVALID_PARAMETERS", tableName);
    return null;
  }
}
