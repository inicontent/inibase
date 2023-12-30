import { isExists } from "../src/file";
import Inibase from "../src/index";
import { rm } from "node:fs/promises";
import { Console } from "node:console";

const bulk = async () => {
  const logger = new Console({
      stdout: process.stdout,
      stderr: process.stderr,
    }),
    db = new Inibase("test");
  let startTime,
    startMemory,
    table: Record<string | number, string | number>[] = [];
  // Delete test folder
  if (await isExists("test")) await rm("test", { recursive: true });

  await db.setTableSchema("user", [
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
  ]);

  logger.group("Bulk");

  // BULK POST
  table[0] = {};
  table[0].METHOD = "POST";

  // BULK POST 10
  gc();
  startMemory = process.memoryUsage().heapUsed;
  startTime = Date.now();
  await db.post(
    "user",
    [...Array(10)].map((_, i) => ({
      username: `username_${i + 1}`,
      email: `email_${i + 1}@test.com`,
      password: `password_${i + 1}`,
    }))
  );

  table[0][10] = `${Date.now() - startTime} ms (${(
    (process.memoryUsage().heapUsed - startMemory) /
    (1024 * 1024)
  ).toFixed(2)} mb)`;

  // BULK POST 100
  gc();
  startMemory = process.memoryUsage().heapUsed;
  startTime = Date.now();
  await db.post(
    "user",
    [...Array(100)].map((_, i) => ({
      username: `username_${i + 1}`,
      email: `email_${i + 1}@test.com`,
      password: `password_${i + 1}`,
    }))
  );

  table[0][100] = `${Date.now() - startTime} ms (${(
    (process.memoryUsage().heapUsed - startMemory) /
    (1024 * 1024)
  ).toFixed(2)} mb)`;

  // BULK POST 1000
  gc();
  startMemory = process.memoryUsage().heapUsed;
  startTime = Date.now();
  await db.post(
    "user",
    [...Array(1000)].map((_, i) => ({
      username: `username_${i + 1}`,
      email: `email_${i + 1}@test.com`,
      password: `password_${i + 1}`,
    }))
  );

  table[0][1000] = `${Date.now() - startTime} ms (${(
    (process.memoryUsage().heapUsed - startMemory) /
    (1024 * 1024)
  ).toFixed(2)} mb)`;

  // BULK GET
  table[1] = {};
  table[1].METHOD = "GET";

  // BULK GET 10
  gc();
  startMemory = process.memoryUsage().heapUsed;
  startTime = Date.now();
  await db.get(
    "user",
    [...Array(10)].map((_, i) => i + 1)
  );

  table[1][10] = `${Date.now() - startTime} ms (${(
    (process.memoryUsage().heapUsed - startMemory) /
    (1024 * 1024)
  ).toFixed(2)} mb)`;

  // BULK GET 100
  gc();
  startMemory = process.memoryUsage().heapUsed;
  startTime = Date.now();
  await db.get(
    "user",
    [...Array(100)].map((_, i) => i + 1)
  );

  table[1][100] = `${Date.now() - startTime} ms (${(
    (process.memoryUsage().heapUsed - startMemory) /
    (1024 * 1024)
  ).toFixed(2)} mb)`;

  // BULK GET 1000
  gc();
  startMemory = process.memoryUsage().heapUsed;
  startTime = Date.now();
  await db.get(
    "user",
    [...Array(1000)].map((_, i) => i + 1)
  );

  table[1][1000] = `${Date.now() - startTime} ms (${(
    (process.memoryUsage().heapUsed - startMemory) /
    (1024 * 1024)
  ).toFixed(2)} mb)`;

  // BULK PUT
  table[2] = {};
  table[2].METHOD = "PUT";

  // BULK PUT 10
  gc();
  startMemory = process.memoryUsage().heapUsed;
  startTime = Date.now();
  await db.put(
    "user",
    { username: "edited_username" },
    [...Array(10)].map((_, i) => i + 1)
  );

  table[2][10] = `${Date.now() - startTime} ms (${(
    (process.memoryUsage().heapUsed - startMemory) /
    (1024 * 1024)
  ).toFixed(2)} mb)`;

  // BULK PUT 100
  gc();
  startMemory = process.memoryUsage().heapUsed;
  startTime = Date.now();
  await db.put(
    "user",
    { username: "edited_username" },
    [...Array(100)].map((_, i) => i + 1)
  );

  table[2][100] = `${Date.now() - startTime} ms (${(
    (process.memoryUsage().heapUsed - startMemory) /
    (1024 * 1024)
  ).toFixed(2)} mb)`;

  // BULK PUT 1000
  gc();
  startMemory = process.memoryUsage().heapUsed;
  startTime = Date.now();
  await db.put(
    "user",
    { username: "edited_username" },
    [...Array(1000)].map((_, i) => i + 1)
  );

  table[2][1000] = `${Date.now() - startTime} ms (${(
    (process.memoryUsage().heapUsed - startMemory) /
    (1024 * 1024)
  ).toFixed(2)} mb)`;

  // BULK DELETE
  table[3] = {};
  table[3].METHOD = "DELETE";

  // BULK DELETE 10
  gc();
  startMemory = process.memoryUsage().heapUsed;
  startTime = Date.now();
  await db.delete(
    "user",
    [...Array(10)].map((_, i) => i + 1)
  );

  table[3][10] = `${Date.now() - startTime} ms (${(
    (process.memoryUsage().heapUsed - startMemory) /
    (1024 * 1024)
  ).toFixed(2)} mb)`;

  // BULK DELETE 100
  gc();
  startMemory = process.memoryUsage().heapUsed;
  startTime = Date.now();
  await db.delete(
    "user",
    [...Array(100)].map((_, i) => i + 1)
  );

  table[3][100] = `${Date.now() - startTime} ms (${(
    (process.memoryUsage().heapUsed - startMemory) /
    (1024 * 1024)
  ).toFixed(2)} mb)`;

  // BULK DELETE 1000
  gc();
  startMemory = process.memoryUsage().heapUsed;
  startTime = Date.now();
  await db.delete(
    "user",
    [...Array(1000)].map((_, i) => i + 1)
  );

  table[3][1000] = `${Date.now() - startTime} ms (${(
    (process.memoryUsage().heapUsed - startMemory) /
    (1024 * 1024)
  ).toFixed(2)} mb)`;

  logger.table(
    table.reduce((arr, { METHOD, ...x }) => {
      arr[METHOD] = x as any;
      return arr;
    }, {})
  );
  logger.groupEnd();
};
bulk();
