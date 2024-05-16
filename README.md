[![Inibase banner](./.github/assets/banner.jpg)](https://github.com/inicontent/inibase)

# Inibase :pencil:

[![npmjs](https://img.shields.io/npm/dm/inibase.svg?style=flat)](https://www.npmjs.org/package/inibase) [![License](https://img.shields.io/github/license/inicontent/inibase.svg?style=flat&colorA=18181B&colorB=28CF8D)](./LICENSE) [![Activity](https://img.shields.io/github/commit-activity/m/inicontent/inibase)](https://github.com/inicontent/inibase/pulse) [![GitHub stars](https://img.shields.io/github/stars/inicontent/inibase?style=social)](https://github.com/inicontent/inibase)

> A file-based & memory-efficient, serverless, ACID compliant, relational database management system :fire:

## Features

- **Lightweight** 🪶
- **Minimalist** :white_circle: (but powerful)
- **100% TypeScript** :large_blue_diamond:
- **Super-Fast** :zap: (built-in caching system)
- **ATOMIC** :lock: File lock for writing
- **Built-in form-validation** included :sunglasses:
- **Suitable for large data** :page_with_curl: (tested with 4M records)
- **Support Compression** :eight_spoked_asterisk: (using built-in nodejs zlib)
- **Support Table Joins** :link:
- **Low memory-usage** :chart_with_downwards_trend: (3-5mb)
- **Safe** :lock: (no sql or javascript injections)
- **Easy to use** :bread:
- **...** and much more :rocket:

## Usage

```js
import Inibase from "inibase";
const db = new Inibase("databaseName");

// Get all items from "user" table
const users = await db.get("user");

// Read page 2 content
const users = await db.get("user", undefined, { page: 2, per_page: 15 });

// Get only required columns to improve speed
const users = await db.get("user", undefined, {
  columns: ["username", "address.street", "hobbies.name"],
});

// Get items from "user" table where "favoriteFoods" does not includes "Pizza" or "Burger"
const users = await db.get("user", { favoriteFoods: "![]Pizza,Burger" });
```
> [!NOTE]
> Enjoy using Inibase? Consider sponsoring us via [PayPal](https://paypal.me/KarimAmahtil) <br>
> Your support helps us maintain and improve our services. <br>
> Thank you! 🫰

## Install

```js
<npm|pnpm|yarn> install inibase
```

## How it works?

`Inibase` organizes data into databases, tables, and columns, each stored in separate files. 

- **POST**: New data is appended to column files efficiently.
- **GET**: Data retrieval is optimized by reading files line-by-line.
- **PUT**: Updates are streamlined, with only the relevant file being modified.
- **DELETE**: Removes lines from column files for swift deletion.

This structure ensures efficient storage, retrieval, and updates, making our system scalable and high-performing for diverse datasets and applications.

## Config (.env)

The `.env` file supports the following parameters

```ini
# Don't add this line, it's an auto generated secret key, will be using for encrypting the IDs
INIBASE_SECRET=

INIBASE_COMPRESSION=false
INIBASE_CACHE=false

# Prepend new items to the beginning of file
INIBASE_REVERSE=false
```

## Benchmark

### Bulk

|        | 10              | 100             | 1000            |
|--------|-----------------|-----------------|-----------------|
| POST   | 11 ms (0.65 mb) | 19 ms (1.00 mb) | 85 ms (4.58 mb) |
| GET    | 14 ms (2.77 mb) | 12 ms (3.16 mb) | 34 ms (1.38 mb) |
| PUT    | 6 ms (1.11 mb)  | 5 ms (1.37 mb)  | 10 ms (1.12 mb) |
| DELETE | 17 ms (1.68 mb) | 14 ms (5.45 mb) | 25 ms (5.94 mb) |

### Single

|        | 10                | 100                | 1000               |
|--------|-------------------|--------------------|--------------------|
| POST   | 43 ms (4.70 mb)   | 387 ms (6.36 mb)   | 5341 ms (24.73 mb) |
| GET    | 99 ms (12.51 mb)  | 846 ms (30.68 mb)  | 7103 ms (30.86 mb) |
| PUT    | 33 ms (10.29 mb)  | 312 ms (11.06 mb)  | 3539 ms (14.87 mb) |
| DELETE | 134 ms (13.50 mb) | 1224 ms (16.57 mb) | 7339 ms (11.46 mb) |

> Testing by default with `user` table, with username, email, password fields _so results include password encryption process_
> To run benchmarks, install *typescript* & *tsx* globally and run `benchmark` `benchmark:bulk` `benchmark:single`

## Inibase CLI

```shell
npx inibase -p <databaseFolderPath>
```

<blockquote>
<details>
<summary>GET</summary>

```shell 
get <tableName> -w <ID|LineNumber|Criteria> -p <pageNumber> -l <perPage> -c <columnName1>  -c <columnName2>
```
</details>

<details>
<summary>POST</summary>

```shell 
post <tableName> -d <InisonStrigifedData>
```
</details>

<details>
<summary>PUT</summary>

```shell 
put <tableName> -d <InisonStrigifedData> -w <ID|LineNumber|Criteria>
```
</details>

<details>
<summary>DELETE</summary>

```shell 
delete <tableName> -w <ID|LineNumber|Criteria>
```
</details>
</blockquote>

## Examples

<details>
<summary>Schema</summary>
<blockquote>

<details>
<summary>Create Schema</summary>
<blockquote>

<details>
<summary>Using schema.json file</summary>
<blockquote>
Inside the table folder

1. Create empty folders `.cache` `.tmp`
2. Create `schema.json` file

```jsonc
[
  {
    // Give a unique ID number for each field
    "id": 1,
    "key": "username",
    "type": "string"
  },
  {
    "id": 2,
    "key": "email",
    "type": "email"
  },
]
```
</blockquote>
</details>

<details>
<summary>Using built-in function</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

const userSchema = [
  {
    key: "username",
    type: "string",
    required: true,
  },
  {
    key: "email",
    type: "string",
    required: true,
  },
  {
    key: "age",
    type: "number",
    required: true,
  },
  {
    key: "isActive",
    type: "boolean",
    // required: false
  },
  {
    key: "hobbies",
    type: "array",
    children: [
      {
        key: "name",
        type: "string",
        // required: false
      },
      {
        key: "level",
        type: "string",
        // required: false
      },
    ],
  },
  {
    key: "favoriteFoods",
    type: "array",
    children: "string",
    // required: false
  },
  {
    key: "address",
    type: "object",
    children: [
      {
        key: "street",
        type: "string",
        // required: false
      },
      {
        key: "city",
        type: "string",
        // required: false
      },
      {
        key: "country",
        type: "string",
        // required: false
      },
    ],
  },
];

await db.setTableSchema("user", userSchema);
```
</blockquote>
</details>

</blockquote>
</details>

<details>
<summary>Add field</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

const userSchema = await db.getTableSchema("user");
const newUserSchema = [...userSchema, {key: "phone2", type: "number", required: false}];

await db.setTableSchema("user", newUserSchema);
```
</blockquote>
</details>

<details>
<summary>Update field</summary>
<blockquote>

```js
import Inibase from "inibase";
import { setField } from "inibase/utils";

const db = new Inibase("/databaseName");

const userSchema = await db.getTableSchema("user");
setField("username", userSchema, {key: "full_name"});
await db.setTableSchema("user", newUserSchema);
```
</blockquote>
</details>

<details>
<summary>Join Tables</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

const productSchema = [
  {
    key: "title",
    type: "string",
    required: true,
  },
  {
    key: "price",
    type: "number",
  },
  {
    key: "createdBy",
    type: "table",
    table: "user",
    required: true,
  },
];

await db.setTableSchema("product", productSchema);

const productData = [
  {
    title: "Product 1",
    price: 16,
    createdBy: "1d88385d4b1581f8fb059334dec30f4c",
  },
  {
    title: "Product 2",
    price: 10,
    createdBy: "5011c230aa44481bf7e8dcfe0710474f",
  },
];

const product = await db.post("product", productData);
// [
//   {
//     "id": "1d88385d4b1581f8fb059334dec30f4c",
//     "title": "Product 1",
//     "price": 16,
//     "createdBy": {
//       "id": "1d88385d4b1581f8fb059334dec30f4c",
//       "username": "user1",
//       "email": "user1@example.com",
//       ...
//     }
//   },
//   {
//     "id": "5011c230aa44481bf7e8dcfe0710474f",
//     "title": "Product 2",
//     "price": 10,
//     "createdBy": {
//       "id": "5011c230aa44481bf7e8dcfe0710474f",
//       "username": "user2",
//       ...
//     }
//   }
// ]
```
</blockquote>
</details>

</blockquote>
</details>

<details>
<summary>POST</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

const userData = [
  {
    username: "user1",
    email: "user1@example.com",
    age: 25,
    isActive: true,
    hobbies: [
      { name: "Reading", level: "Intermediate" },
      { name: "Cooking", level: "Beginner" },
    ],
    favoriteFoods: ["Pizza", "Sushi", "Chocolate"],
    address: {
      street: "123 Main St",
      city: "Exampleville",
      country: "Sampleland",
    },
  },
  {
    username: "user2",
    email: "user2@example.com",
    age: 30,
    isActive: false,
    hobbies: [
      { name: "Gardening", level: "Advanced" },
      { name: "Photography", level: "Intermediate" },
    ],
    favoriteFoods: ["Burgers", null, "Salad"],
    address: {
      street: "456 Elm Rd",
      city: "Testington",
      country: "Demo Country",
    },
  },
];

const users = await db.post("user", userData);
// [
//   {
//     "id": "1d88385d4b1581f8fb059334dec30f4c",
//     "username": "user1",
//     "email": "user1@example.com",
//     "age": 25,
//     "isActive": true,
//     "hobbies": {
//       "name": [
//         "Reading",
//         "Cooking"
//       ],
//       "level": [
//         "Intermediate",
//         "Beginner"
//       ]
//     },
//     "favoriteFoods": [
//       "Pizza",
//       "Sushi",
//       "Chocolate"
//     ],
//     "address": {
//       "street": "123 Main St",
//       "city": "Exampleville",
//       "country": "Sampleland"
//     }
//   },
//   {
//     "id": "5011c230aa44481bf7e8dcfe0710474f",
//     "username": "user2",
//     ...
//   },
//   ...
// ]
```

</blockquote>
</details>

<details>
<summary>GET</summary>
<blockquote>

<details>
<summary>GET by ID</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

const user = await db.get("user", "1d88385d4b1581f8fb059334dec30f4c");
// {
//     "id": "1d88385d4b1581f8fb059334dec30f4c",
//     "username": "user1",
//     "email": "user1@example.com",
//     "age": 25,
//     "isActive": true,
//     "hobbies": {
//         "name": [
//             "Reading",
//             "Cooking"
//         ],
//         "level": [
//             "Intermediate",
//             "Beginner"
//         ]
//     },
//     "favoriteFoods": [
//         "Pizza",
//         "Sushi",
//         "Chocolate"
//     ],
//     "address": {
//         "street": "123 Main St",
//         "city": "Exampleville",
//         "country": "Sampleland"
//     }
// }
```
</blockquote>
</details>

<details>
<summary>GET by criteria</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

const users = await db.get("user", { favoriteFoods: "[]Pizza" });
// [
//   {
//     "id": "1d88385d4b1581f8fb059334dec30f4c",
//     "username": "user1",
//     "email": "user1@example.com",
//     "age": 25,
//     "isActive": true,
//     "hobbies": {
//       "name": [
//         "Reading",
//         "Cooking"
//       ],
//       "level": [
//         "Intermediate",
//         "Beginner"
//       ]
//     },
//     "favoriteFoods": [
//       "Pizza",
//       "Sushi",
//       "Chocolate"
//     ],
//     "address": {
//       "street": "123 Main St",
//       "city": "Exampleville",
//       "country": "Sampleland"
//     }
//   },
//   ...
// ]
```
</blockquote>
</details>

<details>
<summary>GET with columns</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

// Get all "user" columns except "username" & "address.street"
const users = await db.get("user", undefined, {
  columns: ["!username", "!address.street"],
});
```
</blockquote>
</details>

</blockquote>
</details>

<details>
<summary>PUT</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

// set "isActive" to "false" for all items in table "user"
await db.put("user", { isActive: false });

// set "isActive" to "true" for specific "user" by id
await db.put("user", { isActive: false }, "1d88385d4b1581f8fb059334dec30f4c");

// set "isActive" to "true" in table "user" by criteria (where "isActive" is equal to "true")
await db.put("user", { isActive: false }, { isActive: true });
```
</blockquote>
</details>

<details>
<summary>DELETE</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

// delete all items in "user" table
await db.delete("user");

// delete a specific "user" by id
await db.put("user", "1d88385d4b1581f8fb059334dec30f4c");

// delete "user" by criteria (where "isActive" is equal to "false")
await db.put("user", { isActive: false });
```
</blockquote>
</details>

<details>
<summary>SUM</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

// get the sum of column "age" in "user" table
await db.sum("user", "age");

// get the sum of column "age" by criteria (where "isActive" is equal to "false") in "user" table
await db.sum("user", ["age", ...], { isActive: false });
```
</blockquote>
</details>

<details>
<summary>MAX</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

// get the biggest number of column "age" in "user" table
await db.max("user", "age");

// get the biggest number of column "age" by criteria (where "isActive" is equal to "false") in "user" table
await db.max("user", ["age", ...], { isActive: false });
```
</blockquote>
</details>

<details>
<summary>MIN</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

// get the smallest number of column "age" in "user" table
await db.min("user", "age");

// get the smallest number of column "age" by criteria (where "isActive" is equal to "false") in "user" table
await db.min("user", ["age", ...], { isActive: false });
```
</blockquote>
</details>

<details>
<summary>SORT</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

// order users by the age column
await db.sort("user", "age");

// order users by the age and username columns
await db.sort("user", ["age","username"]);
await db.sort("user", {age: -1, username: "asc"});
```
</blockquote>
</details>

## Roadmap

- [x] Actions:
  - [x] GET:
    - [x] Pagination
    - [x] Criteria
    - [x] Columns
    - [x] Sort (using UNIX commands)
  - [x] POST
  - [x] PUT
  - [x] DELETE
  - [x] SUM
  - [x] MAX
  - [x] MIN
- [ ] Schema supported types:
  - [x] String
  - [x] Number
  - [x] Boolean
  - [x] Date
  - [x] Email
  - [x] Url
  - [x] Table
  - [x] Object
  - [x] Array
  - [x] Password
  - [x] IP
  - [x] HTML
  - [x] Id
  - [x] JSON
- [ ] TO-DO:
  - [x] Improve caching
  - [ ] Commenting the code
  - [x] Add property "unique" for schema fields
  - [ ] Add Backup feature (generate a tar.gz)
  - [ ] Add Custom field validation property to schema (using RegEx?)
- [ ] Features:
  - [ ] Encryption
  - [x] Data Compression
  - [x] Caching System
  - [ ] Suggest [new feature +](https://github.com/inicontent/inibase/discussions/new?category=ideas)

## License

[MIT](./LICENSE)