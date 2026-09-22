# Inibase :pencil:

> A file-based & memory-efficient, serverless relational database with **crash-atomic ACID: single-table DML + multi-table transactions** :fire: — per-table writer locks, write-ahead journal + crash recovery, fsync-backed durability, and a `begin`/`commit`/`rollback` transaction API (exact scope in [Durability & crash safety](#durability--crash-safety)).

[![Inibase banner](./.github/assets/banner.jpg)](https://github.com/inicontent/inibase)

[![npmjs](https://img.shields.io/npm/dm/inibase.svg?style=flat)](https://www.npmjs.org/package/inibase) [![License](https://img.shields.io/github/license/inicontent/inibase.svg?style=flat&colorA=18181B&colorB=28CF8D)](./LICENSE) [![Activity](https://img.shields.io/github/commit-activity/m/inicontent/inibase)](https://github.com/inicontent/inibase/pulse) [![GitHub stars](https://img.shields.io/github/stars/inicontent/inibase?style=social)](https://github.com/inicontent/inibase)

## Features

- **Lightweight** 🪶
- **Minimalist** :white_circle: (but powerful)
- **100% TypeScript** :large_blue_diamond:
- **Super-Fast** :zap: (built-in caching system)
- **ATOMIC** :lock: Per-table writer locks, write-ahead journal + crash recovery, fsync-backed durability, and multi-table transactions (`begin`/`commit`/`rollback`) for atomic cascades (exact scope below)
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
// const db = new Inibase("databaseName", ".", "es");
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

> [!WARNING]
> If you're using **Windows**, the following Unix commands are required: `zcat`, `sed`, `gzip`, and `echo`.
>  
> To use the missing commands, you need to install additional tools:
> - **[GnuWin32](http://gnuwin32.sourceforge.net/)**: Provides individual GNU utilities for Windows.  
> - **[Cygwin](https://www.cygwin.com/)**: Offers a full Unix-like environment for Windows.  
>  
> Alternatively, consider using the **Windows Subsystem for Linux (WSL)** to run a Linux environment on Windows. Learn more [here](https://learn.microsoft.com/en-us/windows/wsl/).

## How it works?

`Inibase` organizes data into databases, tables, and columns, each stored in separate files.

- **POST**: New data is appended to column files efficiently.
- **GET**: Data retrieval is optimized by reading files line-by-line.
- **PUT**: Updates are streamlined, with only the relevant file being modified.
- **DELETE**: Removes lines from column files for swift deletion.

This structure ensures efficient storage, retrieval, and updates, making our system scalable and high-performing for diverse datasets and applications.

## Durability & crash safety

> [!IMPORTANT]
> **DML (post / put / delete / truncate) is crash-atomic per table.** A logical
> operation spans many column files plus a pagination-metadata file; all of
> those files are committed as one journaled unit, so a table is never observed
> half-applied. **Multi-table atomicity** is available explicitly through the
> transaction API (`begin` / `commit` / `rollback`, see below) — cascade
> deletes and multi-table writes are atomic *inside* a transaction, and
> best-effort without one.

### How each property is provided

| Property | Mechanism |
|---|---|
| **A**tomicity | Write-ahead journal: one journal per table (`.tmp/journal.jsonl`) for single-table DML, plus a database journal (`<db>/.tmp/journal.jsonl`) that transactions append `op` entries to. Intent is fsynced *before* any live file changes; a `commit` marker is fsynced after publication. On crash: no commit marker → roll back (restore backups), commit present → roll forward (complete swaps, discard backups). Recovery runs automatically under the lock before any mutation/read. |
| **C**onsistency | Schema validation + uniqueness enforcement happen before anything is written; every operation is atomic, so a table is never observed half-applied. |
| **I**solation | **One writer lock per table** serializes every mutation (single-host and multi-host / NFS); a transaction holds the writer lock of every table it touches for its whole lifetime, plus a database lock to serialize transactions. Reads are **lock-free** with optimistic version-retry: each read snapshots the identity of every column + pagination file, and is re-run if anything changed mid-scan — a reader never sees torn rows. |
| **D**urability | Durability knob `INIBASE_DURABILITY=full` (default) fsyncs the temp file, the journal (begin/commit), and the affected directories (incl. shell `sed`/`gzip` temp paths and stream pipelines). DDL (create/update table, compression & prepend toggles) is fsynced too. `INIBASE_DURABILITY=none` skips **every** fsync while keeping the exact journal protocol — the data is process-crash safe (a crash leaves an in-flight journal that recovery rolls back or forward) but **not** power-loss safe, because the OS page cache can be lost. |

**Commit-point ordering:** the pagination metadata rename happens *first* (the atomic publication point — the row count flips in a single rename that lock-free readers observe), then column files are swapped `live → backup` + `tmp → live`.

### Transactions (multi-table atomicity)

```js
await db.begin(["orders", "invoices"]); // pre-lock tables in sorted order (deadlock-free)
try {
  await db.post("orders", order);
  await db.post("invoices", invoice);
  await db.commit(); // publish everything crash-atomically
} catch {
  await db.rollback(); // discard everything; no live file was touched
}
```

- **Semantics:** mutations issued inside a transaction are *staged* — their
  temps are fsynced and an `op` entry appended to the database journal — but no
  live file changes until `commit()`. `commit()` publishes every staged
  mutation (per table: pagination rename first, then column swaps) and ends
  with a single fsynced `commit` marker, making the whole set atomic with
  respect to crashes and process kills. `rollback()` removes the temps and the
  journal without touching any live file.
- **Cascade:** a `delete` inside a transaction cascades into referencing tables
  *through the same journal*, so the whole parent + children removal is atomic;
  a failure during the cascade aborts the transaction.
- **Rules & limits (v1):**
  - **No read-your-writes:** reads inside a transaction observe the last
    committed state, not staged writes.
  - **One mutation per table per transaction.** A second post/put/delete on a
    table already staged in the same transaction throws `INVALID_PARAMETERS`
    (composing same-table writes would require read-your-writes).
  - **DDL is not allowed inside a transaction** (`createTable` / `updateTable`
    throw `INVALID_PARAMETERS`).
  - `begin` without a table list locks tables on first touch, in first-touch
    order; list the tables up front to get sorted, cycle-free ordering.
  - `returnPostedData` inside a transaction returns the formatted staged rows
    (no joins); `returnUpdatedData` inside a transaction throws
    `INVALID_PARAMETERS`.
  - Transactions are excluded from structural lock-upgrade deadlocks, but two
    long transactions that touch overlapping tables can only deadlock in the
    first-touch-order case (pre-listing avoids it).

### Scope & caveats

- **Best-effort without a transaction.** Cross-table cascade deletes outside a
  transaction stay best-effort: referencing rows are removed *after* the
  primary delete commits, and a crash in between can leave orphaned references.
  Wrap them in `begin`/`commit` for atomicity.
- **NFS:** lock files use `O_EXCL` creation, which is advisory on some NFS
  servers — two hosts may briefly both believe they hold a lock. Locks store
  `{pid, host, startedAt}`: a same-host owner that is **provably dead**
  (`kill(pid, 0)` fails) is stolen immediately; foreign/unknown owners fall
  back to the TTL (`INIBASE_LOCK_TTL_MS`, default `60000`).
- **fsync guarantees:** durability assumes the OS/filesystem honours `fsync`.
  Some disks and virtualized filesystems silently ignore it; directory `fsync`
  is unsupported on a few platforms (best-effort there). `none` mode
  deliberately gives up power-loss durability — that is the whole point of the
  knob.
- **Cost:** at `full`, every mutation fsyncs the temp file, journal, and
  directories — expect noticeably slower hot-path writes than pre-durability
  builds (the benchmark compares `full` vs `none` side by side). The swap
  protocol also transiently holds temp + backup + live copies (~2–3× a
  column's size; worst case is a `put` with no `where` — a full-table rewrite).
- **Cache (`.cache`):** entries are derived, rebuildable artifacts versioned by
  the row count; they detect staleness but never participate in the ACID
  guarantee. Non-fsync'd.

Run `pnpm test:durability` for the journal-recovery, multi-process writer,
live-reader and stale-lock test suite, `pnpm test:transaction` for the
transaction/cascade/crash-recovery suite, and `pnpm benchmark:durability` for
the `full` vs `none` throughput comparison.

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
  decodeID: boolean;
}
```

</blockquote>
</details>

<details>
<summary>Schema</summary>
<blockquote>

<details>
<summary>Types</summary>
<blockquote>

```ts
interface Field {
  id: number; // stored as a Number but displayed as a hashed ID
  key: string;
  required?: boolean;
  unique?: boolean | string; // boolean for simple uniqueness, string for grouped uniqueness
  regex?: RegExp; // Regular expression for custom validation
  type:
    | "string"
    | "number"
    | "boolean"
    | "date"
    | "email"
    | "url"
    | "password"
    | "html"
    | "ip"
    | "json"
    | "id";
}

interface TableField {
  id: number;
  key: string;
  required?: boolean;
  unique?: boolean | string; // Supports uniqueness constraints
  type: "table";
  table: string;
}

interface ArrayField {
  id: number;
  key: string;
  required?: boolean;
  unique?: boolean | string; // Supports uniqueness constraints
  type: "array";
  children: string | string[]; // Can be a single type or an array of types
}

interface ObjectOrArrayOfObjectsField {
  id: number;
  key: string;
  required?: boolean;
  unique?: boolean | string; // Supports uniqueness constraints
  regex?: RegExp; // For validation of object-level keys
  type: "object" | "array";
  children: Schema; // Nested schema for objects or arrays
}
```

</blockquote>
</details>

<details>
<summary>Unique</summary>
<blockquote>

The `unique` property ensures that the values of a specific column or a group of columns are unique within a table. This property can be either a boolean or a string.
- **Boolean**: Setting `unique: true` ensures that the values in the column are unique across all rows.
- **String**: By setting a string value, you can group columns to enforce a combined uniqueness constraint. This is useful when you need to ensure that a combination of values across multiple fields is unique.

<details>
<summary>Examples</summary>
<blockquote>

<details>
<summary>Unique Column</summary>
<blockquote>

```js
{
  key: "email",
  type: "string",
  required: true,
  unique: true, // Ensures all email values are unique
}
```

</blockquote>
</details>

<details>
<summary>Group of Unique Columns</summary>
<blockquote>

```js
[
  {
    key: "firstName",
    type: "string",
    required: true,
    unique: "nameGroup", // Part of "nameGroup" uniqueness
  },
  {
    key: "lastName",
    type: "string",
    required: true,
    unique: "nameGroup", // Part of "nameGroup" uniqueness
  },
]
```

</blockquote>
</details>

</blockquote>
</details>

</blockquote>
</details>

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
  prepend: false,
  decodeID: false
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

<details open>
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

// Columns accept dotted nested paths (e.g. "address.street" => nested field)
const nested = await db.get("user", undefined, {
  columns: ["address.street", "hobbies.name"],
});

// Get all columns explicitly with the "*" wildcard
const all = await db.get("user", undefined, {
  columns: ["*"],
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

<details>
<summary>Computed Fields</summary>
<blockquote>

A `computed` column is derived from other columns of the same row whenever the
row is written (`post` / `put`, including backfill on `updateTable`). The
result is stored in its own column file like any other value, so reads and
criteria queries work unchanged.

```ts
const db = new Inibase("/databaseName");

await db.createTable("product", [
	{ key: "name", type: "string" },
	{ key: "price", type: "number" },
]);

// ids are assigned per table in schema order: customer=1, status=2, items=3,
// product=4, quantity=5, unitPriceCents=6, totalCents=7, totalCentsLive=8
await db.createTable("orders", [
	{ key: "customer", type: "string" },
	{ key: "status", type: "number" },
	{
		key: "items",
		type: "array",
		children: [
			{ key: "product", type: "table", table: "product" },
			{ key: "quantity", type: "number" },
			{ key: "unitPriceCents", type: "number" },
		],
	},
	{ key: "totalCents", type: "number", computed: "sum(5 * 6)" }, // quantity x unitPriceCents
	{ key: "totalCentsLive", type: "number", computed: "sum(5 * 4.2)" }, // quantity x product.price
]);

const posted = await db.post(
	"orders",
	{
		customer: "acme",
		status: 1,
		items: [
			{ product: "id-of-widget", quantity: 2, unitPriceCents: 250 },
			{ product: "id-of-gadget", quantity: 1, unitPriceCents: 100 },
		],
	},
	undefined,
	true,
);
// posted.totalCents === 600      (2*250 + 1*100)
// posted.totalCentsLive === 847  (2*price(widget) + 1*price(gadget))
```

**Expression language (v1, integer-only).**

- Operators: `+` `-` `*` `/` `%`; `( )` for grouping. Multiplication
  binds tighter than addition (`1 * 2 + 3` = `(1*2) + 3`).
- Helpers: `sum` `count` `avg` `min` `max` iterate an array-of-objects found by
  the ids inside the parentheses (`sum(5 * 6)` = quantity x unit-price per item).
- Paths: `id ("." id)*` where `.` hops through a `table` link
  (`4.2` = price of the linked product row).
- Integers only: there are no decimal literals — `.` is the path separator, so
  `3.14` is a path (`field 3`, hop `field 14`), never 3.14. Fractional results
  are written as division: `314 / 100` → 3.14.
- A bare integer that matches a field id in the table's schema is that field
  (ids are locative); a bare integer that matches no field is a literal.

**Rules & limits (v1).**

- Computed fields cannot be `required`, `unique` or `regex` (a
  `COMPUTED_FIELD_CONFLICT` error).
- Computed values are never user-settable (`post`/`put` with a computed key
  throws `COMPUTED_FIELD_SETTABLE`).
- Values are evaluated at write time and persisted; compiled expressions are
  stored as `{ expr, ast }` in the schema. The AST carries only field ids, so
  renaming a column (or its linked table's columns) never retargets an
  expression.
- `updateTable` backfills existing rows when a computed field is added or its
  expression changes; a backfill that fails (missing dependency, arithmetic
  error, dangling link) aborts the migration and leaves the schema untouched.
- Aggregates: `sum` over no values is `0`, `count` is the element count, and
  `avg`/`min`/`max` over no values throw `COMPUTED_FIELD_ARITHMETIC`.
- Non-numeric operands, division/modulo by zero, and arithmetic over missing
  (null) values throw `COMPUTED_FIELD_ARITHMETIC`; a link to a missing row
  throws `COMPUTED_FIELD_DANGLING_LINK`.
- Only top-level schema fields can be computed in v1; array contents are
  reachable through helpers. Missing link values make a single bare path
  evaluate to null (stored empty).

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
> Results are measured on a default table plus dedicated tables with `prepend`, `compression`, and `decodeID` configs enabled<br>
> To run benchmarks, install _typescript_ & _[tsx](https://github.com/privatenumber/tsx)_ globally and run `benchmark` by default bulk, for single use `benchmark --single|-s`
>
> > [!WARNING]
> > The numbers above were measured **before** always-on fsync + write-ahead journaling landed (they no longer reflect current hot-path write costs). Run `pnpm benchmark:durability` for the crash-atomic numbers.

### Computed fields

Write-time evaluation cost (helpers `sum(3 * 4)`, `avg(4)`, `min(4)`, `max(4)`, `count(3)` over an `items` array with 3 lines, plus an arithmetic field `itemTotal × (314 / 100)`), compared against the identical table without computed fields:

| rows | POST bulk (plain / computed) | POST single (plain / computed) | PUT recompute (plain / computed) |
|------|------------------------------|--------------------------------|----------------------------------|
| 10   | 21.90 / 22.69 ms             | 25.24 / 26.80 ms               | 23.10 / 37.07 ms                 |
| 100  | 22.00 / 25.23 ms             | 25.24 / 26.80 ms               | 22.16 / 40.00 ms                 |
| 1000 | 28.79 / 35.15 ms             | 25.24 / 26.80 ms               | 21.01 / 45.05 ms                 |

> Min of 3 rounds (fsync + journal on); the plain-vs-computed delta is the pure expression-evaluation cost (~6 ms/1000 rows of helpers on POST, more on `PUT` because every matched row is recomputed). GET all (1110 rows): 11.44 / 15.90 ms — computed values are stored in real column files, so reads never evaluate; the gap is the larger column count to scan. Run `pnpm benchmark:computed` to reproduce.

**Link-heavy: shared product catalog with batched link-hop reads.** Every order's line items reference a shared 20-row catalog; `totalCentsLive = sum(quantity, product.price)` follows one link hop per line item. The engine batches the hops across the whole post: each batch resolves at most one read per **distinct** `(table, column, id)` triple (here: catalogSize=20 product rows) instead of one full row-level read per line item (2000 reads for 1000 orders × 2 items):

| rows | POST bulk (lk link hop) |
|------|-------------------------|
| 10   | 42.29 ms                |
| 100  | 47.76 ms                |
| 1000 | 59.46 ms                |

> Shared 20-row catalog (10/100/1000 orders × 2 line items). Without batching every line item re-reads its product row; with it each batch resolves ≤ catalogSize distinct linked rows once (deduplicated across every line item and every order of the batch) and re-evaluates against the warm in-memory cache. A dangling link anywhere in the batch still rejects the whole post (`COMPUTED_FIELD_DANGLING_LINK`). HTTP-request bound, not disk-bound: the cost scales with the number of *distinct* linked rows the catalog actually has, not with line-item count.

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
  - [x] Use new Map() instead of Object
  - [ ] Ability to search in JSON fields
  - [x] Re-check used exec functions
  - [ ] Use smart caching (based on N° of queries)
  - [ ] Commenting the code
  - [ ] Add Backup feature (generate a tar.gz)
  - [x] Add Custom field validation property to schema (using RegEx?)
- [ ] Features:
  - [ ] Encryption
  - [x] Data Compression
  - [x] Caching System
  - [x] Computed fields (v1 id-only expression language)
  - [ ] Suggest [new feature +](https://github.com/inicontent/inibase/discussions/new?category=ideas)

## License

[MIT](./LICENSE)
