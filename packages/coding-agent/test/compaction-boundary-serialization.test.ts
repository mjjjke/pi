import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { convertMessages as convertAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { convertMessages as convertGoogle } from "@earendil-works/pi-ai/api/google-shared";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { describe, expect, it } from "vitest";
import {
	COMPACTION_BOUNDARY_TEXT_V1,
	type CompactionBoundaryMessage,
	convertToLlm,
	createCompactionBoundaryMessage,
} from "../src/core/messages.ts";

const BOUNDARY = createCompactionBoundaryMessage(COMPACTION_BOUNDARY_TEXT_V1, "2026-10-24T00:00:00.000Z");

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

/** `[summary, kept user, kept assistant, boundary, new user]` as the projection emits it. */
const projected: AgentMessage[] = [
	{ role: "compactionSummary", summary: "SUMMARY", tokensBefore: 10, timestamp: 1 },
	{ role: "user", content: "kept prompt", timestamp: 1 },
	assistant("kept reply"),
	BOUNDARY,
	{ role: "user", content: "new prompt", timestamp: 3 },
];

function textsOf(value: unknown): string[] {
	const texts: string[] = [];
	const walk = (node: unknown) => {
		if (Array.isArray(node)) node.forEach(walk);
		else if (node && typeof node === "object") {
			for (const [key, child] of Object.entries(node)) {
				if ((key === "text" && typeof child === "string") || (key === "content" && typeof child === "string")) {
					texts.push(child);
				} else walk(child);
			}
		}
	};
	walk(value);
	return texts;
}

function expectOrder(texts: string[]): void {
	const at = (needle: string) => texts.findIndex((text) => text.includes(needle));
	expect(at("kept reply")).toBeGreaterThanOrEqual(0);
	expect(at("Compaction boundary (not a request)")).toBeGreaterThan(at("kept reply"));
	expect(at("new prompt")).toBeGreaterThan(at("Compaction boundary (not a request)"));
	expect(texts).toContain(COMPACTION_BOUNDARY_TEXT_V1);
}

describe("compaction boundary message (A2)", () => {
	it("is a timestamped message of its own role, built from the stored text", () => {
		const message: CompactionBoundaryMessage = BOUNDARY;
		expect(message).toEqual({
			role: "compactionBoundary",
			text: COMPACTION_BOUNDARY_TEXT_V1,
			timestamp: Date.parse("2026-10-24T00:00:00.000Z"),
		});
	});

	it("converts to user-role text in place", () => {
		const llm = convertToLlm(projected);
		expect(llm.map((message) => message.role)).toEqual(["user", "user", "assistant", "user", "user"]);
		expect(llm[3]).toEqual({
			role: "user",
			content: [{ type: "text", text: COMPACTION_BOUNDARY_TEXT_V1 }],
			timestamp: BOUNDARY.timestamp,
		});
	});

	it("Anthropic keeps the text and its order when user messages merge", () => {
		const converted = convertAnthropic(convertToLlm(projected) as Message[], false);
		expectOrder(textsOf(converted.messages));
	});

	it("OpenAI Responses / Codex keep the text and its order", () => {
		const model = {
			id: "gpt-test",
			name: "gpt-test",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		} satisfies Model<"openai-codex-responses">;
		const converted = convertResponsesMessages(
			model,
			normalizeContext({ messages: convertToLlm(projected) }),
			new Set(["openai-codex"]),
		);
		expectOrder(textsOf(converted));
	});

	it("a model without instruction messages (Google) keeps it as user text", () => {
		const model = {
			id: "gemini-test",
			name: "gemini-test",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		} satisfies Model<"google-generative-ai">;
		const converted = convertGoogle(model, normalizeContext({ messages: convertToLlm(projected) }));
		expectOrder(textsOf(converted));
		const boundaryTurn = converted.find((content) => textsOf(content).includes(COMPACTION_BOUNDARY_TEXT_V1));
		expect(boundaryTurn?.role).toBe("user");
	});
});
