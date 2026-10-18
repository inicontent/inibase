/** Edit raw line chunks before compression. Unchanged oversized cells stream
 * through without decoding or materialization. Output and backpressure use
 * 64 KiB chunks, including large replacements and extensions beyond EOF.
 */
export async function* replacementChunks(
	input: AsyncIterable<Buffer>,
	replacements: Record<number, unknown>,
): AsyncGenerator<Buffer> {
	const capacity = 64 * 1024;
	let output = Buffer.allocUnsafe(capacity),
		used = 0;
	let line = 1,
		content = false,
		skipLF = false;
	function* emit(bytes: Buffer): Generator<Buffer> {
		let offset = 0;
		while (offset < bytes.length) {
			const count = Math.min(capacity - used, bytes.length - offset);
			bytes.copy(output, used, offset, offset + count);
			used += count;
			offset += count;
			if (used === capacity) {
				yield output;
				output = Buffer.allocUnsafe(capacity);
				used = 0;
			}
		}
	}
	// Encode oversized caller-owned replacement strings in bounded pieces;
	// never split a surrogate pair across UTF-8 conversions.
	function* value(value: unknown): Generator<Buffer> {
		const text = String(value);
		for (let offset = 0; offset < text.length; ) {
			let end = Math.min(text.length, offset + 8192);
			const last = text.charCodeAt(end - 1);
			if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
			yield* emit(Buffer.from(text.slice(offset, end)));
			offset = end;
		}
	}
	const newline = Buffer.from("\n");
	function* finish(): Generator<Buffer> {
		if (Object.hasOwn(replacements, line)) yield* value(replacements[line]);
		yield* emit(newline);
		line++;
		content = false;
	}
	function* consume(chunk: Buffer): Generator<Buffer> {
		let start = 0;
		if (skipLF && chunk.length) {
			if (chunk[0] === 10) start++;
			skipLF = false;
		}
		for (let end = start; end < chunk.length; end++) {
			if (chunk[end] !== 10 && chunk[end] !== 13) continue;
			if (!Object.hasOwn(replacements, line))
				yield* emit(chunk.subarray(start, end));
			yield* finish();
			if (chunk[end] === 13) {
				if (end + 1 === chunk.length) skipLF = true;
				else if (chunk[end + 1] === 10) end++;
			}
			start = end + 1;
		}
		if (start < chunk.length) {
			content = true;
			if (!Object.hasOwn(replacements, line))
				yield* emit(chunk.subarray(start));
		}
	}
	for await (const chunk of input) yield* consume(chunk);
	if (content) yield* finish();
	// Preserve the existing EOF-extension convention (no final separator).
	const remaining = Object.keys(replacements)
		.map(Number)
		.sort((a, b) => a - b)
		.filter((n) => n >= line);
	for (let i = 0; i < remaining.length; i++) {
		const target = remaining[i];
		while (line < target) {
			yield* emit(newline);
			line++;
		}
		yield* value(replacements[target]);
		line++;
		if (i + 1 < remaining.length) yield* emit(newline);
	}
	if (used) yield output.subarray(0, used);
}
