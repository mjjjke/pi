import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { cwdAppliedNotice, formatCwdWarning, resolveCwdTarget } from "../src/core/cwd-change.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const prototype = InteractiveMode.prototype as unknown as {
	handleCdCommand(this: object, args: string): Promise<void>;
};

describe("interactive /cd", () => {
	beforeAll(() => initTheme("dark"));
	it("registers the command and resolves exactly one matching quote pair, not shell syntax", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((c) => c.name === "cd")).toBe(true);
		expect(resolveCwdTarget('  "../two words"  ', "/one/a")).toBe("/one/two words");
		expect(resolveCwdTarget("$HOME; pwd", "/one")).toBe("/one/$HOME; pwd");
	});

	it.each([
		["isStreaming", "Wait for the current response to finish before changing directory."],
		["isCompacting", "Wait for compaction to finish before changing directory."],
		["isBashRunning", "Wait for the shell command to finish before changing directory."],
	])("refuses %s without runtime changes", async (flag, text) => {
		const showWarning = vi.fn();
		const changeCwd = vi.fn();
		await prototype.handleCdCommand.call(
			{ session: { [flag]: true }, sessionManager: { getCwd: () => "/a" }, showWarning, runtimeHost: { changeCwd } },
			"/b",
		);
		expect(showWarning).toHaveBeenCalledWith(text);
		expect(changeCwd).not.toHaveBeenCalled();
	});

	it.each(["idle", "shell", "compaction"] as const)(
		"Escape while a cwd is pending cancels it and preserves %s stop behavior",
		(state) => {
			const abort = vi.fn(async () => {});
			const abortBash = vi.fn();
			const session = {
				pendingCwdChange: { state: "pending" },
				isIdle: state !== "compaction",
				isCompacting: state === "compaction",
				isBashRunning: state === "shell",
				abort,
				abortBash,
				abortCompaction: vi.fn(),
			};
			const editor = { onEscape: undefined as (() => void) | undefined, onAction: vi.fn() };
			const context = { session, defaultEditor: editor, ui: {}, restoreQueuedMessagesToEditor: vi.fn() };
			Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(context);
			editor.onEscape?.();
			expect(abort).toHaveBeenCalledOnce();
			if (state === "shell") expect(abortBash).toHaveBeenCalledOnce();
		},
	);

	it("distinguishes committed cleanup warnings from power-loss durability warnings", () => {
		expect(formatCwdWarning("cd: unlink /old: refused", "~/b")).toBe(
			"cd: could not remove the old session file (cd: unlink /old: refused); it stays hidden from /resume and is removed the next time this session is opened or changes directory.",
		);
		expect(formatCwdWarning("cd: fsync /new: refused", "~/b")).toBe(
			"cd: changed to ~/b, but the change may not survive a power loss (cd: fsync /new: refused); the old copy is kept hidden until it does.",
		);
	});

	it("query and same directory are dim status rows, no transition", async () => {
		const showStatus = vi.fn();
		const context = { sessionManager: { getCwd: () => "/a" }, formatDisplayPath: (p: string) => p, showStatus };
		await prototype.handleCdCommand.call(context, "");
		await prototype.handleCdCommand.call(context, "/a");
		expect(showStatus.mock.calls.map(([text]) => text)).toEqual(["Working directory: /a", "Already in /a"]);
	});

	it.each([40, 80])("renders one unboxed cwd marker at %s columns, expanded shows literal notice", (width) => {
		const from = "/home/u/previous-project";
		const to = "/home/u/destination-project";
		const notice = cwdAppliedNotice(from, to);
		const component = new CustomMessageComponent({
			role: "custom",
			customType: "pi.cwd",
			content: notice,
			display: true,
			details: { kind: "applied", from, to },
			timestamp: 0,
		});
		const rows = component
			.render(width)
			.map(strip)
			.filter((row) => row.trim());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("✓ cd");
		expect(rows[0]).not.toContain("[pi.cwd]");
		expect(visibleWidth(rows[0])).toBeLessThanOrEqual(width);
		component.setExpanded(true);
		expect(component.render(width).map(strip).join("\n").replace(/\s+/g, " ")).toContain(notice);
	});
});
