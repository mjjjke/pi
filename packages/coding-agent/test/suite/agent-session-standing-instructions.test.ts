import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createBootstrappedSessionManager, createHarness, getMessageText, type Harness } from "./harness.ts";

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
