import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode rebuild with staged startup content (§3.7)", () => {
	const staged: AgentMessage[] = [
		{ role: "custom", customType: "handoff", content: "handoff", display: true, timestamp: 1 },
		{
			role: "bashExecution",
			command: "ls",
			output: "file",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 2,
		},
	];

	function fakeMode() {
		const order: string[] = [];
		return {
			order,
			chatContainer: { clear: vi.fn() },
			sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
			session: { stagedMessages: staged },
			renderSessionEntries: vi.fn(() => order.push("entries")),
			renderProjectTrustWarningIfNeeded: vi.fn(),
			showStatus: vi.fn(),
			addMessageToChat: vi.fn((message: AgentMessage) => order.push(message.role)),
		};
	}

	test.each(["rebuildChatFromMessages", "renderInitialMessages"])(
		"%s renders staged custom and bash messages once, after the session entries",
		(method) => {
			const mode = fakeMode();
			const render = Reflect.get(InteractiveMode.prototype, method) as (this: unknown) => void;
			const renderStaged = Reflect.get(InteractiveMode.prototype, "renderStagedMessages") as
				| ((this: unknown) => void)
				| undefined;
			render.call({ ...mode, renderStagedMessages: renderStaged });
			expect(mode.order).toEqual(["entries", "custom", "bashExecution"]);
		},
	);
});
