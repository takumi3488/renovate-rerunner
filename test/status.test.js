import { describe, expect, test } from "bun:test";
import { parseRenovateStatus } from "../src/mend/status.js";

describe("parseRenovateStatus", () => {
	test("Disabled は disabled", () => {
		expect(parseRenovateStatus("Disabled")).toEqual({ kind: "disabled" });
	});

	test("前後空白付き not activated は disabled", () => {
		expect(parseRenovateStatus(" not activated ")).toEqual({
			kind: "disabled",
		});
	});

	test("onboarding は enabled", () => {
		expect(parseRenovateStatus("onboarding")).toEqual({ kind: "enabled" });
	});

	test("paused は unknown で raw を保持", () => {
		expect(parseRenovateStatus("paused")).toEqual({
			kind: "unknown",
			raw: "paused",
		});
	});
});
