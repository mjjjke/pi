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
});
