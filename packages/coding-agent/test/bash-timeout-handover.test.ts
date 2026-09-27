import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BashHandover, BashTimeoutEvent } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";
import { waitForChildProcess } from "../src/utils/child-process.ts";
import { killProcessTree, killTrackedDetachedChildren } from "../src/utils/shell.ts";

const TIMEOUT = 0.3;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs = 3000): Promise<boolean> {
	if (hasExited(child)) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	// Orphaned descendants may linger briefly as zombies until init reaps them.
	const statPath = `/proc/${pid}/stat`;
	if (!existsSync(statPath)) return true;
	try {
		const stat = readFileSync(statPath, "utf-8");
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
	} catch {
		return false;
	}
}

function backgroundPid(message: string): number {
	const match = message.match(/bg:(\d+)/);
	if (!match) throw new Error(`No background pid in: ${message}`);
	return Number(match[1]);
}

// The shell exits while a background descendant keeps the output pipe open (pi#5303 grace window).
const ORPHAN_WRITER_COMMAND = '(while true; do echo x; sleep 0.02; done) & echo "bg:$!"; exit 0';

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await delay(10);
	}
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("bash_timeout handover", () => {
	let testDir: string;
	const pids = new Set<number>();
	const children: ChildProcess[] = [];

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-bash-timeout-"));
	});

	afterEach(() => {
		for (const pid of pids) killProcessTree(pid);
		pids.clear();
		for (const child of children) {
			if (child.pid && !hasExited(child)) killProcessTree(child.pid);
		}
		children.length = 0;
		rmSync(testDir, { recursive: true, force: true });
	});

	it("keeps the stock timeout behavior without onTimeout", async () => {
		const bash = createBashTool(testDir);
		await expect(bash.execute("no-handler", { command: "sleep 30", timeout: TIMEOUT })).rejects.toThrow(
			`Command timed out after ${TIMEOUT} seconds`,
		);
	});

	it("kills and reports the stock timeout when the handler declines", async () => {
		let pid: number | undefined;
		const bash = createBashTool(testDir, {
			onTimeout: (event) => {
				pid = event.pid;
				pids.add(event.pid);
			},
		});
		await expect(bash.execute("declined", { command: "echo partial; sleep 30", timeout: TIMEOUT })).rejects.toThrow(
			/partial\s+Command timed out after 0\.3 seconds$/,
		);
		expect(pid).toBeDefined();
		await waitFor(() => !isAlive(pid!));
	});

	it("kills and reports the stock timeout when the handler throws before takeOver", async () => {
		let pid: number | undefined;
		const bash = createBashTool(testDir, {
			onTimeout: async (event) => {
				pid = event.pid;
				pids.add(event.pid);
				throw new Error("handler failed");
			},
		});
		await expect(bash.execute("throws", { command: "sleep 30", timeout: TIMEOUT })).rejects.toThrow(
			`Command timed out after ${TIMEOUT} seconds`,
		);
		await waitFor(() => !isAlive(pid!));
	});

	it("passes event metadata to the handler", async () => {
		let received: BashTimeoutEvent | undefined;
		const before = Date.now();
		const bash = createBashTool(testDir, {
			commandPrefix: "true",
			onTimeout: (event) => {
				received = event;
				pids.add(event.pid);
			},
		});
		await expect(bash.execute("meta-call", { command: "sleep 30", timeout: TIMEOUT })).rejects.toThrow(/timed out/);
		expect(received).toMatchObject({
			type: "bash_timeout",
			toolCallId: "meta-call",
			toolName: "bash",
			command: "sleep 30",
			cwd: testDir,
			timeout: TIMEOUT,
			taken: false,
		});
		expect(received!.startedAt).toBeGreaterThanOrEqual(before);
		expect(received!.startedAt).toBeLessThanOrEqual(Date.now());
		expect(received!.pid).toBeGreaterThan(0);
	});

	it("hands the running process over without losing output", async () => {
		let handover: BashHandover | undefined;
		let after = "";
		const bash = createBashTool(testDir, {
			onTimeout: (event) => {
				pids.add(event.pid);
				handover = event.takeOver();
				expect(event.taken).toBe(true);
				handover.child.stdout?.on("data", (chunk: Buffer) => {
					after += chunk.toString();
				});
				handover.child.stdout?.resume();
				handover.complete({ content: [{ type: "text", text: "moved to background" }] });
			},
		});

		const command = "for i in $(seq 1 40); do echo line$i; sleep 0.02; done; sleep 30";
		const result = await bash.execute("handover", { command, timeout: TIMEOUT });

		expect(textOf(result)).toBe("moved to background");
		expect(handover).toBeDefined();
		const { child, output } = handover!;
		expect(hasExited(child)).toBe(false);
		expect(isAlive(child.pid!)).toBe(true);
		expect(output.text).toContain("line1\n");
		expect(output.truncation.truncated).toBe(false);

		await waitFor(() => after.includes("line40\n"));
		const expected = Array.from({ length: 40 }, (_, i) => `line${i + 1}\n`).join("");
		expect(output.text + after).toBe(expected);
		expect(after.length).toBeGreaterThan(0);
	});

	it("does not kill a taken-over process on abort or tracked-children shutdown", async () => {
		const controller = new AbortController();
		let child: ChildProcess | undefined;
		const bash = createBashTool(testDir, {
			onTimeout: async (event) => {
				pids.add(event.pid);
				const handover = event.takeOver();
				child = handover.child;
				handover.complete({ content: [{ type: "text", text: "owned" }] });
				// Shutdown cleanup while the handler still runs must not reach the taken-over process.
				killTrackedDetachedChildren();
				await delay(150);
			},
		});

		const result = await bash.execute("abort-after", { command: "sleep 30", timeout: TIMEOUT }, controller.signal);
		expect(textOf(result)).toBe("owned");
		expect(hasExited(child!)).toBe(false);
		controller.abort();
		killTrackedDetachedChildren();
		await delay(150);
		expect(hasExited(child!)).toBe(false);
		expect(isAlive(child!.pid!)).toBe(true);
	});

	it("kills and reports the stock timeout when taken over without complete", async () => {
		let child: ChildProcess | undefined;
		const bash = createBashTool(testDir, {
			onTimeout: async (event) => {
				pids.add(event.pid);
				child = event.takeOver().child;
				await delay(20);
			},
		});

		await expect(bash.execute("no-complete", { command: "echo early; sleep 30", timeout: TIMEOUT })).rejects.toThrow(
			/early\s+Command timed out after 0\.3 seconds$/,
		);
		expect(await waitForExit(child!)).toBe(true);
	});

	it("allows only one claim and one completion", async () => {
		const errors: string[] = [];
		let takenAfterFirst: boolean | undefined;
		const bash = createBashTool(testDir, {
			onTimeout: (event) => {
				pids.add(event.pid);
				const handover = event.takeOver();
				takenAfterFirst = event.taken;
				try {
					event.takeOver();
				} catch (err) {
					errors.push((err as Error).message);
				}
				handover.complete({ content: [{ type: "text", text: "first" }] });
				try {
					handover.complete({ content: [{ type: "text", text: "second" }] });
				} catch (err) {
					errors.push((err as Error).message);
				}
			},
		});

		const result = await bash.execute("single-claim", { command: "sleep 30", timeout: TIMEOUT });
		expect(textOf(result)).toBe("first");
		expect(takenAfterFirst).toBe(true);
		expect(errors).toHaveLength(2);
		expect(errors[0]).toMatch(/already taken/);
		expect(errors[1]).toMatch(/already completed/);
	});

	it("returns the normal result when the process exits while the handler runs", async () => {
		let takeOverError: unknown;
		let handlerDone: Promise<void> | undefined;
		const bash = createBashTool(testDir, {
			onTimeout: (event) => {
				pids.add(event.pid);
				handlerDone = (async () => {
					await delay(800);
					try {
						event.takeOver();
					} catch (err) {
						takeOverError = err;
					}
				})();
				return handlerDone;
			},
		});

		const result = await bash.execute("exits", { command: "sleep 0.3; echo finished", timeout: 0.1 });
		expect(textOf(result)).toBe("finished\n");
		await handlerDone;
		expect(takeOverError).toBeInstanceOf(Error);
		expect((takeOverError as Error).message).toMatch(/exited/);
	});

	it("exposes the truncated tail and a complete full output file", async () => {
		let handover: BashHandover | undefined;
		const bash = createBashTool(testDir, {
			onTimeout: (event) => {
				pids.add(event.pid);
				handover = event.takeOver();
				handover.complete({
					content: [{ type: "text", text: "truncated" }],
					details: { truncation: handover.output.truncation, fullOutputPath: handover.output.fullOutputPath },
				});
			},
		});

		const result = await bash.execute("truncated", { command: "seq 1 5000; sleep 30", timeout: TIMEOUT });
		expect(result.details).toMatchObject({ fullOutputPath: handover!.output.fullOutputPath });
		const { output } = handover!;
		expect(output.truncation.truncated).toBe(true);
		expect(output.text.endsWith("4999\n5000")).toBe(true);
		expect(output.text.startsWith("1\n")).toBe(false);
		expect(output.fullOutputPath).toBeDefined();
		await output.flushed;
		const full = readFileSync(output.fullOutputPath!, "utf-8");
		expect(full).toBe(`${Array.from({ length: 5000 }, (_, i) => i + 1).join("\n")}\n`);
	});

	for (const variant of [
		{ name: "no handler", onTimeout: undefined },
		{ name: "a synchronous no-op handler", onTimeout: () => undefined },
		{ name: "an asynchronous declining handler", onTimeout: async () => {} },
	]) {
		it(`kills a shell whose descendant holds the pipe after exit with ${variant.name}`, async () => {
			const bash = createBashTool(testDir, { onTimeout: variant.onTimeout });
			const startedAt = Date.now();
			let error: unknown;
			try {
				await bash.execute("orphan-writer", { command: ORPHAN_WRITER_COMMAND, timeout: TIMEOUT });
			} catch (err) {
				error = err;
			}
			expect(error).toBeInstanceOf(Error);
			const message = (error as Error).message;
			const descendant = backgroundPid(message);
			pids.add(descendant);
			expect(message).toMatch(/Command timed out after 0\.3 seconds$/);
			expect(Date.now() - startedAt).toBeLessThan(2000);
			await waitFor(() => !isAlive(descendant));
		});
	}

	it("rejects promptly with the stock abort error when aborted after takeOver while the handler is pending", async () => {
		const controller = new AbortController();
		let handover: BashHandover | undefined;
		const bash = createBashTool(testDir, {
			onTimeout: (event) => {
				pids.add(event.pid);
				handover = event.takeOver();
				setTimeout(() => controller.abort(), 50);
				return new Promise<void>(() => {});
			},
		});

		const startedAt = Date.now();
		await expect(
			bash.execute("abort-pending", { command: "echo early; sleep 30", timeout: TIMEOUT }, controller.signal),
		).rejects.toThrow(/early\s+Command aborted$/);
		expect(Date.now() - startedAt).toBeLessThan(2000);
		await delay(100);
		expect(hasExited(handover!.child)).toBe(false);
		expect(isAlive(handover!.child.pid!)).toBe(true);
		expect(() => handover!.complete({ content: [{ type: "text", text: "late" }] })).toThrow(/finished/);
	});

	it("rejects complete() after the handler settled and falls back to the stock timeout", async () => {
		let handover: BashHandover | undefined;
		const bash = createBashTool(testDir, {
			onTimeout: (event) => {
				pids.add(event.pid);
				handover = event.takeOver();
			},
		});

		await expect(bash.execute("late-complete", { command: "sleep 30", timeout: TIMEOUT })).rejects.toThrow(
			`Command timed out after ${TIMEOUT} seconds`,
		);
		expect(() => handover!.complete({ content: [{ type: "text", text: "late" }] })).toThrow(/finished/);
		expect(await waitForExit(handover!.child)).toBe(true);
		expect(handover!.child.stdout?.destroyed).toBe(true);
		expect(handover!.child.stderr?.destroyed).toBe(true);
	});

	it("kills and reports the stock timeout when the handler throws after takeOver", async () => {
		let child: ChildProcess | undefined;
		const bash = createBashTool(testDir, {
			onTimeout: async (event) => {
				pids.add(event.pid);
				child = event.takeOver().child;
				throw new Error("handler failed after takeover");
			},
		});

		await expect(bash.execute("throws-after", { command: "sleep 30", timeout: TIMEOUT })).rejects.toThrow(
			`Command timed out after ${TIMEOUT} seconds`,
		);
		expect(await waitForExit(child!)).toBe(true);
	});

	it("keeps stderr across the handover", async () => {
		let handover: BashHandover | undefined;
		let after = "";
		const bash = createBashTool(testDir, {
			onTimeout: (event) => {
				pids.add(event.pid);
				handover = event.takeOver();
				handover.child.stderr?.on("data", (chunk: Buffer) => {
					after += chunk.toString();
				});
				handover.child.stderr?.resume();
				handover.complete({ content: [{ type: "text", text: "moved" }] });
			},
		});

		const command = "for i in $(seq 1 40); do echo err$i >&2; sleep 0.02; done; sleep 30";
		await bash.execute("stderr", { command, timeout: TIMEOUT });
		await waitFor(() => after.includes("err40\n"));
		const expected = Array.from({ length: 40 }, (_, i) => `err${i + 1}\n`).join("");
		expect(handover!.output.text + after).toBe(expected);
		expect(after.length).toBeGreaterThan(0);
	});

	it("keeps a defensive error listener on the handed-over child", async () => {
		let handover: BashHandover | undefined;
		const bash = createBashTool(testDir, {
			onTimeout: (event) => {
				pids.add(event.pid);
				handover = event.takeOver();
				handover.complete({ content: [{ type: "text", text: "moved" }] });
			},
		});

		await bash.execute("error-listener", { command: "sleep 30", timeout: TIMEOUT });
		expect(handover!.child.listenerCount("error")).toBeGreaterThan(0);
		expect(() => handover!.child.emit("error", new Error("late failure"))).not.toThrow();
	});

	it("keeps stock behavior for custom operations that ignore onTimeout", async () => {
		let called = false;
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("remote output\n"));
				throw new Error(`timeout:${TIMEOUT}`);
			},
		};
		const bash = createBashTool(testDir, {
			operations,
			onTimeout: () => {
				called = true;
			},
		});
		await expect(bash.execute("custom", { command: "remote", timeout: TIMEOUT })).rejects.toThrow(
			/remote output\s+Command timed out after 0\.3 seconds$/,
		);
		expect(called).toBe(false);
	});
});

describe("waitForChildProcess detach signal", () => {
	const children: ChildProcess[] = [];

	afterEach(() => {
		for (const child of children) {
			if (child.pid && !hasExited(child)) killProcessTree(child.pid);
		}
		children.length = 0;
	});

	it("resolves on abort, removes its listeners and leaves streams readable", async () => {
		const child = spawn("bash", ["-c", "sleep 0.2; echo hello; sleep 30"], {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.push(child);
		const counts = () => ({
			exit: child.listenerCount("exit"),
			close: child.listenerCount("close"),
			error: child.listenerCount("error"),
			stdoutData: child.stdout!.listenerCount("data"),
			stdoutEnd: child.stdout!.listenerCount("end"),
			stderrData: child.stderr!.listenerCount("data"),
		});
		const before = counts();
		const controller = new AbortController();
		const waiting = waitForChildProcess(child, controller.signal);
		expect(counts()).not.toEqual(before);
		child.stdout!.pause();
		child.stderr!.pause();
		controller.abort();
		await expect(waiting).resolves.toBeNull();
		expect(counts()).toEqual(before);
		expect(child.stdout!.destroyed).toBe(false);
		expect(child.stderr!.destroyed).toBe(false);

		let received = "";
		child.stdout!.on("data", (chunk: Buffer) => {
			received += chunk.toString();
		});
		child.stdout!.resume();
		await waitFor(() => received.includes("hello\n"));
		expect(hasExited(child)).toBe(false);
	});
});
