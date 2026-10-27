import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, SendMessageReceipt } from "../src/core/extensions/types.ts";
import { SessionPersistenceError } from "../src/core/session-manager.ts";
import { cwdFixture } from "./suite/cwd-change-fixture.ts";
import { createBootstrappedSessionManager, createHarness, type Harness } from "./suite/harness.ts";

const custom = (content: string) => ({ customType: "receipt", content, display: false });
const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});
async function setup(bootstrap = true, extension?: (pi: ExtensionAPI) => void) {
	const h = await createHarness({
		sessionManager: bootstrap ? createBootstrappedSessionManager() : undefined,
		extensionFactories: extension ? [extension] : undefined,
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
	});
	harnesses.push(h);
	h.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("done")));
	return h;
}
function observer(h: Harness) {
	const receipts: SendMessageReceipt[] = [];
	const onReceipt = (receipt: SendMessageReceipt) => {
		if (receipt.status === "committed")
			expect(h.sessionManager.getEntry(receipt.entryId)?.type).toBe("custom_message");
		receipts.push(receipt);
	};
	return { receipts, onReceipt };
}

describe("sendMessage commit receipts", () => {
	it("idle passive is receipted after append, before sendMessage returns", async () => {
		let pi!: ExtensionAPI;
		const h = await setup(true, (api) => {
			pi = api;
		});
		const { receipts, onReceipt } = observer(h);
		pi.sendMessage(custom("passive"), { triggerTurn: false, onReceipt });
		expect(receipts).toEqual([{ status: "committed", entryId: h.sessionManager.getLeafId() }]);
	});

	it("trigger receipt follows extension message_end and its append", async () => {
		const trace: string[] = [];
		const h = await setup(true, (pi) => {
			pi.on("message_end", (event) => {
				if (event.message.role === "custom") trace.push("extension");
			});
		});
		const { receipts, onReceipt } = observer(h);
		await h.session.sendCustomMessage(custom("trigger"), {
			triggerTurn: true,
			onReceipt: (receipt) => {
				trace.push("receipt");
				onReceipt(receipt);
			},
		});
		expect(trace).toEqual(["extension", "receipt"]);
		expect(receipts).toHaveLength(1);
	});

	it("a passive/trigger batch has one receipt per item in arrival order", async () => {
		const h = await setup();
		const trace: string[] = [];
		await h.session.sendCustomMessage(custom("first"), {
			triggerTurn: false,
			orderKey: "a",
			onReceipt: () => {
				trace.push("first");
			},
		});
		await h.session.sendCustomMessage(custom("last"), {
			triggerTurn: true,
			orderKey: "b",
			onReceipt: () => {
				trace.push("last");
			},
		});
		expect(trace).toEqual(["first", "last"]);
		expect(h.faux.state.callCount).toBe(1);
	});

	it("steer and follow-up lanes during a run receipt exactly once each", async () => {
		const receipts: string[] = [];
		const h = await setup(true, (pi) => {
			let sent = false;
			pi.on("agent_start", () => {
				if (sent) return;
				sent = true;
				pi.sendMessage(custom("steer"), {
					deliverAs: "steer",
					onReceipt: () => {
						receipts.push("steer");
					},
				});
				pi.sendMessage(custom("follow"), {
					deliverAs: "followUp",
					onReceipt: () => {
						receipts.push("follow");
					},
				});
			});
		});
		await h.session.prompt("go");
		expect(receipts).toEqual(["steer", "follow"]);
	});

	it("failed append stays owned until a later successful retry", async () => {
		const h = await setup();
		const { receipts, onReceipt } = observer(h);
		const append = vi.spyOn(h.sessionManager, "appendCustomMessageEntry").mockImplementation(() => {
			throw new Error("refused");
		});
		await h.session.sendCustomMessage(custom("retry"), { triggerTurn: true, onReceipt });
		expect(receipts).toEqual([]);
		append.mockRestore();
		await h.session.sendCustomMessage(custom("flush"), { triggerTurn: false });
		expect(receipts).toHaveLength(1);
		expect(receipts[0].status).toBe("committed");
		expect(
			h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.content === "retry"),
		).toHaveLength(1);
	});

	it("staged content is receipted only at bootstrap", async () => {
		const h = await setup(false);
		const { receipts, onReceipt } = observer(h);
		await h.session.sendCustomMessage(custom("staged"), { triggerTurn: false, onReceipt });
		expect(receipts).toEqual([]);
		await h.session.prompt("bootstrap");
		expect(receipts).toHaveLength(1);
		expect(receipts[0].status).toBe("committed");
	});

	it("tree navigation drops staged content", async () => {
		const h = await setup(false);
		const target = h.sessionManager.appendCustomEntry("target", {});
		h.sessionManager.appendCustomEntry("source", {});
		const { receipts, onReceipt } = observer(h);
		await h.session.sendCustomMessage(custom("staged"), { triggerTurn: false, onReceipt });
		await h.session.navigateTree(target);
		expect(receipts).toEqual([{ status: "dropped" }]);
	});

	it("cwd carry is receipted by the new session at bootstrap", async () => {
		const f = await cwdFixture();
		try {
			const receipts: SendMessageReceipt[] = [];
			await f.runtime.session.sendCustomMessage(custom("carried"), {
				triggerTurn: false,
				onReceipt: (receipt) => {
					if (receipt.status === "committed")
						expect(f.runtime.session.sessionManager.getEntry(receipt.entryId)?.type).toBe("custom_message");
					receipts.push(receipt);
				},
			});
			expect((await f.runtime.changeCwd(f.b, { source: "user" })).changed).toBe(true);
			expect(receipts).toEqual([]);
			await f.runtime.session.prompt("go");
			expect(receipts).toHaveLength(1);
			expect(receipts[0].status).toBe("committed");
		} finally {
			await f.cleanup();
		}
	});

	it.each(["recover", "failure", "sticky"] as const)("dispose receipts an idle owned item: %s", async (scenario) => {
		const h = await setup();
		const { receipts, onReceipt } = observer(h);
		const append = vi.spyOn(h.sessionManager, "appendCustomMessageEntry").mockImplementation(() => {
			throw new Error("refused");
		});
		await expect(h.session.sendCustomMessage(custom("owned"), { triggerTurn: false, onReceipt })).rejects.toThrow(
			"refused",
		);
		if (scenario === "recover") append.mockRestore();
		if (scenario === "sticky")
			vi.spyOn(h.sessionManager, "getPersistenceError").mockReturnValue(
				new SessionPersistenceError(new Error("sticky")),
			);
		h.session.dispose();
		h.session.dispose();
		expect(receipts).toHaveLength(1);
		expect(receipts[0].status).toBe(scenario === "recover" ? "committed" : "dropped");
	});

	it.each(["commit", "drop"] as const)(
		"dispose during an active append admission leaves %s to loop unwind",
		async (outcome) => {
			let release!: () => void;
			let entered!: () => void;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			const ready = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const h = await setup(true, (pi) => {
				pi.on("message_end", async (event) => {
					if (event.message.role === "custom") {
						entered();
						await blocked;
					}
				});
			});
			const { receipts, onReceipt } = observer(h);
			const sending = h.session.sendCustomMessage(custom("admitted"), { triggerTurn: true, onReceipt });
			await ready;
			if (outcome === "drop")
				vi.spyOn(h.sessionManager, "appendCustomMessageEntry").mockImplementation(() => {
					throw new Error("refused");
				});
			h.session.dispose();
			expect(receipts).toEqual([]);
			release();
			await sending;
			expect(receipts).toHaveLength(1);
			expect(receipts[0].status).toBe(outcome === "commit" ? "committed" : "dropped");
		},
	);

	it("dispose drops staged content without waiting for an async receipt callback", async () => {
		const h = await setup(false);
		const onReceipt = vi.fn(async () => new Promise<void>(() => {}));
		await h.session.sendCustomMessage(custom("staged"), { triggerTurn: false, onReceipt });
		h.session.dispose();
		expect(onReceipt).toHaveBeenCalledExactlyOnceWith({ status: "dropped" });
	});

	it.each(["commit", "staged drop", "final drop"] as const)(
		"async receipt rejection is reported without waiting or repeating: %s",
		async (scenario) => {
			const h = await setup(scenario !== "staged drop");
			const report = vi.fn();
			h.session.extensionRunner.onError(report);
			let reject!: (error: Error) => void;
			const pending = new Promise<void>((_resolve, rejectPromise) => {
				reject = rejectPromise;
			});
			const failure = new Error("async receipt failed");
			const onReceipt = vi.fn(async () => {
				await pending;
			});
			if (scenario === "final drop") {
				vi.spyOn(h.sessionManager, "appendCustomMessageEntry").mockImplementation(() => {
					throw new Error("refused");
				});
				await expect(
					h.session.sendCustomMessage(custom("async"), { triggerTurn: false, onReceipt }),
				).rejects.toThrow("refused");
			} else {
				await h.session.sendCustomMessage(custom("async"), { triggerTurn: false, onReceipt });
			}
			h.session.dispose();
			h.session.dispose();
			expect(onReceipt).toHaveBeenCalledExactlyOnceWith(
				scenario === "commit"
					? { status: "committed", entryId: h.sessionManager.getLeafId() }
					: { status: "dropped" },
			);
			expect(h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(
				scenario === "commit" ? 1 : 0,
			);
			report.mockClear();
			reject(failure);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(report).toHaveBeenCalledExactlyOnceWith({
				extensionPath: "<runtime>",
				event: "send_message_receipt",
				error: failure.message,
				stack: failure.stack,
			});
			expect(onReceipt).toHaveBeenCalledOnce();
		},
	);

	it("reentrant idle receipt sends once, without repeating the first receipt", async () => {
		const h = await setup();
		const trace: string[] = [];
		await h.session.sendCustomMessage(custom("A"), {
			triggerTurn: false,
			onReceipt: () => {
				trace.push("A");
				void h.session.sendCustomMessage(custom("B"), {
					triggerTurn: false,
					onReceipt: () => {
						trace.push("B");
					},
				});
			},
		});
		expect(trace).toEqual(["A", "B"]);
		expect(
			h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message")
				.map((entry) => entry.content),
		).toEqual(["A", "B"]);
	});

	it("bootstrap callbacks cannot interleave reentrant content into the existing batch", async () => {
		const h = await setup(false);
		const trace: string[] = [];
		await h.session.sendCustomMessage(custom("A"), {
			triggerTurn: false,
			onReceipt: () => {
				trace.push("A");
				expect(
					h.sessionManager
						.getEntries()
						.filter((entry) => entry.type === "custom_message")
						.map((entry) => entry.content),
				).toEqual(["A", "B"]);
				void h.session.sendCustomMessage(custom("C"), {
					triggerTurn: false,
					onReceipt: () => {
						trace.push("C");
					},
				});
			},
		});
		await h.session.sendCustomMessage(custom("B"), {
			triggerTurn: false,
			onReceipt: () => {
				trace.push("B");
			},
		});
		await h.session.prompt("go");
		expect(trace).toEqual(["A", "B", "C"]);
		expect(
			h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message")
				.map((entry) => entry.content),
		).toEqual(["A", "B", "C"]);
	});

	it("receipts survive sender invalidation by reload", async () => {
		let pi!: ExtensionAPI;
		const h = await setup(false, (api) => {
			pi = api;
		});
		await h.session.bindExtensions({});
		const { receipts, onReceipt } = observer(h);
		pi.sendMessage(custom("survives"), { triggerTurn: false, onReceipt });
		const oldRunner = h.session.extensionRunner;
		await h.session.reload();
		expect(oldRunner.isInvalidated()).toBe(true);
		await h.session.prompt("go");
		expect(receipts).toHaveLength(1);
	});

	it("throwing callbacks are reported without failing or duplicating the append", async () => {
		const h = await setup();
		const errors: string[] = [];
		h.session.extensionRunner.onError((error) => errors.push(error.error));
		const onReceipt = vi.fn(() => {
			throw new Error("receipt failed");
		});
		await h.session.sendCustomMessage(custom("throw"), { triggerTurn: false, onReceipt });
		expect(errors).toContain("receipt failed");
		expect(onReceipt).toHaveBeenCalledOnce();
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
	});

	it("nextTurn with onReceipt throws synchronously at the extension boundary", async () => {
		let pi!: ExtensionAPI;
		await setup(true, (api) => {
			pi = api;
		});
		expect(() => pi.sendMessage(custom("unsupported"), { deliverAs: "nextTurn", onReceipt: () => {} })).toThrow(
			'onReceipt is not supported with deliverAs "nextTurn"',
		);
	});
});
