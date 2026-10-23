import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { createRuntimeHarness, type RuntimeHarness } from "./runtime-harness.ts";

/** role:text of a message; system messages show their tool declarations. */
function describeMessage(message: { role: string } & Record<string, unknown>): string {
	if (message.role === "system") return "system";
	if (message.role === "assistant") return "assistant";
	return `${message.role}:${getMessageText(message)}`;
}

function journal(harness: Harness): string[] {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message" || entry.type === "custom_message")
		.map((entry) =>
			entry.type === "message"
				? describeMessage(entry.message as never)
				: `custom:${typeof entry.content === "string" ? entry.content : getMessageText({ content: entry.content })}`,
		);
}

function recordRequests(harness: Harness, count = 1): string[][] {
	const requests: string[][] = [];
	harness.setResponses(
		Array.from(
			{ length: count },
			(): FauxResponseFactory => (context) => {
				requests.push(context.messages.map((message) => describeMessage(message as never)));
				return fauxAssistantMessage("done");
			},
		),
	);
	return requests;
}

const lateTool = (name: string) => ({
	name,
	label: name,
	description: name,
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text" as const, text: name }], details: {} }),
});

describe("AgentSession bootstrap commit (B)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(factories: Array<(pi: ExtensionAPI) => void> = []): Promise<Harness> {
		const harness = await createHarness({ extensionFactories: factories });
		harnesses.push(harness);
		return harness;
	}

	it("session_start passive send is staged and written after the snapshot (tool registered late included)", async () => {
		const harness = await setup([
			(pi) => {
				pi.on("session_start", async () => {
					pi.sendMessage({ customType: "handoff", content: "handoff", display: true });
					await Promise.resolve();
					pi.registerTool(lateTool("late"));
				});
			},
		]);
		const messageEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_start" || event.type === "message_end")
				messageEvents.push(`${event.type}:${describeMessage(event.message as never)}`);
		});
		await harness.session.bindExtensions({});
		expect(journal(harness)).toEqual([]);
		expect(harness.session.messages).toEqual([]);
		expect(harness.session.stagedMessages.map((message) => describeMessage(message as never))).toEqual([
			"custom:handoff",
		]);
		// Announced at send, not again at B.
		expect(messageEvents).toEqual(["message_start:custom:handoff", "message_end:custom:handoff"]);
		const requests = recordRequests(harness);

		await harness.session.prompt("hello");

		// Custom messages reach the model as user-role text.
		expect(requests[0]).toEqual(["system", "user:handoff", "user:hello"]);
		expect(journal(harness)).toEqual(["system", "custom:handoff", "user:hello", "assistant"]);
		const snapshot = harness.sessionManager.buildSessionProjection().messages[0];
		expect(snapshot?.role === "system" && snapshot.toolsAdded?.map((tool) => tool.name)).toContain("late");
		expect(Object.keys(snapshot?.role === "system" ? (snapshot.sections ?? {}) : {}).length).toBeGreaterThan(0);
		expect(harness.sessionManager.buildSessionProjection().messages[0]?.role).toBe("system");
		expect(messageEvents.filter((event) => event.includes("custom:handoff"))).toHaveLength(2);
		expect(messageEvents.filter((event) => event.startsWith("message_end:system"))).toHaveLength(1);
		expect(harness.session.stagedMessages).toEqual([]);
	});

	it("idle and preflight developers are staged FIFO, committed at B with onCommit, before content", async () => {
		const onCommit = vi.fn();
		const harness = await setup([
			(pi) => {
				pi.on("before_agent_start", () => {
					const result = pi.queueDeveloperMessage("preflight dev", { onCommit });
					expect(result.status).toBe("staged");
					pi.sendMessage(
						{ customType: "pf", content: "preflight custom", display: false },
						{ triggerTurn: false },
					);
				});
			},
		]);
		await harness.session.bindExtensions({});
		const idle = harness.session.queueDeveloperMessage("idle dev", { onCommit });
		expect(idle.status).toBe("staged");
		const cancelled = harness.session.queueDeveloperMessage("cancel me");
		expect(cancelled.status).toBe("staged");
		if (cancelled.status === "staged")
			expect(harness.session.cancelQueuedDeveloperMessage(cancelled.pendingId)).toBe(true);
		harness.session.appendDeveloperMessage("appended dev");
		await harness.session.sendCustomMessage({ customType: "idle", content: "idle custom", display: false });
		expect(journal(harness)).toEqual([]);
		expect(onCommit).not.toHaveBeenCalled();
		const requests = recordRequests(harness);

		await harness.session.prompt("go");

		expect(requests[0]).toEqual([
			"system",
			"developer:idle dev",
			"developer:appended dev",
			"developer:preflight dev",
			"user:idle custom",
			"user:preflight custom",
			"user:go",
		]);
		expect(onCommit).toHaveBeenCalledTimes(2);
	});

	it("!cmd results, nextTurn and returned messages keep the canonical order", async () => {
		const harness = await setup([
			(pi) => {
				pi.on("before_agent_start", () => ({
					message: { customType: "ret", content: "returned", display: false },
				}));
			},
		]);
		await harness.session.bindExtensions({});
		harness.session.recordBashResult("ls", {
			output: "files",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		await harness.session.sendCustomMessage(
			{ customType: "nt", content: "next turn", display: false },
			{ deliverAs: "nextTurn" },
		);
		expect(journal(harness)).toEqual([]);
		const requests = recordRequests(harness);

		await harness.session.prompt("go");

		expect(requests[0]?.[0]).toBe("system");
		expect(requests[0]?.slice(2)).toEqual(["user:go", "user:next turn", "user:returned"]);
		expect(requests[0]?.[1]).toMatch(/^user:/);
		expect(journal(harness)[1]).toMatch(/^bashExecution/);
	});

	it("a custom-triggered first run writes the snapshot first", async () => {
		const harness = await setup();
		await harness.session.bindExtensions({});
		await harness.session.sendCustomMessage({ customType: "seed", content: "seed", display: false });
		const requests = recordRequests(harness);

		await harness.session.sendCustomMessage(
			{ customType: "kick", content: "kickoff", display: false },
			{ triggerTurn: true },
		);

		expect(requests[0]).toEqual(["system", "user:seed", "user:kickoff"]);
	});

	describe("session replacement", () => {
		const runtimes: RuntimeHarness[] = [];

		afterEach(async () => {
			while (runtimes.length > 0) await runtimes.pop()?.cleanup();
		});

		function recordRuntimeRequests(runtime: RuntimeHarness, count = 1): string[][] {
			const requests: string[][] = [];
			runtime.faux.setResponses(
				Array.from(
					{ length: count },
					(): FauxResponseFactory => (context) => {
						requests.push(context.messages.map((message) => describeMessage(message as never)));
						return fauxAssistantMessage("done");
					},
				),
			);
			return requests;
		}

		function runtimeJournal(runtime: RuntimeHarness): string[] {
			return runtime.runtime.session.sessionManager
				.buildSessionProjection()
				.messages.map((message) => describeMessage(message as never));
		}

		it("/new setup + withSession: state entries, context and developers land after the snapshot", async () => {
			const harness = await createRuntimeHarness();
			runtimes.push(harness);
			const requests = recordRuntimeRequests(harness, 2);
			await harness.runtime.session.prompt("old");
			const messageEnds: string[] = [];

			await harness.runtime.newSession({
				setup: async (sm) => {
					sm.appendCustomEntry("handoff-state", { ready: true });
				},
				withSession: async (ctx) => {
					harness.runtime.session.subscribe((event) => {
						if (event.type === "message_end") messageEnds.push(describeMessage(event.message as never));
					});
					await ctx.sendMessage({ customType: "handoff", content: "handoff", display: true });
					ctx.appendDeveloperMessage("notice");
				},
			});
			const session = harness.runtime.session;
			expect(runtimeJournal(harness)).toEqual([]);
			expect(session.stagedMessages.map((message) => describeMessage(message as never))).toEqual(["custom:handoff"]);

			await session.prompt("go");

			expect(requests[1]).toEqual(["system", "developer:notice", "user:handoff", "user:go"]);
			expect(runtimeJournal(harness)).toEqual([
				"system",
				"developer:notice",
				"custom:handoff",
				"user:go",
				"assistant",
			]);
			expect(session.sessionManager.getEntries().some((entry) => entry.type === "custom")).toBe(true);
			expect(messageEnds.filter((end) => end === "custom:handoff")).toHaveLength(1);
			expect(messageEnds.filter((end) => end === "system")).toHaveLength(1);
		});

		it("collab-style fresh session: state entry, standing mask from session_start, artifact and a triggered kickoff", async () => {
			const harness = await createRuntimeHarness((pi) => {
				pi.on("session_start", (_event, ctx) => {
					const state = ctx.sessionManager
						.getEntries()
						.findLast((entry) => entry.type === "custom" && entry.customType === "mode-state");
					const mode = state?.type === "custom" ? (state.data as { mode: string }).mode : "Default";
					pi.setStandingInstruction("collaboration-mode", `mode:${mode}`);
				});
			});
			runtimes.push(harness);
			const requests = recordRuntimeRequests(harness, 2);
			await harness.runtime.session.prompt("plan it");
			const messageEnds: string[] = [];

			await harness.runtime.newSession({
				setup: async (sm) => {
					sm.appendCustomEntry("mode-state", { mode: "Execute" });
				},
				withSession: async (ctx) => {
					harness.runtime.session.subscribe((event) => {
						if (event.type === "message_end") messageEnds.push(describeMessage(event.message as never));
					});
					await ctx.sendMessage({ customType: "artifact", content: "artifact", display: true });
					await ctx.sendMessage(
						{ customType: "kickoff", content: "kickoff", display: true },
						{ deliverAs: "followUp", triggerTurn: true },
					);
				},
			});
			await harness.runtime.session.waitForIdle();

			expect(requests).toHaveLength(2);
			expect(requests[1]).toEqual(["system", "developer:mode:Execute", "user:artifact", "user:kickoff"]);
			const session = harness.runtime.session;
			expect(session.sessionManager.buildSessionProjection().messages[0]?.role).toBe("system");
			expect(runtimeJournal(harness).filter((line) => line === "system")).toHaveLength(1);
			expect(session.getStandingInstruction("collaboration-mode")).toMatchObject({ delivered: true });
			expect(messageEnds.filter((end) => end === "custom:artifact")).toHaveLength(1);
			expect(messageEnds.filter((end) => end === "custom:kickoff")).toHaveLength(1);
		});
	});

	it("later runs are unchanged: idle sends append at once", async () => {
		const harness = await setup();
		await harness.session.bindExtensions({});
		recordRequests(harness, 2);
		await harness.session.prompt("first");
		await harness.session.sendCustomMessage({ customType: "later", content: "later", display: false });
		const result = harness.session.queueDeveloperMessage("later dev");
		expect(result.status).toBe("committed");
		expect(journal(harness).slice(-2)).toEqual(["custom:later", "developer:later dev"]);
	});
});
