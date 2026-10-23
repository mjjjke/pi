// Fork-only: model capabilities and compat flags the fork adds to generated model data
// (fast mode, mid-conversation developer instructions, progress updates, mid-conversation
// system messages). Shared by generate-models.ts and pin-release-model-data.ts so live
// generation and release pinning produce the same metadata. See FORK.md.
import {
	anthropicSupportsMidConversationInstructions,
	openAiSupportsMidConversationInstructions,
} from "../src/providers/instruction-messages.ts";
import { getAnthropicFastModeCapability, getCodexFastModeCapability } from "../src/providers/pi-fast-mode.ts";
import { anthropicSupportsProgressUpdates } from "../src/providers/progress-updates.ts";
import type { Api, Model, ModelCapabilities } from "../src/types.ts";

const FIRST_PARTY_OPENAI_INSTRUCTION_PROVIDERS = new Set(["openai", "azure-openai-responses", "openai-codex"]);

function getNativeModelId(modelId: string): string {
	return modelId.split("/").at(-1) ?? modelId;
}

export function getGeneratedCapabilities(model: Model<Api>): ModelCapabilities | undefined {
	const capabilities: ModelCapabilities = { ...model.capabilities };
	switch (model.api) {
		case "anthropic-messages": {
			const nativeModelId = getNativeModelId(model.id);
			if (
				capabilities.midConversationInstructionMessages === undefined &&
				model.provider === "anthropic" &&
				nativeModelId.startsWith("claude-") &&
				anthropicSupportsMidConversationInstructions(nativeModelId)
			) {
				capabilities.midConversationInstructionMessages = true;
			}
			if (capabilities.fastMode === undefined && model.provider === "anthropic" && nativeModelId.startsWith("claude-")) {
				const fastMode = getAnthropicFastModeCapability(nativeModelId);
				if (fastMode) capabilities.fastMode = fastMode;
			}
			if (
				capabilities.progressUpdates === undefined &&
				model.provider === "anthropic" &&
				anthropicSupportsProgressUpdates(nativeModelId)
			) {
				capabilities.progressUpdates = true;
			}
			break;
		}
		case "openai-completions":
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses":
			if (
				capabilities.midConversationInstructionMessages === undefined &&
				FIRST_PARTY_OPENAI_INSTRUCTION_PROVIDERS.has(model.provider) &&
				openAiSupportsMidConversationInstructions(model.id)
			) {
				capabilities.midConversationInstructionMessages = true;
			}
			if (capabilities.fastMode === undefined) {
				const fastMode = getCodexFastModeCapability(model.provider, model.api);
				if (fastMode) capabilities.fastMode = fastMode;
			}
			break;
		default:
			break;
	}
	return Object.values(capabilities).some((value) => value !== undefined) ? capabilities : undefined;
}

// First-party OpenAI models whose upstream data lacks `supportsMidConvoSystemMessages` although
// they accept developer messages mid-conversation, which is how their transport renders later
// system updates. Without the flag the fork refuses those updates (assertSystemUpdatesSupported).
const FORK_MID_CONVO_SYSTEM_MESSAGE_MODELS = new Set(["openai:gpt-5.4-nano", "openai:gpt-5.5-pro"]);

/** Fork compat patch: flags the fork sets on top of the upstream data. */
export function getGeneratedCompat(model: Model<Api>): Model<Api>["compat"] {
	if (!FORK_MID_CONVO_SYSTEM_MESSAGE_MODELS.has(`${model.provider}:${model.id}`)) return model.compat;
	return { ...model.compat, supportsMidConvoSystemMessages: true } as Model<Api>["compat"];
}

/** Apply every fork patch (capabilities and compat) to one generated or pinned model, in place. */
export function applyForkModelData(model: Model<Api>): void {
	const compat = getGeneratedCompat(model);
	if (compat !== undefined) model.compat = compat;
	const capabilities = getGeneratedCapabilities(model);
	if (capabilities) model.capabilities = capabilities;
}
