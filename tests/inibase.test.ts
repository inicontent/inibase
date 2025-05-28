import { strict as assert } from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { test } from "node:test";

import Inibase, { type Schema } from "../src/index.js";
import { encodeID } from "../src/utils.server.js";

// Test database directory
const dbPath = "test-db";
let inibase: Inibase;

function removeDatabase() {
	if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
}

function initializeDatabase() {
	removeDatabase();
	inibase = new Inibase(dbPath);
}

await test("Initialize Inibase", async (t) => {
	initializeDatabase();
	assert.ok(inibase, "Inibase instance should be initialized");
});

await test("Basic Table Operations", async (t) => {
	const tableName = "users";
	const tableSchema: Schema = [
		{ key: "name", type: "string", required: true },
		{ key: "age", type: "number", required: true },
	];
	const testData = { name: "John Doe", age: 30 };

	await t.test("Create Table", async () => {
		await inibase.createTable(tableName, tableSchema);
		assert.ok(true, "Table created successfully");
	});

	await t.test("Insert Data", async () => {
		const insertedData = await inibase.post(
			tableName,
			testData,
			undefined,
			true,
		);

		assert.equal(
			typeof insertedData?.id,
			"string",
			"Inserted data ID should be a string",
		);
		assert.deepEqual(
			insertedData,
			{ id: insertedData?.id, createdAt: insertedData?.createdAt, ...testData },
			"Data should match",
		);
	});

	await t.test("Retrieve Data", async () => {
		const retrievedData = await inibase.get(tableName);
		assert.equal(retrievedData?.length, 1, "Should retrieve one record");
	});

	await t.test("Update Data", async () => {
		await inibase.put(
			tableName,
			{ name: "John Doe", age: 31 },
			{ name: "John Doe" },
		);
		const updatedData = await inibase.get(tableName);
		assert.deepEqual(updatedData?.[0].age, 31, "Data should be updated");
	});

	await t.test("Delete Data", async () => {
		await inibase.delete(tableName, { name: "John Doe" });
		const dataAfterDelete = await inibase.get(tableName);
		assert.equal(dataAfterDelete, null, "Table should be empty after deletion");
	});
});

await test("Complex Schema with Flexible Children Definitions", async (t) => {
	initializeDatabase();

	const tableName = "flexible_children";
	const tableSchema: Schema = [
		{ key: "name", type: "string", required: true },
		{
			key: "profile",
			type: "object",
			required: true,
			children: [
				{ key: "age", type: "number", required: true },
				{ key: "location", type: "string", required: false },
			],
		},
		{
			key: "tags",
			type: "array",
			required: false,
			children: "string", // Each element in the array must be a string
		},
		{
			key: "scores",
			type: "array",
			required: false,
			children: ["number", "string"], // Mixed types allowed
		},
		{
			key: "settings",
			type: "array",
			required: false,
			children: [
				{ key: "theme", type: "string", required: true },
				{ key: "enabled", type: "boolean", required: true },
			], // Each element in the array must match this schema
		},
	];
	const validData = [
		{
			name: "Alice",
			profile: { age: 25, location: "NYC" },
			tags: ["developer", "engineer"],
			scores: [95, "excellent"],
			settings: [{ theme: "dark", enabled: true }],
		},
		{
			name: "Bob",
			profile: { age: 30 },
			tags: ["designer"],
			scores: [89],
			settings: [{ theme: "light", enabled: false }],
		},
	];

	const invalidData = {
		name: "Charlie",
		profile: { age: 40 },
		scores: [true], // Invalid type for scores
		settings: [{ theme: "minimal" }], // Missing required field in settings
	};

	await t.test("Create Table with Flexible Children", async () => {
		await inibase.createTable(tableName, tableSchema);
		assert.ok(true, "Table created successfully");
	});

	await t.test("Insert Valid Data", async () => {
		const insertedData = await inibase.post(
			tableName,
			validData,
			undefined,
			true,
		);
		assert.equal(
			insertedData?.length,
			2,
			"Should insert two records successfully",
		);
	});

	await t.test("Reject Invalid Data", async () => {
		await assert.rejects(
			inibase.post(tableName, invalidData, undefined, true),
			/INVALID_TYPE|FIELD_REQUIRED/,
			"Should reject invalid data",
		);
	});

	await t.test("Validate Array with Single Type Children", async () => {
		const tagsField = validData[0].tags;
		assert.ok(
			tagsField.every((tag) => typeof tag === "string"),
			"All tags should be strings",
		);
	});

	await t.test("Validate Array with Mixed Type Children", async () => {
		const scoresField = validData[0].scores;
		assert.ok(
			scoresField.every(
				(score) => typeof score === "number" || typeof score === "string",
			),
			"All scores should be numbers or strings",
		);
	});

	await t.test("Validate Array with Schema-Based Children", async () => {
		const settingsField = validData[0].settings;
		for (const setting of settingsField) {
			assert.equal(typeof setting.theme, "string", "Theme should be a string");
			assert.equal(
				typeof setting.enabled,
				"boolean",
				"Enabled should be a boolean",
			);
		}
	});

	await t.test("Delete All Records", async () => {
		await inibase.delete(tableName);
		const dataAfterDelete = await inibase.get(tableName);
		assert.equal(dataAfterDelete, null, "All records should be deleted");
	});
});

await test("Single Unique Field", async (t) => {
	initializeDatabase();

	const tableName = "unique_field_test";
	const tableSchema: Schema = [
		{ key: "email", type: "string", required: true, unique: true },
	];

	await t.test("Create Table with Unique Field", async () => {
		await inibase.createTable(tableName, tableSchema);
		assert.ok(true, "Table with unique field created successfully");
	});

	await t.test("Insert Unique Values", async () => {
		await inibase.post(tableName, { email: "test@example.com" });
		await inibase.post(tableName, { email: "unique@example.com" });
		assert.ok(true, "Inserted unique values successfully");
	});

	await t.test("Reject Duplicate Value", async () => {
		await assert.rejects(
			inibase.post(tableName, { email: "test@example.com" }),
			/FIELD_UNIQUE/,
			"Should reject duplicate unique field value",
		);
	});
});

await test("Group of Unique Fields", async (t) => {
	initializeDatabase();

	const tableName = "unique_group_test";
	const tableSchema: Schema = [
		{
			key: "firstName",
			type: "string",
			required: true,
			unique: "firstNameEmailGroup",
		},
		{ key: "lastName", type: "string", required: true, unique: true },
		{
			key: "email",
			type: "string",
			required: true,
			unique: "firstNameEmailGroup",
		},
	];

	await t.test("Create Table with Group Unique Fields", async () => {
		await inibase.createTable(tableName, tableSchema);
		assert.ok(true, "Table with group unique fields created successfully");
	});

	await t.test("Insert Unique Group Values", async () => {
		await inibase.post(tableName, {
			firstName: "John",
			lastName: "Doe",
			email: "john.doe@example.com",
		});
		await inibase.post(tableName, {
			firstName: "Jane",
			lastName: "Poe",
			email: "jane.doe@example.com",
		});
		await inibase.post(tableName, {
			firstName: "John",
			lastName: "Koe",
			email: "jane.doe@example.com",
		});
		assert.ok(true, "Inserted unique group values successfully");
	});

	await t.test("Reject Duplicate Group", async () => {
		await assert.rejects(
			inibase.post(tableName, {
				firstName: "John",
				lastName: "Noe",
				email: "john.doe@example.com",
			}),
			/GROUP_UNIQUE/,
			"Should reject duplicate unique group value",
		);
	});

	await t.test("Reject Duplicate Values", async () => {
		await assert.rejects(
			inibase.post(tableName, {
				firstName: "Vohn",
				lastName: "Doe",
				email: "vohn.doe@example.com",
			}),
			/FIELD_UNIQUE/,
			"Should reject duplicate unique value",
		);
	});
});

await test("Regex Validation", async (t) => {
	initializeDatabase();

	const tableName = "regex_field_test";
	const tableSchema: Schema = [
		{
			key: "username",
			type: "string",
			required: true,
			regex: "^[a-zA-Z0-9_]{3,16}$",
		},
	];

	await t.test("Create Table with Regex Validation", async () => {
		await inibase.createTable(tableName, tableSchema);
		assert.ok(true, "Table with regex validation created successfully");
	});

	await t.test("Insert Valid Data", async () => {
		await inibase.post(tableName, { username: "valid_user" });
		await inibase.post(tableName, { username: "anotherUser123" });
		assert.ok(true, "Inserted valid data successfully");
	});

	await t.test("Reject Invalid Data", async () => {
		await assert.rejects(
			inibase.post(tableName, { username: "invalid user" }),
			/INVALID_REGEX_MATCH/,
			"Should reject data that does not match the regex",
		);

		await assert.rejects(
			inibase.post(tableName, { username: "sh" }),
			/INVALID_REGEX_MATCH/,
			"Should reject data that is too short",
		);

		await assert.rejects(
			inibase.post(tableName, { username: "thisusernameiswaytoolong123" }),
			/INVALID_REGEX_MATCH/,
			"Should reject data that is too long",
		);
	});
});

await test("Compression Configuration", async (t) => {
	initializeDatabase();

	const tableName = "compression_test";
	const tableSchema: Schema = [{ key: "data", type: "string", required: true }];

	await t.test("Create Table with Compression Enabled", async () => {
		await inibase.createTable(tableName, tableSchema, { compression: true });
		assert.ok(true, "Table with compression enabled created successfully");
	});

	await t.test("Insert Data into Compressed Table", async () => {
		await inibase.post(tableName, { data: "This is some test data" });
		await inibase.post(tableName, { data: "Another piece of test data" });
		assert.ok(true, "Inserted data into compressed table successfully");
	});

	await t.test("Retrieve Data from Compressed Table", async () => {
		const data = await inibase.get(tableName);
		assert.equal(
			data?.length,
			2,
			"Should retrieve all records from compressed table",
		);
		assert.deepEqual(
			data.map((item) => item.data),
			["This is some test data", "Another piece of test data"],
			"Data retrieved should match inserted values",
		);
	});

	await t.test("Update Data in Compressed Table", async () => {
		await inibase.put(
			tableName,
			{ data: "Updated test data" },
			{ data: "This is some test data" },
		);
		const updatedData = await inibase.get(tableName);
		assert.ok(
			updatedData?.some((item) => item.data === "Updated test data"),
			"Updated data should exist in compressed table",
		);
	});

	await t.test("Delete Data from Compressed Table", async () => {
		await inibase.delete(tableName, { data: "Updated test data" });
		const remainingData = await inibase.get(tableName);
		assert.equal(
			remainingData?.length,
			1,
			"Should have one record left after deletion",
		);
		assert.equal(
			remainingData[0].data,
			"Another piece of test data",
			"Remaining data should match expected value",
		);
	});

	await t.test("Enable Compression for Existing Table", async () => {
		const existingTableName = "existing_table_test";
		await inibase.createTable(existingTableName, tableSchema);

		// Insert a large amount of data into the table
		await inibase.post(
			existingTableName,
			[...Array(1000)].map((_, i) => ({ data: `Test data ${i}` })),
		);

		// Enable compression for the existing table
		await inibase.updateTable(existingTableName, undefined, {
			compression: true,
		});

		// Validate that the data is still intact
		const allData = await inibase.get(existingTableName, undefined, {
			page: Math.round(1000 / 15),
		});

		assert.equal(
			inibase.pageInfo[existingTableName].total,
			1000,
			"All records should still exist after enabling compression",
		);
		assert.ok(
			allData?.some((item) => item.data === "Test data 999"),
			"Last record should exist after enabling compression",
		);
	});
});

await test("Prepend Configuration", async (t) => {
	initializeDatabase();

	const tableName = "prepend_test";
	const tableSchema: Schema = [{ key: "data", type: "string", required: true }];

	await t.test("Create Table with Prepend Enabled", async () => {
		await inibase.createTable(tableName, tableSchema, { prepend: true });
		assert.ok(true, "Table with prepend enabled created successfully");
	});

	await t.test("Insert Data into Prepend Table", async () => {
		await inibase.post(tableName, { data: "First piece of data" });
		await inibase.post(tableName, { data: "Second piece of data" });
		await inibase.post(tableName, { data: "Third piece of data" });
		assert.ok(true, "Inserted data into prepend table successfully");
	});

	await t.test("Validate Data Order in Prepend Table", async () => {
		const data = await inibase.get(tableName);
		assert.equal(
			data?.length,
			3,
			"Should retrieve all records from prepend table",
		);
		assert.deepEqual(
			data.map((item) => item.data),
			["Third piece of data", "Second piece of data", "First piece of data"],
			"Data should be in reversed order due to prepend configuration",
		);
	});

	await t.test("Update Data in Prepend Table", async () => {
		await inibase.put(
			tableName,
			{ data: "Updated piece of data" },
			{ data: "Second piece of data" },
		);
		const updatedData = await inibase.get(tableName);
		assert.ok(
			updatedData?.some((item) => item.data === "Updated piece of data"),
			"Updated data should exist in prepend table",
		);
	});

	await t.test("Delete Data from Prepend Table", async () => {
		await inibase.delete(tableName, { data: "Third piece of data" });
		const remainingData = await inibase.get(tableName);
		assert.equal(
			remainingData?.length,
			2,
			"Should have two records left after deletion",
		);
		assert.deepEqual(
			remainingData.map((item) => item.data),
			["Updated piece of data", "First piece of data"],
			"Remaining data order should still follow prepend configuration",
		);
	});
});

await test("Multiple Optional Recursive Arrays with Prepend Config", async (t) => {
	initializeDatabase();

	const tableName = "recursive_array_test";
	const tableSchema: Schema = [
		{
			key: "items",
			type: "array",
			required: false,
			children: [
				{
					key: "name",
					type: "string",
					required: false,
				},
				{
					key: "details",
					type: "array",
					required: false,
					children: [
						{
							key: "description",
							type: "string",
							required: false,
						},
						{
							key: "value",
							type: "number",
							required: false,
						},
					],
				},
			],
		},
	];

	await t.test("Create Table with Prepend Enabled", async () => {
		await inibase.createTable(tableName, tableSchema, { prepend: true });
		assert.ok(true, "Table with prepend enabled created successfully");
	});

	await t.test("Insert Data with All Fields Present", async () => {
		await inibase.post(tableName, {
			items: [
				{
					name: "Item 1",
					details: [
						{ description: "Detail 1", value: 10 },
						{ description: "Detail 12", value: 12 },
					],
				},
				{
					name: "Item 2",
					details: [{ description: "Detail 2", value: 20 }],
				},
			],
		});
		assert.ok(true, "Inserted data with all fields present successfully");
	});

	await t.test("Insert Data with Some Fields Missing", async () => {
		await inibase.post(tableName, {
			items: [
				{
					name: "Item 3",
					details: [
						{ description: "Detail 3" }, // Missing value
					],
				},
				{
					details: [
						{ value: 30 }, // Missing description
					],
				},
			],
		});
		assert.ok(true, "Inserted data with some fields missing successfully");
	});

	await t.test("Validate Data Order with Prepend Enabled", async () => {
		const data = await inibase.get(tableName);
		assert.equal(data?.length, 2, "Should retrieve all records from table");
		assert.deepEqual(
			data.map((record) => record.items.map((item) => item.name)),
			[
				["Item 3", undefined],
				["Item 1", "Item 2"],
			],
			"Data order should follow prepend configuration",
		);
	});

	await t.test("Switch Prepend Off and Insert More Data", async () => {
		await inibase.updateTable(tableName, undefined, { prepend: false });
		await inibase.post(tableName, [
			{
				items: [
					{
						name: "Item 4",
						details: [],
					},
				],
			},
			{
				items: [
					{
						name: "Item 5",
						details: [
							{ description: "Detail 5" }, // Missing value
							{ value: 50 }, // Missing description
						],
					},
				],
			},
		]);

		const data = await inibase.get(tableName);
		assert.equal(data?.length, 4, "Should retrieve all records from table");
		assert.deepEqual(
			data.map((record) => record.items.map((item) => item.name)),
			[["Item 1", "Item 2"], ["Item 3", undefined], ["Item 4"], ["Item 5"]],
			"Data order should respect updated prepend configuration",
		);
		assert.deepEqual(
			data.map((record) =>
				record.items.map((item) => item.details?.map((_item) => _item.value)),
			),
			[[[10, 12], [20]], [[undefined], [30]], [undefined], [[0, 50]]],
			"Data order should respect updated prepend configuration",
		);
		assert.deepEqual(
			data.map((record) =>
				record.items.map((item) =>
					item.details?.map((_item) => _item.description),
				),
			),
			[
				[["Detail 1", "Detail 12"], ["Detail 2"]],
				[["Detail 3"], [undefined]],
				[undefined],
				[["Detail 5", undefined]],
			],
			"Data order should respect updated prepend configuration",
		);
	});

	await t.test("Update Data Using Put Function", async () => {
		await inibase.put(
			tableName,
			{
				items: [
					{
						name: "Item 1 Updated",
						details: [
							{ description: "Detail 1 Updated", value: 100 },
							{ description: "Detail 12 Updated", value: 120 },
						],
					},
				],
			},
			{ "items.name": "Item 1" },
		);

		const updatedData = await inibase.get(tableName);

		assert.ok(
			updatedData?.some((record) =>
				record.items.some(
					(item) =>
						item.name === "Item 1 Updated" &&
						item.details?.some(
							(detail) =>
								detail.description === "Detail 1 Updated" &&
								detail.value === 100,
						) &&
						item.details?.some(
							(detail) =>
								detail.description === "Detail 12 Updated" &&
								detail.value === 120,
						),
				),
			),
			"Put function should update the specified record",
		);
	});
});

await test("Data Validation and Schema Enforcement", async (t) => {
	initializeDatabase();

	const tableName = "validation_test";
	const tableSchema: Schema = [
		{ key: "id", type: "string", required: true, unique: true },
		{ key: "count", type: "number", required: true },
		{
			key: "nested",
			type: "object",
			required: true,
			children: [
				{ key: "value", type: "string", required: true },
				{ key: "optionalValue", type: "number", required: false },
			],
		},
		{
			key: "list",
			type: "array",
			required: false,
			children: "string",
		},
	];

	await t.test("Create Table for Validation", async () => {
		await inibase.createTable(tableName, tableSchema);
		assert.ok(true, "Table for validation created successfully");
	});

	await t.test("Reject Data with Missing Required Field", async () => {
		await assert.rejects(
			inibase.post(tableName, { id: "test1" }), // Missing 'count' and 'nested'
			/FIELD_REQUIRED/,
			"Should reject data with missing required field 'count'",
		);
	});

	await t.test("Reject Data with Incorrect Data Type", async () => {
		await assert.rejects(
			inibase.post(tableName, {
				id: "test2",
				count: "not a number", // Incorrect type for 'count'
				nested: { value: "nestedValue" },
			}),
			/INVALID_TYPE/,
			"Should reject data with incorrect type for 'count'",
		);
	});

	await t.test(
		"Reject Data with Missing Required Field in Nested Object",
		async () => {
			await assert.rejects(
				inibase.post(tableName, {
					id: "test3",
					count: 10,
					nested: {}, // Missing 'value' in 'nested' object
				}),
				/FIELD_REQUIRED/,
				"Should reject data with missing required field 'value' in nested object",
			);
		},
	);

	await t.test(
		"Reject Data with Incorrect Data Type in Nested Object",
		async () => {
			await assert.rejects(
				inibase.post(tableName, {
					id: "test4",
					count: 20,
					nested: { value: 123 }, // Incorrect type for 'value' in 'nested'
				}),
				/INVALID_TYPE/,
				"Should reject data with incorrect type for 'value' in nested object",
			);
		},
	);

	await t.test("Reject Data with Incorrect Array Child Type", async () => {
		await assert.rejects(
			inibase.post(tableName, {
				id: "test5",
				count: 30,
				nested: { value: "anotherNestedValue" },
				list: [123], // Incorrect type for array child, expected string
			}),
			/INVALID_TYPE/,
			"Should reject data with incorrect array child type",
		);
	});

	await t.test("Accept Valid Data", async () => {
		const validData = {
			id: "valid1",
			count: 100,
			nested: { value: "correctValue", optionalValue: 42 },
			list: ["item1", "item2"],
		};
		const insertedData = await inibase.post(
			tableName,
			validData,
			undefined,
			true,
		);
		assert.ok(insertedData?.id, "Should accept and insert valid data");
	});

	await t.test("Accept Valid Data with Optional Fields Missing", async () => {
		const validDataOptionalMissing = {
			id: "valid2",
			count: 200,
			nested: { value: "correctValueMissingOptional" },
			// 'list' is also optional and missing
		};
		const insertedData = await inibase.post(
			tableName,
			validDataOptionalMissing,
			undefined,
			true,
		);
		assert.ok(
			insertedData?.id,
			"Should accept valid data with optional fields missing",
		);
	});
});

await test("Table Relationships", async (t) => {
	initializeDatabase();

	const usersTable = "users_relation";
	const postsTable = "posts_relation";

	const usersSchema: Schema = [
		{ key: "first_name", type: "string", required: true },
		{ key: "last_name", type: "string", required: true },
	];

	const postsSchema: Schema = [
		{ key: "title", type: "string", required: true },
		{ key: "content", type: "string", required: true },
		{
			key: "user",
			type: "table",
			required: true,
			table: usersTable, // Specifies the referenced table
		},
	];

	await t.test("Create Tables with Relationship", async () => {
		await inibase.createTable(usersTable, usersSchema);
		await inibase.createTable(postsTable, postsSchema);
		assert.ok(true, "Tables with relationship created successfully");
	});

	let userId: string;
	await t.test("Insert Related Data", async () => {
		const user = await inibase.post(
			usersTable,
			{ first_name: "John", last_name: "Doe" },
			undefined,
			true,
		);
		assert.ok(user?.id, "User inserted successfully");
		if (!user || !user.id) {
			assert.fail("User creation failed, cannot proceed with post creation.");
			return;
		}
		userId = user.id as string;

		const post = await inibase.post(
			postsTable,
			{ title: "My First Post", content: "Hello world!", user: { id: userId } },
			undefined,
			true,
		);
		assert.ok(post?.id, "Post inserted successfully");
		assert.equal(post?.user?.id, userId, "Post should be linked to the user");
	});

	await t.test(
		"Check Post with Non-Existent User results in null user field",
		async () => {
			const postWithNonExistentUser = await inibase.post(
				postsTable,
				{
					title: "Another Post",
					content: "Content",
					user: { id: encodeID(9999) },
				},
				undefined,
				true,
			);
			assert.ok(
				postWithNonExistentUser?.id,
				"Post should be created even with non-existent user ID",
			);
			assert.equal(
				postWithNonExistentUser?.user,
				undefined,
				"User field should be undefined for non-existent user ID",
			);
		},
	);

	await t.test("Cascade Delete Related Data", async () => {
		await inibase.delete(usersTable, { id: userId });
		const userAfterDelete = await inibase.get(usersTable, { id: userId });
		assert.equal(userAfterDelete, null, "User should be deleted");

		const postsAfterDelete = await inibase.get(postsTable, { userId });
		assert.equal(
			postsAfterDelete,
			null,
			"Related posts should be deleted due to cascade",
		);
	});
});

await test("Cleanup Database", removeDatabase);
