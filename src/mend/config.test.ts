import { describe, expect, test } from "bun:test";
import { ConfigError } from "../config";
import { loadMendConfig } from "./config";

describe("loadMendConfig", () => {
	test("未設定なら既定値（baseUrl と interval 1000ms）", () => {
		const config = loadMendConfig({});
		expect(config.baseUrl).toBe("https://developer.mend.io");
		expect(config.triggerIntervalMs).toBe(1000);
	});

	test("MEND_BASE_URL の末尾スラッシュは削る", () => {
		expect(
			loadMendConfig({ MEND_BASE_URL: "https://example.com/" }).baseUrl,
		).toBe("https://example.com");
	});

	test("MEND_TRIGGER_INTERVAL_MS を数値として読む", () => {
		expect(
			loadMendConfig({ MEND_TRIGGER_INTERVAL_MS: "2500" }).triggerIntervalMs,
		).toBe(2500);
	});

	test("MEND_TRIGGER_INTERVAL_MS が 0 なら待機なし", () => {
		expect(
			loadMendConfig({ MEND_TRIGGER_INTERVAL_MS: "0" }).triggerIntervalMs,
		).toBe(0);
	});

	test.each(["abc", "-1", "1.5", "5000ms", "10 000"])(
		"MEND_TRIGGER_INTERVAL_MS が不正値（%s）なら ConfigError で fail fast する",
		(raw) => {
			expect(() => loadMendConfig({ MEND_TRIGGER_INTERVAL_MS: raw })).toThrow(
				ConfigError,
			);
		},
	);

	test("MEND_TRIGGER_INTERVAL_MS が setTimeout の上限を超えるなら ConfigError", () => {
		expect(() =>
			loadMendConfig({ MEND_TRIGGER_INTERVAL_MS: "3000000000" }),
		).toThrow(ConfigError);
	});
});
