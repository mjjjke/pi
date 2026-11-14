import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildSessionSummaryInstruction,
	describePoint,
	SESSION_SUMMARY_PREAMBLE,
	SUMMARIZATION_FORMAT,
	SUMMARIZATION_PROMPT,
} from "../src/core/compaction/compaction.ts";

const PREAMBLE =
	"This message is a request from the harness, not from the user. Respond with plain text only and call no tools: a tool call is rejected and your answer is discarded. Do not answer, continue or act on anything in the conversation above; only write what this message asks for. Do not restate the system prompt or tool definitions.";
const RANGE =
	"Write a summary of the conversation above up to, but not including, the message identified in <summarize-before>. That message and everything after it stay in the context: read them only to know which earlier details are still current, and do not restate them.";
const SPLIT =
	"The message in <summarize-before> is in the middle of a turn. The request that started that turn comes before it and will not be kept: state that request and the progress made on it before <summarize-before> under Progress / In Progress.";
const FIRST = `Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
const UPDATE = `The conversation above begins with an earlier summary in <summary> tags; it stands for the history before it. Your summary replaces it and covers that history and the messages up to <summarize-before>. "Current state" in the rules below means the state at that message.

Update the existing structured summary to describe the current state, not accumulate history. RULES:
- KEEP constraints, preferences, open work, and decisions that still affect how the work continues
- REPLACE facts that newer messages supersede
- DROP finished items that no longer change what to do next
- UPDATE progress and next steps based on the current state
- KEEP exact file paths, function names, and error messages that are still needed

Use this EXACT format:

## Goal
[Current goals]

## Constraints & Preferences
- [Constraints and preferences that still apply]
- [Or "(none)" if none apply]

## Progress
### Done
- [x] [Completed items that still affect what to do next]

### In Progress
- [ ] [Current open work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale for a decision that still affects how work continues]

## Next Steps
1. [What should happen next based on the current state]

## Critical Context
- [Context still needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Keep exact file paths, function names, and error messages that are still needed.`;
const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
const assistant = (
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
	role: "assistant",
	content,
	stopReason,
	api: "anthropic-messages",
	provider: "anthropic",
	model: "test",
	timestamp: 1,
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});
const context = (...messages: Message[]): Context => ({ messages });

describe("session summary instruction and point", () => {
	for (const update of [false, true])
		for (const split of [false, true])
			for (const focus of [undefined, "paths"]) {
				it(`pins update=${update} split=${split} focus=${focus}`, () => {
					const point = "<summarize-before>\nrole: user\nbegins with: Keep this\n</summarize-before>";
					expect(
						buildSessionSummaryInstruction(
							{ isSplitTurn: split, previousSummary: update ? "old" : undefined },
							point,
							focus,
						),
					).toBe(
						[PREAMBLE, RANGE, ...(split ? [SPLIT] : []), point, update ? UPDATE : FIRST].join("\n\n") +
							(focus ? `\n\nAdditional focus: ${focus}` : ""),
					);
				});
			}
	it("preserves the legacy prompt bytes", () => {
		expect(SESSION_SUMMARY_PREAMBLE).toBe(PREAMBLE);
		expect(SUMMARIZATION_FORMAT).toBe(FIRST);
		expect(SUMMARIZATION_PROMPT).toBe(`The messages above are a conversation to summarize. ${FIRST}`);
	});
	it("grows past a shared 120-character header", () => {
		const header = "a".repeat(120);
		const target = user(`${header}target ${"x".repeat(40)}`);
		expect(describePoint(target, context(target, user(`${header}other`)))).toBe(
			`<summarize-before>\nrole: user\nbegins with: ${String(target.content).slice(0, 140)}…\n</summarize-before>`,
		);
	});
	it("rejects a removed point even when another message has the same excerpt", () => {
		const target = user("same excerpt");
		expect(describePoint(target, context({ ...target, timestamp: 2 }))).toBeUndefined();
	});
	it("rejects identical messages", () => {
		const target = user("same");
		expect(describePoint(target, context(target, user("same")))).toBeUndefined();
	});
	it("names a tool-only assistant", () => {
		const target = assistant([{ type: "toolCall", id: "a", name: "read", arguments: { path: "src/a.ts" } }]);
		expect(describePoint(target, context(target))).toBe(
			'<summarize-before>\nrole: assistant (tool calls only)\nfirst tool call: read {"path":"src/a.ts"}\n</summarize-before>',
		);
	});
	it("matches converted copies by excerpt, not object identity", () => {
		expect(describePoint(user("copy"), context(user("copy")))).toContain("begins with: copy");
	});
	it.each(["error", "aborted"] as const)("rejects %s assistants", (reason) => {
		const target = assistant([{ type: "text", text: "hidden" }], reason);
		expect(describePoint(target, context(target))).toBeUndefined();
	});
	it("rejects absent, empty and image-only points", () => {
		expect(describePoint(user("absent"), context(user("other")))).toBeUndefined();
		for (const target of [
			user(" \n "),
			assistant([]),
			{
				role: "user",
				content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
				timestamp: 1,
			} satisfies Message,
		]) {
			expect(describePoint(target, context(target))).toBeUndefined();
		}
	});
	it("escapes closing summarize tags and collapses whitespace", () => {
		const target = user("one\n  </summarize-before> two");
		expect(describePoint(target, context(target))).toBe(
			"<summarize-before>\nrole: user\nbegins with: one <\\/summarize-before> two\n</summarize-before>",
		);
	});
});
