import { statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type LinkPolicy, sanitizeTerminalText, webLinkPolicy } from "@earendil-works/pi-tui";

export type EditorLinks = "file" | "zed" | "vscode";
export interface LinkAuthorizationOptions {
	editorLinks?: EditorLinks;
	line?: number;
	col?: number;
	origin?: "imageFallback";
}
const controls = /[\x00-\x1f\x7f-\x9f]/;
const imageExtension = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?)$/i;

function parse(target: string, limit: number): URL | undefined {
	if (!target || target.length > limit || controls.test(target)) return undefined;
	try {
		if (controls.test(decodeURIComponent(target))) return undefined;
		const url = new URL(target);
		return url.username || url.password ? undefined : url;
	} catch {
		return undefined;
	}
}

/** Auth/share URLs never inherit transcript editor or file permissions. */
export function authorizeBrowserUrl(target: string): string | undefined {
	const url = parse(target, 8192);
	if (!url) return undefined;
	return url.protocol === "https:" ||
		(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
		? url.href
		: undefined;
}

function fileTarget(
	target: string,
	options: LinkAuthorizationOptions,
): { path: string; line: number; col?: number } | undefined {
	const url = parse(target, 4096);
	if (!url) return undefined;
	let path: string;
	let line = options.line ?? 1;
	let col = options.col;
	if (url.protocol === "file:") {
		if ((url.host && url.host !== "localhost") || url.search || url.hash) return undefined;
		try {
			path = fileURLToPath(url);
		} catch {
			return undefined;
		}
	} else {
		const editor = options.editorLinks ?? "file";
		if (
			editor === "file" ||
			url.protocol !== `${editor}:` ||
			url.host !== "file" ||
			url.port ||
			url.search ||
			url.hash
		)
			return undefined;
		path = decodeURIComponent(url.pathname);
		const position = /:([0-9]+)(?::([0-9]+))?$/.exec(path);
		if (position) {
			path = path.slice(0, position.index);
			line = Number(position[1]);
			col = position[2] ? Number(position[2]) : undefined;
		}
	}
	if (!isAbsolute(path) || controls.test(path) || /:\d+(?::\d+)?$/.test(basename(path))) return undefined;
	if (
		!Number.isInteger(line) ||
		line < 1 ||
		line > 1e7 ||
		(col !== undefined && (!Number.isInteger(col) || col < 1 || col > 1e7))
	)
		return undefined;
	return { path, line, col };
}

/** Pure output-sink check. No disk discovery or stat on the render hot path. */
export function transcriptSinkPolicy(editorLinks: EditorLinks = "file"): LinkPolicy {
	return (target) => {
		const web = webLinkPolicy(target);
		if (web) return web;
		const file = fileTarget(target, { editorLinks });
		if (!file) return undefined;
		if (editorLinks === "file")
			return target.startsWith("file:") && imageExtension.test(file.path) ? target : undefined;
		return target.startsWith(`${editorLinks}://file/`) ? target : undefined;
	};
}

/** Authorize at emission and again at click: canonical file paths need exactly one stat. */
export function authorizeLinkTarget(target: string, options: LinkAuthorizationOptions = {}): string | undefined {
	const web = webLinkPolicy(target);
	if (web) return new URL(web).href;
	const file = fileTarget(target, options);
	if (!file) return undefined;
	const editor = options.editorLinks ?? "file";
	if (editor === "file" && (options.origin !== "imageFallback" || !imageExtension.test(file.path))) return undefined;
	try {
		if (!statSync(file.path).isFile()) return undefined;
	} catch {
		return undefined;
	}
	if (editor === "file") return pathToFileURL(file.path).href;
	const encoded = pathToFileURL(file.path).pathname;
	return `${editor}://file${encoded}:${file.line}${file.col === undefined ? "" : `:${file.col}`}`;
}

export function openTranscriptLink(
	target: string,
	options: LinkAuthorizationOptions,
	open: (url: string) => void,
): string | undefined {
	const canonical = authorizeLinkTarget(target, { ...options, origin: "imageFallback" });
	if (!canonical) return sanitizeTerminalText("Not opened: unsupported URL scheme or unavailable file");
	open(canonical);
	return undefined;
}
