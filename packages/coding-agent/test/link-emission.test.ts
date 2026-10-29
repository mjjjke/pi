import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getCapabilities, setCapabilities, setMarkdownLinkOptions } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { browserLink } from "../src/utils/browser-link.ts";
import { openBrowser } from "../src/utils/open-browser.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));
afterEach(() => vi.clearAllMocks());
it("real user and assistant prompt zones survive the regular/exit-transcript sink", () => {
	initTheme("dark");
	const terminal = new VirtualTerminal(80, 24);
	const writes: string[] = [];
	terminal.write = (data) => {
		writes.push(data);
	};
	const tui = new TuiMainScreen(terminal);
	tui.addChild(new UserMessageComponent("hello"));
	tui.addChild(
		new AssistantMessageComponent({
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "test",
			content: [{ type: "text", text: "hello" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		}),
	);
	tui.start();
	tui.renderNow();
	tui.stop();
	for (const zone of ["A", "B", "C"])
		expect(writes.join("").match(new RegExp(`\\x1b\\]133;${zone}\\x07`, "g"))).toHaveLength(2);
});
it("assistant streaming defers only the growing final bare target, preserving delimiters and finalization", () => {
	initTheme("dark");
	const capabilities = getCapabilities();
	setCapabilities({ ...capabilities, hyperlinks: true });
	setMarkdownLinkOptions({
		linkify: (text) =>
			[...text.matchAll(/a\.ts/g)].map((match) => ({
				start: match.index,
				end: match.index + 4,
				target: "https://files.test/a.ts",
			})),
	});
	const component = new AssistantMessageComponent();
	const message: AssistantMessage = {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "test",
		content: [],
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	try {
		for (const text of ["https://pi/", "[docs](https://pi/", "a.ts"]) {
			message.content = [{ type: "text", text }];
			component.updateContent(message, true);
			expect(component.render(120).join("")).not.toContain("\x1b]8;");
			component.invalidate();
			expect(component.render(120).join("")).not.toContain("\x1b]8;");
			message.content = [{ type: "text", text: `${text} ` }];
			component.updateContent(message, true);
			expect(component.render(120).join("")).toContain("\x1b]8;");
			message.content = [{ type: "text", text }];
			component.updateContent(message, false);
			expect(component.render(120).join("")).toContain("\x1b]8;");
			message.content = [
				{ type: "text", text },
				{ type: "text", text: "next block" },
			];
			component.updateContent(message, true);
			expect(component.render(120).join("")).toContain("\x1b]8;");
		}
		const writes: string[] = [];
		const terminal = new VirtualTerminal(120, 24);
		terminal.write = (data) => {
			writes.push(data);
		};
		const tui = new TuiMainScreen(terminal);
		tui.addChild(component);
		message.content = [{ type: "text", text: "[docs](https://pi/" }];
		component.updateContent(message, true);
		tui.start();
		try {
			tui.renderNow();
			expect(writes.join("")).not.toMatch(/\x1b\]8;[^;]*;https?:/);
			message.content = [{ type: "text", text: "[docs](https://pi.dev/docs)" }];
			component.updateContent(message, true);
			tui.renderNow();
			expect(writes.join("")).toContain("https://pi.dev/docs");
		} finally {
			tui.stop();
		}
	} finally {
		setCapabilities(capabilities);
		setMarkdownLinkOptions({});
	}
});

it("auth/share links retain sanitized labels without OSC 8 when hyperlinks are unsupported", () => {
	const capabilities = getCapabilities();
	try {
		setCapabilities({ ...capabilities, hyperlinks: false });
		expect(browserLink("\x1b]0;title\x07label", "https://example.com/share")).toBe("label");
		initTheme("dark");
		const dialog = new LoginDialogComponent(new TuiMainScreen(new VirtualTerminal()), "test", () => {});
		dialog.showDeviceCode({ verificationUri: "https://example.com/device", userCode: "123" });
		expect(dialog.render(120).join("\n")).not.toContain("\x1b]8;");
		setCapabilities({ ...capabilities, hyperlinks: true });
		expect(browserLink("label", "https://example.com/share")).toContain("\x1b]8;");
	} finally {
		setCapabilities(capabilities);
	}
});

it("auth, device and provider-info emissions refuse schemes and sanitize labels before styling", () => {
	initTheme("dark");
	const tui = new TuiMainScreen(new VirtualTerminal());
	const dialog = new LoginDialogComponent(tui, "test", () => {});
	const url = "smb://host/share\x1b]0;title\x07";
	dialog.showAuth(url);
	expect(openBrowser).not.toHaveBeenCalled();
	dialog.showDeviceCode({ verificationUri: url, userCode: "123" });
	dialog.showInfo("info", [{ label: "\x1b]0;title\x07label", url }]);
	const rendered = dialog.render(120).join("\n");
	expect(rendered).not.toMatch(/\x1b\]8;|\x1b\]0;/);
	expect(rendered).toContain("Not opened: unsupported URL scheme");
	expect(browserLink(url, url)).not.toMatch(/\x1b/);
	dialog.showAuth("http://localhost:123/callback");
	expect(openBrowser).toHaveBeenCalledExactlyOnceWith("http://localhost:123/callback");
});
