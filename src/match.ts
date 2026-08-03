import type { MendRepo } from "./mend/types";
import type { GithubRepo, ScanTarget } from "./types";

export interface MatchOptions {
	/** fork を対象から除外するか。既定 true。 */
	readonly excludeForks?: boolean;
}

export interface MatchResult {
	/** scan をトリガーすべきリポジトリ。 */
	readonly targets: readonly ScanTarget[];
	/** Renovate ステータスを判別できなかったリポジトリ。呼び出し側が warn ログを出すために返す。 */
	readonly unknownStatuses: readonly {
		readonly name: string;
		readonly raw: string;
	}[];
	/** Mend 側に存在するが GitHub 側の対象集合に無かった disabled リポジトリ名（archived/fork/削除済みなど）。 */
	readonly skippedNotInGithub: readonly string[];
}

/**
 * GitHub 側と Mend 側のリポジトリ一覧を突合し、Renovate scan をトリガーすべき対象を求める。
 *
 * 純粋関数。I/O・ログ出力・例外は一切行わず、どんな入力でも必ず結果オブジェクトを返す。
 */
export function findScanTargets(
	org: string,
	githubRepos: readonly GithubRepo[],
	mendRepos: readonly MendRepo[],
	options?: MatchOptions,
): MatchResult {
	const excludeForks = options?.excludeForks ?? true;

	// GitHub 側の対象集合を先に作る。archived と GitHub 側 disabled は
	// 操作しようがないリポジトリなので無条件除外（オプション化しない）。
	// キーは repo 名を小文字化したもの。同一 org 内では大小文字を無視して一意なので
	// これで安全に突合できるが、表示・triggerScan には各システムの元表記を使うため
	// 値としては GithubRepo をそのまま保持しておく。
	const githubTargetsByKey = new Map<string, GithubRepo>();
	for (const repo of githubRepos) {
		if (repo.archived || repo.disabled) {
			continue;
		}
		if (excludeForks && repo.fork) {
			continue;
		}
		githubTargetsByKey.set(repo.name.toLowerCase(), repo);
	}

	const targets: ScanTarget[] = [];
	const unknownStatuses: { name: string; raw: string }[] = [];
	const skippedNotInGithub: string[] = [];
	// Mend 側に大小文字違いの重複が来ても同じ GitHub リポジトリに 2 回 scan を撃たないための集合。
	const matchedKeys = new Set<string>();

	// 出力順は mendRepos の入力順を保つ（決定的な結果にするため、ここでの反復順がそのまま反映される）。
	for (const mendRepo of mendRepos) {
		const status = mendRepo.renovateStatus;

		if (status.kind === "enabled") {
			// 対象外。何もせずスキップする（unknownStatuses にも入れない）。
			continue;
		}

		if (status.kind === "unknown") {
			// Mend が未知のステータス文字列を返してきた場合、安全側に倒して対象外にする。
			// 誤って scan を撃たないようにしつつ、呼び出し側が warn できるよう raw を記録する。
			unknownStatuses.push({ name: mendRepo.name, raw: status.raw });
			continue;
		}

		// ここに到達するのは kind === "disabled" のみ。
		const key = mendRepo.name.toLowerCase();
		const githubRepo = githubTargetsByKey.get(key);

		if (!githubRepo) {
			// GitHub 側の対象集合に見つからない = archived / fork / 削除済みなど正常なケース。
			// エラーではないのでここに記録するだけで例外は投げない。
			skippedNotInGithub.push(mendRepo.name);
			continue;
		}

		if (matchedKeys.has(key)) {
			// 大小文字違いの重複を除いた 2 件目以降。同一 repo への重複 scan を防ぐため無視する。
			continue;
		}
		matchedKeys.add(key);

		targets.push({
			org,
			githubRepoName: githubRepo.name,
			mendRepoName: mendRepo.name,
		});
	}

	return { targets, unknownStatuses, skippedNotInGithub };
}
