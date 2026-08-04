import { describe, expect, test } from "bun:test";
import { ConfigError } from "./config";
import { decideExitCode, describeFatalError, EXIT_CODES } from "./errors";
import { MendApiError, MendAuthError, MendUiError } from "./mend/types";
import type { MendTriggerResult } from "./mend/types";

describe("decideExitCode", () => {
	test("空配列なら success", () => {
		expect(decideExitCode([], false)).toBe(EXIT_CODES.success);
	});

	test("全件成功なら success", () => {
		const results: MendTriggerResult[] = [{ ok: true }, { ok: true }];
		expect(decideExitCode(results, false)).toBe(EXIT_CODES.success);
	});

	test("alreadyQueued は成功として扱う", () => {
		const results: MendTriggerResult[] = [
			{ ok: true },
			{ ok: true, alreadyQueued: true },
		];
		expect(decideExitCode(results, false)).toBe(EXIT_CODES.success);
	});

	test("alreadyQueued と失敗の混合なら partialFailure（alreadyQueued は分母にも残る）", () => {
		const results: MendTriggerResult[] = [
			{ ok: true, alreadyQueued: true },
			{ ok: false, reason: "y" },
		];
		expect(decideExitCode(results, false)).toBe(EXIT_CODES.partialFailure);
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
		// UI ではなく内部 API を見に行く案内であること。文言が後退しないよう区別できる部分を assert する
		expect(result.hint).toContain("内部 API");
		expect(result.hint).toContain("bun run observe");
	});

	test("MendApiError は個別失敗として処理される想定なので、fatal でもヒントは出さない", () => {
		// triggerScan / listRepos の呼び出し側で ok:false や orgError に変換されるため、
		// ここに到達するのは想定外の経路だけ。汎用の fatal として扱う。
		const result = describeFatalError(
			new MendApiError("Mend API が 500 を返しました", 500, "boom"),
		);
		expect(result.code).toBe(EXIT_CODES.fatal);
		expect(result.hint).toBeUndefined();
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
