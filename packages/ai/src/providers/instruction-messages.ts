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

/**
 * Anthropic models that accept mid-conversation `system` messages, per
 * https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages:
 * Fable 5.1/5, Mythos 5.1/5, Opus 5.5/5/4.8 and Sonnet 5.5, but not Sonnet 5.
 * Accepts native ids, dated variants (`-YYYYMMDD`, `@YYYYMMDD`) and provider-prefixed ids
 * (`us.anthropic.claude-...`, `anthropic/claude-...`). A one- or two-digit segment after the
 * major version is the minor version; an eight-digit one is a date.
 */
export function anthropicSupportsMidConversationInstructions(id: string | undefined): boolean {
	if (!id) return false;
	const m = id.toLowerCase().replace(/^(?:[\w-]+[./])+(?=claude-)/, "");
	if (/^claude-3(?:[.-]|$)/.test(m)) return false;
	if (/^claude-haiku-4(?:[.-]|$)/.test(m)) return false;
	const sonnet = m.match(/^claude-sonnet-(\d+)(?:[.-](\d{1,2})(?![0-9]))?/);
	if (sonnet) {
		const major = Number(sonnet[1]);
		const minor = Number(sonnet[2] ?? "0");
		return major > 5 || (major === 5 && minor >= 5);
	}
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
