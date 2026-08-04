/**
 * テスト専用のインメモリ MendClient。
 * Playwright を起動せずに orchestrator の制御フローを検証するために使う。
 */

import type { MendClient, MendRepo, MendTriggerResult } from "../mend/types";
import { MendAuthError, MendUiError } from "../mend/types";

export interface FakeMendClientOptions {
	/** org 名 → その org の Mend 側リポジトリ一覧。 */
	readonly reposByOrg: Readonly<Record<string, readonly MendRepo[]>>;
	/** `"org/repo"` → 失敗理由。指定したものだけ triggerScan が失敗する。 */
	readonly triggerFailures?: Readonly<Record<string, string>>;
	/** この org の listRepos で MendAuthError を投げる。 */
	readonly authErrorOnListOrg?: string;
	/** この org の listRepos で MendUiError を投げる。 */
	readonly uiErrorOnListOrg?: string;
	/** この `"org/repo"` の triggerScan で MendAuthError を投げる。 */
	readonly authErrorOnTrigger?: string;
	/** この org の listRepos で通常のエラーを投げる。 */
	readonly listErrorOnOrg?: string;
	/** これらの `"org/repo"` の triggerScan は 409（既にキュー済み）を返す。 */
	readonly alreadyQueuedOnTrigger?: readonly string[];
}

export interface FakeMendClient extends MendClient {
	/** triggerScan が呼ばれた `"org/repo"` の記録。呼ばれた順に入る。 */
	readonly triggeredScans: readonly string[];
	/** listRepos が呼ばれた org の記録。 */
	readonly listedOrgs: readonly string[];
	/** Symbol.asyncDispose が呼ばれたか。ブラウザの閉じ忘れ検証に使う。 */
	readonly disposed: () => boolean;
}

export function createFakeMendClient(
	options: FakeMendClientOptions,
): FakeMendClient {
	const triggeredScans: string[] = [];
	const listedOrgs: string[] = [];
	let isDisposed = false;

	return {
		triggeredScans,
		listedOrgs,
		disposed: () => isDisposed,

		async listRepos(org: string): Promise<readonly MendRepo[]> {
			listedOrgs.push(org);
			if (options.authErrorOnListOrg === org) {
				throw new MendAuthError(`fake: セッションが失効しました (${org})`);
			}
			if (options.uiErrorOnListOrg === org) {
				throw new MendUiError(
					`fake: レスポンス構造が想定と異なります (${org})`,
				);
			}
			if (options.listErrorOnOrg === org) {
				throw new Error(`fake: 一覧取得に失敗しました (${org})`);
			}
			return options.reposByOrg[org] ?? [];
		},

		async triggerScan(
			org: string,
			mendRepoName: string,
		): Promise<MendTriggerResult> {
			const key = `${org}/${mendRepoName}`;
			if (options.authErrorOnTrigger === key) {
				throw new MendAuthError(`fake: セッションが失効しました (${key})`);
			}
			triggeredScans.push(key);
			if (options.alreadyQueuedOnTrigger?.includes(key)) {
				return { ok: true, alreadyQueued: true };
			}
			const reason = options.triggerFailures?.[key];
			return reason === undefined ? { ok: true } : { ok: false, reason };
		},

		async [Symbol.asyncDispose](): Promise<void> {
			isDisposed = true;
		},
	};
}

/** テストデータを短く書くためのヘルパー。 */
export function mendRepo(
	name: string,
	status: "enabled" | "disabled" | string,
): MendRepo {
	if (status === "enabled" || status === "disabled") {
		return { name, renovateStatus: { kind: status } };
	}
	return { name, renovateStatus: { kind: "unknown", raw: status } };
}
