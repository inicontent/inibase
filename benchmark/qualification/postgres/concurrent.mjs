import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { adapter, values } from "./adapter.mjs";

const options = JSON.parse(process.argv[2]);
const db = await adapter({ ...options, busyTimeout: 10000 });
const key = (id) => `concurrent-key-${id}`;
const row = (seq) => ({
	seq,
	key: key(seq),
	title: `Record ${seq}`,
	category: "concurrent",
	body: "Concurrent correctness fixture",
	score: seq,
});
const writerCount = 3,
	iterations = options.writes;
const idFor = (writer, step) => 1 + writer * iterations + step;
const check = (value, id) => {
	if (!value) {
		assert.ok(
			id <= writerCount * iterations && ((id - 1) % iterations) % 4 === 3,
			`unexpected missing record ${id}`,
		);
		return;
	}
	const expected = row(id);
	assert.ok(
		value.score === id || value.score === -id,
		`invalid committed score: ${id}/${value.score}`,
	);
	expected.score = value.score;
	assert.deepEqual(values(value), values(expected));
};
const waitStart = () =>
	new Promise((resolve) => {
		process.once("message", resolve);
		process.send?.({ ready: true });
	});
if (options.role) {
	const result = { role: options.role, samples: [], reads: 0, errors: [] };
	try {
		await db.open();
		if (options.role === "reader") {
			let running = true;
			await waitStart();
			process.on("message", () => {
				running = false;
			});
			process.on("disconnect", () => {
				running = false;
			});
			while (running) {
				const id =
					1 + ((result.reads * 7919 + 42) % (writerCount * iterations));
				const start = performance.now();
				check(await db.point(key(id)), id);
				if (result.samples.length < 2048)
					result.samples.push(performance.now() - start);
				result.reads++;
				await new Promise((resolve) => setImmediate(resolve));
			}
		} else {
			await waitStart();
			for (let step = 0; step < iterations; step++) {
				const id = idFor(options.writer, step),
					start = performance.now();
				await db.update(key(id), -id);
				assert.equal((await db.point(key(id))).score, -id);
				if (step % 4 === 3) {
					await db.remove(key(id));
					assert.equal((await db.point(key(id))) ?? null, null);
				}
				if (step % 8 === 7) await db.maintain();
				result.samples.push(performance.now() - start);
			}
		}
		await db.close();
		result.verified = true;
	} catch (error) {
		result.errors.push({ message: error.message, stack: error.stack });
		process.exitCode = 1;
		try {
			await db.close();
		} catch {}
	}
	result.usage = process.resourceUsage();
	await writeFile(
		`${options.destination}.${options.role}${options.writer ?? ""}.json`,
		`${JSON.stringify(result, null, 2)}\n`,
	);
	process.disconnect?.();
} else {
	const result = {
		workloadVersion: "concurrent-1",
		options,
		errors: [],
		verified: false,
		usageStart: process.resourceUsage(),
	};
	const children = [];
	let reader;
	const launch = (role, writer) => {
		const child = fork(
			new URL(import.meta.url),
			[JSON.stringify({ ...options, role, writer })],
			{
				execArgv: ["--max-old-space-size=256"],
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			},
		);
		children.push(child);
		let stderr = "";
		child.stdout.resume();
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		let readyResolve, readyReject;
		const ready = new Promise((resolve, reject) => {
			readyResolve = resolve;
			readyReject = reject;
		});
		const done = new Promise((resolve, reject) => {
			child.on("message", (message) => {
				if (message.ready) readyResolve();
			});
			child.on("error", (error) => {
				readyReject(error);
				reject(error);
			});
			child.on("exit", (code, signal) => {
				const error = new Error(
					`${role}/${writer}: ${code}/${signal}: ${stderr}`,
				);
				readyReject(error);
				code === 0 ? resolve() : reject(error);
			});
		});
		// Observe immediately; still await/rethrow below after other children settle.
		ready.catch(() => {});
		done.catch(() => {});
		return { child, ready, done };
	};
	try {
		assert.ok(options.rows >= writerCount * iterations);
		await db.open();
		await db.create("records");
		for (let first = 1; first <= options.rows; first += 1000)
			await db.insert(
				"records",
				Array.from(
					{ length: Math.min(1000, options.rows - first + 1) },
					(_, i) => row(first + i),
				),
			);
		await db.index();
		await db.close();
		reader = launch("reader");
		const writers = Array.from({ length: writerCount }, (_, writer) =>
			launch("writer", writer),
		);
		await Promise.all([reader.ready, ...writers.map((writer) => writer.ready)]);
		const start = performance.now();
		for (const child of children) child.send("start");
		const completed = await Promise.allSettled(
			writers.map((writer) => writer.done),
		);
		if (reader.child.connected) reader.child.send("stop");
		await reader.done;
		result.reader = JSON.parse(
			await readFile(`${options.destination}.reader.json`, "utf8"),
		);
		assert.ok(result.reader.reads > 0);
		for (const status of completed)
			if (status.status === "rejected") throw status.reason;
		result.elapsedMs = performance.now() - start;
		await db.open();
		const all = await db.all();
		assert.equal(
			all.length,
			options.rows - writerCount * Math.floor(iterations / 4),
		);
		all.sort((a, b) => a.seq - b.seq);
		for (let i = 0; i < all.length; i++) {
			const value = all[i],
				expected = row(value.seq);
			assert.ok(value.seq >= 1 && value.seq <= options.rows);
			if (i) assert.ok(value.seq > all[i - 1].seq);
			if (value.seq <= writerCount * iterations) {
				assert.notEqual(((value.seq - 1) % iterations) % 4, 3);
				expected.score = -value.seq;
			}
			assert.deepEqual(values(value), values(expected));
		}
		for (let writer = 0; writer < writerCount; writer++)
			for (let step = 0; step < iterations; step++) {
				const id = idFor(writer, step),
					value = await db.point(key(id));
				if (step % 4 === 3) assert.equal(value ?? null, null);
				else assert.equal(value.score, -id);
			}
		result.final = await db.info();
		await db.close();
		result.verified = true;
	} catch (error) {
		result.errors.push({ message: error.message, stack: error.stack });
		process.exitCode = 1;
	} finally {
		for (const child of children)
			if (child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
		await Promise.allSettled(
			children.map((child) =>
				child.exitCode !== null || child.signalCode
					? Promise.resolve()
					: new Promise((resolve) => child.once("exit", resolve)),
			),
		);
		try {
			await db.close();
		} catch {}
	}
	result.usageEnd = process.resourceUsage();
	await writeFile(options.destination, `${JSON.stringify(result, null, 2)}\n`);
}
