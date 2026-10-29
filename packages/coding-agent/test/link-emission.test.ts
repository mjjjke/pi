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
