/**
 * Mend 実装モジュール専用の設定。
 *
 * CLI 全体の設定（`src/config.ts`）はここを一切知らない。Mend 側の環境変数が増減しても
 * 呼び出し側に波及させないため、Mend の env は必ずこのファイルだけで読む。
 */

import { ConfigError } from "../config";

export interface MendConfig {
	/** developer.mend.io のベース URL。EU リージョンなどのために上書き可能にしてある。 */
	readonly baseUrl: string;
	/**
	 * job/add を連続で叩きすぎないよう、scan トリガー間に挟む待機時間（ミリ秒）。
	 * Mend 側のレート制限・過負荷を避けるためのもの。0 で待機なし。
	 */
	readonly triggerIntervalMs: number;
}

const DEFAULT_BASE_URL = "https://developer.mend.io";
const DEFAULT_TRIGGER_INTERVAL_MS = 1000;

/** setTimeout の上限（2^31-1 ms）。これを超えると待機が ~1ms に丸められて意味をなさない。 */
const MAX_INTERVAL_MS = 2_147_483_647;

/** 整数表記のみ許可する。符号・小数点・空白混じりを弾く。 */
const INTEGER_PATTERN = /^\d+$/;

/**
 * MEND_TRIGGER_INTERVAL_MS を解釈する。
 * 不正値を黙って既定値に丸めると、レート制限回避のつもりが無効化されていた
 * （あるいは逆）ことに気づけないため、プロジェクトの設定検証の流儀に合わせて
 * ConfigError で fail fast する。
 */
function parseTriggerIntervalMs(raw: string | undefined): number {
	if (!raw?.trim()) return DEFAULT_TRIGGER_INTERVAL_MS;
	const trimmed = raw.trim();
	if (!INTEGER_PATTERN.test(trimmed)) {
		throw new ConfigError(
			`MEND_TRIGGER_INTERVAL_MS には 0 以上の整数を指定してください（受け取った値: "${raw}"）。`,
		);
	}
	const n = Number(trimmed);
	if (n > MAX_INTERVAL_MS) {
		throw new ConfigError(
			`MEND_TRIGGER_INTERVAL_MS が大きすぎます（受け取った値: "${raw}"、上限: ${MAX_INTERVAL_MS}）。`,
		);
	}
	return n;
}

export function loadMendConfig(
	env: Record<string, string | undefined> = process.env,
): MendConfig {
	return {
		baseUrl: (env.MEND_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
			/\/+$/,
			"",
		),
		triggerIntervalMs: parseTriggerIntervalMs(env.MEND_TRIGGER_INTERVAL_MS),
	};
}
