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
 *
 * 本番で観測したステータスの意味（2026-08-04）:
 * - 409 Conflict: そのリポジトリのジョブが既にキューにある（＝既にトリガー済み）。
 *   トリガー直後も renovateStatus はしばらく disabled のまま一覧に出るため、
 *   連続実行すると必ず発生しうる。冪等な成功として扱う。
 * - 500: リポジトリ固有の状態（ジョブ追加不可など）と考えられる。そのリポジトリだけの
 *   失敗として記録して処理を継続する（全体を fatal にしない）。
 */

import { SpanKind } from "@opentelemetry/api";
import type { CookiejarClient } from "../cookiejar/client";
import type { Logger } from "../logger";
import { withSpan } from "../telemetry";
import type { MendConfig } from "./config";
import { loadMendConfig } from "./config";
import type {
	MendClient,
	MendRenovateStatus,
	MendRepo,
	MendTriggerResult,
} from "./types";
import { MendApiError, MendAuthError, MendUiError } from "./types";

/** 内部 API が要求するヘッダ。これが無いと 401 になる。 */
const APP_ID_HEADER = "1";

/** ページネーションのサイズ。UI の既定と同じ。 */
const PAGE_SIZE = 50;

/**
 * エラーの reason に含めるレスポンスボディの最大文字数。
 * Mend のエラーボディは HTML のことがあり全文は不要。原因追跡に足る先頭だけ残す。
 */
const BODY_PREVIEW_LIMIT = 500;

/**
 * ボディプレビューから値を伏せる対象のキー名。
 * logger.ts の SECRET_KEY_PATTERN と同じ方針だが、こちらはテキスト中に適用する。
 * エラーページがリクエストヘッダやクエリをエコーする場合（`key=value` 形式）と、
 * エラー JSON が秘密値を含む場合（`"key":"value"` 形式）の両方からの
 * mend_session Cookie 流出を防ぐのが目的。
 */
const SECRET_VALUE_PATTERN =
	/([\w-]*(?:cookie|password|token|secret|authorization|session)[\w-]*=)("?)[^"&\s;]+/gi;
const SECRET_JSON_PATTERN =
	/("[\w-]*(?:cookie|password|token|secret|authorization|session)[\w-]*"\s*:\s*")[^"]*(")/gi;

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

	/**
	 * 認証済みの fetch。401/403（セッション失効）のときだけ MendAuthError を投げ、
	 * それ以外のステータスは呼び出し側が意味を判断できるよう Response をそのまま返す。
	 */
	async function mendRequest(
		path: string,
		init?: RequestInit,
	): Promise<Response> {
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

		return response;
	}

	/** ボディテキストを診断用の 1 行プレビューに整える。秘密値らしきキーの値は伏せ、改行は畳む（ログ注入防止）。 */
	function toBodyPreview(text: string): string {
		const collapsed = text
			.replace(SECRET_VALUE_PATTERN, "$1$2[REDACTED]")
			.replace(SECRET_JSON_PATTERN, "$1[REDACTED]$2")
			.replace(/\s+/g, " ")
			.trim();
		return collapsed.length > BODY_PREVIEW_LIMIT
			? `${collapsed.slice(0, BODY_PREVIEW_LIMIT)}…`
			: collapsed;
	}

	/**
	 * レスポンスボディの先頭を読む。エラーの原因追跡用。
	 * 読み取りに失敗しても元のエラーを上書きしないよう、例外は握りつぶして空文字を返す。
	 */
	async function readBodyPreview(response: Response): Promise<string> {
		try {
			return toBodyPreview(await response.text());
		} catch {
			return "";
		}
	}

	/** JSON を返す GET 用。非 2xx は MendApiError、構造が壊れていれば MendUiError を投げる。 */
	async function mendGet<T>(path: string): Promise<T> {
		const response = await mendRequest(path);
		if (!response.ok) {
			const preview = await readBodyPreview(response);
			throw new MendApiError(
				`Mend API が ${response.status} を返しました: ${path}${preview ? `: ${preview}` : ""}`,
				response.status,
				preview,
			);
		}
		const text = await response.text();
		try {
			return JSON.parse(text) as T;
		} catch {
			// 200 なのに JSON でない = HTML エラーページ等へのすり替わり。構造変更とみなす。
			const preview = toBodyPreview(text);
			throw new MendUiError(
				`Mend API が JSON ではないレスポンスを返しました: ${path}${preview ? `: ${preview}` : ""}`,
			);
		}
	}

	return {
		async listRepos(org: string): Promise<readonly MendRepo[]> {
			return withSpan(
				"mend.list_repos",
				{ attributes: { "rerunner.org": org }, kind: SpanKind.CLIENT },
				async (span) => {
					const repos: MendRepo[] = [];
					let page = 0;
					let totalPages = 1;

					while (page < totalPages) {
						const path = `/api/orgs/github/${encodeURIComponent(org)}/repos?page=${page}&size=${PAGE_SIZE}&renovateStatuses=disabled`;
						const data = await mendGet<MendRepoResponse>(path);

						// エンベロープの構造が想定と違う場合は内部 API の構造変更と判断する。
						// 空ページでも content: []（または null）と totalElements は返る前提
						// （この前提が崩れたときに黙って 0 件扱いすると scan 対象を永続的に
						// 見落とすため、fail fast させる）。content の null は空ページの
						// シリアライズ揺れとして許容し、欠落とはみなさない。
						if (
							data === null ||
							typeof data !== "object" ||
							Array.isArray(data)
						) {
							throw new MendUiError(
								`Mend のリポジトリ一覧がオブジェクトではありません: ${path}`,
							);
						}
						const content = data.content;
						if (
							(content !== undefined &&
								content !== null &&
								!Array.isArray(content)) ||
							(content == null && data.totalElements == null)
						) {
							throw new MendUiError(
								`Mend のリポジトリ一覧のレスポンス構造が想定と異なります: ${path}`,
							);
						}

						for (const item of content ?? []) {
							repos.push({
								name: item.name,
								renovateStatus: parseRenovateStatus(item.renovateStatus ?? ""),
							});
						}

						if (typeof data.totalPages === "number") {
							totalPages = data.totalPages;
						} else if (typeof data.totalElements === "number") {
							// totalPages が落とされても totalElements から導出できる。
							totalPages = Math.max(
								1,
								Math.ceil(data.totalElements / PAGE_SIZE),
							);
						} else {
							totalPages = 1;
							if ((content?.length ?? 0) === PAGE_SIZE) {
								// ページネーション情報が両方無いと続きページを追えない。
								// ちょうど満杯のページのときだけ、取りこぼしの可能性を warn する。
								logger.warn(
									"Mend の一覧レスポンスにページネーション情報がなく、全件取得できていない可能性があります",
									{ org, page },
								);
							}
						}
						page += 1;
					}

					span.setAttribute("rerunner.mend.repo_count", repos.length);
					span.setAttribute("rerunner.mend.page_count", page);
					logger.debug("Mend からリポジトリを読み取った", {
						org,
						count: repos.length,
					});
					return repos;
				},
			);
		},

		async triggerScan(
			org: string,
			mendRepoName: string,
		): Promise<MendTriggerResult> {
			return withSpan(
				"mend.trigger_scan",
				{
					attributes: {
						"rerunner.org": org,
						"rerunner.mend.repo": mendRepoName,
					},
					kind: SpanKind.CLIENT,
				},
				async (span) => {
					const path = `/api/repos/github/${encodeURIComponent(org)}/${encodeURIComponent(mendRepoName)}/renovate/job/add`;

					let response: Response;
					try {
						response = await mendRequest(path, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ selectedBranches: [] }),
						});
					} catch (error) {
						// セッション切れは以降のリポジトリも全滅するため fatal として再 throw する。
						if (error instanceof MendAuthError) {
							throw error;
						}
						// ネットワークエラーなど。このリポジトリだけの失敗として記録し、処理は継続する。
						const reason = `scan のトリガーに失敗しました: ${error instanceof Error ? error.message : String(error)}`;
						span.setAttribute("rerunner.trigger.ok", false);
						span.setAttribute("rerunner.trigger.reason", reason);
						return { ok: false, reason };
					}

					span.setAttribute("http.response.status_code", response.status);

					if (response.ok) {
						// ログインページへのリダイレクト等で HTML が返ってきた場合を検出する。
						// JSON API が成功時に HTML を返すことはなく、検出しないと
						// セッション切れのまま全リポジトリを「成功」と誤記録し続ける。
						const contentType = response.headers.get("content-type") ?? "";
						if (contentType.includes("text/html")) {
							throw new MendAuthError(
								`Mend が HTML を返しました（ログインページへのリダイレクトの可能性。ブラウザで developer.mend.io にログインし直してください）: ${path}`,
							);
						}
						span.setAttribute("rerunner.trigger.ok", true);
						logger.debug("scan をトリガーした", { org, repo: mendRepoName });
						return { ok: true };
					}

					if (response.status === 409) {
						// ジョブが既にキューにある = 前回の実行などで既にトリガー済み。
						// 目的（scan が走ること）は達成されているので成功扱いにする。
						span.setAttribute("rerunner.trigger.ok", true);
						span.setAttribute("rerunner.trigger.already_queued", true);
						logger.debug("ジョブは既にキューにある", {
							org,
							repo: mendRepoName,
						});
						return { ok: true, alreadyQueued: true };
					}

					// 個別リポジトリの失敗は戻り値で表す設計なので、span は ERROR にせず
					// 属性に留める（失敗の集計は呼び出し側が failedCount・終了コードで表現する）。
					// span の reason にはボディプレビューを含めない
					// （未検証の外部コンテンツを span 属性に載せないため。プレビューは
					// スクラブ済みのうえ戻り値の reason 経由でログにのみ残す）。
					const preview = await readBodyPreview(response);
					const reasonCore = `Mend API が ${response.status} を返しました: ${path}`;
					const reason = preview ? `${reasonCore}: ${preview}` : reasonCore;
					span.setAttribute("rerunner.trigger.ok", false);
					span.setAttribute("rerunner.trigger.reason", reasonCore);
					return { ok: false, reason };
				},
			);
		},

		async [Symbol.asyncDispose](): Promise<void> {
			// 内部 API 方式ではリソースは持たない
		},
	};
}
