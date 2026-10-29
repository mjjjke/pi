import { statSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { MarkdownLinkSpan } from "@earendil-works/pi-tui";
import { authorizeLinkTarget, type EditorLinks } from "./link-policy.ts";
import { resolvePath } from "./paths.ts";

interface DetectorOptions {
	maxEntries?: number;
	ttlMs?: number;
	authorize?: (target: string) => string | undefined;
}
interface Discovery {
	target?: string;
	exactFile?: boolean;
	expires: number;
}

/** Bounded positive/negative disk discovery. A new instance invalidates cwd/editor state. */
export class LinkDetector {
	private readonly cwd: string;
	private readonly editor: EditorLinks;
	private readonly options: DetectorOptions;
	private readonly cache = new Map<string, Discovery>();
	constructor(cwd: string, editor: EditorLinks, options: DetectorOptions = {}) {
		this.cwd = cwd;
		this.editor = editor;
		this.options = options;
	}
	private remember(key: string, discovery: Discovery): Discovery {
		this.cache.delete(key);
		this.cache.set(key, discovery);
		if (this.cache.size > (this.options.maxEntries ?? 2048)) this.cache.delete(this.cache.keys().next().value!);
		return discovery;
	}
	private discover(raw: string, exact: boolean): Discovery {
		const path = resolvePath(raw, this.cwd);
		const key = `${exact ? "exact" : "file"}:${path}`;
		const cached = this.cache.get(key);
		const now = Date.now();
		if (cached && cached.expires > now) return this.remember(key, cached);
		const expires = now + (this.options.ttlMs ?? 5000);
		if (exact) {
			if (!/[A-Za-z]/.test(basename(path))) return this.remember(key, { expires });
			try {
				if (statSync(path).isFile())
					return this.remember(key, {
						expires,
						exactFile: true,
						target: authorizeLinkTarget(pathToFileURL(path).href, { editorLinks: this.editor }),
					});
			} catch {
				/* Missing exact codespan: try a position suffix next. */
			}
			return this.remember(key, { expires });
		}
		const name = basename(raw);
		if (!/[A-Za-z]/.test(name) || (!raw.includes("/") && !raw.includes("."))) return this.remember(key, { expires });
		const target = pathToFileURL(path).href;
		return this.remember(key, {
			expires,
			target: this.options.authorize
				? this.options.authorize(target)
				: authorizeLinkTarget(target, { editorLinks: this.editor }),
		});
	}
	readonly authorize = (target: string): string | undefined => {
		const key = `url:${target}`;
		const cached = this.cache.get(key);
		const now = Date.now();
		if (cached && cached.expires > now) return this.remember(key, cached).target;
		return this.remember(key, {
			expires: now + (this.options.ttlMs ?? 5000),
			target: authorizeLinkTarget(target, { editorLinks: this.editor }),
		}).target;
	};
	readonly linkify = (text: string, kind: "text" | "codespan"): MarkdownLinkSpan[] => {
		if (kind === "codespan" && this.editor !== "file") {
			const exact = this.discover(text, true);
			if (exact.exactFile) return exact.target ? [{ start: 0, end: text.length, target: exact.target }] : [];
		}
		const spans: MarkdownLinkSpan[] = [];
		// URLs own their entire token before path discovery, so /a.ts in a URL is never probed.
		const candidate = /(^|[\s([{"'`])([^\s<>()[\]{}"'`]+)/g;
		for (const match of text.matchAll(candidate)) {
			const raw = match[2].replace(/[.,;!?]+$/, "");
			if (!raw) continue;
			const start = match.index + match[1].length;
			let target: string | undefined;
			if (/^(?:https?:\/\/|mailto:)/i.test(raw)) target = authorizeLinkTarget(raw);
			else if (this.editor !== "file" && !raw.includes("://")) {
				const position = /:([0-9]+)(?::([0-9]+))?$/.exec(raw);
				const file = position ? raw.slice(0, position.index) : raw;
				const validPosition =
					!position ||
					[position[1], position[2]].every(
						(value) => value === undefined || (Number(value) >= 1 && Number(value) <= 1e7),
					);
				if (validPosition) {
					target = this.discover(file, false).target;
					if (target && position)
						target = target.replace(
							/:1$/,
							`:${Number(position[1])}${position[2] ? `:${Number(position[2])}` : ""}`,
						);
				}
			}
			if (target) spans.push({ start, end: start + raw.length, target });
		}
		return spans;
	};
}
