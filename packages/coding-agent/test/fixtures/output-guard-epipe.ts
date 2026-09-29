/**
 * Child process for output-guard.test.ts: takes over stdout, writes "ready", then keeps writing
 * until the parent closes its end of the pipe. Diagnostics go to fd 2 synchronously.
 *
 * argv[2]:
 * - "none": no broken-stdout handler (print/json mode behavior).
 * - "handler": registers onRawStdoutBroken; after it fires, writes and flushes again, then exits 0.
 * - "handler-eio": like "handler", but every stdout write fails with EIO (not a gone sink).
 */
import { writeSync } from "node:fs";
import {
	flushRawStdout,
	onRawStdoutBroken,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../src/core/output-guard.ts";

const mode = process.argv[2];
const log = (message: string) => writeSync(2, `${message}\n`);
process.on("exit", (code) => log(`exit ${code}`));

if (mode === "handler-eio") {
	process.stdout.write = ((_chunk: unknown, callback?: (error?: Error | null) => void) => {
		const error = Object.assign(new Error("write EIO"), { code: "EIO" });
		setImmediate(() => callback?.(error));
		return false;
	}) as typeof process.stdout.write;
}

takeOverStdout();

if (mode !== "none") {
	let calls = 0;
	onRawStdoutBroken(() => {
		calls++;
		log(`broken ${calls}`);
		if (calls > 1) return;
		void (async () => {
			writeRawStdout("after broken\n");
			await waitForRawStdoutBackpressure();
			await flushRawStdout();
			log("flushed");
			setTimeout(() => {
				log("alive");
				process.exit(0);
			}, 100);
		})();
	});
}

writeRawStdout("ready\n");
let line = 0;
setInterval(() => {
	writeRawStdout(`line ${line++}\n`);
}, 5);
