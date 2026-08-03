/**
 * Mend 実装モジュール専用の設定。
 *
 * CLI 全体の設定（`src/config.ts`）はここを一切知らない。Mend 側の環境変数が増減しても
 * 呼び出し側に波及させないため、Mend の env は必ずこのファイルだけで読む。
 */

export interface MendConfig {
	/** developer.mend.io のベース URL。EU リージョンなどのために上書き可能にしてある。 */
	readonly baseUrl: string;
	readonly headless: boolean;
	/**
	 * org ごとのリポジトリ一覧ページのパス。`{org}` が org 名に置換される。
	 *
	 * Mend は UI の URL 構成を公開していないため既定値は暫定。`bun run observe` で
	 * 実物を確認し、違っていれば MEND_REPO_LIST_PATH で上書きすること。
	 */
	readonly repoListPathTemplate: string;
	readonly navigationTimeoutMs: number;
	readonly actionTimeoutMs: number;
}

const DEFAULT_BASE_URL = "https://developer.mend.io";
const DEFAULT_REPO_LIST_PATH = "/orgs/github/{org}/repos";
const DEFAULT_NAVIGATION_TIMEOUT_MS = 60_000;
const DEFAULT_ACTION_TIMEOUT_MS = 30_000;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value.trim() === "") return fallback;
	const normalized = value.trim().toLowerCase();
	if (normalized === "1" || normalized === "true" || normalized === "yes")
		return true;
	if (normalized === "0" || normalized === "false" || normalized === "no")
		return false;
	return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
	return parsed;
}

export function loadMendConfig(
	env: Record<string, string | undefined> = process.env,
): MendConfig {
	return {
		baseUrl: (env.MEND_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
			/\/+$/,
			"",
		),
		headless: parseBoolean(env.MEND_HEADLESS, true),
		repoListPathTemplate:
			env.MEND_REPO_LIST_PATH?.trim() || DEFAULT_REPO_LIST_PATH,
		navigationTimeoutMs: parsePositiveInt(
			env.MEND_NAVIGATION_TIMEOUT_MS,
			DEFAULT_NAVIGATION_TIMEOUT_MS,
		),
		actionTimeoutMs: parsePositiveInt(
			env.MEND_ACTION_TIMEOUT_MS,
			DEFAULT_ACTION_TIMEOUT_MS,
		),
	};
}
