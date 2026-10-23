import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	lazyApi,
	type Message,
	type Model,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transformMessages } from "../../../ai/src/api/transform-messages.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionPersistenceError } from "../../src/core/session-manager.ts";
import { createBootstrappedSessionManager, createHarness, getMessageText, type Harness } from "./harness.ts";
import { createRpcHarness } from "./rpc-harness.ts";
import { createRuntimeHarness, type RuntimeHarness } from "./runtime-harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	onRawStdoutBroken: vi.fn(() => () => {}),
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

function describeMessage(message: { role: string }): string {
	return message.role === "system" || message.role === "assistant" || message.role === "toolResult"
		? message.role
		: `${message.role}:${getMessageText(message)}`;
}

function respond(
	requests: string[][],
	reply: () => ReturnType<typeof fauxAssistantMessage> = () => fauxAssistantMessage("ok"),
): FauxResponseFactory {
	return (context) => {
		requests.push(context.messages.map(describeMessage));
		return reply();
	};
}

function keyedDevelopers(harness: Harness): string[] {
	return harness.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "message" && entry.standingKey ? [`${entry.standingKey}:${getMessageText(entry.message)}`] : [],
		);
}

describe("AgentSession standing instructions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		options: { factories?: Array<(pi: ExtensionAPI) => void>; bootstrapped?: boolean; tools?: AgentTool[] } = {},
	): Promise<Harness> {
		const harness = await createHarness({
			extensionFactories: options.factories,
			tools: options.tools,
			initialActiveToolNames: options.tools?.map((tool) => tool.name),
			sessionManager: options.bootstrapped ? createBootstrappedSessionManager() : undefined,
		});
		harnesses.push(harness);
		return harness;
	}

	it("API: no-op for the desired value, replace before delivery, apply-only change, clear, and input checks", async () => {
		const harness = await setup({ bootstrapped: true });
		const session = harness.session;
		const stateEntries = () =>
			harness.sessionManager.getEntries().filter((entry) => entry.type === "standing_instruction").length;

		session.setStandingInstruction("mode", "Plan");
		expect(stateEntries()).toBe(1);
		session.setStandingInstruction("mode", "Plan");
		expect(stateEntries()).toBe(1);
		expect(session.getStandingInstruction("mode")).toEqual({
			content: "Plan",
			apply: "next-input",
			delivered: false,
		});
		session.setStandingInstruction("mode", "Plan", { apply: "next-request" });
		expect(stateEntries()).toBe(2);
		expect(session.getStandingInstruction("mode")?.apply).toBe("next-request");
		session.setStandingInstruction("mode", "Default");
		expect(session.getStandingInstruction("mode")).toMatchObject({ content: "Default", apply: "next-input" });
		session.clearStandingInstruction("mode");
		expect(session.getStandingInstruction("mode")).toBeUndefined();
		session.clearStandingInstruction("mode");
		expect(stateEntries()).toBe(4);
		expect(keyedDevelopers(harness)).toEqual([]);

		expect(() => session.setStandingInstruction("", "x")).toThrow("key must not be empty");
		expect(() => session.setStandingInstruction("mode", "  ")).toThrow("non-blank");
		session.dispose();
		expect(() => session.setStandingInstruction("mode", "x")).toThrow("disposed");
	});

	it("B writes pending values once each in key order before the staged one-shots", async () => {
		const harness = await setup({
			factories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.setStandingInstruction("b", "b1");
					});
					pi.on("before_agent_start", () => {
						pi.setStandingInstruction("b", "b2");
						pi.queueDeveloperMessage("one-shot");
					});
				},
			],
		});
		await harness.session.bindExtensions({});
		harness.session.setStandingInstruction("a", "a1");
		const requests: string[][] = [];
		harness.setResponses([respond(requests)]);

		await harness.session.prompt("go");

		expect(requests[0]).toEqual(["system", "developer:b2", "developer:a1", "developer:one-shot", "user:go"]);
		expect(keyedDevelopers(harness)).toEqual(["b:b2", "a:a1"]);
		expect(harness.session.getStandingInstruction("b")?.delivered).toBe(true);
	});

	it("next-input: an idle value is delivered after the next prompt, before its request, exactly once; passive content is no input", async () => {
		const delivered: string[] = [];
		const harness = await setup({
			bootstrapped: true,
			factories: [
				(pi) => {
					pi.on("standing_instruction_delivered", (event) => {
						delivered.push(`${event.key}:${event.content}`);
					});
				},
			],
		});
		await harness.session.bindExtensions({});
		const requests: string[][] = [];
		harness.setResponses([respond(requests), respond(requests)]);

		harness.session.setStandingInstruction("mode", "Plan");
		await harness.session.sendCustomMessage({ customType: "note", content: "passive", display: false });
		expect(keyedDevelopers(harness)).toEqual([]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");

		// The passive message is not an input: the value follows the prompt, not the passive message.
		expect(requests[0]?.filter((line) => line !== "system")).toEqual([
			"user:passive",
			"user:first",
			"developer:Plan",
		]);
		expect(requests[1]?.filter((line) => line === "developer:Plan")).toHaveLength(1);
		expect(delivered).toEqual(["mode:Plan"]);
	});

	it("next-request: a value set during a tool call is delivered after its result, in the same run", async () => {
		let api: ExtensionAPI | undefined;
		const tool: AgentTool = {
			name: "enter",
			label: "enter",
			description: "enter",
			parameters: Type.Object({}),
			execute: async () => {
				api!.setStandingInstruction("mode", "Plan", { apply: "next-request" });
				return { content: [{ type: "text", text: "entered" }], details: {} };
			},
		};
		const harness = await setup({
			tools: [tool],
			factories: [
				(pi) => {
					api = pi;
				},
			],
		});
		await harness.session.bindExtensions({});
		const requests: string[][] = [];
		harness.setResponses([
			respond(requests, () => fauxAssistantMessage([fauxToolCall("enter", {})], { stopReason: "toolUse" })),
			respond(requests),
		]);

		await harness.session.prompt("go");

		expect(requests[1]?.slice(-2)).toEqual(["toolResult", "developer:Plan"]);
	});

	it("fails closed: an eligible value whose append throws sends no request; the next prompt delivers it", async () => {
		const harness = await setup({ bootstrapped: true });
		const requests: string[][] = [];
		harness.setResponses([respond(requests), respond(requests)]);
		harness.session.setStandingInstruction("mode", "Plan");
		const original = harness.sessionManager.appendMessage.bind(harness.sessionManager);
		let failing = true;
		vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation((message, options) => {
			if (failing && options?.standingKey) throw new Error("boom");
			return original(message, options);
		});

		await harness.session.prompt("first");
		expect(requests).toHaveLength(0);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
		expect((harness.session.messages.at(-1) as { errorMessage?: string }).errorMessage).toContain(
			'Standing instruction "mode" could not be delivered: boom',
		);
		expect(harness.session.getStandingInstruction("mode")?.delivered).toBe(false);

		failing = false;
		await harness.session.prompt("second");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.filter((line) => line === "developer:Plan")).toHaveLength(1);
		expect(requests[0]?.at(-1)).toBe("developer:Plan");
	});

	/** A tool that runs `onRun` while the agent is streaming. */
	function sideTool(name: string, onRun: () => unknown): AgentTool {
		return {
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			execute: async () => {
				await onRun();
				return { content: [{ type: "text", text: name }], details: {} };
			},
		};
	}

	const toolCall = (name: string) => () => fauxAssistantMessage([fauxToolCall(name, {})], { stopReason: "toolUse" });

	/** Make appendMessage throw for keyed developers whose key `fails(key)` selects. */
	function failStandingAppend(harness: Harness, fails: (key: string) => boolean) {
		const original = harness.sessionManager.appendMessage.bind(harness.sessionManager);
		return vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation((message, options) => {
			if (options?.standingKey && fails(options.standingKey))
				throw new Error(`append ${options.standingKey} failed`);
			return original(message, options);
		});
	}

	const lastError = (harness: Harness) =>
		(harness.session.messages.findLast((message) => message.role === "assistant") as { errorMessage?: string })
			?.errorMessage;

	/**
	 * An extension whose agent_before_settle continues once, context-only (a boundary custom message, no
	 * queued input), at the first settle where `armed()` is true.
	 */
	function contextOnlyContinuation(armed: () => boolean) {
		return (pi: ExtensionAPI) => {
			let used = false;
			pi.on("agent_before_settle", () => {
				if (used || !armed()) return;
				used = true;
				return {
					entries: [{ type: "custom_message", customType: "cont", content: "continue now", display: false }],
					continue: true,
				};
			});
		};
	}

	describe("next-input", () => {
		it("is delivered after a custom-triggered start", async () => {
			const harness = await setup({ bootstrapped: true });
			const requests: string[][] = [];
			harness.setResponses([respond(requests)]);
			harness.session.setStandingInstruction("mode", "Plan");

			await harness.session.sendCustomMessage(
				{ customType: "kick", content: "kickoff", display: false },
				{ triggerTurn: true },
			);

			expect(requests[0]?.slice(-2)).toEqual(["user:kickoff", "developer:Plan"]);
			expect(keyedDevelopers(harness)).toEqual(["mode:Plan"]);
		});

		it("is delivered after a steer drained mid-run, not at the preceding tool-result boundary", async () => {
			let session: Harness["session"] | undefined;
			const harness = await setup({
				bootstrapped: true,
				tools: [
					sideTool("first", () => session!.setStandingInstruction("mode", "Plan")),
					sideTool("second", () => session!.steer("redirect")),
				],
			});
			session = harness.session;
			const requests: string[][] = [];
			harness.setResponses([
				respond(requests, toolCall("first")),
				respond(requests, toolCall("second")),
				respond(requests),
			]);

			await harness.session.prompt("go");

			expect(requests[1]?.filter((line) => line === "developer:Plan")).toEqual([]);
			expect(requests[2]?.slice(-3)).toEqual(["toolResult", "user:redirect", "developer:Plan"]);
			expect(keyedDevelopers(harness)).toEqual(["mode:Plan"]);
		});

		it("is delivered after a follow-up continued by agent.continue() after the run", async () => {
			let session: Harness["session"] | undefined;
			let queued = false;
			const harness = await setup({
				bootstrapped: true,
				factories: [
					(pi) => {
						pi.on("agent_before_settle", () => {
							if (queued) return;
							queued = true;
							session!.setStandingInstruction("mode", "Plan");
							void session!.followUp("later");
						});
					},
				],
			});
			session = harness.session;
			const requests: string[][] = [];
			harness.setResponses([respond(requests), respond(requests)]);

			await harness.session.prompt("go");

			expect(requests).toHaveLength(2);
			expect(requests[0]?.filter((line) => line === "developer:Plan")).toEqual([]);
			expect(requests[1]?.slice(-2)).toEqual(["user:later", "developer:Plan"]);
		});

		it("is not delivered on a context-only agent_before_settle continuation", async () => {
			let continued = false;
			let session: Harness["session"] | undefined;
			const harness = await setup({
				bootstrapped: true,
				factories: [
					(pi) => {
						pi.on("agent_before_settle", () => {
							if (continued) return;
							continued = true;
							session!.setStandingInstruction("mode", "Plan");
							return {
								entries: [
									{ type: "custom_message", customType: "cont", content: "continue now", display: false },
								],
								continue: true,
							};
						});
					},
				],
			});
			session = harness.session;
			const requests: string[][] = [];
			harness.setResponses([respond(requests), respond(requests), respond(requests)]);

			await harness.session.prompt("go");
			expect(requests).toHaveLength(2);
			expect(requests[1]?.at(-1)).toBe("user:continue now");
			expect(keyedDevelopers(harness)).toEqual([]);

			await harness.session.prompt("next");
			expect(requests[2]?.slice(-2)).toEqual(["user:next", "developer:Plan"]);
		});

		it("is not delivered for passive custom messages or bash results that arrive mid-run", async () => {
			let session: Harness["session"] | undefined;
			const harness = await setup({
				bootstrapped: true,
				tools: [
					sideTool("side", async () => {
						session!.setStandingInstruction("mode", "Plan");
						await session!.sendCustomMessage(
							{ customType: "note", content: "passive", display: false },
							{ triggerTurn: false },
						);
						session!.recordBashResult("ls", { output: "files", exitCode: 0, cancelled: false, truncated: false });
					}),
				],
			});
			session = harness.session;
			const requests: string[][] = [];
			harness.setResponses([respond(requests, toolCall("side")), respond(requests), respond(requests)]);

			await harness.session.prompt("go");
			expect(requests[1]).toContain("user:passive");
			expect(requests[1]?.filter((line) => line === "developer:Plan")).toEqual([]);
			expect(keyedDevelopers(harness)).toEqual([]);

			await harness.session.prompt("next");
			expect(requests[2]?.slice(-2)).toEqual(["user:next", "developer:Plan"]);
		});
	});

	it("reload and resume rebuild nothing: a pending next-request value survives and is delivered at the next request", async () => {
		const runtime = await createRuntimeHarness();
		try {
			const requests: string[][] = [];
			runtime.faux.setResponses([respond(requests), respond(requests), respond(requests)]);
			const session = () => runtime.runtime.session;
			await session().prompt("first");
			session().setStandingInstruction("mode", "Plan", { apply: "next-request" });
			const entryCount = () => session().sessionManager.getEntries().length;
			const before = entryCount();

			await session().reload();
			expect(entryCount()).toBe(before);
			expect(session().getStandingInstruction("mode")).toMatchObject({ apply: "next-request", delivered: false });

			const file = session().sessionFile!;
			await runtime.runtime.switchSession(file);
			expect(entryCount()).toBe(before);
			expect(session().getStandingInstruction("mode")).toMatchObject({ apply: "next-request", delivered: false });

			await session().prompt("second");
			expect(requests[1]?.slice(-2)).toEqual(["user:second", "developer:Plan"]);
			expect(session().getStandingInstruction("mode")?.delivered).toBe(true);
		} finally {
			await runtime.cleanup();
		}
	});

	describe("fail closed (Astra recheck 3 F3)", () => {
		it.each([
			["delivers before its request once the append works", true],
			["fails closed again while the append still throws", false],
		])("an inputless retry finds the key due: it %s", async (_label, worksOnRetry) => {
			let armed = false;
			const harness = await setup({ bootstrapped: true, factories: [contextOnlyContinuation(() => armed)] });
			const requests: string[][] = [];
			harness.setResponses([respond(requests), respond(requests)]);
			harness.session.setStandingInstruction("mode", "Plan");
			let failing = true;
			failStandingAppend(harness, () => failing);
			// The failed boundary ends the run; the settle boundary then continues without a new input.
			const spy = vi.spyOn(harness.session.agent, "continue");
			harness.session.subscribe((event) => {
				if (event.type === "agent_end" && !armed) {
					armed = true;
					failing = !worksOnRetry;
				}
			});

			await harness.session.prompt("first");

			expect(spy).toHaveBeenCalled();
			if (worksOnRetry) {
				expect(requests).toHaveLength(1);
				expect(requests[0]?.filter((line) => line === "developer:Plan")).toHaveLength(1);
				expect(requests[0]?.slice(-2)).toEqual(["user:continue now", "developer:Plan"]);
				expect(harness.session.getStandingInstruction("mode")?.delivered).toBe(true);
			} else {
				expect(requests).toHaveLength(0);
				expect(lastError(harness)).toContain('Standing instruction "mode" could not be delivered');
				expect(harness.session.getStandingInstruction("mode")?.delivered).toBe(false);
			}
		});

		it("the due latch is reset by reload and by tree navigation to another branch with the same key pending (§7.3)", async () => {
			const harness = await setup({ bootstrapped: true });
			harness.setResponses([respond([]), respond([])]);
			const due = () => [...(harness.session as unknown as { _standingDue: Set<string> })._standingDue];
			const rootLeaf = harness.sessionManager.getLeafId()!;
			let failing = true;
			failStandingAppend(harness, () => failing);

			harness.session.setStandingInstruction("mode", "Plan");
			await harness.session.prompt("first");
			expect(due()).toEqual(["mode"]);
			await harness.session.reload();
			expect(due()).toEqual([]);

			await harness.session.prompt("second");
			expect(due()).toEqual(["mode"]);
			// Another branch from the bootstrapped root, where the same key is pending with another value.
			failing = false;
			const firstLeaf = harness.sessionManager.getLeafId()!;
			harness.sessionManager.branch(rootLeaf);
			harness.session.setStandingInstruction("mode", "Default");
			const otherLeaf = harness.sessionManager.getLeafId()!;
			harness.sessionManager.branch(firstLeaf);
			await harness.session.navigateTree(otherLeaf, { summarize: false });
			expect(harness.session.getStandingInstruction("mode")?.delivered).toBe(false);
			expect(due()).toEqual([]);
		});

		it("already-acknowledged child: a next-request value set and acked at once; the task's boundary append throws", async () => {
			let acked = false;
			const harness = await setup({
				bootstrapped: true,
				factories: [
					(pi) => {
						pi.on("session_start", () => {
							pi.setStandingInstruction("subagent-profile", "profile", { apply: "next-request" });
							acked = true;
						});
					},
				],
			});
			await harness.session.bindExtensions({});
			expect(acked).toBe(true);
			const requests: string[][] = [];
			harness.setResponses([respond(requests)]);
			let failing = true;
			failStandingAppend(harness, () => failing);

			await harness.session.prompt("task");
			expect(requests).toHaveLength(0);
			expect(lastError(harness)).toContain('Standing instruction "subagent-profile" could not be delivered');

			failing = false;
			await harness.session.prompt("again");
			expect(requests).toHaveLength(1);
			expect(requests[0]?.slice(-2)).toEqual(["user:again", "developer:profile"]);
		});

		it("failed-B remainder: B fails on the second value; the next boundary also throws; a third prompt sends it", async () => {
			const harness = await setup();
			harness.session.setStandingInstruction("a", "A");
			harness.session.setStandingInstruction("b", "B");
			const requests: string[][] = [];
			harness.setResponses([respond(requests)]);
			let failing = true;
			failStandingAppend(harness, (key) => failing && key === "b");

			await expect(harness.session.prompt("first")).rejects.toThrow("append b failed");
			expect(requests).toHaveLength(0);

			await harness.session.prompt("second");
			expect(requests).toHaveLength(0);
			expect(lastError(harness)).toContain('Standing instruction "b" could not be delivered');

			failing = false;
			await harness.session.prompt("third");
			expect(requests).toHaveLength(1);
			expect(requests[0]?.slice(0, 2)).toEqual(["system", "developer:A"]);
			expect(requests[0]?.slice(-2)).toEqual(["user:third", "developer:B"]);
			expect(keyedDevelopers(harness)).toEqual(["a:A", "b:B"]);
		});

		it.each([
			["the first key fails", "a"],
			["the middle key fails after A commits", "b"],
		])(
			"batch latch (recheck 4 N1): %s; an inputless retry delivers every remaining key",
			async (_label, failingKey) => {
				let armed = false;
				const harness = await setup({ bootstrapped: true, factories: [contextOnlyContinuation(() => armed)] });
				const requests: string[][] = [];
				harness.setResponses([respond(requests)]);
				harness.session.setStandingInstruction("a", "A");
				harness.session.setStandingInstruction("b", "B");
				let failing = true;
				failStandingAppend(harness, (key) => failing && key === failingKey);
				harness.session.subscribe((event) => {
					if (event.type === "agent_end" && !armed) {
						expect(requests).toHaveLength(0);
						expect(lastError(harness)).toContain(`Standing instruction "${failingKey}" could not be delivered`);
						armed = true;
						failing = false;
					}
				});

				await harness.session.prompt("first");

				expect(requests).toHaveLength(1);
				expect(requests[0]?.filter((line) => line.startsWith("developer:"))).toEqual([
					"developer:A",
					"developer:B",
				]);
				expect(keyedDevelopers(harness)).toEqual(["a:A", "b:B"]);
				expect(harness.session.getStandingInstruction("a")?.delivered).toBe(true);
				expect(harness.session.getStandingInstruction("b")?.delivered).toBe(true);
			},
		);

		it("a one-shot whose append throws is reported and the request proceeds with the standing value", async () => {
			let session: Harness["session"] | undefined;
			const harness = await setup({
				bootstrapped: true,
				tools: [
					sideTool("side", () => {
						session!.setStandingInstruction("mode", "Plan", { apply: "next-request" });
						session!.queueDeveloperMessage("notice");
					}),
				],
			});
			session = harness.session;
			const errors: string[] = [];
			harness.session.extensionRunner.onError((error) => errors.push(error.error));
			const original = harness.sessionManager.appendMessage.bind(harness.sessionManager);
			vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation((message, options) => {
				if (message.role === "developer" && getMessageText(message) === "notice") throw new Error("notice failed");
				return original(message, options);
			});
			const requests: string[][] = [];
			harness.setResponses([respond(requests, toolCall("side")), respond(requests)]);

			await harness.session.prompt("go");

			expect(requests).toHaveLength(2);
			expect(requests[1]?.slice(-2)).toEqual(["toolResult", "developer:Plan"]);
			expect(errors).toContain("notice failed");
		});

		it("with persistenceError set the request at a standing boundary is refused", async () => {
			let failed = false;
			let session: Harness["session"] | undefined;
			const harness = await setup({
				bootstrapped: true,
				tools: [
					sideTool("side", () => {
						session!.setStandingInstruction("mode", "Plan", { apply: "next-request" });
						failed = true;
					}),
				],
			});
			session = harness.session;
			const error = new SessionPersistenceError(Object.assign(new Error("io"), { code: "EIO" }));
			vi.spyOn(harness.sessionManager, "getPersistenceError").mockImplementation(() => (failed ? error : undefined));
			const requests: string[][] = [];
			harness.setResponses([respond(requests, toolCall("side")), respond(requests)]);

			await harness.session.prompt("go");

			expect(requests).toHaveLength(1);
			expect(lastError(harness)).toContain("Session file write failed (EIO)");
		});
	});

	describe("legacy F2: a tagged v4 file with an old compaction C", () => {
		/** system → Plan mask[keyed] → user → assistant → old compaction C → user → assistant. */
		function writeLegacyFile(
			dir: string,
			retained: boolean,
			leafAtC = false,
		): { file: string; compactionId: string } {
			// Fixed ids, so the test can target C.
			const ts = new Date(0).toISOString();
			const assistant = fauxAssistantMessage("answer");
			const raw = [
				{ type: "message", id: "s1", message: { role: "system", content: "", sections: {}, timestamp: 0 } },
				{
					type: "message",
					id: "m1",
					standingKey: "collaboration-mode",
					message: { role: "developer", content: "Plan", timestamp: 0 },
				},
				{ type: "message", id: "u1", message: { role: "user", content: "task", timestamp: 0 } },
				{ type: "message", id: "a1", message: assistant },
				{
					type: "compaction",
					id: "c1",
					summary: "old summary",
					firstKeptEntryId: retained ? "m1" : "u1",
					tokensBefore: 100,
					// Migrated files carry a checkpoint on every compaction (§4.2 step 3); no `standing` field.
					systemMessage: { role: "system", content: "", sections: {}, timestamp: 0 },
				},
				{ type: "message", id: "u2", message: { role: "user", content: "after", timestamp: 0 } },
				{ type: "message", id: "a2", message: assistant },
			];
			const entries = (leafAtC ? raw.slice(0, 5) : raw).map((entry, index, all) => ({
				...entry,
				parentId: index === 0 ? null : all[index - 1]!.id,
				timestamp: ts,
			}));
			const header = { type: "session", version: 4, id: `legacy-${retained}-${leafAtC}`, timestamp: ts, cwd: dir };
			const file = join(dir, `legacy-${retained ? "retained" : "omitted"}-${leafAtC ? "c" : "leaf"}.jsonl`);
			writeFileSync(file, `${[header, ...entries].map((line) => JSON.stringify(line)).join("\n")}\n`);
			return { file, compactionId: "c1" };
		}

		const runtimes: RuntimeHarness[] = [];
		afterEach(async () => {
			while (runtimes.length > 0) await runtimes.pop()?.cleanup();
		});

		it.each([
			["navigate", false],
			["navigate", true],
			["fork", false],
			["fork", true],
			["resume", false],
			["resume", true],
		] as const)("%s to C (mask retained: %s)", async (how, retained) => {
			const runtime = await createRuntimeHarness();
			runtimes.push(runtime);
			const { file, compactionId } = writeLegacyFile(runtime.tempDir, retained, how === "resume");
			await runtime.runtime.switchSession(file);
			if (how === "navigate") await runtime.runtime.session.navigateTree(compactionId, { summarize: false });
			if (how === "fork") await runtime.runtime.fork(compactionId, { position: "at" });
			const session = runtime.runtime.session;
			if (how === "fork") expect(session.sessionFile).not.toBe(file);
			// The last context entry of the branch is C (fork and resume may add non-context entries).
			const branch = session.sessionManager.getBranch();
			const cIndex = branch.findIndex((entry) => entry.type === "compaction");
			expect(cIndex).toBeGreaterThan(0);
			expect(branch.slice(cIndex + 1).filter((entry) => entry.type === "message")).toEqual([]);
			// Writes beyond the file's one tagged mask: state entries or keyed developers.
			const written = () =>
				session.sessionManager
					.getEntries()
					.filter(
						(entry) =>
							entry.type === "standing_instruction" ||
							(entry.type === "message" && entry.standingKey !== undefined),
					).length - 1;
			expect(written()).toBe(0);
			expect(session.getStandingInstruction("collaboration-mode")).toMatchObject({
				content: "Plan",
				delivered: retained,
			});
			const requests: string[][] = [];
			runtime.faux.setResponses([respond(requests)]);

			await session.prompt("next");

			expect(requests[0]?.filter((line) => line === "developer:Plan")).toHaveLength(1);
			if (retained) {
				expect(written()).toBe(0);
			} else {
				expect(requests[0]?.slice(-2)).toEqual(["user:next", "developer:Plan"]);
				expect(written()).toBe(1);
			}
		});
	});

	it("delivered event: once per delivery (B, boundary, carry of a pending value), none on a re-carry; a throwing handler does not stop the others", async () => {
		const delivered: string[] = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("standing_instruction_delivered", () => {
						throw new Error("handler failed");
					});
				},
				(pi) => {
					pi.on("standing_instruction_delivered", (event) => {
						delivered.push(`${event.key}:${event.content}`);
					});
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const errors: string[] = [];
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		harness.setResponses([respond([]), respond([]), respond([]), respond([])]);

		harness.session.setStandingInstruction("mode", "Default");
		await harness.session.prompt("one");
		expect(delivered).toEqual(["mode:Default"]);
		harness.session.setStandingInstruction("mode", "Plan");
		await harness.session.prompt("two");
		expect(delivered).toEqual(["mode:Default", "mode:Plan"]);
		await harness.session.compact();
		expect(delivered).toEqual(["mode:Default", "mode:Plan"]);
		harness.session.setStandingInstruction("mode", "Default");
		await harness.session.prompt("three");
		harness.session.setStandingInstruction("mode", "Plan");
		await harness.session.compact();

		expect(delivered).toEqual(["mode:Default", "mode:Plan", "mode:Default", "mode:Plan"]);
		expect(errors.filter((error) => error === "handler failed")).toHaveLength(4);
	});

	it("a model without developer capability: values reach the journal, are dropped on the wire, no refusal; a capable model gets them", async () => {
		const harness = await createHarness({ models: [{ id: "plain" }, { id: "capable" }] });
		harnesses.push(harness);
		const wire: string[][] = [];
		const original = harness.session.agent.streamFunction as unknown as ProviderStreams["streamSimple"];
		const recording: ProviderStreams["streamSimple"] = (model, context, options) => {
			wire.push(transformMessages(context.messages as Message[], model).map(describeMessage));
			return original(model, context, options);
		};
		const api = lazyApi(async () => ({ stream: recording, streamSimple: recording }) as ProviderStreams);
		harness.session.agent.streamFunction = (model, context, options) => {
			const capable = model.id === "capable";
			return api.streamSimple(
				{
					...(model as Model<Api>),
					capabilities: { ...model.capabilities, midConversationInstructionMessages: capable },
					compat: { supportsMidConvoSystemMessages: capable },
				},
				context,
				options,
			);
		};
		harness.setResponses([respond([]), respond([]), respond([])]);
		await harness.session.setModel(harness.getModel("plain")!);

		await harness.session.prompt("first");
		harness.session.setStandingInstruction("mode", "Plan");
		await harness.session.prompt("second");

		expect(keyedDevelopers(harness)).toEqual(["mode:Plan"]);
		expect(harness.session.getStandingInstruction("mode")?.delivered).toBe(true);
		expect(wire[1]?.some((line) => line.startsWith("developer:"))).toBe(false);
		expect(lastError(harness)).toBeUndefined();

		await harness.session.setModel(harness.getModel("capable")!);
		await harness.session.prompt("third");
		expect(wire[2]?.filter((line) => line === "developer:Plan")).toHaveLength(1);
		expect(lastError(harness)).toBeUndefined();
	});

	it("RPC: a value set by an extension is delivered after the RPC prompt; get_state.pendingMessageCount stays 0", async () => {
		const requests: string[][] = [];
		const harness = await createRpcHarness(rpcIo, {
			extensionFactory: (pi) => {
				pi.registerCommand("plan", {
					description: "plan",
					handler: async () => {
						pi.setStandingInstruction("collaboration-mode", "Plan");
					},
				});
			},
		});
		try {
			harness.faux.setResponses([respond(requests), respond(requests)]);
			harness.send({ id: "p1", type: "prompt", message: "first" });
			await harness.waitForResponse("p1");
			await harness.runtime.session.waitForIdle();
			harness.send({ id: "c1", type: "prompt", message: "/plan" });
			await harness.waitForResponse("c1");
			harness.send({ id: "s1", type: "get_state" });
			const state = await harness.waitForResponse("s1");
			expect((state.data as { pendingMessageCount: number }).pendingMessageCount).toBe(0);
			expect(harness.runtime.session.getStandingInstruction("collaboration-mode")?.delivered).toBe(false);

			harness.send({ id: "p2", type: "prompt", message: "second" });
			await harness.waitForResponse("p2");
			await harness.runtime.session.waitForIdle();

			expect(requests[1]?.slice(-2)).toEqual(["user:second", "developer:Plan"]);
			harness.send({ id: "s2", type: "get_state" });
			const after = await harness.waitForResponse("s2");
			expect((after.data as { pendingMessageCount: number }).pendingMessageCount).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	describe("compaction", () => {
		type Compactor = (pi: ExtensionAPI, summary: () => string) => void;
		const summaryCompactor =
			(onBefore?: () => void, firstKept?: () => string | undefined, maxCompactions = Infinity): Compactor =>
			(pi, summary) => {
				let count = 0;
				pi.on("session_before_compact", async (event) => {
					if (++count > maxCompactions) return { cancel: true };
					onBefore?.();
					return {
						compaction: {
							summary: summary(),
							firstKeptEntryId: firstKept?.() ?? event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
			};

		async function compactionSetup(options: {
			onBefore?: (api: ExtensionAPI) => void;
			firstKept?: () => string | undefined;
			maxCompactions?: number;
			summary?: () => string;
			models?: Array<{ id: string; contextWindow: number; maxTokens: number }>;
			settings?: Record<string, unknown>;
			tools?: AgentTool[];
			bootstrapped?: boolean;
		}) {
			const delivered: Array<{ key: string; content: unknown; entryId: string }> = [];
			const compacted: string[] = [];
			let api: ExtensionAPI | undefined;
			const harness = await createHarness({
				models: options.models,
				settings: options.settings ?? { compaction: { keepRecentTokens: 1 } },
				tools: options.tools,
				sessionManager: options.bootstrapped === false ? undefined : createBootstrappedSessionManager(),
				extensionFactories: [
					(pi) => {
						api = pi;
						summaryCompactor(
							() => options.onBefore?.(pi),
							options.firstKept,
							options.maxCompactions,
						)(pi, options.summary ?? (() => "summary"));
						pi.on("standing_instruction_delivered", (event) => {
							delivered.push({ key: event.key, content: event.content, entryId: event.entryId });
						});
						pi.on("session_compact", (event) => {
							compacted.push(event.compactionEntry.id);
						});
					},
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			return { harness, delivered, compacted, api: () => api! };
		}

		const latestCompaction = (harness: Harness) => {
			const entry = harness.sessionManager
				.getBranch()
				.filter((item) => item.type === "compaction")
				.at(-1);
			if (entry?.type !== "compaction") throw new Error("expected a compaction");
			return entry;
		};

		it.each([
			["Default", "Plan"],
			["Plan", "Default"],
		])(
			"conflicting masks (B2): kept %s, pending %s; /compact carries the pending value and hides the kept copy",
			async (kept, pending) => {
				let keepFrom: string | undefined;
				const { harness, delivered, compacted } = await compactionSetup({ firstKept: () => keepFrom });
				const requests: string[][] = [];
				harness.setResponses([respond(requests), respond(requests), respond(requests), respond(requests)]);
				await harness.session.prompt("one");
				harness.session.setStandingInstruction("mode", kept);
				await harness.session.prompt("two");
				keepFrom = harness.sessionManager
					.getBranch()
					.find((entry) => entry.type === "message" && getMessageText(entry.message) === "two")?.id;
				harness.session.setStandingInstruction("mode", pending);
				delivered.length = 0;

				await harness.session.compact();

				const compaction = latestCompaction(harness);
				const branch = harness.sessionManager.getBranch();
				const keptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
				expect(
					branch.slice(keptIndex).some((entry) => entry.type === "message" && entry.standingKey === "mode"),
				).toBe(true);
				expect(compaction.standing?.map((item) => `${item.key}:${getMessageText(item.message)}`)).toEqual([
					`mode:${pending}`,
				]);
				expect(delivered).toEqual([{ key: "mode", content: pending, entryId: compaction.id }]);
				expect(compacted).toEqual([compaction.id]);
				expect(harness.session.getStandingInstruction("mode")).toMatchObject({ delivered: true });

				await harness.session.prompt("three");
				const request = requests.at(-1) ?? [];
				expect(request.slice(0, 2)).toEqual(["system", `developer:${pending}`]);
				expect(request.filter((line) => line.startsWith("developer:"))).toEqual([`developer:${pending}`]);
				expect(keyedDevelopers(harness).filter((line) => line === `mode:${pending}`)).toEqual([]);
				expect(delivered).toHaveLength(1);
			},
		);

		it("a value set while the summarizer runs is in a between-runs carry (post-run overflow without retry)", async () => {
			const { harness, delivered } = await compactionSetup({
				models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
				settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
				onBefore: (pi) => pi.setStandingInstruction("mode", "Plan"),
			});
			harness.setResponses([fauxAssistantMessage("answer")]);

			await harness.session.prompt("hello");

			const compaction = latestCompaction(harness);
			expect(compaction.standing?.map((item) => getMessageText(item.message))).toEqual(["Plan"]);
			expect(delivered).toEqual([{ key: "mode", content: "Plan", entryId: compaction.id }]);
			expect(harness.session.getStandingInstruction("mode")?.delivered).toBe(true);
		});

		it("boundary compaction drafts carry the delivered values; the pending one follows the next input", async () => {
			let draft = false;
			let api: ExtensionAPI | undefined;
			const delivered: string[] = [];
			const harness = await createHarness({
				sessionManager: createBootstrappedSessionManager(),
				extensionFactories: [
					(pi) => {
						api = pi;
						pi.on("standing_instruction_delivered", (event) => {
							delivered.push(`${event.key}:${event.content}`);
						});
						pi.on("turn_end", () => {
							if (!draft) return;
							draft = false;
							pi.setStandingInstruction("mode", "Plan");
							return { entries: [{ type: "compaction", summary: "handoff", firstKeptEntryId: null }] };
						});
					},
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			const requests: string[][] = [];
			harness.setResponses([respond(requests), respond(requests), respond(requests)]);
			api!.setStandingInstruction("mode", "Default");
			await harness.session.prompt("one");
			draft = true;
			delivered.length = 0;
			await harness.session.prompt("two");

			const compaction = latestCompaction(harness);
			expect(compaction.standing?.map((item) => `${item.key}:${getMessageText(item.message)}`)).toEqual([
				"mode:Default",
			]);
			expect(delivered).toEqual([]);
			expect(harness.session.getStandingInstruction("mode")).toMatchObject({ content: "Plan", delivered: false });

			await harness.session.prompt("three");
			const request = requests.at(-1) ?? [];
			expect(request.slice(0, 2)).toEqual(["system", "developer:Default"]);
			expect(request.slice(-2)).toEqual(["user:three", "developer:Plan"]);
			expect(delivered).toEqual(["mode:Plan"]);
		});

		it("two compactions with identical summaries: session_compact receives the new entry", async () => {
			const { harness, compacted } = await compactionSetup({ summary: () => "same" });
			harness.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b"), fauxAssistantMessage("c")]);
			await harness.session.prompt("one");
			await harness.session.prompt("two");
			await harness.session.compact();
			const first = latestCompaction(harness).id;
			await harness.session.prompt("three");
			await harness.session.compact();
			const second = latestCompaction(harness).id;

			expect(second).not.toBe(first);
			expect(compacted).toEqual([first, second]);
		});

		it("mid-run threshold compaction carries the delivered value; the pending one follows the next input; tree R3", async () => {
			const largeTool: AgentTool = {
				name: "large_result",
				label: "Large result",
				description: "Returns enough content to cross the compaction threshold",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [{ type: "text", text: `large-tool-result:${"x".repeat(7400)}` }],
					details: {},
				}),
			};
			let setPlan = false;
			const { harness, delivered } = await compactionSetup({
				models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
				settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
				tools: [largeTool],
				bootstrapped: false,
				maxCompactions: 1,
				onBefore: (pi) => {
					if (setPlan) pi.setStandingInstruction("mode", "Plan");
				},
			});
			const requests: string[][] = [];
			harness.setResponses([
				respond(requests, () => fauxAssistantMessage(`old-history:${"a".repeat(800)}`)),
				respond(requests, () => fauxAssistantMessage(`recent-history:${"b".repeat(800)}`)),
				respond(requests, () => fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" })),
				respond(requests, () => fauxAssistantMessage("after compaction")),
				respond(requests),
				respond(requests),
				respond(requests),
			]);
			harness.session.setStandingInstruction("mode", "Default");
			await harness.session.prompt("seed old history");
			await harness.session.prompt("seed recent history");
			setPlan = true;
			delivered.length = 0;
			await harness.session.prompt("run the large tool");

			// The threshold compaction in prepareNextTurn is mid-run: it carries the delivered Default and
			// emits no delivered event; Plan stays pending until the next input.
			const compaction = latestCompaction(harness);
			expect(compaction.standing?.map((item) => getMessageText(item.message))).toEqual(["Default"]);
			expect(delivered).toEqual([]);
			expect(requests[3]?.filter((line) => line.startsWith("developer:"))).toEqual(["developer:Default"]);
			expect(harness.session.getStandingInstruction("mode")).toMatchObject({ content: "Plan", delivered: false });

			await harness.session.prompt("next");
			expect(requests[4]?.slice(-2)).toEqual(["user:next", "developer:Plan"]);
			expect(delivered).toEqual([expect.objectContaining({ key: "mode", content: "Plan" })]);
			const leaf = harness.sessionManager.getLeafId();
			if (!leaf) throw new Error("expected a leaf");

			// Tree (Astra R3): at C Plan is pending again and the next input gets it; back at the leaf it is
			// delivered and nothing is sent.
			await harness.session.navigateTree(compaction.id, { summarize: false });
			expect(harness.session.getStandingInstruction("mode")).toMatchObject({ content: "Plan", delivered: false });
			await harness.session.prompt("from C");
			expect(requests[5]?.slice(-2)).toEqual(["user:from C", "developer:Plan"]);
			await harness.session.navigateTree(leaf, { summarize: false });
			expect(harness.session.getStandingInstruction("mode")?.delivered).toBe(true);
			const keyedBefore = keyedDevelopers(harness).length;
			await harness.session.prompt("at leaf");
			expect(keyedDevelopers(harness)).toHaveLength(keyedBefore);
		});

		it("retry + queued follow-up (R1): the retry has the delivered value only; the follow-up gets the pending one once", async () => {
			let session: Harness["session"] | undefined;
			const { harness } = await compactionSetup({
				models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
				settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
				bootstrapped: false,
				onBefore: (pi) => {
					pi.setStandingInstruction("mode", "Plan");
					void session!.followUp("follow");
				},
			});
			session = harness.session;
			const requests: string[][] = [];
			harness.setResponses([
				respond(requests, () => fauxAssistantMessage("partial", { stopReason: "length" })),
				respond(requests, () => fauxAssistantMessage("completed")),
				respond(requests, () => fauxAssistantMessage("followed")),
			]);
			harness.session.setStandingInstruction("mode", "Default");

			await harness.session.prompt("x".repeat(5000));
			await harness.session.agent.waitForIdle();

			expect(requests).toHaveLength(3);
			const developers = (request: string[] | undefined) => request?.filter((line) => line.startsWith("developer:"));
			expect(developers(requests[1])).toEqual(["developer:Default"]);
			expect(developers(requests[2])).toEqual(["developer:Default", "developer:Plan"]);
			expect(requests[2]?.slice(-2)).toEqual(["user:follow", "developer:Plan"]);
			expect(keyedDevelopers(harness).filter((line) => line === "mode:Plan")).toHaveLength(1);
		});
	});
});
