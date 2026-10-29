import { expect, it } from "vitest";
import { parseAuthorizationServerMetadata } from "../src/oauth/types.ts";

const metadata = {
	issuer: "https://auth.test",
	token_endpoint: "https://auth.test/token",
	response_types_supported: ["code"],
};
it("authorization endpoints are HTTPS or loopback HTTP, never arbitrary desktop handlers", () => {
	for (const authorization_endpoint of [
		"smb://host/share",
		"file:///x.desktop",
		"zed://file/x",
		"http://auth.test/a",
		"https://u:p@auth.test/a",
		"https://auth.test/%00",
	])
		expect(() => parseAuthorizationServerMetadata({ ...metadata, authorization_endpoint })).toThrow(
			"Invalid authorization endpoint",
		);
	for (const authorization_endpoint of [
		"https://auth.test/a",
		"http://127.0.0.1:123/a",
		"http://localhost/a",
		"http://[::1]/a",
	])
		expect(parseAuthorizationServerMetadata({ ...metadata, authorization_endpoint }).authorization_endpoint).toBe(
			authorization_endpoint,
		);
});
