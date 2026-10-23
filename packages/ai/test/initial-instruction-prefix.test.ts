import { describe, expect, test } from "vitest";
import type { Message } from "../src/types.ts";
import { getInitialInstructionPrefix, getInitialSystemMessage } from "../src/utils/transcript.ts";

const system: Message = { role: "system", content: "base", timestamp: 1 };
const mask: Message = { role: "developer", content: "mask", timestamp: 2 };
const notice: Message = { role: "developer", content: "notice", timestamp: 3 };
const user: Message = { role: "user", content: "hi", timestamp: 4 };
const later: Message = { role: "developer", content: "later", timestamp: 5 };

describe("initial instruction prefix", () => {
	test("only an index-0 system message is the initial snapshot", () => {
		expect(getInitialSystemMessage([system, user])).toBe(system);
		expect(getInitialSystemMessage([mask, system, user])).toBeUndefined();
		expect(getInitialSystemMessage([user, system])).toBeUndefined();
		expect(getInitialSystemMessage([])).toBeUndefined();
	});

	test("the prefix holds the developers directly after the snapshot, up to the first non-developer", () => {
		expect(getInitialInstructionPrefix([system, mask, notice, user, later])).toEqual({
			system,
			developers: [mask, notice],
		});
		expect(getInitialInstructionPrefix([system, user, later])).toEqual({ system, developers: [] });
		expect(getInitialInstructionPrefix([system, mask, { ...system, timestamp: 9 }, later])).toEqual({
			system,
			developers: [mask],
		});
	});

	test("without an initial snapshot the prefix is empty", () => {
		expect(getInitialInstructionPrefix([mask, system, user])).toEqual({ system: undefined, developers: [] });
	});
});
