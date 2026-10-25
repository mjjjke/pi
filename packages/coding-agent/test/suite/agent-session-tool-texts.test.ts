import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

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
