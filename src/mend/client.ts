/**
 * developer.mend.io の MendClient 実装。
 *
 * Mend はリポジトリ一覧の取得も scan のトリガーも公開 API を提供していない
 * （公開 API は GitHub Secrets 管理専用）ため、認証済みブラウザから UI を操作する。
 *
 * ■ UI 依存を局所化する方針
 * 列の位置やボタンのラベルはヘッダー行とアクセシビリティロールから動的に特定し、
 * ハッシュ化されうる CSS クラス名には一切依存しない。それでも Mend の UI 変更で
 * 壊れることはあるので、壊れたときは黙って続行せず MendUiError で fail fast し、
 * `bun run observe` での再調査を促す。
 */

import type { Locator, Page } from "playwright";
import type { CookiejarClient } from "../cookiejar/client";
import type { Logger } from "../logger";
import type { MendSession } from "./auth";
import { openMendSession } from "./auth";
import type { MendConfig } from "./config";
import { loadMendConfig } from "./config";
import type {
	MendClient,
	MendRenovateStatus,
	MendRepo,
	MendTriggerResult,
} from "./types";
import { MendUiError } from "./types";

/**
 * Renovate が「動いている」ことを示すステータス文字列。
 *
 * Mend のステータス値は公開されていないが、コミュニティで確認されているのは
 * onboarding / onboarded / activated / disabled の 4 つ。
 * onboarding 中のリポジトリは Renovate が既に動いているので scan の対象にしない。
 */
const ENABLED_LABELS = new Set([
	"enabled",
	"activated",
	"onboarded",
	"onboarding",
	"active",
]);
const DISABLED_LABELS = new Set(["disabled", "inactive", "not activated"]);

/** UI に表示されている文字列を Renovate の状態に変換する。 */
export function parseRenovateStatus(raw: string): MendRenovateStatus {
	const normalized = raw.trim().toLowerCase();
	if (DISABLED_LABELS.has(normalized)) return { kind: "disabled" };
	if (ENABLED_LABELS.has(normalized)) return { kind: "enabled" };
	// 判別できない値は握りつぶさず raw を残す。突合側が安全側に倒して対象外にする。
	return { kind: "unknown", raw: raw.trim() };
}

/**
 * ヘッダー行の中から Renovate 列の位置を探す。
 *
 * Mend のリポジトリ一覧には SCA / SAST / Renovate それぞれの有効無効列があるので、
 * 列位置を決め打ちすると別プロダクトの状態を読んでしまう。必ずヘッダー名で特定する。
 */
export function findRenovateColumnIndex(headers: readonly string[]): number {
	return headers.findIndex((header) => /renovate/i.test(header));
}

/** org ごとのリポジトリ一覧ページ URL。観測結果に合わせて調整する箇所。 */
function repoListUrl(config: MendConfig, org: string): string {
	const template = config.repoListPathTemplate;
	return `${config.baseUrl}${template.replace("{org}", encodeURIComponent(org))}`;
}

async function readTableHeaders(page: Page): Promise<string[]> {
	const headerCells = page.getByRole("columnheader");
	const count = await headerCells.count();
	if (count === 0) return [];
	return (await headerCells.allTextContents()).map((text) => text.trim());
}

/** データ行（ヘッダー行を除く）を取得する。 */
async function readDataRows(page: Page): Promise<Locator[]> {
	const rows = await page.getByRole("row").all();
	const dataRows: Locator[] = [];
	for (const row of rows) {
		// columnheader しか持たない行はヘッダーなので除外する。
		if ((await row.getByRole("cell").count()) === 0) continue;
		dataRows.push(row);
	}
	return dataRows;
}

export interface CreateMendClientOptions {
	readonly logger: Logger;
	readonly cookiejar: CookiejarClient;
	readonly config?: MendConfig;
}

/** MendClient に、セッションの Cookie を書き戻す機能を足したもの。index.ts が正常終了時に呼ぶ。 */
export interface MendClientWithSession extends MendClient {
	persistCookies(): Promise<boolean>;
}

export async function createMendClient(
	options: CreateMendClientOptions,
): Promise<MendClientWithSession> {
	const config = options.config ?? loadMendConfig();
	const logger = options.logger;
	const session: MendSession = await openMendSession({
		config,
		cookiejar: options.cookiejar,
		logger,
	});

	/** 一覧ページを開き、Renovate 列の位置を確定させる。 */
	async function openRepoList(
		org: string,
	): Promise<{ page: Page; renovateIndex: number }> {
		const page = await session.page();
		const url = repoListUrl(config, org);
		logger.debug("Mend のリポジトリ一覧を開く", { url });
		await page.goto(url, { waitUntil: "domcontentloaded" });

		// テーブルが描画されるまで待つ。SPA なので goto 直後は空であることが多い。
		await page
			.getByRole("row")
			.first()
			.waitFor({ state: "visible", timeout: config.actionTimeoutMs })
			.catch(() => {
				throw new MendUiError(
					`Mend のリポジトリ一覧テーブルが見つかりません（${url}）。URL が変わった可能性があります。MEND_REPO_LIST_PATH で調整するか、bun run observe で再調査してください。`,
				);
			});

		const headers = await readTableHeaders(page);
		const renovateIndex = findRenovateColumnIndex(headers);
		if (renovateIndex < 0) {
			throw new MendUiError(
				`リポジトリ一覧に Renovate 列が見つかりません（検出した列: ${headers.join(" | ") || "なし"}）。bun run observe で UI を再調査してください。`,
			);
		}
		return { page, renovateIndex };
	}

	return {
		async listRepos(org: string): Promise<readonly MendRepo[]> {
			const { page, renovateIndex } = await openRepoList(org);
			const rows = await readDataRows(page);

			const repos: MendRepo[] = [];
			for (const row of rows) {
				const cells = await row.getByRole("cell").allTextContents();
				const name = cells[0]?.trim();
				const statusText = cells[renovateIndex]?.trim();
				if (!name || statusText === undefined) continue;

				repos.push({ name, renovateStatus: parseRenovateStatus(statusText) });
			}

			if (repos.length === 0) {
				throw new MendUiError(
					`${org} のリポジトリ一覧から 1 件も読み取れませんでした。テーブル構造が変わった可能性があります。`,
				);
			}
			logger.debug("Mend からリポジトリを読み取った", {
				org,
				count: repos.length,
			});
			return repos;
		},

		async triggerScan(
			org: string,
			mendRepoName: string,
		): Promise<MendTriggerResult> {
			const { page } = await openRepoList(org);
			const row = page
				.getByRole("row")
				.filter({ hasText: mendRepoName })
				.first();

			if ((await row.count()) === 0) {
				return {
					ok: false,
					reason: `一覧に ${mendRepoName} の行が見つかりませんでした`,
				};
			}

			const scanButton = row
				.getByRole("button", { name: /run renovate scan/i })
				.first();
			if ((await scanButton.count()) === 0) {
				// ボタンが行に直接無い場合はアクションメニューの中にあることが多い。
				const menuButton = row
					.getByRole("button", { name: /action|more|menu|︙|⋮/i })
					.first();
				if ((await menuButton.count()) === 0) {
					return {
						ok: false,
						reason: `${mendRepoName} の行に Run Renovate scan の導線が見つかりませんでした`,
					};
				}
				await menuButton.click({ timeout: config.actionTimeoutMs });
			}

			const target = page
				.getByRole("menuitem", { name: /run renovate scan/i })
				.first();
			const clickable = (await target.count()) > 0 ? target : scanButton;
			if ((await clickable.count()) === 0) {
				return {
					ok: false,
					reason: `${mendRepoName} の Run Renovate scan を特定できませんでした`,
				};
			}

			// scan は非同期実行なので、トリガーが受理された時点で完了とみなす。
			// 完了まで待つと 1 リポジトリあたり数分かかり実用にならない。
			try {
				await clickable.click({ timeout: config.actionTimeoutMs });
			} catch (error) {
				return {
					ok: false,
					reason: `クリックに失敗しました: ${error instanceof Error ? error.message : String(error)}`,
				};
			}

			// 確認ダイアログが出る場合に備える。無ければ何もしない。
			const confirm = page
				.getByRole("dialog")
				.getByRole("button", { name: /confirm|run|ok|yes/i })
				.first();
			if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) {
				await confirm.click({ timeout: config.actionTimeoutMs });
			}

			logger.debug("scan をトリガーした", { org, repo: mendRepoName });
			return { ok: true };
		},

		async persistCookies(): Promise<boolean> {
			return session.persistCookies();
		},

		async [Symbol.asyncDispose](): Promise<void> {
			await session[Symbol.asyncDispose]();
		},
	};
}
