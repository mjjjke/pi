import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCompaction, SESSION_SUMMARY_PREAMBLE } from "../../src/core/compaction/compaction.ts";
import { createHarness, type Harness } from "./harness.ts";

const SUMMARY = "## Goal\nTest\n## Next Steps\nContinue";
const fixtures: Harness[] = [];
afterEach(() => {
	for (const h of fixtures.splice(0)) h.cleanup();
});

describe("summary warm-cache eligibility", () => {
	for (const path of ["blocking", "background"] as const)
		for (const cold of ["expired", "aborted-newest", "other-model", "no-ttl"] as const) {
			it(`${path}: ${cold} serializes; fresh same-model response uses the fork`, async () => {
				const h = await createHarness({
					api: "anthropic-messages",
					settings: { compaction: { enabled: false, keepRecentTokens: 20 } },
				});
				fixtures.push(h);
				h.session.agent.sessionId = h.session.sessionId;
				h.session.agent.state.model = { ...h.session.model!, promptCache: { short: 300 } };
				h.setResponses([fauxAssistantMessage("old"), fauxAssistantMessage("tail")]);
				await h.session.prompt(`old ${"x".repeat(5000)}`);
				await h.session.prompt(`kept ${"y".repeat(200)}`);
				const latest = h.sessionManager
					.getBranch()
					.findLast((e) => e.type === "message" && e.message.role === "assistant");
				if (latest?.type !== "message" || latest.message.role !== "assistant")
					throw new Error("No assistant fixture");
				const response = latest.message;
				if (cold === "expired" || cold === "aborted-newest") response.timestamp = Date.now() - 300_001;
				if (cold === "other-model") response.model = "another-model";
				if (cold === "no-ttl") h.session.agent.state.model = { ...h.session.model!, promptCache: undefined };
				if (cold === "aborted-newest") {
					h.sessionManager.appendMessage({
						...fauxAssistantMessage("", { stopReason: "aborted" }),
						api: "anthropic-messages",
						provider: response.provider,
						model: response.model,
					});
				}
				h.session.refreshContext();
				const requests: boolean[] = [];
				const stream = h.session.agent.streamFunction;
				h.session.agent.streamFunction = (model, context, options) => {
					requests.push(JSON.stringify(context.messages.at(-1)).includes(SESSION_SUMMARY_PREAMBLE));
					return stream(model, context, options);
				};
				async function summarize() {
					h.setResponses([fauxAssistantMessage(SUMMARY), fauxAssistantMessage(SUMMARY)]);
					if (path === "blocking") {
						const prep = prepareCompaction(
							h.sessionManager.getBranch(),
							h.settingsManager.getCompactionSettings(h.session.model),
						)!;
						// biome-ignore lint/complexity/useLiteralKeys: exercise the private blocking entry point.
						await h.session["_runDefaultCompaction"](
							prep,
							h.session.model!,
							undefined,
							new AbortController().signal,
							"manual",
						);
					} else {
						expect(h.session.startBackgroundCompaction({ source: "user" }).status).toBe("started");
						await vi.waitFor(() => expect(h.session.getBackgroundCompaction()?.phase).toBe("ready"));
						h.session.cancelBackgroundCompaction();
					}
				}
				await summarize();
				expect(requests.length).toBeGreaterThan(0);
				expect(requests.every((fork) => !fork)).toBe(true);
				requests.length = 0;
				response.timestamp = Date.now();
				response.model = h.session.model!.id;
				h.session.agent.state.model = { ...h.session.model!, promptCache: { short: 300 } };
				await summarize();
				expect(requests).toEqual([true]);
			});
		}
});
