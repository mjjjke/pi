import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getCapabilities, setCapabilities, setMarkdownLinkOptions } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { TuiAltScreen } from "../../tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { browserLink } from "../src/utils/browser-link.ts";
import { LinkDetector } from "../src/utils/link-detector.ts";
import { transcriptSinkPolicy } from "../src/utils/link-policy.ts";
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

it.each([false, true])("streaming punctuation never completes a raw token (fullscreen=%s)", (fullscreen) => {
	initTheme("dark");
	const capabilities = getCapabilities();
	const cwd = mkdtempSync(join(tmpdir(), "streaming-links-"));
	writeFileSync(join(cwd, "foo.ts"), "");
	const detector = new LinkDetector(cwd, "zed");
	setCapabilities({ ...capabilities, hyperlinks: true });
	setMarkdownLinkOptions({ linkify: detector.linkify, linkPolicy: detector.authorize });
	const sequences = [
		["https://example.com/a", "https://example.com/a.", "https://example.com/a.ts"],
		["https://example", "https://example.", "https://example.com"],
		["foo.", "foo.ts", "foo.ts.", "foo.ts:", "foo.ts:1", "foo.ts:12"],
		["https://example.com/a?", "https://example.com/a?x", "https://example.com/a?x=1"],
		["https://example.com/a#", "https://example.com/a#s", "https://example.com/a#section"],
	];
	try {
		for (const sequence of sequences) {
			const writes: string[] = [];
			const terminal = new VirtualTerminal(120, 24);
			terminal.write = (data) => {
				writes.push(data);
			};
			const tui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
			tui.setLinkPolicy(transcriptSinkPolicy("zed"));
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
			tui.addChild(component);
			tui.start();
			try {
				for (const text of sequence) {
					writes.length = 0;
					message.content = [{ type: "text", text }];
					component.updateContent(message, true);
					tui.renderNow();
					expect(writes.join(""), text).not.toMatch(/\x1b\]8;[^;]*;[^\x1b\x07]+/);
					component.invalidate();
					tui.renderNow();
					expect(writes.join(""), text).not.toMatch(/\x1b\]8;[^;]*;[^\x1b\x07]+/);
				}
				const complete = sequence[sequence.length - 1];
				for (const delimiter of [" ", "\n", "\t"]) {
					message.content = [{ type: "text", text: complete }];
					component.updateContent(message, true);
					tui.renderNow();
					writes.length = 0;
					message.content = [{ type: "text", text: `${complete}${delimiter}` }];
					component.updateContent(message, true);
					tui.renderNow();
					expect(writes.join("")).toMatch(/\x1b\]8;[^;]*;[^\x1b\x07]+/);
				}
				message.content = [{ type: "text", text: complete }];
				component.updateContent(message, true);
				tui.renderNow();
				writes.length = 0;
				component.updateContent(message, false);
				tui.renderNow();
				expect(writes.join("")).toMatch(/\x1b\]8;[^;]*;[^\x1b\x07]+/);
				message.content = [{ type: "text", text: "[complete](https://example.com/a.ts)" }];
				component.updateContent(message, true);
				writes.length = 0;
				tui.renderNow();
				expect(writes.join("")).toMatch(/\x1b\]8;[^;]*;https:\/\/example.com\/a\.ts/);
			} finally {
				tui.stop();
			}
		}
	} finally {
		setCapabilities(capabilities);
		setMarkdownLinkOptions({});
		rmSync(cwd, { recursive: true, force: true });
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
