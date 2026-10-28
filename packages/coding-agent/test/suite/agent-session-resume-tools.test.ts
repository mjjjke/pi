import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createRuntimeHarness } from "./runtime-harness.ts";

describe("saved-session tool restoration", () => {
	// #10887: opening a saved session discovers newly installed tools, including via /resume.
	it("activates a new extension tool when switchSession opens a saved session", async () => {
		let installed = false;
		const harness = await createRuntimeHarness((pi) => {
			if (installed) {
				pi.registerTool({
					name: "new_tool",
					label: "New Tool",
					description: "Installed after the saved session",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			}
		});
		try {
			const { runtime, faux } = harness;
			runtime.session.setActiveToolsByName(["read"]);
			faux.setResponses([fauxAssistantMessage("saved")]);
			await runtime.session.prompt("save the closed loadout");
			const savedFile = runtime.session.sessionFile!;
			installed = true;
			await runtime.newSession();
			await runtime.switchSession(savedFile);
			expect(runtime.session.getActiveToolNames().sort()).toEqual(["new_tool", "read"]);
		} finally {
			await harness.cleanup();
		}
	});

	// #10887: a fork is not opening an old session; its recorded selection stays closed.
	it.each(["before", "at"] as const)("preserves a closed loadout when forking %s an entry", async (position) => {
		const harness = await createRuntimeHarness((pi) => {
			pi.registerTool({
				name: "eligible",
				label: "Eligible",
				description: "Default-active extension tool deliberately deactivated",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		});
		try {
			const { runtime, faux } = harness;
			runtime.session.setActiveToolsByName(["read"]);
			faux.setResponses([fauxAssistantMessage("saved")]);
			await runtime.session.prompt("save the closed loadout");
			const entry = runtime.session.getUserMessagesForForking()[0]!;
			await runtime.fork(entry.entryId, { position });
			expect(runtime.session.getActiveToolNames()).toEqual(["read"]);
		} finally {
			await harness.cleanup();
		}
	});

	// #10887: navigating the existing tree does not rediscover default-active extension tools.
	it("preserves the recorded closed loadout during tree navigation", async () => {
		const harness = await createRuntimeHarness((pi) => {
			pi.registerTool({
				name: "eligible",
				label: "Eligible",
				description: "Default-active extension tool deliberately deactivated",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		});
		try {
			const { runtime, faux } = harness;
			runtime.session.setActiveToolsByName(["read"]);
			faux.setResponses([fauxAssistantMessage("saved"), fauxAssistantMessage("later")]);
			await runtime.session.prompt("save the closed loadout");
			const target = runtime.session.sessionManager.getLeafId()!;
			runtime.session.setActiveToolsByName(["read", "eligible"]);
			await runtime.session.prompt("later branch");
			await runtime.session.navigateTree(target);
			expect(runtime.session.getActiveToolNames()).toEqual(["read"]);
		} finally {
			await harness.cleanup();
		}
	});
});
