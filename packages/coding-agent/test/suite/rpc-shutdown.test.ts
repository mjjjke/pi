import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/index.ts";
import { RPC_SHUTDOWN_BUDGET_MS } from "../../src/modes/rpc/rpc-mode.ts";
import { createRpcHarness, type RpcHarness } from "./rpc-harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
	flush: (async () => {}) as () => Promise<void>,
	flushCalls: 0,
	onBroken: undefined as (() => void) | undefined,
}));

vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(() => {
		rpcIo.flushCalls++;
		return rpcIo.flush();
	}),
	onRawStdoutBroken: vi.fn((handler: () => void) => {
		rpcIo.onBroken = handler;
		return () => {
			if (rpcIo.onBroken === handler) rpcIo.onBroken = undefined;
		};
	}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

interface Gate {
	promise: Promise<void>;
	open: () => void;
}

function gate(): Gate {
	let open = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

interface Exit {
	code: number | undefined;
	at: number;
}

describe("RPC shutdown on stdin EOF", () => {
	const harnesses: RpcHarness[] = [];
	const releases: Array<() => void> = [];
	let exits: Exit[] = [];

	afterEach(async () => {
		for (const release of releases.splice(0)) release();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
		vi.restoreAllMocks();
		rpcIo.flush = async () => {};
		rpcIo.flushCalls = 0;
		rpcIo.onBroken = undefined;
		exits = [];
	});

	async function setup(extensionFactory?: ExtensionFactory): Promise<{
		harness: RpcHarness;
		sigterm: () => void;
		dispose: ReturnType<typeof vi.spyOn>;
	}> {
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exits.push({ code, at: Date.now() });
		}) as typeof process.exit);
		const before = new Set(process.listeners("SIGTERM"));
		const harness = await createRpcHarness(rpcIo, { extensionFactory });
		harnesses.push(harness);
		const handler = process.listeners("SIGTERM").find((listener) => !before.has(listener));
		if (!handler) throw new Error("RPC mode did not register a SIGTERM handler");
		const dispose = vi.spyOn(harness.runtime, "dispose");
		return { harness, sigterm: () => (handler as () => void)(), dispose };
	}

	/** A provider response that blocks until the request is aborted (cooperative) or released. */
	function heldResponse(harness: RpcHarness, options: { cooperative: boolean }): Promise<void> {
		const started = gate();
		const release = gate();
		releases.push(release.open);
		harness.faux.setResponses([
			async (_context, streamOptions) => {
				started.open();
				if (options.cooperative) {
					await new Promise<void>((resolve) => {
						streamOptions?.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
				} else {
					await release.promise;
				}
				return fauxAssistantMessage("partial answer", { stopReason: "aborted" });
			},
		]);
		return started.promise;
	}

	function eof(): number {
		process.stdin.emit("end");
		return Date.now();
	}

	async function waitForExit(): Promise<Exit> {
		await vi.waitFor(() => expect(exits.length).toBeGreaterThan(0), { timeout: RPC_SHUTDOWN_BUDGET_MS + 2000 });
		return exits[0]!;
	}

	function persistedAssistantStops(harness: RpcHarness): string[] {
		const dir = join(harness.tempDir, "sessions");
		return readdirSync(dir)
			.filter((file) => file.endsWith(".jsonl"))
			.flatMap((file) => readFileSync(join(dir, file), "utf8").split("\n"))
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as { type: string; message?: { role: string; stopReason?: string } })
			.flatMap((entry) =>
				entry.type === "message" && entry.message?.role === "assistant" ? [entry.message.stopReason ?? ""] : [],
			);
	}

	it("persists the aborted assistant of a cooperative stream and exits 0 within the budget", async () => {
		const { harness } = await setup();
		const started = heldResponse(harness, { cooperative: true });
		harness.send({ id: "p1", type: "prompt", message: "work" });
		await started;

		const at = eof();
		const exit = await waitForExit();

		expect(exit.code).toBe(0);
		expect(exit.at - at).toBeLessThan(RPC_SHUTDOWN_BUDGET_MS);
		expect(persistedAssistantStops(harness)).toEqual(["aborted"]);
		expect(rpcIo.flushCalls).toBe(1);
		expect(exits).toHaveLength(1);
	});

	it("exits at the budget when the stream ignores the abort, without a partial message", async () => {
		const { harness, dispose } = await setup();
		const started = heldResponse(harness, { cooperative: false });
		harness.send({ id: "p1", type: "prompt", message: "work" });
		await started;

		const at = eof();
		const exit = await waitForExit();

		expect(exit.code).toBe(0);
		expect(exit.at - at).toBeGreaterThanOrEqual(RPC_SHUTDOWN_BUDGET_MS - 50);
		expect(exit.at - at).toBeLessThan(RPC_SHUTDOWN_BUDGET_MS + 1000);
		expect(dispose).toHaveBeenCalledWith({ handlersDispatched: true });
		expect(
			harness.runtime.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "message" && entry.message.role === "assistant"),
		).toBe(false);
	});

	it("dispatches a hung session_shutdown handler once and still disposes at the budget", async () => {
		const handlerGate = gate();
		releases.push(handlerGate.open);
		let handlerCalls = 0;
		const { harness, dispose } = await setup((pi) => {
			pi.on("session_shutdown", async () => {
				handlerCalls++;
				await handlerGate.promise;
			});
		});

		const at = eof();
		const exit = await waitForExit();

		expect(exit.code).toBe(0);
		expect(exit.at - at).toBeGreaterThanOrEqual(RPC_SHUTDOWN_BUDGET_MS - 50);
		expect(handlerCalls).toBe(1);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledWith({ handlersDispatched: true });
		expect(() => harness.runtime.session.queueDeveloperMessage("late")).toThrow(/disposed/);
	});

	it("rejects a prompt whose preflight is in flight at EOF: error response, no run, nothing queued", async () => {
		const inputStarted = gate();
		const inputGate = gate();
		releases.push(inputGate.open);
		const { harness } = await setup((pi) => {
			pi.on("input", async () => {
				inputStarted.open();
				await inputGate.promise;
				return { action: "continue" };
			});
		});
		harness.faux.setResponses([fauxAssistantMessage("should not run")]);

		harness.send({ id: "p1", type: "prompt", message: "late prompt" });
		await inputStarted.promise;
		eof();
		inputGate.open();

		const response = await harness.waitForResponse("p1");
		expect(response).toMatchObject({
			success: false,
			error: "prompt cancelled: session shutting down",
		});
		await waitForExit();
		expect(harness.records().some((record) => record.type === "agent_start")).toBe(false);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.runtime.session.pendingMessageCount).toBe(0);
		expect(harness.runtime.session.sessionManager.getEntries().some((entry) => entry.type === "message")).toBe(false);
	});

	it("answers commands after EOF with a shutting-down error", async () => {
		const handlerGate = gate();
		releases.push(handlerGate.open);
		const { harness } = await setup((pi) => {
			pi.on("session_shutdown", async () => {
				await handlerGate.promise;
			});
		});

		eof();
		harness.send({ id: "s1", type: "get_state" });

		expect(await harness.waitForResponse("s1")).toMatchObject({ success: false, error: "shutting down" });
		handlerGate.open();
		await waitForExit();
	});

	it("cancels a pending extension dialog", async () => {
		const results: boolean[] = [];
		const { harness } = await setup((pi) => {
			pi.registerCommand("ask", {
				description: "Ask",
				handler: async (_args, ctx) => {
					results.push(await ctx.ui.confirm("Proceed?", "Really?"));
				},
			});
		});

		harness.send({ id: "c1", type: "prompt", message: "/ask" });
		await vi.waitFor(() =>
			expect(harness.records().some((record) => record.type === "extension_ui_request")).toBe(true),
		);
		eof();

		await vi.waitFor(() => expect(results).toEqual([false]));
		await waitForExit();
	});

	it("uses one shutdown for EOF and a concurrent shutdown request", async () => {
		let handlerCalls = 0;
		const { harness, dispose } = await setup((pi) => {
			pi.on("agent_start", (_event, ctx) => ctx.shutdown());
			pi.on("session_shutdown", async () => {
				handlerCalls++;
			});
		});
		const started = heldResponse(harness, { cooperative: true });
		harness.send({ id: "p1", type: "prompt", message: "work" });
		await started;

		eof();
		await waitForExit();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(harness.records().some((record) => record.type === "agent_settled")).toBe(true);
		expect(exits).toHaveLength(1);
		expect(exits[0]!.code).toBe(0);
		expect(handlerCalls).toBe(1);
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("escalates SIGTERM during an EOF drain: skips remaining phases and exits 143", async () => {
		let handlerCalls = 0;
		const { harness, sigterm, dispose } = await setup((pi) => {
			pi.on("session_shutdown", async () => {
				handlerCalls++;
			});
		});
		const started = heldResponse(harness, { cooperative: false });
		harness.send({ id: "p1", type: "prompt", message: "work" });
		await started;

		eof();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const at = Date.now();
		sigterm();
		const exit = await waitForExit();

		expect(exit.code).toBe(143);
		expect(exit.at - at).toBeLessThan(500);
		expect(handlerCalls).toBe(0);
		expect(dispose).toHaveBeenCalledWith({ handlersDispatched: true });
		expect(exits).toHaveLength(1);
	});

	it("keeps a SIGTERM-triggered shutdown: handlers dispatched once, disposed, exit 143", async () => {
		let handlerCalls = 0;
		const { sigterm, dispose } = await setup((pi) => {
			pi.on("session_shutdown", async () => {
				handlerCalls++;
			});
		});

		sigterm();
		const exit = await waitForExit();

		expect(exit.code).toBe(143);
		expect(handlerCalls).toBe(1);
		expect(dispose).toHaveBeenCalledWith({ handlersDispatched: true });
		expect(rpcIo.flushCalls).toBe(0);
	});

	it("runs the bounded shutdown when stdout's reader is gone: aborted assistant persisted, exit 0 once", async () => {
		const { harness, dispose } = await setup();
		const started = heldResponse(harness, { cooperative: true });
		harness.send({ id: "p1", type: "prompt", message: "work" });
		await started;

		expect(rpcIo.onBroken).toBeDefined();
		const at = Date.now();
		rpcIo.onBroken?.();
		// The parent's death also closes stdin; both triggers share one shutdown.
		eof();
		const exit = await waitForExit();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(exit.code).toBe(0);
		expect(exit.at - at).toBeLessThan(RPC_SHUTDOWN_BUDGET_MS);
		expect(persistedAssistantStops(harness)).toEqual(["aborted"]);
		expect(exits).toHaveLength(1);
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("ignores a gone stderr reader instead of crashing", async () => {
		await setup();
		const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

		expect(() => process.stderr.emit("error", epipe)).not.toThrow();
		eof();
		await waitForExit();
	});

	it("exits without waiting on stdout once the budget is spent", async () => {
		const stuckFlush = gate();
		releases.push(stuckFlush.open);
		rpcIo.flush = () => stuckFlush.promise;
		const { harness } = await setup();
		const started = heldResponse(harness, { cooperative: false });
		harness.send({ id: "p1", type: "prompt", message: "work" });
		await started;

		const at = eof();
		const exit = await waitForExit();

		expect(exit.code).toBe(0);
		expect(exit.at - at).toBeLessThan(RPC_SHUTDOWN_BUDGET_MS + 1000);
	});
});
