// Profiling-only builtin wrappers; normal comparison trials never load this.
import fs from "node:fs";
import childProcess from "node:child_process";
import zlib from "node:zlib";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const totals = {};
let liveHandles = 0, peakHandles = 0;
const record = (name, elapsed, bytes = 0) => {
	const value = totals[name] ??= { calls: 0, milliseconds: 0, bytes: 0 };
	value.calls++; value.milliseconds += elapsed; value.bytes += bytes;
};
for (const name of ["stat", "readdir", "readFile", "writeFile", "copyFile", "rename", "unlink", "mkdir"]) {
	const original = fs.promises[name].bind(fs.promises);
	fs.promises[name] = async (...args) => {
		const start = performance.now();
		try { return await original(...args); }
		finally { record(`fs.${name}`, performance.now() - start); }
	};
}
const open = fs.promises.open.bind(fs.promises);
fs.promises.open = async (...args) => {
	const start = performance.now();
	const handle = await open(...args);
	record("fs.open", performance.now() - start);
	liveHandles++; peakHandles = Math.max(peakHandles, liveHandles);
	let closed = false;
	for (const method of ["read", "write", "writeFile", "sync", "truncate", "stat", "close"]) {
		const original = handle[method].bind(handle);
		handle[method] = async (...values) => {
			const start = performance.now();
			try { const result = await original(...values); record(`handle.${method}`, performance.now() - start, result?.bytesRead ?? result?.bytesWritten ?? 0); return result; }
			finally { if (method === "close" && !closed) { closed = true; liveHandles--; } }
		};
	}
	return handle;
};
for (const name of ["exec", "execFile", "spawn", "spawnSync"]) {
	const original = childProcess[name];
	const wrapper = function (...args) { record(`subprocess.${name}`, 0); return original.apply(this, args); };
	if (original[promisify.custom]) wrapper[promisify.custom] = (...args) => {
		record(`subprocess.${name}`, 0); return original[promisify.custom](...args);
	};
	childProcess[name] = wrapper;
}
for (const name of ["gzipSync", "gunzipSync", "createGzip", "createGunzip"]) {
	const original = zlib[name];
	Object.defineProperty(zlib, name, { configurable: true, writable: true, value: function (...args) {
		const start = performance.now(); const result = original.apply(this, args); record(`zlib.${name}`, performance.now() - start, args[0]?.byteLength ?? 0); return result;
	} });
}
syncBuiltinESMExports();
export const snapshot = () => ({ totals, liveHandles, peakHandles, note: "Async timings include queue/wait time; CPU profiles are separate. Stream-owned descriptor closes may not invoke the JS wrapper." });
