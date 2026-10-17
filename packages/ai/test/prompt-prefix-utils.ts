import { expect } from "vitest";

interface JsonSlice {
	raw: string;
	children: Map<string, JsonSlice>;
}

/** Read values without reserializing them: escaping, whitespace and key order are significant. */
export function jsonSlices(body: string): JsonSlice {
	JSON.parse(body); // Reject malformed fixtures/requests before scanning their source spans.
	let offset = 0;
	const whitespace = () => {
		while (/\s/.test(body[offset] ?? "") && offset < body.length) offset++;
	};
	const string = () => {
		const start = offset++;
		while (offset < body.length) {
			const char = body[offset++];
			if (char === "\\") offset++;
			else if (char === '"') break;
		}
		return body.slice(start, offset);
	};
	const value = (): JsonSlice => {
		whitespace();
		const start = offset;
		const children = new Map<string, JsonSlice>();
		const opening = body[offset];
		if (opening === "{" || opening === "[") {
			offset++;
			whitespace();
			const closing = opening === "{" ? "}" : "]";
			while (body[offset] !== closing) {
				let key = String(children.size);
				if (opening === "{") {
					key = JSON.parse(string()) as string;
					whitespace();
					offset++; // colon
				}
				children.set(key, value());
				whitespace();
				if (body[offset] === ",") {
					offset++;
					whitespace();
				}
			}
			offset++;
		} else if (opening === '"') {
			string();
		} else {
			while (offset < body.length && !/[\s,}\]]/.test(body[offset]!)) offset++;
		}
		return { raw: body.slice(start, offset), children };
	};
	return value();
}

interface PrefixOptions {
	fixed: readonly string[];
	history: string;
	/** Narrow, provider-specific exceptions; never canonicalize or recursively strip fields. */
	normalize?: (raw: string, path: string, previousLength: number) => string;
}

/** Compare UTF-8 bytes of fixed fields and *every* old history item at the final wire boundary. */
export function expectPromptPrefixStable(previous: string, next: string, options: PrefixOptions): void {
	const before = jsonSlices(previous).children;
	const after = jsonSlices(next).children;
	const oldHistory = before.get(options.history);
	const newHistory = after.get(options.history);
	expect(oldHistory, options.history).toBeDefined();
	expect(newHistory, options.history).toBeDefined();
	const length = oldHistory!.children.size;
	expect(length).toBeGreaterThan(0);
	expect(newHistory!.children.size).toBeGreaterThan(length);
	const compare = (left: JsonSlice | undefined, right: JsonSlice | undefined, path: string) => {
		expect(left, path).toBeDefined();
		expect(right, path).toBeDefined();
		const normalize = (raw: string) => options.normalize?.(raw, path, length) ?? raw;
		expect(Buffer.from(normalize(right!.raw), "utf8"), `cached prefix changed at ${path}`).toEqual(
			Buffer.from(normalize(left!.raw), "utf8"),
		);
	};
	for (const field of options.fixed) compare(before.get(field), after.get(field), field);
	for (const [index, item] of oldHistory!.children) {
		compare(item, newHistory!.children.get(index), `${options.history}[${index}]`);
	}
}
