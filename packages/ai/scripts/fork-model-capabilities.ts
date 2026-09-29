// Fork-only: model capabilities the fork adds to generated model data
// (fast mode, mid-conversation developer instructions, progress updates). Shared by
// generate-models.ts and pin-release-model-data.ts so live generation and
// release pinning produce the same metadata. See FORK.md.
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
