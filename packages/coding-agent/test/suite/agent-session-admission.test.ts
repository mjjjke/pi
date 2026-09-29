import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptDisposition } from "../../src/core/agent-session.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

interface Gate {
	promise: Promise<void>;
	open: () => void;
}

function gate(): Gate {
	let open = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

/** Extension whose input handler blocks the prompt preflight until released. */
function heldInput(started: Gate, release: Gate) {
	return (pi: ExtensionAPI) => {
		pi.on("input", async (event) => {
			if (!event.text.startsWith("held")) return { action: "continue" };
			started.open();
			await release.promise;
			return { action: "continue" };
		});
	};
}

describe("AgentSession prompt admission", () => {
	const harnesses: Harness[] = [];
	const gates: Gate[] = [];

	afterEach(() => {
		for (const g of gates.splice(0)) g.open();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
		const harness = await createHarness(options);
		harnesses.push(harness);
		return harness;
	}

	function newGate(): Gate {
		const g = gate();
		gates.push(g);
		return g;
	}

	it("runs a prompt sent after an idle abort", async () => {
		const harness = await setup();
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.abort();
		await harness.session.prompt("after abort");

		expect(getUserTexts(harness)).toEqual(["after abort"]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("does not cancel a prompt whose preflight overlaps an idle abort", async () => {
		const started = newGate();
		const release = newGate();
		const harness = await setup({ extensionFactories: [heldInput(started, release)] });
		harness.setResponses([fauxAssistantMessage("ok")]);

		const prompt = harness.session.prompt("held prompt");
		await started.promise;
		await harness.session.abort();
		release.open();
		await prompt;

		expect(getUserTexts(harness)).toEqual(["held prompt"]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("closeAdmission() cancels a prompt whose preflight is in flight and later prompts", async () => {
		const started = newGate();
		const release = newGate();
		const harness = await setup({ extensionFactories: [heldInput(started, release)] });
		harness.setResponses([fauxAssistantMessage("should not run")]);
		let preflight: PromptDisposition | undefined;

		const prompt = harness.session.prompt("held prompt", {
			preflightResult: (disposition) => {
				preflight = disposition;
			},
		});
		await started.promise;
		harness.session.closeAdmission();
		release.open();

		await expect(prompt).rejects.toThrow("prompt cancelled: session shutting down");
		await expect(harness.session.prompt("later")).rejects.toThrow("prompt cancelled: session shutting down");
		expect(preflight).toBeUndefined();
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "message")).toBe(false);
	});

	it("closeAdmission() cancels a steer whose preflight is in flight without queueing it", async () => {
		const started = newGate();
		const release = newGate();
		const toolStarted = newGate();
		const toolRelease = newGate();
		const barrier: AgentTool = {
			name: "barrier",
			label: "barrier",
			description: "Blocks until released",
			parameters: Type.Object({}),
			execute: async () => {
				toolStarted.open();
				await toolRelease.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await setup({ tools: [barrier], extensionFactories: [heldInput(started, release)] });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("barrier", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const run = harness.session.prompt("start");
		await toolStarted.promise;
		const steer = harness.session.prompt("held steer", { streamingBehavior: "steer" });
		await started.promise;
		harness.session.closeAdmission();
		release.open();

		await expect(steer).rejects.toThrow("prompt cancelled: session shutting down");
		expect(harness.session.pendingMessageCount).toBe(0);
		toolRelease.open();
		await run;
		expect(getUserTexts(harness)).toEqual(["start"]);
	});

	it("does not run a prompt deferred from agent_settled once admission closed", async () => {
		const preflights: PromptDisposition[] = [];
		let harness: Harness | undefined;
		let deferred = false;
		harness = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						if (deferred || !harness) return;
						deferred = true;
						void harness.session.prompt("deferred", {
							preflightResult: (disposition) => preflights.push(disposition),
						});
						harness.session.closeAdmission();
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("should not run")]);

		await harness.session.prompt("first");
		await harness.session.waitForIdle();

		expect(deferred).toBe(true);
		expect(preflights).toEqual([]);
		expect(harness.faux.state.callCount).toBe(1);
		expect(getUserTexts(harness)).toEqual(["first"]);
	});
});
