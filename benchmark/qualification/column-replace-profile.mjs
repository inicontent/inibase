// Diagnostic only: no commit/publication, locks or durability are bypassed in
// the public benchmark. This isolates File.replace and its compressor traffic.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const args = Object.fromEntries(
	process.argv.slice(2).map((v) => v.replace(/^--/, "").split("=")),
);
let calls = 0,
	bytes = 0;
const original = zlib.createGzip;
Object.defineProperty(zlib, "createGzip", {
	configurable: true,
	value(...args) {
		const stream = original(...args),
			write = stream.write;
		stream.write = function (chunk, ...rest) {
			calls++;
			bytes += Buffer.byteLength(chunk);
			return write.call(this, chunk, ...rest);
		};
		return stream;
	},
});
syncBuiltinESMExports();
const modulePath = resolve(args.module ?? "dist/file.js");
const File = await import(pathToFileURL(modulePath));
const directory = await mkdtemp("/private/tmp/inibase-replace-profile-");
const result = {
	modulePath,
	runtime: process.versions,
	note: "Instrumented isolated rewrite, not durable public API latency",
	samples: [],
};
try {
	await mkdir(join(directory, ".tmp"));
	const filename = join(directory, "score.gz");
	await writeFile(filename, zlib.gzipSync("1234\n".repeat(100000)));
	for (let i = 0; i < Number(args.repeats ?? 5); i++) {
		calls = bytes = 0;
		const start = performance.now(),
			cpu = process.cpuUsage();
		const [temp] = await File.replace(filename, { 50000: 5678 });
		result.samples.push({
			ms: performance.now() - start,
			cpu: process.cpuUsage(cpu),
			compressorWrites: calls,
			compressorInputBytes: bytes,
		});
		const decoded = zlib.gunzipSync(await readFile(temp)).toString();
		assert.equal(
			decoded,
			`${"1234\n".repeat(49999)}5678\n${"1234\n".repeat(50000)}`,
		);
		await rm(temp);
	}
	result.verified = true;
} finally {
	await rm(directory, { recursive: true, force: true });
}
await writeFile(resolve(args.output), `${JSON.stringify(result, null, 2)}\n`);
