import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	isHTML,
	isEmail,
	isNumber,
	isString,
	isIP,
	isArrayOfArrays,
	isArrayOfNulls,
	isArrayOfObjects,
	isDate,
	isObject,
	isURL,
} from "../src/utils";

await test("Utilities: isString", async (t) => {
	await t.test("should return true for a normal string", () => {
		assert.ok(isString("Hello"), "Expected true for a valid string");
	});

	await t.test("should return false for non-string values", () => {
		assert.equal(isString(123), false, "Numbers are not strings");
		assert.equal(isString({}), false, "Objects are not strings");
		assert.equal(isString([]), false, "Arrays are not strings");
		assert.equal(isString(null), false, "null is not a string");
		assert.equal(isString(undefined), false, "undefined is not a string");
	});
});

await test("Utilities: isNumber", async (t) => {
	await t.test("should return true for numbers", () => {
		assert.ok(isNumber(0), "Expected true for 0");
		assert.ok(isNumber(123), "Expected true for 123");
		assert.ok(isNumber("123"), "Expected true for '123'");
		assert.ok(isNumber(-456), "Expected true for -456");
		assert.ok(isNumber(3.14), "Expected true for 3.14");
	});

	await t.test("should return false for non-number values", () => {
		assert.equal(
			isNumber("blabla123"),
			false,
			"String+Number might be considered invalid",
		);
		assert.equal(
			isNumber("123blabla"),
			false,
			"Number+String might be considered invalid",
		);
		assert.equal(
			isNumber("123blabla123"),
			false,
			"Number+String+Number might be considered invalid",
		);
		assert.equal(
			isNumber(Number.NaN),
			false,
			"NaN might be considered invalid",
		);
		assert.equal(
			isNumber(Number.POSITIVE_INFINITY),
			false,
			"Infinity might be excluded",
		);
		assert.equal(isNumber([]), false, "Array is not a number");
		assert.equal(isNumber({}), false, "Object is not a number");
	});
});

await test("Utilities: isHTML", async (t) => {
	await t.test("should return true for strings containing HTML tags", () => {
		assert.ok(isHTML("<div>Hello</div>"), "Simple HTML tag should be detected");
		assert.ok(
			isHTML("<p><strong>Nested</strong></p>"),
			"Nested tags should be detected",
		);
	});

	await t.test("should return false for plain text", () => {
		assert.equal(isHTML("Just some text"), false, "No HTML tags");
		assert.equal(isHTML("123"), false, "Numbers in string without tags");
	});

	await t.test("edge cases", () => {
		// Mismatched tags, depending on your isHTML logic
		assert.ok(
			isHTML("<b>unclosed"),
			"Might pass if we only check presence of <tag>",
		);
	});
});

await test("Utilities: isEmail", async (t) => {
	await t.test("should return true for typical emails", () => {
		assert.ok(isEmail("test@example.com"), "Basic email format");
		assert.ok(isEmail("user.name+tag@sub.domain.org"), "Complex email");
	});

	await t.test("should return false for invalid emails", () => {
		assert.equal(isEmail("not-an-email"), false, "Missing @ and domain");
		assert.equal(isEmail("foo@"), false, "Missing domain");
		assert.equal(isEmail("@bar.com"), false, "Missing username");
		assert.equal(isEmail("foo@bar@baz.com"), false, "Multiple @");
	});
});

await test("Utilities: isIP", async (t) => {
	await t.test("should return true for valid IPv4 addresses", () => {
		assert.ok(isIP("127.0.0.1"), "Localhost IPv4");
		assert.ok(isIP("192.168.1.1"), "Common private IPv4");
		assert.ok(isIP("255.255.255.255"), "Broadcast address");
	});

	await t.test("should return false for invalid IPv4 addresses", () => {
		assert.equal(isIP("999.999.999.999"), false, "Out of range");
		assert.equal(isIP("192.168.1"), false, "Incomplete");
		assert.equal(isIP("300.10.10.10"), false, "Octet out of range");
		assert.equal(isIP("hello.world"), false, "Not numeric");
	});
});

//
// New tests for isDate, isObject, isArrayOfArrays, isArrayOfNulls, isArrayOfObjects, isURL
//

await test("Utilities: isDate", async (t) => {
	await t.test("should return true for Date objects", () => {
		assert.ok(isDate(new Date()), "new Date() is a Date");
		assert.ok(isDate(new Date(Date.now())), "new Date(timestamp) is a Date");
		assert.ok(isDate(Date.now()), "Number (timestamp) is a Date");
	});

	await t.test("should return false for non-Date values", () => {
		assert.equal(isDate("2025-01-01"), false, "String is not a Date object");
		assert.equal(isDate({}), false, "Plain object is not a Date");
		assert.equal(isDate(null), false, "null is not a Date");
		assert.equal(isDate(undefined), false, "undefined is not a Date");
	});
});

await test("Utilities: isObject", async (t) => {
	await t.test("should return true for plain objects", () => {
		assert.ok(isObject({}), "Empty object is an object");
		assert.ok(isObject({ key: "value" }), "Non-empty object is an object");
	});

	await t.test("should return false for arrays, null, etc.", () => {
		assert.equal(isObject([]), false, "Array is not a plain object");
		assert.equal(isObject(null), false, "null is not an object");
		assert.equal(isObject("string"), false, "String is not an object");
	});
});

await test("Utilities: isArrayOfArrays", async (t) => {
	await t.test("should return true for arrays of arrays", () => {
		assert.ok(isArrayOfArrays([[], []]), "Nested empty arrays");
		assert.ok(isArrayOfArrays([[1], [2, 3]]), "Arrays with elements");
	});

	await t.test("should return false for anything else", () => {
		assert.equal(isArrayOfArrays([]), false, "Empty array has no subarrays");
		assert.equal(
			isArrayOfArrays([[1], "not an array"]),
			false,
			"Mixed content",
		);
		assert.equal(isArrayOfArrays({}), false, "Object is not an array");
		assert.equal(isArrayOfArrays(null), false, "null is not an array");
	});
});

await test("Utilities: isArrayOfNulls", async (t) => {
	await t.test("should return true for arrays full of null", () => {
		assert.ok(isArrayOfNulls([null, null, null]), "All nulls");
		assert.ok(
			isArrayOfNulls([]),
			"Empty array might be considered all nulls (depends on your logic)",
		);
	});

	await t.test("should return false otherwise", () => {
		assert.equal(
			isArrayOfNulls([null, undefined]),
			false,
			"Contains undefined, not just null",
		);
		assert.equal(isArrayOfNulls([0, null]), false, "Contains 0, not null");
		assert.equal(isArrayOfNulls("not an array"), false, "Not an array");
	});
});

await test("Utilities: isArrayOfObjects", async (t) => {
	await t.test("should return true for arrays of objects", () => {
		assert.ok(isArrayOfObjects([{}, { a: 1 }]), "Plain objects");
		assert.ok(isArrayOfObjects([{}, new Object()]), "Even new Object()");
	});

	await t.test("should return false if any element is not an object", () => {
		assert.equal(
			isArrayOfObjects([{}, []]),
			false,
			"Array is not a plain object",
		);
		assert.equal(
			isArrayOfObjects([{}, null]),
			false,
			"null is not a plain object",
		);
		assert.equal(
			isArrayOfObjects([{}, "string"]),
			false,
			"string is not an object",
		);
	});

	await t.test("should return false for non-arrays", () => {
		assert.equal(isArrayOfObjects({}), false, "Object is not an array");
		assert.equal(isArrayOfObjects(null), false, "null is not an array");
	});
});

await test("Utilities: isURL", async (t) => {
	await t.test("should return true for typical URLs", () => {
		assert.ok(isURL("http://example.com"), "Basic HTTP");
		assert.ok(isURL("https://example.com/path?query=1#hash"), "Complex URL");
		assert.ok(
			isURL("ftp://ftp.example.com"),
			"If your isURL accepts ftp protocol, depends on your implementation",
		);
		assert.ok(
			isURL("mailto:test@example.com"),
			"If your isURL handles mailto (depends on your logic)",
		);
	});

	await t.test("should return false for invalid URLs", () => {
		assert.equal(
			isURL("example"),
			false,
			"Just a domain without protocol might fail, depending on your logic",
		);
		assert.equal(isURL("://example.com"), false, "Malformed scheme");
		assert.equal(isURL(""), false, "Empty string");
		assert.equal(isURL(null), false, "null is not a string");
	});
});
