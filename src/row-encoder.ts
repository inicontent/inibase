import { constants, createDeflateRaw, type DeflateRaw } from "node:zlib";
import { checksum } from "./updatelog.js";

/** One native compressor and bounded output workspace per active build. */
export class RowEncoder {
	private readonly stream: DeflateRaw;
	private output: Buffer;
	private used = 0;
	private closed = false;
	private failure: Error | undefined;
	private reject: ((error: Error) => void) | undefined;
	constructor(
		pageBytes: number,
		smallWorkingSet = false,
		memoryLevel = smallWorkingSet ? 4 : 8,
	) {
		this.output = Buffer.allocUnsafe(pageBytes + 4096);
		this.stream = createDeflateRaw({
			level: 1,
			memLevel: memoryLevel,
			chunkSize: smallWorkingSet ? 16384 : pageBytes + 4096,
			windowBits: smallWorkingSet ? 14 : 15,
		});
		this.stream.on("error", (error) => {
			this.failure = error;
			this.reject?.(error);
		});
		this.stream.on("data", (part: Buffer) => {
			if (this.used + part.length + 8 > this.output.length) {
				const error = new Error("ROWPACK_ENCODE_BOUNDS");
				this.failure = error;
				this.reject?.(error);
				this.stream.destroy(error);
				return;
			}
			part.copy(this.output, this.used);
			this.used += part.length;
		});
	}
	/** Returned bytes stay valid until the next encode; calls must be serial. */
	async encode(bytes: Buffer): Promise<Buffer> {
		if (this.failure) throw this.failure;
		if (this.reject) throw new Error("ROWPACK_ENCODER_BUSY");
		if (this.closed) throw new Error("ROWPACK_ENCODER_CLOSED");
		// A standard gzip header, independently checksummed member per page.
		this.output.set([31, 139, 8, 0, 0, 0, 0, 0, 4, 3]);
		this.used = 10;
		try {
			await new Promise<void>((resolve, reject) => {
				this.reject = reject;
				this.stream.write(bytes, (error) => {
					if (error) reject(error);
				});
				this.stream.flush(constants.Z_FINISH, () =>
					this.failure ? reject(this.failure) : resolve(),
				);
			});
			this.stream.reset();
			this.output.writeUInt32LE(checksum(bytes), this.used);
			this.output.writeUInt32LE(bytes.length, this.used + 4);
			this.used += 8;
			return this.output.subarray(0, this.used);
		} finally {
			this.reject = undefined;
		}
	}
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await new Promise<void>((resolve) => this.stream.close(() => resolve()));
		this.output = Buffer.alloc(0);
	}
}
