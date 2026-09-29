interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

const RAW_STDOUT_RETRY_DELAY_MS = 10;

let rawStdoutWriteTail: Promise<void> = Promise.resolve();

/** Write errors that mean the reader of stdout is gone (e.g. the parent process died). */
const SINK_GONE_ERROR_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED"]);

let rawStdoutBrokenHandler: (() => void) | undefined;
let rawStdoutBroken = false;

function isSinkGoneError(error: unknown): boolean {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	return typeof code === "string" && SINK_GONE_ERROR_CODES.has(code);
}

/**
 * Mark raw stdout broken if a handler is registered and the error means the reader is gone.
 * Returns false when the caller must keep today's fatal behavior.
 */
function markRawStdoutBroken(error: unknown): boolean {
	const handler = rawStdoutBrokenHandler;
	if (!handler || !isSinkGoneError(error)) {
		return false;
	}
	if (!rawStdoutBroken) {
		rawStdoutBroken = true;
		handler();
	}
	return true;
}

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

async function writeRawStdoutChunk(text: string): Promise<void> {
	while (!rawStdoutBroken) {
		try {
			await new Promise<void>((resolve, reject) => {
				try {
					getRawStdoutWrite()(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

/**
 * Handle a gone stdout reader instead of exiting: on EPIPE / ERR_STREAM_DESTROYED (from a raw
 * write or a stdout 'error' event), raw stdout is marked broken, `handler` runs once, and later
 * raw writes and flushes are no-ops. Without a handler, any raw write error exits 1. Other stdout
 * errors stay fatal. Returns a function that unregisters the handler.
 */
export function onRawStdoutBroken(handler: () => void): () => void {
	rawStdoutBrokenHandler = handler;
	const onStdoutError = (error: Error) => {
		if (!markRawStdoutBroken(error)) {
			throw error;
		}
	};
	process.stdout.on("error", onStdoutError);
	return () => {
		process.stdout.off("error", onStdoutError);
		if (rawStdoutBrokenHandler === handler) {
			rawStdoutBrokenHandler = undefined;
		}
	};
}

export function writeRawStdout(text: string): void {
	if (text.length === 0 || rawStdoutBroken) {
		return;
	}
	rawStdoutWriteTail = rawStdoutWriteTail
		.then(() => writeRawStdoutChunk(text))
		.catch((error: unknown) => {
			if (!markRawStdoutBroken(error)) {
				throw error;
			}
		});
	void rawStdoutWriteTail.catch(() => {
		process.exit(1);
	});
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = rawStdoutWriteTail;
		await tail;
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	try {
		await writeRawStdoutChunk("");
	} catch (error) {
		if (!markRawStdoutBroken(error)) {
			throw error;
		}
	}
}
