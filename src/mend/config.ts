/**
 * Mend 実装モジュール専用の設定。
 *
 * CLI 全体の設定（`src/config.ts`）はここを一切知らない。Mend 側の環境変数が増減しても
 * 呼び出し側に波及させないため、Mend の env は必ずこのファイルだけで読む。
 */

export interface MendConfig {
	/** developer.mend.io のベース URL。EU リージョンなどのために上書き可能にしてある。 */
	readonly baseUrl: string;
}

const DEFAULT_BASE_URL = "https://developer.mend.io";

export function loadMendConfig(
	env: Record<string, string | undefined> = process.env,
): MendConfig {
	return {
		baseUrl: (env.MEND_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
			/\/+$/,
			"",
		),
	};
}
