// Fork-only model capabilities and compat flags, shared by catalog generation,
// release pinning and runtime model composition. Explicit capabilities win. See FORK.md.

import type { Provider } from "../models.ts";
import type { AnyModel, Api, Model, ModelCapabilities } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";
import {
	anthropicSupportsMidConversationInstructions,
	openAiSupportsMidConversationInstructions,
} from "./instruction-messages.ts";
import { getAnthropicFastModeCapability, getCodexFastModeCapability } from "./pi-fast-mode.ts";
import { anthropicSupportsProgressUpdates } from "./progress-updates.ts";

const FIRST_PARTY_OPENAI_INSTRUCTION_PROVIDERS = new Set(["openai", "azure-openai-responses", "openai-codex"]);

/** Apply fork defaults to runtime catalog reads, without changing provider-owned models. */
export function withForkModelData(provider: Provider): Provider {
	// No fork policy applies to other provider identities. Preserve their native behavior.
	if (provider.id !== "anthropic" && !FIRST_PARTY_OPENAI_INSTRUCTION_PROVIDERS.has(provider.id)) return provider;
	const patch = <T extends AnyModel>(model: T): T => {
		if (!isModelType(model, "chat")) return model;
		const patched = { ...model };
		applyForkModelData(patched);
		return patched;
	};
	return {
		...provider,
		getModels: () => provider.getModels().map(patch),
		...(provider.getAllModels ? { getAllModels: () => provider.getAllModels!().map(patch) } : {}),
	};
}

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
			if (
				capabilities.fastMode === undefined &&
				model.provider === "anthropic" &&
				nativeModelId.startsWith("claude-")
			) {
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
// the fork capability policy marks them for developer messages. Their transport renders later
// system updates as developer messages; without this flag the fork refuses those updates.
const FORK_MID_CONVO_SYSTEM_MESSAGE_MODELS = new Set([
	"openai:gpt-5.4-nano",
	"openai:gpt-5.5-pro",
	"openai:gpt-5.6-cyber",
]);

/** Fork compat patch: flags the fork sets on top of the upstream data. */
export function getGeneratedCompat(model: Model<Api>): Model<Api>["compat"] {
	if (!FORK_MID_CONVO_SYSTEM_MESSAGE_MODELS.has(`${model.provider}:${model.id}`)) return model.compat;
	return { ...model.compat, supportsMidConvoSystemMessages: true } as Model<Api>["compat"];
}

/** Apply every fork patch (capabilities and compat) to one model, in place. */
export function applyForkModelData(model: Model<Api>): void {
	const compat = getGeneratedCompat(model);
	if (compat !== undefined) model.compat = compat;
	const capabilities = getGeneratedCapabilities(model);
	if (capabilities) model.capabilities = capabilities;
}
