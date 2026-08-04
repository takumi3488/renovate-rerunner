/**
 * CLI の中核となる制御フロー。
 *
 * org の一覧・突合・scan トリガーをどう組み合わせるかだけを担い、GitHub API / Mend UI の
 * 個別実装には一切踏み込まない（それぞれ github.ts / mend/client.ts の責務）。
 */

import type { GithubClient } from "./github";
import type { Logger } from "./logger";
import { findScanTargets } from "./match";
import type { MendClient, MendTriggerResult } from "./mend/types";
import { MendAuthError } from "./mend/types";
import { withSpan } from "./telemetry";

export interface RunOptions {
	readonly orgs: readonly string[];
	readonly githubClient: GithubClient;
	readonly mendClient: MendClient;
	readonly logger: Logger;
	readonly dryRun: boolean;
	/** scan をトリガーする最大件数（org 横断の合計）。 */
	readonly limit?: number;
}

export interface RunSummary {
	/** 実際に triggerScan を呼んだ結果。dry-run のときは空。 */
	readonly results: readonly MendTriggerResult[];
	readonly targetCount: number;
	readonly triggeredCount: number;
	readonly failedCount: number;
	/** limit に達したため実行しなかった件数。 */
	readonly skippedByLimit: number;
	/** org 単位で処理に失敗した記録。 */
	readonly orgErrors: readonly {
		readonly org: string;
		readonly message: string;
	}[];
}

/** Error なら message、それ以外は String() で文字列化する。ログに安全に埋め込むための最小変換。 */
function toMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function run(options: RunOptions): Promise<RunSummary> {
	const { orgs, githubClient, mendClient, logger, dryRun, limit } = options;

	const results: MendTriggerResult[] = [];
	const orgErrors: { org: string; message: string }[] = [];
	let targetCount = 0;
	let triggeredCount = 0;
	let failedCount = 0;
	let skippedByLimit = 0;
	// limit 到達の warn は 1 回だけ出す。target ごとに出すと同じ警告が大量に並んでノイズになる。
	let limitWarned = false;

	// org は逐次処理する。Mend 側は単一ブラウザセッションなので並列化しても速くならず、
	// 状態切り替え（一覧ページの org 切り替えなど）が競合するだけ。
	for (const org of orgs) {
		// org 単位の span で囲み、失敗した org の切り分けをトレース上でも容易にする。
		// ループの continue に相当する早期終了は、withSpan のコールバックから return することで表現する。
		await withSpan(
			"orchestrator.process_org",
			{ attributes: { "rerunner.org": org } },
			async (span) => {
				let matchResult: ReturnType<typeof findScanTargets>;
				try {
					// GitHub と Mend の一覧取得は互いに独立しているので同時に投げてよい。
					const [githubRepos, mendRepos] = await Promise.all([
						githubClient.listOrgRepos(org),
						mendClient.listRepos(org),
					]);
					matchResult = findScanTargets(org, githubRepos, mendRepos);
				} catch (err) {
					if (err instanceof MendAuthError) {
						// セッションが壊れている = 残りの org を処理しても全滅が確定している。
						// 無駄な GitHub API 呼び出しを避けるため、ここまでのログを残したまま再 throw する。
						throw err;
					}
					// GithubApiError や Mend 一覧取得の失敗など。org 名のタイポ 1 つで
					// 他の org の処理まで止めないよう、この org だけスキップして継続する。
					const message = toMessage(err);
					logger.error("org の処理に失敗したためスキップします", {
						org,
						error: message,
					});
					orgErrors.push({ org, message });
					span.setAttribute("rerunner.org_error", message);
					return;
				}

				span.setAttribute(
					"rerunner.unknown_status_count",
					matchResult.unknownStatuses.length,
				);
				span.setAttribute("rerunner.target_count", matchResult.targets.length);

				if (matchResult.unknownStatuses.length > 0) {
					// Mend が新しいステータス文字列を返し始めた兆候。運用者が気づけるよう warn にする。
					logger.warn("Mend が未知の Renovate ステータスを返しました", {
						org,
						unknownStatuses: matchResult.unknownStatuses,
					});
				}
				if (matchResult.skippedNotInGithub.length > 0) {
					// archived/fork/削除済みなど正常なケースなので info に留める。
					logger.info(
						"GitHub 側に見つからないため対象外にしたリポジトリがあります",
						{
							org,
							count: matchResult.skippedNotInGithub.length,
						},
					);
				}

				targetCount += matchResult.targets.length;

				if (dryRun) {
					// dry-run では triggerScan を絶対に呼ばない。検出結果を出すだけ。
					for (const target of matchResult.targets) {
						logger.info("dry-run: scan 対象を検出しました", {
							org: target.org,
							githubRepoName: target.githubRepoName,
							mendRepoName: target.mendRepoName,
						});
					}
					return;
				}

				for (const target of matchResult.targets) {
					if (limit !== undefined && results.length >= limit) {
						// 黙って打ち切ると「全部処理した」と誤読されるため、到達した瞬間に明示する。
						if (!limitWarned) {
							logger.warn("limit に達したため残りの scan はスキップします", {
								limit,
							});
							limitWarned = true;
						}
						skippedByLimit++;
						continue;
					}

					// triggerScan は自動リトライしない（同一 scan の二重トリガーを避けるため）。
					// MendAuthError はここで捕まえず、そのまま呼び出し元へ伝播させる
					// （＝この時点までの成功/失敗ログは既に出力済みの状態で中断する）。
					const result = await mendClient.triggerScan(org, target.mendRepoName);
					results.push(result);
					if (result.ok) {
						triggeredCount++;
						logger.info("scan をトリガーしました", {
							org,
							mendRepoName: target.mendRepoName,
						});
					} else {
						failedCount++;
						logger.error("scan のトリガーに失敗しました", {
							org,
							mendRepoName: target.mendRepoName,
							reason: result.reason,
						});
					}
				}
			},
		);
	}

	// ログを流し読みしても結果が分かるよう、最後に 1 行でまとめる。
	logger.info("実行結果のサマリ", {
		orgCount: orgs.length,
		targetCount,
		executedCount: results.length,
		triggeredCount,
		failedCount,
		skippedByLimit,
	});

	return {
		results,
		targetCount,
		triggeredCount,
		failedCount,
		skippedByLimit,
		orgErrors,
	};
}
