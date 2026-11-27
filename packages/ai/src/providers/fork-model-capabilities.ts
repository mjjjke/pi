// Fork-only model capabilities and compat flags, shared by catalog generation,
// release pinning and runtime model composition. Explicit capabilities win. See FORK.md.

import type { Provider } from "../models.ts";
import type { AnyModel, Api, Model, ModelCapabilities } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";
import { supportsMidConversationInstructionMessages } from "./instruction-messages.ts";
import { getFastModeCapability } from "./pi-fast-mode.ts";
import { supportsProgressUpdates } from "./progress-updates.ts";

const FIRST_PARTY_OPENAI_INSTRUCTION_PROVIDERS = new Set(["openai", "azure-openai-responses", "openai-codex"]);

/** Fill fork defaults on a runtime model without changing caller-owned data. */
export function withForkModel<T extends AnyModel>(model: T): T {
	if (!isModelType(model, "chat")) return model;
	// Only physical transports covered by this policy qualify. In particular, a virtual
	// alias must not gain compat flags merely by sharing a first-party model's name.
	switch (model.api) {
		case "anthropic-messages":
		case "openai-completions":
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses":
			break;
		default:
			return model;
	}
	const compat = getGeneratedCompat(model);
	const capabilities = getGeneratedCapabilities(model);
	if (compat === model.compat && capabilities === model.capabilities) return model;
	return { ...model, ...(compat ? { compat } : {}), ...(capabilities ? { capabilities } : {}) };
}

/** Apply fork defaults to catalog state without changing caller-owned models. Requests resolve at read. */
export function withForkModelData(provider: Provider): Provider {
	// No fork policy applies to other provider identities. Preserve their native behavior.
	if (provider.id !== "anthropic" && !FIRST_PARTY_OPENAI_INSTRUCTION_PROVIDERS.has(provider.id)) return provider;
	return {
		...provider,
		getModels: () => provider.getModels().map(withForkModel),
		...(provider.getAllModels ? { getAllModels: () => provider.getAllModels!().map(withForkModel) } : {}),
	};
}

export function getGeneratedCapabilities(model: Model<Api>): ModelCapabilities | undefined {
	const previous = model.capabilities;
	const instructions = supportsMidConversationInstructionMessages(model);
	const progress = supportsProgressUpdates(model);
	const fastMode = getFastModeCapability(model);
	if (
		(!instructions || previous?.midConversationInstructionMessages !== undefined) &&
		(!progress || previous?.progressUpdates !== undefined) &&
		fastMode === previous?.fastMode
	)
		return previous;
	return {
		...previous,
		...(instructions ? { midConversationInstructionMessages: true } : {}),
		...(progress ? { progressUpdates: true } : {}),
		...(fastMode ? { fastMode } : {}),
	};
}

// First-party OpenAI models whose upstream data lacks `supportsMidConvoSystemMessages` although
// the fork capability policy marks them for developer messages. Their transport renders later
// system updates as developer messages; without this flag the fork refuses those updates.
const FORK_MID_CONVO_SYSTEM_MESSAGE_MODELS = new Set([
	"openai:gpt-5.4-nano",
	"openai:gpt-5.5-pro",
	"openai:gpt-5.6-cyber",
	// Added with the v1.7.0 catalog.
	"openai:gpt-6-astra-healthcare",
	"openai:gpt-6-cyber",
	"openai:gpt-6.1-sol-healthcare",
	"openai:gpt-6.2-astra-healthcare",
	"openai:gpt-6.2-sol-healthcare",
]);

/** Fork compat patch: flags the fork sets on top of the upstream data. */
export function getGeneratedCompat(model: Model<Api>): Model<Api>["compat"] {
	if (!FORK_MID_CONVO_SYSTEM_MESSAGE_MODELS.has(`${model.provider}:${model.id}`)) return model.compat;
	if (
		(model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages ===
		true
	)
		return model.compat;
	return { ...model.compat, supportsMidConvoSystemMessages: true } as Model<Api>["compat"];
}

/** Apply every fork patch (capabilities and compat) to one model, in place. */
export function applyForkModelData(model: Model<Api>): void {
	const compat = getGeneratedCompat(model);
	if (compat !== undefined) model.compat = compat;
	const capabilities = getGeneratedCapabilities(model);
	if (capabilities) model.capabilities = capabilities;
}
