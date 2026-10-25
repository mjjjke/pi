import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

function client() {
	const value = new RpcClient();
	const write = vi.fn();
	Reflect.set(value, "process", { exitCode: null, stdin: { destroyed: false, writable: true, write } });
	const respond = (data: object) =>
		Reflect.get(value, "handleLine").call(
			value,
			JSON.stringify({ type: "response", id: "req_1", command: "compact", success: true, data }),
		);
	return { value, write, respond };
}
afterEach(() => vi.useRealTimers());
describe("RPC background compaction client deadlines", () => {
	it("keeps an explicit now wait pending past the normal command deadline", async () => {
		vi.useFakeTimers();
		const { value, write, respond } = client();
		let settled = false;
		const result = value.compactNow().then(
			(result) => {
				settled = true;
				return result;
			},
			(error: unknown) => {
				settled = true;
				return error;
			},
		);
		expect(JSON.parse(write.mock.calls[0]![0] as string)).toMatchObject({ type: "compact", mode: "now" });
		await vi.advanceTimersByTimeAsync(90000);
		expect(settled).toBe(false);
		respond({ status: "released" });
		expect(await result).toEqual({ status: "released" });
	});
	it("retains the ordinary deadline for the nonblocking background launch", async () => {
		vi.useFakeTimers();
		const { value } = client();
		const result = value.compact().catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(30000);
		expect(await result).toMatchObject({ message: "Timeout waiting for response to compact. Stderr: " });
	});
});
