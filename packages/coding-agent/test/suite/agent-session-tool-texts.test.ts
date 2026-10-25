import {
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const factStart = "The user sees each edit as a colored diff";

describe("tool rendering facts belong only to the TUI mode", () => {
	it.each(["tui", "print", "json", "rpc", undefined] as const)(
		"gates startup, requests and reload in %s",
		async (mode) => {
			const harness = await createHarness();
			try {
				expect(harness.session.systemPrompt).not.toContain(factStart);
				const declarations = harness.session
					.getAllTools()
					.map(({ name, description, parameters }) => ({ name, description, parameters }));
				if (mode) await harness.session.bindExtensions({ mode });
				expect(harness.session.systemPrompt.includes(factStart)).toBe(mode === "tui");
				const prompts: string[] = [];
				harness.setResponses([() => fauxAssistantMessage("one"), () => fauxAssistantMessage("two")]);
				const original = harness.session.agent.prepareRequest;
				harness.session.agent.prepareRequest = async (request, signal) => {
					const prepared = await original?.(request, signal);
					prompts.push(getCurrentSystemPrompt((prepared?.context ?? request.context).messages));
					return prepared ?? undefined;
				};
				await harness.session.prompt("first");
				await harness.session.prompt("second");
				expect(prompts).toHaveLength(2);
				expect(prompts[0].includes(factStart)).toBe(mode === "tui");
				expect(prompts[1]).toBe(prompts[0]);
				await harness.session.reload();
				expect(harness.session.systemPrompt.includes(factStart)).toBe(mode === "tui");
				expect(
					harness.session
						.getAllTools()
						.map(({ name, description, parameters }) => ({ name, description, parameters })),
				).toEqual(declarations);
			} finally {
				harness.cleanup();
			}
		},
	);
	it.each([
		["tui", "rpc"],
		["rpc", "tui"],
	] as const)("updates an active run from %s to %s at the next request", async (from, to) => {
		let session: Harness["session"];
		let rebound = false;
		const runGuideline = "Keep this extension-owned run guideline.";
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.promptGuidelines.push(runGuideline);
						event.systemPromptOptions.sections.run_extension = "Keep this run section.";
					});
					pi.on("turn_end", async () => {
						if (rebound) return;
						rebound = true;
						await session.bindExtensions({ mode: to });
					});
				},
			],
		});
		session = harness.session;
		try {
			const requests: Context[] = [];
			let activePrompt: string | undefined;
			harness.setResponses([
				(context) => {
					requests.push(structuredClone(context));
					return fauxAssistantMessage([fauxToolCall("read", { path: "missing" })], { stopReason: "toolUse" });
				},
				(context) => {
					requests.push(structuredClone(context));
					activePrompt = session.systemPrompt;
					return fauxAssistantMessage("done");
				},
			]);
			await session.bindExtensions({ mode: from });
			await session.prompt("go");
			expect(requests).toHaveLength(2);
			expect(activePrompt).toBe(getCurrentSystemPrompt(requests[1].messages));
			expect(getCurrentSystemPrompt(requests[0].messages).includes(factStart)).toBe(from === "tui");
			expect(getCurrentSystemPrompt(requests[1].messages).includes(factStart)).toBe(to === "tui");
			for (const request of requests) {
				expect(getCurrentSystemPrompt(request.messages)).toContain(runGuideline);
				expect(getCurrentSystemPrompt(request.messages)).toContain("<run_extension>\nKeep this run section.");
			}
			expect(requests[1].messages.slice(0, requests[0].messages.length)).toEqual(requests[0].messages);
			expect(getCurrentTools(requests[1].messages)).toEqual(getCurrentTools(requests[0].messages));
			const updates = requests[1].messages.slice(requests[0].messages.length).filter((m) => m.role === "system");
			expect(updates).toHaveLength(1);
			expect(updates[0].sections).toEqual({ rules: expect.any(String) });
		} finally {
			harness.cleanup();
		}
	});
	it.each(["on", "only", "absent"] as const)("gates TUI requests with codemode %s", async (mode) => {
		const harness = await createHarness({
			settings: { codemode: { mode: mode === "only" ? "only" : "on" } },
			initialActiveToolNames: ["read", "bash", "edit", "write", ...(mode === "absent" ? [] : ["codemode"])],
			extensionFactories: [createCodemodeExtension()],
		});
		try {
			await harness.session.bindExtensions({ mode: "tui" });
			const requests: Context[] = [];
			harness.setResponses([
				(context) => {
					requests.push(structuredClone(context));
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("go");
			expect(requests).toHaveLength(1);
			const tools = getCurrentTools(requests[0].messages).map((tool) => tool.name);
			expect(tools.includes("codemode")).toBe(mode !== "absent");
			expect(tools.includes("edit")).toBe(mode !== "only");
			expect(getCurrentSystemPrompt(requests[0].messages).includes(factStart)).toBe(mode === "absent");
		} finally {
			harness.cleanup();
		}
	});
	it("applies the mode before session_start handlers observe the prompt", async () => {
		const prompts: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						prompts.push(ctx.getSystemPrompt());
					});
				},
			],
		});
		try {
			await harness.session.bindExtensions({ mode: "tui" });
			expect(prompts[0]).toContain(factStart);
		} finally {
			harness.cleanup();
		}
	});
});
