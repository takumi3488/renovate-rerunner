/**
 * GitHub 側のリポジトリ。突合に必要な最小限のフィールドのみを保持する。
 */
export interface GithubRepo {
	readonly name: string;
	readonly fullName: string;
	/** GitHub 上でアーカイブされているか。 */
	readonly archived: boolean;
	/**
	 * GitHub 側でアクセスが無効化されているか（DMCA 等）。
	 * Mend 側の Renovate disabled とは全く別の概念なので混同しないこと。
	 */
	readonly disabled: boolean;
	readonly fork: boolean;
	readonly visibility: string;
}

/**
 * 「GitHub では生きているのに Mend では Renovate が disabled」なリポジトリ。
 * scan のトリガー対象。
 */
export interface ScanTarget {
	readonly org: string;
	/** GitHub が認識している名前。ログ表示に使う。 */
	readonly githubRepoName: string;
	/** Mend が認識している名前。triggerScan にはこちらを渡す。 */
	readonly mendRepoName: string;
}
