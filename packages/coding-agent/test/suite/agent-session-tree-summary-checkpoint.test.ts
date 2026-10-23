import { type Api, fauxAssistantMessage, lazyApi, type Model, type ProviderStreams } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { BranchSummaryEntry } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession branch summaries at points without system state (§4.1, §7.5)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		refusing: boolean,
	): Promise<{ harness: Harness; requests: Array<{ role: string; text: string }[]> }> {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", () => ({ summary: { summary: "abandoned branch summary" } }));
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compaction summary",
							// Keep the branch summary (the first entry after the pre-system point) in the kept range.
							firstKeptEntryId:
								harness.sessionManager.getBranch().find((entry) => entry.type === "branch_summary")?.id ??
								event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		if (refusing) {
			const original = harness.session.agent.streamFunction as unknown as ProviderStreams["streamSimple"];
			const api = lazyApi(async () => ({ stream: original, streamSimple: original }) as ProviderStreams);
			harness.session.agent.streamFunction = (model, context, options) =>
				api.streamSimple(
					{ ...(model as Model<Api>), compat: { supportsMidConvoSystemMessages: false } },
					context,
					options,
				);
		}
		const requests: Array<{ role: string; text: string }[]> = [];
		const respond = () => (context: { messages: Array<{ role: string }> }) => {
			requests.push(context.messages.map((message) => ({ role: message.role, text: getMessageText(message) })));
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([respond(), respond(), respond(), respond()]);
		return { harness, requests };
	}

	/** Navigate to the last non-context entry before the initial snapshot, summarizing the abandoned branch. */
	async function summarizeToPreSystemPoint(harness: Harness): Promise<BranchSummaryEntry> {
		const branch = harness.sessionManager.getBranch();
		const systemIndex = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "system");
		const target = branch[systemIndex - 1];
		if (!target) throw new Error("expected an entry before the snapshot");
		const result = await harness.session.navigateTree(target.id, { summarize: true });
		if (!result.summaryEntry) throw new Error("expected a branch summary");
		return result.summaryEntry;
	}

	it.each([false, true])(
		"the summary carries the checkpoint and no standing items; the next run starts with one system (refusing model: %s)",
		async (refusing) => {
			const { harness, requests } = await setup(refusing);
			harness.session.setStandingInstruction("mode", "Plan");
			await harness.session.prompt("first");

			const summary = await summarizeToPreSystemPoint(harness);
			expect(summary.systemMessage?.role).toBe("system");
			expect(summary).not.toHaveProperty("standing");

			await harness.session.prompt("second");
			const projection = harness.sessionManager.buildSessionProjection().messages;
			expect(projection[0]?.role).toBe("system");
			expect(projection.filter((message) => message.role === "system")).toHaveLength(1);
			const request = requests.at(-1) ?? [];
			expect(request[0]?.role).toBe("system");
			expect(request.filter((message) => message.role === "system")).toHaveLength(1);
			// The new path derives its own values: the pending value is delivered after the input.
			expect(request.slice(-2)).toEqual([
				{ role: "user", text: "second" },
				{ role: "developer", text: "Plan" },
			]);

			// Root summary → compaction keeping the summary: exactly one system message, at index 0.
			await harness.session.compact();
			await harness.session.prompt("third");
			const afterCompaction = requests.at(-1) ?? [];
			expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(afterCompaction[0]?.role).toBe("system");
			expect(afterCompaction.filter((message) => message.role === "system")).toHaveLength(1);
			expect(afterCompaction.some((message) => message.text.includes("abandoned branch summary"))).toBe(true);
		},
	);
});
