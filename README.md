# Inibase :pencil:

> A file-based & memory-efficient, serverless, ACID compliant, relational database management system :fire:

[![Inibase banner](./.github/assets/banner.jpg)](https://github.com/inicontent/inibase)

[![npmjs](https://img.shields.io/npm/dm/inibase.svg?style=flat)](https://www.npmjs.org/package/inibase) [![License](https://img.shields.io/github/license/inicontent/inibase.svg?style=flat&colorA=18181B&colorB=28CF8D)](./LICENSE) [![Activity](https://img.shields.io/github/commit-activity/m/inicontent/inibase)](https://github.com/inicontent/inibase/pulse) [![GitHub stars](https://img.shields.io/github/stars/inicontent/inibase?style=social)](https://github.com/inicontent/inibase)

## Features

- **Lightweight** 🪶
- **Minimalist** :white_circle: (but powerful)
- **100% TypeScript** :large_blue_diamond:
- **Super-Fast** :zap: (built-in caching system)
- **ATOMIC** :lock: File lock for writing
- **Built-in** form validation (+unique values :new: ) :sunglasses:
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
<npm|pnpm|yarn|bun> install inibase
```

## How it works?

`Inibase` organizes data into databases, tables, and columns, each stored in separate files.

- **POST**: New data is appended to column files efficiently.
- **GET**: Data retrieval is optimized by reading files line-by-line.
- **PUT**: Updates are streamlined, with only the relevant file being modified.
- **DELETE**: Removes lines from column files for swift deletion.

This structure ensures efficient storage, retrieval, and updates, making our system scalable and high-performing for diverse datasets and applications.

## Inibase CLI

```shell
npx inibase -p <databaseFolderPath>
# by default it will diplay a list of available commands (or type 'help')
```

## Examples

<details>
<summary>Tables</summary>
<blockquote>

<details>
<summary>Config</summary>
<blockquote>

```ts
interface {
  compression: boolean;
  cache: boolean;
  prepend: boolean;
}
```

</blockquote>
</details>

<details>
<summary>Schema</summary>
<blockquote>

```ts
interface {
  id: number; // stored as a Number but displayed as a hashed ID
  key: string;
  required?: boolean;
  unique?: boolean;
  type: "string" | "number" | "boolean" | "date" | "email" | "url" | "password" | "html" | "ip" | "json" | "id";
}
interface Table {
  id: number;
  key: string;
  required?: boolean;
  type: "table";
  table: string;
}
interface Array {
  id: number;
  key: string;
  required?: boolean;
  type: "array";
  children: string|string[];
}
interface ObjectOrArrayOfObjects {
  id: number;
  key: string;
  required?: boolean;
  type: "object" | "array";
  children: Schema;
}
```

</blockquote>
</details>

<details>
<summary>Create Table</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

const userTableConfig = {
  compression: true,
  cache: true,
  prepend: false
}

const userTableSchema = [
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

await db.createTable("user", userTableSchema, userTableConfig);
```

</blockquote>
</details>

<details>
<summary>Update Table</summary>
<blockquote>
  
<details>
<summary>Change Name</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

// this will change table name also in joined tables
await db.updateTable("user", undefined, {name: "userV2"});
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

const userTableSchema = (await db.getTable("user")).schema;
setField("username", userTableSchema, {key: "fullName"});
await db.updateTable("user", newUserTableSchema);
```

</blockquote>
</details>

<details>
<summary>Remove field</summary>
<blockquote>

```js
import Inibase from "inibase";
import { unsetField } from "inibase/utils";

const db = new Inibase("/databaseName");

const userTableSchema = (await db.getTable("user")).schema;
unsetField("fullName", userTableSchema);
await db.updateTable("user", newUserTableSchema);
```

</blockquote>
</details>

</blockquote>
</details>

<details>
<summary>Join Tables</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

const productTableSchema = [
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

await db.createTable("product", productTableSchema);

const productTableData = [
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

const product = await db.post("product", productTableData);
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
<summary>Methods</summary>
<blockquote>

<details>
<summary>POST</summary>
<blockquote>

```js
import Inibase from "inibase";
const db = new Inibase("/databaseName");

const userTableData = [
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

const users = await db.post("user", userTableData);
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
await db.get("user", undefined, { sort: "age" });

// order users by the age and username columns
await db.get("user", undefined, { sort: ["age", "username"] });
await db.get("user", undefined, { sort: {age: -1, username: "asc"} });
```

</blockquote>
</details>

</blockquote>
</details>

## Benchmark

### Bulk

|        | 10                | 100               | 1000              |
|--------|-------------------|-------------------|-------------------|
| POST   | 11 ms (0.66 mb)   | 5 ms (1.02 mb)    | 24 ms (1.44 mb)   |
| GET    | 29 ms (2.86 mb)   | 24 ms (2.81 mb)   | 36 ms (0.89 mb)   |
| PUT    | 21 ms (2.68 mb)   | 16 ms (2.90 mb)   | 12 ms (0.63 mb)   |
| DELETE | 14 ms (0.82 mb)   | 13 ms (0.84 mb)   | 2 ms (0.17 mb)    |


### Single

|        | 10                  | 100                | 1000               |
|--------|---------------------|--------------------|--------------------|
| POST   | 45 ms (1.07 mb)     | 12 ms (0.52 mb)    | 11 ms (0.37 mb)    |
| GET    | 200 ms (2.15 mb)    | 192 ms (2.72 mb)   | 190 ms (2.31 mb)   |
| PUT    | 49 ms (3.22 mb)     | 17 ms (2.98 mb)    | 17 ms (3.06 mb)    |
| DELETE | 118 ms (0.59 mb)    | 113 ms (0.51 mb)   | 103 ms (3.14 mb)   |

> Default testing uses a table with username, email, and password fields, ensuring password encryption is included in the process<br>
> To run benchmarks, install _typescript_ & _[tsx](https://github.com/privatenumber/tsx)_ globally and run `benchmark` by default bulk, for single use `benchmark --single|-s`

## Roadmap

- [x] Actions:
  - [x] GET:
    - [x] Pagination
    - [x] Criteria
    - [x] Columns
    - [x] Sort
  - [x] POST
  - [x] PUT
  - [x] DELETE
  - [x] SUM
  - [x] MAX
  - [x] MIN
- [x] Schema supported types:
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
  - [ ] Ability to search in JSON fields
  - [ ] Re-check used exec functions
  - [ ] Use smart caching (based on N° of queries)
  - [ ] Commenting the code
  - [ ] Add Backup feature (generate a tar.gz)
  - [ ] Add Custom field validation property to schema (using RegEx?)
- [ ] Features:
  - [ ] Encryption
  - [x] Data Compression
  - [x] Caching System
  - [ ] Suggest [new feature +](https://github.com/inicontent/inibase/discussions/new?category=ideas)

## License

[MIT](./LICENSE)
