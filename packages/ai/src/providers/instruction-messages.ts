import type { Api, DeveloperMessage, Model, SystemMessage, TextContent } from "../types.ts";

export type InstructionMessage = SystemMessage | DeveloperMessage;

export function isInstructionMessage(message: { role: string }): message is InstructionMessage {
	return message.role === "system" || message.role === "developer";
}

export function instructionContentToText(content: InstructionMessage["content"]): string {
	if (typeof content === "string") return content;
	return content.map((block: TextContent) => block.text).join("\n");
}

export function openAiSupportsMidConversationInstructions(id: string | undefined): boolean {
	const m = id?.toLowerCase().match(/gpt-(\d+)(?:\.(\d+))?/);
	if (!m) return false;
	const major = Number(m[1]);
	const minor = Number(m[2] ?? "0");
	return major > 5 || (major === 5 && minor >= 4);
}

export function anthropicSupportsMidConversationInstructions(id: string | undefined): boolean {
	if (!id) return false;
	const m = id.toLowerCase();
	if (/^claude-3(?:[.-]|$)/.test(m)) return false;
	if (/^claude-(?:sonnet|haiku)-4(?:[.-]|$)/.test(m)) return false;
	const opus = m.match(/^claude-opus-4(?:[.-](\d{1,2})(?![0-9]))?/);
	if (opus) return Number(opus[1] ?? "0") >= 8;
	return true;
}

export function supportsMidConversationInstructionMessages(model: Model<Api>): boolean {
	return model.capabilities?.midConversationInstructionMessages === true;
}

export function assertSupportsMidConversationInstructionMessages(model: Model<Api>): void {
	if (supportsMidConversationInstructionMessages(model)) return;
	throw new Error(
		`Model ${model.provider}/${model.id} (api ${model.api}) does not support mid-conversation system/developer messages.`,
	);
}

export function resolveInstructionRole(model: Model<Api>, role: InstructionMessage["role"]): "system" | "developer" {
	if (model.api === "anthropic-messages") return "system";
	if (role === "developer") {
		const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
		return compat?.supportsDeveloperRole === false ? "system" : "developer";
	}
	return "system";
}
