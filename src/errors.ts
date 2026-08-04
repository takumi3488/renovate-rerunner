import type { MendTriggerResult } from "./mend/types";

/**
 * プロセスの終了コード。orchestrator / index はこの定数のみを参照し、
 * マジックナンバーを埋め込まないようにする。
 */
export const EXIT_CODES = {
	/** 正常（検出 0 件 / 全成功 / dry-run）。 */
	success: 0,
	/** 一部の trigger が失敗した。 */
	partialFailure: 1,
	/** 検出したが全件失敗した。 */
	allFailed: 2,
	/** 継続不能（設定不備・GitHub 認証エラー・Mend セッション確立不能）。 */
	fatal: 3,
} as const;

/**
 * scan トリガー結果一覧から終了コードを決める。
 *
 * dry-run は実際には何も変更していないため、結果の中身に関わらず常に成功扱いにする。
 */
export function decideExitCode(
	results: readonly MendTriggerResult[],
	dryRun: boolean,
): number {
	if (dryRun) return EXIT_CODES.success;
	if (results.length === 0) return EXIT_CODES.success;

	const failedCount = results.filter((result) => !result.ok).length;
	if (failedCount === 0) return EXIT_CODES.success;
	if (failedCount === results.length) return EXIT_CODES.allFailed;
	return EXIT_CODES.partialFailure;
}

/**
 * 致命的エラーを終了コードと人間向けメッセージに変換する。
 *
 * エラー種別の判別は `instanceof` ではなく `name` プロパティの文字列比較で行う。
 * モジュール間の import 循環や Bun のバンドル境界をまたぐと instanceof が
 * 期待通りに働かないケースがあるため、より頑健な name 比較を採用している。
 */
export function describeFatalError(err: unknown): {
	code: number;
	message: string;
	hint?: string;
} {
	const name = errorName(err);
	const message = errorMessage(err);

	if (name === "MendAuthError") {
		return {
			code: EXIT_CODES.fatal,
			message,
			// message 側に「ブラウザでログインし直せ」という案内が入っているので、
			// hint では設定側の疑いどころを挙げる。
			hint: "ブラウザ拡張が developer.mend.io を対象に含んでいるか、COOKIEJAR_HOSTS の値が cookiejar の保存キー（Cookie の domain 属性の実値）と一致しているかも確認してください。",
		};
	}
	if (name === "CookiejarError") {
		return {
			code: EXIT_CODES.fatal,
			message,
			hint: "COOKIEJAR_READER_ENDPOINT への到達性を確認してください（クラスタ内 DNS はクラスタ外から解決できません）。",
		};
	}
	if (name === "MendUiError") {
		return {
			code: EXIT_CODES.fatal,
			message,
			hint: "Mend の内部 API の構造が変わった可能性があります。bun run observe で再調査してください。",
		};
	}
	if (name === "ConfigError") {
		return {
			code: EXIT_CODES.fatal,
			message,
			hint: "--help で必要な環境変数を確認してください。",
		};
	}
	return { code: EXIT_CODES.fatal, message };
}

function errorName(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null || !("name" in err))
		return undefined;
	const name = (err as { name?: unknown }).name;
	return typeof name === "string" ? name : undefined;
}

/**
 * err を安全に文字列化する。スタックトレースやオブジェクト全体をそのまま埋め込むと
 * 認証情報などが紛れ込む恐れがあるため、Error なら message のみを使う。
 */
function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
