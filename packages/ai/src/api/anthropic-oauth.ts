// Subscription compatibility is a permanent fork divergence. Keep the wire logic here.
import type { Model, ProviderEnv } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

export const CLAUDE_CODE_VERSION = "2.1.280";
export const CLAUDE_CODE_ENTRYPOINT = "cli";
export const CLAUDE_CODE_CCH_SEED = "0x4d659218e32a3268";
const BILLING_HEADER_SALT = "59cf53e54c78";
const BILLING_HEADER_POSITIONS = [4, 7, 20] as const;
export const ANTHROPIC_OAUTH_EFFORT_BETA = "effort-2025-11-24";

export function getClaudeCodeVersion(env?: ProviderEnv): string {
	const value = (
		env?.PI_ANTHROPIC_CLAUDE_CODE_VERSION ?? getProviderEnvValue("PI_ANTHROPIC_CLAUDE_CODE_VERSION")
	)?.trim();
	return value && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value) ? value : CLAUDE_CODE_VERSION;
}

export function getClaudeCodeCchSeed(env?: ProviderEnv): string {
	const value = (env?.PI_ANTHROPIC_CCH_SEED ?? getProviderEnvValue("PI_ANTHROPIC_CCH_SEED"))?.trim();
	return value && /^0x[0-9a-f]{1,16}$/i.test(value) ? value : CLAUDE_CODE_CCH_SEED;
}

export function anthropicModelIdentity(model: Pick<Model<"anthropic-messages">, "name" | "id">): string {
	const name = model.name.replace(/\s+\([^()]*\)\s*$/, "").trim();
	return `You are ${name && name !== model.id ? name : "Claude"} (model ID: ${model.id}), made by Anthropic.`;
}

type BillingMessage = { role?: string; content?: string | readonly { type?: string; text?: string }[] };

export function extractFirstUserMessageText(messages: readonly BillingMessage[]): string {
	const message = messages.find((message) => message.role === "user");
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	const texts = message.content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text!);
	const substantive = texts.filter((text) => {
		const trimmed = text.trimStart();
		return !trimmed.startsWith("<system-reminder>") && !trimmed.startsWith("System:");
	});
	return (substantive.length > 0 ? substantive : texts).at(-1) ?? "";
}

export async function computeBillingVersionSuffix(messageText: string, version = CLAUDE_CODE_VERSION): Promise<string> {
	const sampled = BILLING_HEADER_POSITIONS.map((index) => messageText[index] || "0").join("");
	const bytes = new TextEncoder().encode(`${BILLING_HEADER_SALT}${sampled}${version}`);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 3);
}

/** Both placeholders are filled from the final SDK body, after onPayload. */
export function buildBillingHeaderValue(version = CLAUDE_CODE_VERSION): string {
	return `x-anthropic-billing-header: cc_version=${version}.000; cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT}; cch=00000;`;
}

const UINT64_MASK = 0xffff_ffff_ffff_ffffn;
const PRIME64_1 = 0x9e37_79b1_85eb_ca87n;
const PRIME64_2 = 0xc2b2_ae3d_27d4_eb4fn;
const PRIME64_3 = 0x1656_67b1_9e37_79f9n;
const PRIME64_4 = 0x85eb_ca77_c2b2_ae63n;
const PRIME64_5 = 0x27d4_eb2f_1656_67c5n;

const encoder = new TextEncoder();

function uint64(value: bigint): bigint {
	return value & UINT64_MASK;
}

function rotateLeft(value: bigint, bits: bigint): bigint {
	return uint64((value << bits) | (value >> (64n - bits)));
}

function readUint32LE(bytes: Uint8Array, offset: number): bigint {
	return (
		BigInt(bytes[offset] ?? 0) |
		(BigInt(bytes[offset + 1] ?? 0) << 8n) |
		(BigInt(bytes[offset + 2] ?? 0) << 16n) |
		(BigInt(bytes[offset + 3] ?? 0) << 24n)
	);
}

function readUint64LE(bytes: Uint8Array, offset: number): bigint {
	return readUint32LE(bytes, offset) | (readUint32LE(bytes, offset + 4) << 32n);
}

function round(accumulator: bigint, input: bigint): bigint {
	let acc = uint64(accumulator + uint64(input * PRIME64_2));
	acc = rotateLeft(acc, 31n);
	return uint64(acc * PRIME64_1);
}

function mergeRound(accumulator: bigint, value: bigint): bigint {
	let acc = accumulator ^ round(0n, value);
	acc = uint64(acc * PRIME64_1 + PRIME64_4);
	return acc;
}

function avalanche(input: bigint): bigint {
	let hash = input;
	hash ^= hash >> 33n;
	hash = uint64(hash * PRIME64_2);
	hash ^= hash >> 29n;
	hash = uint64(hash * PRIME64_3);
	hash ^= hash >> 32n;
	return uint64(hash);
}

export function parseCchSeed(seed: string | bigint): bigint {
	if (typeof seed === "bigint") {
		return uint64(seed);
	}

	const value = seed.trim();
	if (!/^0x[0-9a-f]{1,16}$/i.test(value)) {
		throw new Error(`Invalid Claude Code cch seed: ${seed}`);
	}

	return uint64(BigInt(value));
}

export function xxHash64(bytes: Uint8Array, seed: string | bigint): bigint {
	const seedValue = parseCchSeed(seed);
	const length = bytes.length;
	let offset = 0;
	let hash: bigint;

	if (length >= 32) {
		let v1 = uint64(seedValue + PRIME64_1 + PRIME64_2);
		let v2 = uint64(seedValue + PRIME64_2);
		let v3 = seedValue;
		let v4 = uint64(seedValue - PRIME64_1);

		const limit = length - 32;
		while (offset <= limit) {
			v1 = round(v1, readUint64LE(bytes, offset));
			offset += 8;
			v2 = round(v2, readUint64LE(bytes, offset));
			offset += 8;
			v3 = round(v3, readUint64LE(bytes, offset));
			offset += 8;
			v4 = round(v4, readUint64LE(bytes, offset));
			offset += 8;
		}

		hash = uint64(rotateLeft(v1, 1n) + rotateLeft(v2, 7n) + rotateLeft(v3, 12n) + rotateLeft(v4, 18n));
		hash = mergeRound(hash, v1);
		hash = mergeRound(hash, v2);
		hash = mergeRound(hash, v3);
		hash = mergeRound(hash, v4);
	} else {
		hash = uint64(seedValue + PRIME64_5);
	}

	hash = uint64(hash + BigInt(length));

	while (offset <= length - 8) {
		const k1 = round(0n, readUint64LE(bytes, offset));
		hash ^= k1;
		hash = uint64(rotateLeft(hash, 27n) * PRIME64_1 + PRIME64_4);
		offset += 8;
	}

	if (offset <= length - 4) {
		hash ^= uint64(readUint32LE(bytes, offset) * PRIME64_1);
		hash = uint64(rotateLeft(hash, 23n) * PRIME64_2 + PRIME64_3);
		offset += 4;
	}

	while (offset < length) {
		hash ^= uint64(BigInt(bytes[offset] ?? 0) * PRIME64_5);
		hash = uint64(rotateLeft(hash, 11n) * PRIME64_1);
		offset += 1;
	}

	return avalanche(hash);
}

export function computeClaudeCodeCch(placeholderBodyText: string, seed: string | bigint): string {
	const digest = xxHash64(encoder.encode(placeholderBodyText), seed);
	return (digest & 0xfffffn).toString(16).padStart(5, "0");
}

/** Signs only the provider-owned placeholder block, after SDK serialization and onPayload.
 * Unsupported shapes and signing errors fail open; request content is never logged.
 */
export function signAnthropicOAuthFetch(
	transport: typeof globalThis.fetch,
	seed = CLAUDE_CODE_CCH_SEED,
): typeof globalThis.fetch {
	return async (input, init) => {
		let nextInit = init;
		try {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (
				url.pathname === "/v1/messages" &&
				init?.method?.toUpperCase() === "POST" &&
				typeof init.body === "string"
			) {
				const payload = JSON.parse(init.body);
				const block = payload?.system?.[0];
				const match =
					Array.isArray(payload?.system) && block?.type === "text" && typeof block.text === "string"
						? /^x-anthropic-billing-header: cc_version=([A-Za-z0-9][A-Za-z0-9._+-]*)\.000; cc_entrypoint=cli; cch=00000;$/.exec(
								block.text,
							)
						: null;
				if (match) {
					const version = match[1]!;
					const suffix = await computeBillingVersionSuffix(
						extractFirstUserMessageText(payload.messages ?? []),
						version,
					);
					block.text = `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT}; cch=00000;`;
					const cch = computeClaudeCodeCch(JSON.stringify(payload), seed);
					block.text = `${block.text.slice(0, -6)}${cch};`;
					const body = JSON.stringify(payload);
					// Parsing noncanonical JSON may change its byte length. Let fetch
					// calculate the new length rather than preserve a stale caller header.
					const headers = new Headers(init.headers);
					const staleLength = headers.has("content-length");
					if (staleLength) headers.delete("content-length");
					nextInit = { ...init, body, ...(staleLength ? { headers } : {}) };
				}
			}
		} catch {
			// Send the original request unchanged.
		}
		return transport(input, nextInit);
	};
}
