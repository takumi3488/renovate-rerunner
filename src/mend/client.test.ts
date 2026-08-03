import { describe, expect, test } from "bun:test";
import { parseRenovateStatus } from "./client";

describe("parseRenovateStatus", () => {
	test.each([
		"disabled",
		"Disabled",
		"  DISABLED  ",
		"inactive",
		"Not Activated",
	])("%s を disabled と判定する", (raw) => {
		expect(parseRenovateStatus(raw)).toEqual({ kind: "disabled" });
	});

	test.each(["enabled", "Activated", "onboarded", "Onboarding", "active"])(
		"%s を enabled と判定する",
		(raw) => {
			expect(parseRenovateStatus(raw)).toEqual({ kind: "enabled" });
		},
	);

	test("onboarding は enabled 扱いにする", () => {
		// オンボーディング中は Renovate が既に動いているので scan を撃つ対象ではない。
		expect(parseRenovateStatus("Onboarding").kind).toBe("enabled");
	});

	test("知らない文字列は unknown として raw を残す", () => {
		expect(parseRenovateStatus("  Resource Limit  ")).toEqual({
			kind: "unknown",
			raw: "Resource Limit",
		});
	});

	test("空文字も unknown として扱う", () => {
		expect(parseRenovateStatus("   ")).toEqual({ kind: "unknown", raw: "" });
	});
});
