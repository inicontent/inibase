import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { adapter, values } from "./adapter.mjs";

const options = JSON.parse(process.argv[2]);
const db = await adapter(options);
const row = (seq) => ({
	seq,
	key: `recovery-key-${seq}`,
	title: `Recovery ${seq}`,
	category: "recovery",
	body: "Acknowledged durable record",
	score: seq,
});
if (options.role === "writer") {
	process.on("message", () => {}); // parent owns termination, including after the final acknowledgement
	await db.open();
	for (let id = 1; id <= options.writes; id++) {
		await db.update(row(id).key, -id);
		const deleted = id % 4 === 0;
		if (deleted) await db.remove(row(id).key);
		process.send({ ack: { id, deleted, score: -id } });
	}
	await db.close();
} else {
	const result = {
		workloadVersion: "recovery-2",
		options,
		acknowledgements: [],
		errors: [],
		verified: false,
		usageStart: process.resourceUsage(),
	};
	let child;
	try {
		assert.ok(options.rows >= options.writes && options.writes >= 4);
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
		child = fork(
			new URL(import.meta.url),
			[JSON.stringify({ ...options, role: "writer" })],
			{
				execArgv: ["--max-old-space-size=256"],
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			},
		);
		let stderr = "",
			killed = false;
		child.stdout.resume();
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const target = Math.min(16, options.writes);
		child.on("message", (message) => {
			if (!message.ack) return;
			result.acknowledgements.push(message.ack);
			if (!killed && result.acknowledgements.length >= target) {
				killed = true;
				child.kill("SIGKILL");
			}
		});
		result.writerExit = await new Promise((resolve, reject) => {
			child.on("error", reject);
			child.on("exit", (code, signal) => resolve({ code, signal, stderr }));
		});
		assert.equal(result.writerExit.signal, "SIGKILL", stderr);
		assert.ok(result.acknowledgements.length >= target);
		if (options.engine === "postgres") {
			// Kill the actual server too. Killing a client alone does not exercise WAL restart recovery.
			const command = promisify(execFile),
				start = performance.now();
			result.serverStop = await command(
				join(options.binaryDirectory, "pg_ctl"),
				[
					"-D",
					join(options.directory, "cluster"),
					"-w",
					"-m",
					"immediate",
					"stop",
				],
			);
			result.serverRestart = await command(
				join(options.binaryDirectory, "pg_ctl"),
				[
					"-D",
					join(options.directory, "cluster"),
					"-l",
					join(options.directory, "server.log"),
					"-w",
					"start",
				],
			);
			result.serverCrashRestartMs = performance.now() - start;
			const serverPid = Number(
				(
					await readFile(
						join(options.directory, "cluster/postmaster.pid"),
						"utf8",
					)
				).split("\n")[0],
			);
			process.send?.({ serverPid });
		}
		const start = performance.now();
		await db.open();
		result.reopenMs = performance.now() - start;
		for (const ack of result.acknowledgements) {
			const value = await db.point(row(ack.id).key);
			if (ack.deleted) assert.equal(value ?? null, null);
			else {
				const expected = row(ack.id);
				expected.score = ack.score;
				assert.deepEqual(values(value), values(expected));
			}
			if (result.firstVerifiedReadMs === undefined)
				result.firstVerifiedReadMs = performance.now() - start;
		}
		const all = await db.all();
		all.sort((a, b) => a.seq - b.seq);
		for (let i = 0; i < all.length; i++) {
			const value = all[i];
			assert.ok(value.seq >= 1 && value.seq <= options.rows);
			if (i) assert.ok(value.seq > all[i - 1].seq);
			assert.ok(
				value.score === value.seq ||
					(value.seq <= options.writes && value.score === -value.seq),
			);
			const expected = row(value.seq);
			expected.score = value.score;
			assert.deepEqual(values(value), values(expected));
		}
		// Only writer-targeted, every-fourth records may be absent, including commits whose ack was not observed.
		let cursor = 0;
		for (let id = 1; id <= options.rows; id++) {
			if (all[cursor]?.seq === id) cursor++;
			else
				assert.ok(
					id <= options.writes && id % 4 === 0,
					`unexpected missing record ${id}`,
				);
		}
		result.completeVerificationMs = performance.now() - start;
		result.final = await db.info();
		await db.close();
		result.verified = true;
	} catch (error) {
		result.errors.push({ message: error.message, stack: error.stack });
		process.exitCode = 1;
	} finally {
		if (child?.exitCode === null && !child.signalCode) child.kill("SIGKILL");
		try {
			await db.close();
		} catch {}
	}
	result.usageEnd = process.resourceUsage();
	await writeFile(options.destination, `${JSON.stringify(result, null, 2)}\n`);
}
