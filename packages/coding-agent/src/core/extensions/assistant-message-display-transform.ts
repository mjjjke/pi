import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { AssistantMessageDisplayTransformResult } from "./types.ts";

export function cloneAssistantMessage(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.map((block): AssistantMessage["content"][number] => {
			switch (block.type) {
				case "text":
					return { ...block };
				case "thinking":
					return { ...block };
				case "toolCall":
					return { ...block, arguments: structuredClone(block.arguments) };
			}
			const _exhaustive: never = block;
			return _exhaustive;
		}),
		diagnostics: message.diagnostics ? structuredClone(message.diagnostics) : undefined,
		usage: {
			...message.usage,
			cost: { ...message.usage.cost },
		},
	};
}

export function deepFreeze<T>(value: T): Readonly<T> {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return value as Readonly<T>;
	}

	Object.freeze(value);
	const object = value as Record<string, unknown>;
	for (const key of Object.getOwnPropertyNames(object)) {
		deepFreeze(object[key]);
	}
	return value as Readonly<T>;
}

function cloneTextBlockWithText(
	block: Pick<TextContent, "text" | "textSignature">,
	text: string,
	textSignature?: string,
): TextContent {
	const next: TextContent = { type: "text", text };
	if (textSignature !== undefined) {
		next.textSignature = textSignature;
	} else if (text === block.text && block.textSignature !== undefined) {
		next.textSignature = block.textSignature;
	}
	return next;
}

function replaceAggregateText(message: AssistantMessage, text: string): AssistantMessage {
	const displayMessage = cloneAssistantMessage(message);
	let replacedFirstText = false;
	const content: AssistantMessage["content"] = [];

	for (const block of displayMessage.content) {
		if (block.type !== "text") {
			content.push(block);
			continue;
		}

		content.push(cloneTextBlockWithText(block, replacedFirstText ? "" : text));
		replacedFirstText = true;
	}

	if (!replacedFirstText && text.length > 0) {
		content.unshift({ type: "text", text });
	}

	return { ...displayMessage, content };
}

function getReturnedContent(result: AssistantMessageDisplayTransformResult): unknown[] | undefined {
	if (Array.isArray(result)) {
		return result;
	}
	if (typeof result !== "object" || result === null || !("content" in result)) {
		return undefined;
	}

	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return undefined;
	}
	return content;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getReturnedTextBlock(block: unknown): Pick<TextContent, "text" | "textSignature"> | undefined {
	if (!isObject(block) || block.type !== "text") {
		return undefined;
	}
	if (typeof block.text !== "string") {
		throw new Error("Assistant message display transform returned a text block without string text");
	}
	if (block.textSignature !== undefined && typeof block.textSignature !== "string") {
		throw new Error("Assistant message display transform returned a text block with non-string textSignature");
	}
	return { text: block.text, textSignature: block.textSignature };
}

function firstReturnedText(content: unknown[]): Pick<TextContent, "text" | "textSignature"> | undefined {
	for (const block of content) {
		const textBlock = getReturnedTextBlock(block);
		if (textBlock && textBlock.text.length > 0) {
			return textBlock;
		}
	}
	return undefined;
}

export function sanitizeAssistantMessageDisplayTransformResult(
	currentDisplayMessage: AssistantMessage,
	result: AssistantMessageDisplayTransformResult,
): AssistantMessage {
	if (result === undefined) {
		return currentDisplayMessage;
	}

	if (typeof result === "string") {
		return replaceAggregateText(currentDisplayMessage, result);
	}

	const resultContent = getReturnedContent(result);
	if (!resultContent) {
		return currentDisplayMessage;
	}

	const displayMessage = cloneAssistantMessage(currentDisplayMessage);
	let sawTextBlock = false;
	const content = displayMessage.content.map((block, index) => {
		if (block.type !== "text") {
			return block;
		}

		sawTextBlock = true;
		const returnedBlock = getReturnedTextBlock(resultContent[index]);
		if (!returnedBlock) {
			return block;
		}

		return cloneTextBlockWithText(block, returnedBlock.text, returnedBlock.textSignature);
	});

	if (!sawTextBlock) {
		const textBlock = firstReturnedText(resultContent);
		if (textBlock) {
			content.unshift(cloneTextBlockWithText(textBlock, textBlock.text, textBlock.textSignature));
		}
	}

	return { ...displayMessage, content };
}
