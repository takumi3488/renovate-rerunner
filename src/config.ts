/**
 * CLI 全体で共有する設定。
 *
 * GitHub 側の認証情報と対象 org のみを扱う。Mend 側（MEND_*）の環境変数は Mend 実装モジュールが
 * 自分で読む設計になっているため、ここで扱うと責務が漏れる。
 */
export interface Config {
	readonly githubToken: string;
	readonly orgs: readonly string[];
}

export class ConfigError extends Error {
	override readonly name = "ConfigError";
}

/**
 * カンマ区切り文字列を正規化する。各要素を trim し、空要素と重複を除去する。
 *
 * GITHUB_ORGS（環境変数）と --org（CLI フラグ）の両方で同じルールが必要なため、
 * cli.ts からも import して使い回す。
 */
export function parseOrgList(value: string): string[] {
	const seen = new Set<string>();
	const orgs: string[] = [];
	for (const rawOrg of value.split(",")) {
		const org = rawOrg.trim();
		if (org === "") continue;
		// 同じ org を 2 回 scan しても意味がないため重複は無視する
		if (seen.has(org)) continue;
		seen.add(org);
		orgs.push(org);
	}
	return orgs;
}

/**
 * 環境変数から設定を読み込み検証する。
 *
 * @param env テスト容易性のため差し替え可能にしている。省略時は `process.env`。
 */
export function loadConfig(
	env: Record<string, string | undefined> = process.env,
): Config {
	const githubToken = env.GITHUB_TOKEN?.trim();
	if (!githubToken) {
		throw new ConfigError(
			"環境変数 GITHUB_TOKEN が設定されていません。GitHub の Personal Access Token を設定してください（例: GITHUB_TOKEN=ghp_xxxx）。",
		);
	}

	const rawOrgs = env.GITHUB_ORGS;
	if (!rawOrgs || rawOrgs.trim() === "") {
		throw new ConfigError(
			"環境変数 GITHUB_ORGS が設定されていません。対象の org をカンマ区切りで指定してください（例: GITHUB_ORGS=org-a,org-b）。",
		);
	}

	const orgs = parseOrgList(rawOrgs);
	if (orgs.length === 0) {
		throw new ConfigError(
			"環境変数 GITHUB_ORGS に有効な org が1件も含まれていません。カンマ区切りで少なくとも1つの org を指定してください（例: GITHUB_ORGS=org-a,org-b）。",
		);
	}

	return { githubToken, orgs };
}
