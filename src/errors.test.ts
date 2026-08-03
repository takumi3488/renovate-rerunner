import { describe, expect, test } from "bun:test";
import { ConfigError } from "./config";
import { decideExitCode, describeFatalError, EXIT_CODES } from "./errors";
import { MendAuthError, MendUiError } from "./mend/types";
import type { MendTriggerResult } from "./mend/types";

describe("decideExitCode", () => {
	test("空配列なら success", () => {
		expect(decideExitCode([], false)).toBe(EXIT_CODES.success);
	});

	test("全件成功なら success", () => {
		const results: MendTriggerResult[] = [{ ok: true }, { ok: true }];
		expect(decideExitCode(results, false)).toBe(EXIT_CODES.success);
	});

	test("全件失敗なら allFailed", () => {
		const results: MendTriggerResult[] = [
			{ ok: false, reason: "x" },
			{ ok: false, reason: "y" },
		];
		expect(decideExitCode(results, false)).toBe(EXIT_CODES.allFailed);
	});

	test("一部失敗なら partialFailure", () => {
		const results: MendTriggerResult[] = [
			{ ok: true },
			{ ok: false, reason: "y" },
		];
		expect(decideExitCode(results, false)).toBe(EXIT_CODES.partialFailure);
	});

	test("dryRun なら結果に関わらず常に success", () => {
		const results: MendTriggerResult[] = [
			{ ok: false, reason: "x" },
			{ ok: false, reason: "y" },
		];
		expect(decideExitCode(results, true)).toBe(EXIT_CODES.success);
	});
});

describe("describeFatalError", () => {
	test("ConfigError は fatal + ヘルプ表示のヒント", () => {
		const result = describeFatalError(
			new ConfigError("GITHUB_TOKEN がありません"),
		);
		expect(result.code).toBe(EXIT_CODES.fatal);
		expect(result.message).toBe("GITHUB_TOKEN がありません");
		expect(result.hint).toContain("--help");
	});

	test("MendAuthError は fatal + Cookie の在処を疑うヒント", () => {
		const result = describeFatalError(new MendAuthError("session expired"));
		expect(result.code).toBe(EXIT_CODES.fatal);
		expect(result.message).toBe("session expired");
		expect(result.hint).toContain("COOKIEJAR_HOSTS");
	});

	test("CookiejarError は fatal + 到達性を疑うヒント", () => {
		// cookiejar に届かないのは設定ミスか障害。到達先を確認させるのが最短の復旧経路。
		const cookiejarError = new Error("unreachable");
		Object.defineProperty(cookiejarError, "name", { value: "CookiejarError" });
		const result = describeFatalError(cookiejarError);
		expect(result.code).toBe(EXIT_CODES.fatal);
		expect(result.hint).toContain("COOKIEJAR_READER_ENDPOINT");
	});

	test("MendUiError は fatal + observe 再実行のヒント", () => {
		const result = describeFatalError(new MendUiError("selector not found"));
		expect(result.code).toBe(EXIT_CODES.fatal);
		expect(result.message).toBe("selector not found");
		expect(result.hint).toContain("bun run observe");
	});

	test("不明な Error はヒントなしで message のみ", () => {
		const result = describeFatalError(new Error("boom"));
		expect(result.code).toBe(EXIT_CODES.fatal);
		expect(result.message).toBe("boom");
		expect(result.hint).toBeUndefined();
	});

	test("文字列を渡しても落ちない", () => {
		const result = describeFatalError("plain string error");
		expect(result.code).toBe(EXIT_CODES.fatal);
		expect(result.message).toBe("plain string error");
		expect(result.hint).toBeUndefined();
	});

	test("プレーンオブジェクトを渡しても落ちない", () => {
		const result = describeFatalError({ some: "object" });
		expect(result.code).toBe(EXIT_CODES.fatal);
		expect(result.message).toBe("[object Object]");
		expect(result.hint).toBeUndefined();
	});

	test("null / undefined を渡しても落ちない", () => {
		expect(describeFatalError(null).message).toBe("null");
		expect(describeFatalError(undefined).message).toBe("undefined");
	});
});
