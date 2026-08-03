/**
 * developer.mend.io の MendClient 実装。
 *
 * Mend はリポジトリ一覧の取得も scan のトリガーも公開 API を提供していない
 * （公開 API は GitHub Secrets 管理専用）ため、UI が叩いている内部 API を
 * `x-app-id: 1` ヘッダと Cookie で直接叩く。
 *
 * 観測結果（2026-08-03）:
 * - 一覧: `GET /api/orgs/github/{org}/repos?page=0&size=50&renovateStatuses=disabled`
 * - scan: `POST /api/repos/github/{org}/{repo}/renovate/job/add` (body: `{"selectedBranches":[]}`)
 * - 必須ヘッダ: `x-app-id: 1`、`Cookie: mend_session=...`
 */

import type { CookiejarClient } from "../cookiejar/client";
import type { Logger } from "../logger";
import type { MendConfig } from "./config";
import { loadMendConfig } from "./config";
import type {
	MendClient,
	MendRenovateStatus,
	MendRepo,
	MendTriggerResult,
} from "./types";
import { MendAuthError, MendUiError } from "./types";

/** 内部 API が要求するヘッダ。これが無いと 401 になる。 */
const APP_ID_HEADER = "1";

/** ページネーションのサイズ。UI の既定と同じ。 */
const PAGE_SIZE = 50;

/**
 * UI に表示されている文字列を Renovate の状態に変換する。
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

export function parseRenovateStatus(raw: string): MendRenovateStatus {
	const normalized = raw.trim().toLowerCase();
	if (DISABLED_LABELS.has(normalized)) return { kind: "disabled" };
	if (ENABLED_LABELS.has(normalized)) return { kind: "enabled" };
	// 判別できない値は握りつぶさず raw を残す。突合側が安全側に倒して対象外にする。
	return { kind: "unknown", raw: raw.trim() };
}

interface MendRepoResponse {
	readonly content?: readonly {
		readonly id: string;
		readonly fullName: string;
		readonly name: string;
		readonly renovateStatus?: string;
		readonly enabled?: boolean;
		readonly renovateEnabled?: boolean;
	}[];
	readonly totalElements?: number;
	readonly totalPages?: number;
	readonly number?: number;
}

export interface CreateMendClientOptions {
	readonly logger: Logger;
	readonly cookiejar: CookiejarClient;
	readonly config?: MendConfig;
}

export async function createMendClient(
	options: CreateMendClientOptions,
): Promise<MendClient> {
	const config = options.config ?? loadMendConfig();
	const logger = options.logger;

	/** Cookie ヘッダを組み立てる。mend.io ドメインの Cookie のみ。 */
	function buildCookieHeader(
		cookies: readonly { name: string; value: string; domain: string }[],
	): string {
		return cookies
			.filter((c) => c.domain.includes("mend.io"))
			.map((c) => `${c.name}=${c.value}`)
			.join("; ");
	}

	/** 認証済みの fetch。失効していたら MendAuthError を投げる。 */
	async function mendFetch<T>(path: string, init?: RequestInit): Promise<T> {
		const cookies = await options.cookiejar.fetchCookies();
		const cookieHeader = buildCookieHeader(cookies);
		if (!cookieHeader) {
			throw new MendAuthError(
				"cookiejar に Mend の Cookie がありません。ブラウザで developer.mend.io にログインしてください（拡張が自動で保存します）。",
			);
		}

		const url = `${config.baseUrl}${path}`;
		const response = await fetch(url, {
			...init,
			headers: {
				...init?.headers,
				Cookie: cookieHeader,
				"x-app-id": APP_ID_HEADER,
				Accept: "application/json",
			},
		});

		if (response.status === 401 || response.status === 403) {
			throw new MendAuthError(
				`Mend のセッションが失効しています（${response.status}）。ブラウザで developer.mend.io にログインしてください（拡張が自動で保存します）。`,
			);
		}

		if (!response.ok) {
			throw new MendUiError(
				`Mend API が ${response.status} を返しました: ${path}`,
			);
		}

		return (await response.json()) as T;
	}

	return {
		async listRepos(org: string): Promise<readonly MendRepo[]> {
			const repos: MendRepo[] = [];
			let page = 0;
			let totalPages = 1;

			while (page < totalPages) {
				const data = await mendFetch<MendRepoResponse>(
					`/api/orgs/github/${encodeURIComponent(org)}/repos?page=${page}&size=${PAGE_SIZE}&renovateStatuses=disabled`,
				);

				for (const item of data.content ?? []) {
					repos.push({
						name: item.name,
						renovateStatus: parseRenovateStatus(item.renovateStatus ?? ""),
					});
				}

				totalPages = data.totalPages ?? 1;
				page += 1;
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
			try {
				await mendFetch(
					`/api/repos/github/${encodeURIComponent(org)}/${encodeURIComponent(mendRepoName)}/renovate/job/add`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ selectedBranches: [] }),
					},
				);
				logger.debug("scan をトリガーした", { org, repo: mendRepoName });
				return { ok: true };
			} catch (error) {
				if (error instanceof MendAuthError || error instanceof MendUiError) {
					throw error;
				}
				return {
					ok: false,
					reason: `scan のトリガーに失敗しました: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		},

		async [Symbol.asyncDispose](): Promise<void> {
			// 内部 API 方式ではリソースは持たない
		},
	};
}
