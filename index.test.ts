import { decode } from "./src/file";
import Inibase, { Schema, Data } from "./src/index";
import { join } from "node:path";
// import os from "os";
// Create a new instance of Inibase with the database path
const db = new Inibase("inicontent", join("..", "inicontent", "databases"));

const schema_1: Schema = [
  {
    key: "username",
    type: "string",
    required: true,
  },
  {
    key: "password",
    type: "password",
    required: true,
  },
  {
    key: "email",
    type: "email",
    required: true,
  },
  {
    key: "role",
    type: "string",
    required: true,
  },
];

const data_1: Data = [
  {
    username: "admin",
    password: "admina",
    email: "karim.amahtil@gmail.com",
    role: "admin",
  },
  {
    username: "kamatil",
    password: "admina",
    email: "karim.amahtil21@gmail.com",
    role: "user",
  },
  {
    username: "tvonthego",
    password: "azqswx",
    email: "vip72abdo@gmail.com",
    role: "user",
  },
];

const schema_2: Schema = [
  {
    key: "name",
    type: "string",
    required: true,
  },
  {
    key: "slug",
    type: "string",
    required: true,
  },
  {
    key: "icon",
    type: "url",
    required: false,
  },
  {
    key: "languages",
    type: "array",
    children: "string",
    required: false,
  },
  {
    key: "allowed_domains",
    type: "array",
    children: "url",
    required: false,
  },
  {
    key: "tables",
    type: "array",
    children: [
      {
        key: "name",
        type: "string",
        required: true,
      },
      {
        key: "slug",
        type: "string",
        required: true,
      },
      {
        key: "allowed_methods",
        type: "array",
        children: [
          {
            key: "role",
            type: "string",
            required: true,
          },
          {
            key: "methods",
            type: "string",
            required: true,
          },
        ],
        required: true,
      },
      {
        key: "schema",
        type: "array",
        children: [
          {
            key: "id",
            type: "id",
            required: true,
          },
          {
            key: "subtype",
            type: "string",
          },
          {
            key: "accept",
            type: "array",
            children: "string",
          },
          {
            key: "search",
            type: "array",
            children: "string",
          },
          {
            key: "label",
            type: "array",
            children: "string",
          },
          {
            key: "image",
            type: "string",
          },
          {
            key: "values",
            type: "array",
            children: "string",
          },
        ],
      },
    ],
  },
  {
    key: "user",
    type: ["array", "table"],
    children: "table",
    required: false,
  },
];

const data_2 = [
  {
    name: "Inicontent",
    slug: "inicontent",
    allowed_domains: ["http://localhost:3000"],
    tables: [
      {
        name: "User",
        slug: "user",
        allowed_methods: [
          {
            role: "user",
            methods: "cru",
          },
          {
            role: "guest",
            methods: "c",
          },
        ],
      },
      {
        name: "Database",
        slug: "database",
        allowed_methods: [
          {
            role: "user",
            methods: "crud",
          },
          {
            role: "guest",
            methods: "c",
          },
        ],
      },
    ],
    user: 1,
  },
];
try {
  // db.setTableSchema("database", schema_2);
  // const DATA = await db.post("database", data_2);
  // const DATA = await db.delete("database", 2);
  // const DATA = await db.post("database", {
  //   slug: "iptv",
  //   allowed_domains: ['https://iptv.kamatil.com'],
  //   tables: [
  //     {
  //       id: 1,
  //       slug: "user",
  //       allowed_methods: [
  //         {
  //           role: "user",
  //           methods: ["c", "r", "u"],
  //         },
  //         {
  //           role: "guest",
  //           methods: ["c"],
  //         },
  //         {
  //           role: "admin",
  //           methods: ["d", "u"],
  //         },
  //       ],
  //     },
  //     {
  //       id: 1,
  //       slug: "user",
  //       allowed_methods: [
  //         {
  //           role: "user",
  //           methods: ["c", "r", "u"],
  //         },
  //         {
  //           role: "guest",
  //           methods: ["c"],
  //         },
  //         {
  //           role: "admin",
  //           methods: ["d", "u"],
  //         },
  //       ],
  //     },
  //   ],
  // });
  const DATA = await db.get("database");
  console.log(JSON.stringify(DATA, null, 4));
} catch (er) {
  console.log(er);
}
