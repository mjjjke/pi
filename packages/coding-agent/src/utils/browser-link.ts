import { getCapabilities, linkTo, sanitizeTerminalText } from "@earendil-works/pi-tui";
import { authorizeBrowserUrl } from "./link-policy.ts";

/** Sanitize before styling; rejected remote URLs never become OSC payloads. */
export function browserLink(label: string, rawTarget: string, id?: string): string {
	const text = sanitizeTerminalText(label);
	const target = authorizeBrowserUrl(rawTarget);
	if (!target) return `${text} (Not opened: unsupported URL scheme)`;
	return getCapabilities().hyperlinks ? linkTo(text, target, { id }) : text;
}
