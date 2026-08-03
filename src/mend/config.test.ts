import { describe, expect, test } from "bun:test";
import { loadMendConfig } from "./config";

describe("loadMendConfig", () => {
	test("環境変数が空でも既定値で動く", () => {
		const config = loadMendConfig({});
		expect(config.baseUrl).toBe("https://developer.mend.io");
		expect(config.headless).toBe(true);
		expect(config.navigationTimeoutMs).toBeGreaterThan(0);
		expect(config.actionTimeoutMs).toBeGreaterThan(0);
	});

	test("baseUrl の末尾スラッシュを取り除く", () => {
		// パス結合時に // が生まれるのを防ぐため正規化している。
		expect(
			loadMendConfig({ MEND_BASE_URL: "https://developer-eu.mend.io///" })
				.baseUrl,
		).toBe("https://developer-eu.mend.io");
	});

	test.each([
		["false", false],
		["0", false],
		["no", false],
		["true", true],
		["1", true],
		["", true],
		["なにか変な値", true],
	])("MEND_HEADLESS=%s を %s と解釈する", (value, expected) => {
		expect(loadMendConfig({ MEND_HEADLESS: value }).headless).toBe(expected);
	});

	test("不正なタイムアウト値は既定値にフォールバックする", () => {
		const fallback = loadMendConfig({}).navigationTimeoutMs;
		expect(
			loadMendConfig({ MEND_NAVIGATION_TIMEOUT_MS: "abc" }).navigationTimeoutMs,
		).toBe(fallback);
		expect(
			loadMendConfig({ MEND_NAVIGATION_TIMEOUT_MS: "0" }).navigationTimeoutMs,
		).toBe(fallback);
		expect(
			loadMendConfig({ MEND_NAVIGATION_TIMEOUT_MS: "-5" }).navigationTimeoutMs,
		).toBe(fallback);
	});

	test("正しいタイムアウト値は反映される", () => {
		expect(
			loadMendConfig({ MEND_ACTION_TIMEOUT_MS: "5000" }).actionTimeoutMs,
		).toBe(5000);
	});

	test("リポジトリ一覧パスの既定値に {org} プレースホルダを含む", () => {
		expect(loadMendConfig({}).repoListPathTemplate).toContain("{org}");
	});

	test("リポジトリ一覧パスを上書きできる", () => {
		// Mend の URL 構成は公開されていないため、観測結果に合わせて差し替えられる必要がある。
		expect(
			loadMendConfig({ MEND_REPO_LIST_PATH: "/x/{org}" }).repoListPathTemplate,
		).toBe("/x/{org}");
	});
});
