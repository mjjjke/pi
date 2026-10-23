import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, SessionPersistenceError } from "../../src/core/session-manager.ts";

// Pass-through fs with fault hooks (§3.6, Astra M4).
const faults = vi.hoisted(() => ({
	/** Fail the n-th whole-file entry write (fd writes) after writing half of it. */
	failFdWriteAt: undefined as number | undefined,
	fdWrites: 0,
	/** Short-write the next append: write half of the data, then throw. */
	shortAppend: false,
}));
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	const ioError = () => Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
	return {
		...actual,
		writeFileSync: (target: unknown, data: unknown, ...rest: unknown[]) => {
			if (typeof target === "number" && faults.failFdWriteAt !== undefined) {
				faults.fdWrites++;
				if (faults.fdWrites === faults.failFdWriteAt) {
					actual.writeSync(target, String(data).slice(0, String(data).length / 2));
					throw ioError();
				}
			}
			return (actual.writeFileSync as (...args: unknown[]) => void)(target, data, ...rest);
		},
		appendFileSync: (target: unknown, data: unknown, ...rest: unknown[]) => {
			if (faults.shortAppend) {
				faults.shortAppend = false;
				actual.appendFileSync(target as string, String(data).slice(0, Math.floor(String(data).length / 2)));
				throw ioError();
			}
			return (actual.appendFileSync as (...args: unknown[]) => void)(target, data, ...rest);
		},
	};
});

const EXPECTED_TEXT =
	"Session file write failed (EIO): the last entry may be missing or partial. Resume the session (/resume, or restart with pi -c) to continue.";

const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

describe("session persistence failures (§3.6)", () => {
	let dir: string;
	beforeEach(() => {
		dir = realFs.mkdtempSync(join(tmpdir(), "pi-persist-"));
	});
	afterEach(() => {
		faults.failFdWriteAt = undefined;
		faults.fdWrites = 0;
		faults.shortAppend = false;
		realFs.rmSync(dir, { recursive: true, force: true });
	});

	const files = () => realFs.readdirSync(dir);
	const lines = (file: string) => realFs.readFileSync(file, "utf8").split("\n");

	it("a first flush failing mid-file leaves no visible file and rolls memory back; a retry creates the file once", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendModelChange("p", "m");
		const leaf = manager.getLeafId();
		faults.failFdWriteAt = 2;
		expect(() => manager.appendMessage(user("hello"))).toThrow("EIO");
		faults.failFdWriteAt = undefined;
		expect(files()).toEqual([]);
		expect(manager.getLeafId()).toBe(leaf);
		expect(manager.getEntries()).toHaveLength(1);
		expect(manager.getPersistenceError()).toBeUndefined();

		const id = manager.appendMessage(user("hello"));
		expect(files()).toEqual([realFs.readdirSync(dir)[0]]);
		const file = manager.getSessionFile()!;
		const written = lines(file).filter(Boolean);
		expect(written).toHaveLength(3);
		expect(JSON.parse(written[2]!)).toMatchObject({ id, message: { content: "hello" } });
	});

	it("a short write on append sets a sticky persistenceError; later appends throw the documented text", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage(user("first"));
		const leaf = manager.getLeafId();
		faults.shortAppend = true;
		expect(() => manager.appendMessage(user("second"))).toThrow(EXPECTED_TEXT);
		expect(manager.getLeafId()).toBe(leaf);
		expect(manager.getEntries()).toHaveLength(1);
		const error = manager.getPersistenceError();
		expect(error).toBeInstanceOf(SessionPersistenceError);
		expect(error?.message).toBe(EXPECTED_TEXT);

		const sizeAfterFailure = realFs.statSync(manager.getSessionFile()!).size;
		expect(() => manager.appendCustomEntry("state")).toThrow(EXPECTED_TEXT);
		expect(() => manager.appendMessage(user("third"))).toThrow(EXPECTED_TEXT);
		expect(realFs.statSync(manager.getSessionFile()!).size).toBe(sizeAfterFailure);
	});

	it("rolls back branchWithSummary to the previous leaf when its append fails", () => {
		const manager = SessionManager.create(dir, dir);
		const first = manager.appendMessage(user("first"));
		const second = manager.appendMessage(user("second"));
		faults.shortAppend = true;
		expect(() => manager.branchWithSummary(first, "summary")).toThrow(EXPECTED_TEXT);
		expect(manager.getLeafId()).toBe(second);
	});

	it("reopening skips the torn line and the next append starts on a new line", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage(user("first"));
		faults.shortAppend = true;
		expect(() => manager.appendMessage(user("second"))).toThrow(EXPECTED_TEXT);
		const file = manager.getSessionFile()!;
		expect(realFs.readFileSync(file, "utf8").endsWith("\n")).toBe(false);

		const reopened = SessionManager.open(file);
		expect(reopened.getPersistenceError()).toBeUndefined();
		expect(reopened.getEntries().map((entry) => entry.type)).toEqual(["message"]);
		const id = reopened.appendMessage(user("third"));
		const parsed = lines(file)
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as { id?: string }];
				} catch {
					return [];
				}
			});
		expect(parsed.at(-1)?.id).toBe(id);
		expect(SessionManager.open(file).getEntries()).toHaveLength(2);
	});

	it("newSession and setSessionFile clear the flag", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage(user("first"));
		const file = manager.getSessionFile()!;
		faults.shortAppend = true;
		expect(() => manager.appendMessage(user("second"))).toThrow(EXPECTED_TEXT);
		manager.newSession();
		expect(manager.getPersistenceError()).toBeUndefined();
		manager.appendMessage(user("fresh"));

		faults.shortAppend = true;
		expect(() => manager.appendMessage(user("again"))).toThrow(EXPECTED_TEXT);
		manager.setSessionFile(file);
		expect(manager.getPersistenceError()).toBeUndefined();
		manager.appendMessage(user("resumed"));
	});
});
