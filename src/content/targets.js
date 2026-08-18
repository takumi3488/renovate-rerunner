/**
 * Mend 側の disabled リポジトリと GitHub 側の生存リポジトリ名を突合し、
 * scan をトリガーすべき対象を求める。純粋関数。
 *
 * GitHub 側の archived / disabled / fork 除外はバックグラウンドで済ませて
 * 「生存 repo 名の配列」を受け取る形にしてある。
 *
 * @param {{platform:string, org:string, mendRepos:readonly {name:string}[], aliveRepoNames:readonly string[]}} input
 * @returns {{targets:{platform:string, org:string, repo:string}[]}}
 */
export function findScanTargets({ platform, org, mendRepos, aliveRepoNames }) {
	// 同一 org 内では大小文字を無視して一意なので小文字キーで突合する。
	const aliveKeys = new Set(aliveRepoNames.map((name) => name.toLowerCase()));

	const targets = [];
	// Mend 側に大小文字違いの重複が来ても同じリポジトリに 2 回 scan を撃たないための集合。
	const matchedKeys = new Set();

	// 出力順は mendRepos の入力順を保つ。
	for (const mendRepo of mendRepos) {
		const key = mendRepo.name.toLowerCase();

		if (!aliveKeys.has(key)) {
			// GitHub 側に無い = archived / fork / 削除済みなど正常なケース。
			continue;
		}

		if (matchedKeys.has(key)) continue;
		matchedKeys.add(key);

		// POST パスに使うため Mend 側の表記を保持する。
		targets.push({ platform, org, repo: mendRepo.name });
	}

	return { targets };
}
