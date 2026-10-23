import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	lazyApi,
	type Model,
	type ProviderStreams,
	type SystemMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

function lateTool(name: string): Parameters<ExtensionAPI["registerTool"]>[0] {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: `${name} ran` }], details: {} }),
	};
}

/** Tool names declared by the system messages of a transcript, in order (additions minus removals). */
function declaredTools(messages: ReadonlyArray<{ role: string }>): string[] {
	const declared = new Set<string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		const system = message as SystemMessage;
		for (const tool of system.toolsAdded ?? []) declared.add(tool.name);
		for (const tool of system.toolsRemoved ?? []) declared.delete(tool.name);
	}
	return [...declared];
}

interface Request {
	declared: string[];
}

function record(requests: Request[], reply = () => fauxAssistantMessage("ok")): FauxResponseFactory {
	return (context) => {
		requests.push({ declared: declaredTools(context.messages) });
		return reply();
	};
}

describe("AgentSession tool declarations per request boundary", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(factory: (pi: ExtensionAPI) => void, tools?: AgentTool[]): Promise<Harness> {
		const harness = await createHarness({ extensionFactories: [factory], tools });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	}

	it("declares a tool registered in agent_start of the first run before the first request", async () => {
		const harness = await setup((pi) => {
			pi.on("agent_start", () => {
				pi.registerTool(lateTool("late"));
			});
		});
		const requests: Request[] = [];
		harness.setResponses([record(requests)]);

		await harness.session.prompt("go");

		expect(requests[0]?.declared).toContain("late");
		expect(declaredTools(harness.sessionManager.buildSessionProjection().messages)).toContain("late");
	});

	it("declares a tool registered by an awaited message_end hook before the first request", async () => {
		const harness = await setup((pi) => {
			pi.on("message_end", async (event) => {
				if (event.message.role === "user") pi.registerTool(lateTool("hooked"));
			});
		});
		const requests: Request[] = [];
		harness.setResponses([record(requests)]);

		await harness.session.prompt("go");

		expect(requests[0]?.declared).toContain("hooked");
	});

	it("a tool registered in an onCommit at the instruction boundary is declared at the next boundary, never sent undeclared", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await setup((pi) => {
			api = pi;
			pi.on("agent_start", () => {
				pi.queueDeveloperMessage("notice", {
					onCommit: () => {
						pi.registerTool(lateTool("committed"));
					},
				});
			});
		});
		const requests: Request[] = [];
		harness.setResponses([
			record(requests, () => fauxAssistantMessage([fauxToolCall("committed", {})], { stopReason: "toolUse" })),
			record(requests),
		]);
		expect(api).toBeDefined();

		await harness.session.prompt("go");

		expect(requests).toHaveLength(2);
		expect(requests[0]?.declared).not.toContain("committed");
		// The first request's executable tools are its declared snapshot: the undeclared tool does not run.
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(result).toMatchObject({ toolName: "committed", isError: true });
		expect(requests[1]?.declared).toContain("committed");
	});

	it("on a model without mid-conversation system messages, the agent_start registration is refused", async () => {
		const harness = await setup((pi) => {
			pi.on("agent_start", () => {
				pi.registerTool(lateTool("late"));
			});
		});
		const original = harness.session.agent.streamFunction as unknown as ProviderStreams["streamSimple"];
		const refusing = lazyApi(async () => ({ stream: original, streamSimple: original }) as ProviderStreams);
		harness.session.agent.streamFunction = (model, context, options) =>
			refusing.streamSimple(
				{ ...(model as Model<Api>), compat: { supportsMidConvoSystemMessages: false } } as Model<Api>,
				context,
				options,
			);
		const requests: Request[] = [];
		harness.setResponses([record(requests)]);

		await harness.session.prompt("go");

		expect(requests).toHaveLength(0);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
		expect((harness.session.messages.at(-1) as { errorMessage?: string }).errorMessage).toContain(
			"does not support mid-conversation system messages",
		);
	});
});
