import { hyperlink, sanitizeTerminalText } from "@earendil-works/pi-tui";
import { authorizeBrowserUrl } from "./link-policy.ts";

/** Sanitize before styling; rejected remote URLs never become OSC payloads. */
export function browserLink(label: string, rawTarget: string): string {
	const text = sanitizeTerminalText(label);
	const target = authorizeBrowserUrl(rawTarget);
	return target ? hyperlink(text, target) : `${text} (Not opened: unsupported URL scheme)`;
}
