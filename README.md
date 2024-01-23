[![Inibase banner](./.github/assets/banner.jpg)](https://github.com/inicontent/inibase)

# Inibase :pencil:

[![npmjs](https://img.shields.io/npm/dm/inibase.svg?style=flat)](https://www.npmjs.org/package/inibase) [![License](https://img.shields.io/github/license/inicontent/inibase.svg?style=flat&colorA=18181B&colorB=28CF8D)](./LICENSE) [![Activity](https://img.shields.io/github/commit-activity/m/inicontent/inibase)](https://github.com/inicontent/inibase/pulse) [![GitHub stars](https://img.shields.io/github/stars/inicontent/inibase?style=social)](https://github.com/inicontent/inibase)

> A file-based & memory-efficient, serverless, ACID compliant, relational database management system :fire:

## Features

- **Lightweight** 🪶
- **Minimalist** :white_circle: (but powerful)
- **TypeScript** :large_blue_diamond:
- **Super-Fast** :zap: (built-in caching system)
- **Built-in form-validation** included :sunglasses:
- **Suitable for large data** :page_with_curl: (tested with 200K row)
- **Support Compression** :eight_spoked_asterisk: (using built-in nodejs zlib)
- **Support Table Joins** :link:
- **Low memory-usage** :chart_with_downwards_trend: (3-5mb)
- **Safe** :lock: (no sql or javascript injections)
- **Easy to use** :bread:
- **...** and much more :rocket:

## Usage

```js
import Inibase from "inibase";
const db = new Inibase("database_name");

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

If you like Inibase, please sponsor: [GitHub Sponsors](https://github.com/sponsors/inicontent) || [Paypal](https://paypal.me/KarimAmahtil).

## Install

```js
<npm|pnpm|yarn> install inibase
```

## How it works?

To simplify the idea, each database has tables, each table has columns, each column will be stored in a seperated file. When **POST**ing new data, it will be appended to the _head_ of each file as new line. When **GET**ing data, the file will be readed line-by-line so it can handle large data (without consuming a lot of resources), when **PUT**ing(updating) in a specific column, only one file will be opened and updated

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

Ps: Testing by default with `user` table, with username, email, password fields _so results include password encryption process_


## Roadmap

- [x] Actions:
  - [x] GET:
    - [x] Pagination
    - [x] Criteria
    - [x] Columns
    - [ ] Order By
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
  - [x] Commenting the code
- [ ] Features:
  - [ ] Encryption
  - [x] Data Compression
  - [x] Caching System
  - [ ] Suggest [new feature +](https://github.com/inicontent/inibase/discussions/new?category=ideas)


## Examples

<details>
<summary>POST</summary>

```js
import Inibase from "inibase";
const db = new Inibase("/database_name");

const user_schema = [
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

const user_data = [
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

const users = await db.post("user", user_data);
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

Link two tables: "product" with "user"

```js
import Inibase from "inibase";
const db = new Inibase("/database_name");

const product_schema = [
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
    key: "user",
    type: "table",
    required: true,
  },
];

const product_data = [
  {
    title: "Product 1",
    price: 16,
    user: "1d88385d4b1581f8fb059334dec30f4c",
  },
  {
    title: "Product 2",
    price: 10,
    user: "5011c230aa44481bf7e8dcfe0710474f",
  },
];

const product = await db.post("product", product_data);
// [
//   {
//     "id": "1d88385d4b1581f8fb059334dec30f4c",
//     "title": "Product 1",
//     "price": 16,
//     "user": {
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
//     "user": {
//       "id": "5011c230aa44481bf7e8dcfe0710474f",
//       "username": "user2",
//       ...
//     }
//   }
// ]
```

</details>

<details>
<summary>GET</summary>

```js
import Inibase from "inibase";
const db = new Inibase("/database_name");

// Get "user" by id
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

// Get "user" by Criteria: where "favoriteFoods" includes "Pizza"
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

// Get all "user" columns except "username" & "address.street"
const users = await db.get("user", undefined, {
  columns: ["!username", "!address.street"],
});
```

</details>

<details>
<summary>PUT</summary>

```js
import Inibase from "inibase";
const db = new Inibase("/database_name");

// set "isActive" to "false" for all items in table "user"
await db.put("user", { isActive: false });

// set "isActive" to "true" for specific "user" by id
await db.put("user", { isActive: false }, "1d88385d4b1581f8fb059334dec30f4c");

// set "isActive" to "true" in table "user" by criteria (where "isActive" is equal to "true")
await db.put("user", { isActive: false }, { isActive: true });
```

</details>

<details>
<summary>DELETE</summary>

```js
import Inibase from "inibase";
const db = new Inibase("/database_name");

// delete all items in "user" table
await db.delete("user");

// delete a specific "user" by id
await db.put("user", "1d88385d4b1581f8fb059334dec30f4c");

// delete "user" by criteria (where "isActive" is equal to "false")
await db.put("user", { isActive: false });
```

</details>

<details>
<summary>SUM</summary>

```js
import Inibase from "inibase";
const db = new Inibase("/database_name");

// get the sum of column "age" in "user" table
await db.sum("user", "age");

// get the sum of column "age" by criteria (where "isActive" is equal to "false") in "user" table
await db.sum("user", ["age", ...], { isActive: false });
```

</details>

<details>
<summary>MAX</summary>

```js
import Inibase from "inibase";
const db = new Inibase("/database_name");

// get the biggest number of column "age" in "user" table
await db.max("user", "age");

// get the biggest number of column "age" by criteria (where "isActive" is equal to "false") in "user" table
await db.max("user", ["age", ...], { isActive: false });
```

</details>

<details>
<summary>MIN</summary>

```js
import Inibase from "inibase";
const db = new Inibase("/database_name");

// get the smallest number of column "age" in "user" table
await db.min("user", "age");

// get the smallest number of column "age" by criteria (where "isActive" is equal to "false") in "user" table
await db.min("user", ["age", ...], { isActive: false });
```

</details>

<details>
<summary>createWorker</summary>

```js
import Inibase from "inibase";
const db = new Inibase("/database_name");

// POST 10,000 USER
await Promise.all(
  [...Array(10)]
    .map((x, i) => i)
    .map(
      (_index) =>
        db.createWorker("post", [
          "user",
          [...Array(1000)].map((_, i) => ({
            username: `username_${i + 1}`,
            email: `email_${i + 1}@test.com`,
            password: `password_${i + 1}`,
          })),
        ])
    )
)
```

</details>

## Config (.env)

The `.env` file supports the following parameters (make sure to run commands with flag --env-file=.env)

```ini
# Auto generated secret key, will be using for encrypting the IDs
INIBASE_SECRET=

INIBASE_COMPRESSION=true
INIBASE_CACHE=true

# Prepend new items to the beginning of file 
INIBASE_REVERSE=true
```

## License

[MIT](./LICENSE)
