import type { GithubRepo } from "./types";

/**
 * GitHub REST API 呼び出しに関するエラー。
 * status を持たせておくことで呼び出し側が 401/404 などを個別にハンドリングできる。
 */
export class GithubApiError extends Error {
	override readonly name = "GithubApiError";

	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
	}
}

export interface GithubClientOptions {
	/** テスト用の差し替え口。省略時はグローバルの fetch。 */
	readonly fetchImpl?: typeof fetch;
	/** リトライの最大回数（初回試行を含まない）。既定 3。 */
	readonly maxRetries?: number;
	/** バックオフの基準ミリ秒。既定 1000。テストでは 0 を渡して即時化する。 */
	readonly baseDelayMs?: number;
	/** 待機の差し替え口。省略時は Bun.sleep 相当。テストでは no-op を渡す。 */
	readonly sleepImpl?: (ms: number) => Promise<void>;
	/** ページネーションの安全弁。既定 50 ページ（= 5000 件）。 */
	readonly maxPages?: number;
}

export interface GithubClient {
	listOrgRepos(org: string): Promise<readonly GithubRepo[]>;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_PAGES = 50;
/** 待機時間の上限（ミリ秒）。レート制限リセットが遠い場合に何時間も止まらないようにする。 */
const MAX_WAIT_MS = 60_000;

const GITHUB_API_BASE = "https://api.github.com";

/**
 * Link ヘッダから rel="next" の URL を取り出す。無ければ undefined。
 * `rel="next"` はシングルクォートや空白ゆれを許容し、要素の並び順にも依存しない。
 */
export function parseNextLink(linkHeader: string | null): string | undefined {
	if (!linkHeader) {
		return undefined;
	}

	// Link ヘッダは `<url>; rel="next", <url>; rel="last"` のようにカンマ区切りで並ぶ。
	// URL 自体にカンマを含むことは無い前提でシンプルに分割する。
	const segments = linkHeader.split(",");
	for (const segment of segments) {
		const urlMatch = segment.match(/<([^>]*)>/);
		// rel="next" と rel='next' の両方、および前後の空白ゆれを許容する。
		const relMatch = segment.match(/rel\s*=\s*["']([^"']*)["']/);
		if (urlMatch?.[1] && relMatch?.[1] === "next") {
			return urlMatch[1];
		}
	}

	return undefined;
}

/**
 * GitHub API のレスポンス 1 件を GithubRepo に変換する。
 * 突合キーとして使う name / fullName の信頼性を優先し、欠落時は握りつぶさずエラーにする。
 */
export function toGithubRepo(raw: unknown): GithubRepo {
	if (typeof raw !== "object" || raw === null) {
		throw new GithubApiError(
			"GitHub API のレスポンスが不正です（リポジトリがオブジェクトではありません）",
		);
	}

	const record = raw as Record<string, unknown>;

	const name = record["name"];
	if (typeof name !== "string") {
		throw new GithubApiError("GitHub API のレスポンスに name がありません");
	}

	const fullName = record["full_name"];
	if (typeof fullName !== "string") {
		// full_name が無い場合に name から補うと突合キーの信頼性が落ちるため、エラーにする。
		throw new GithubApiError(
			`GitHub API のレスポンスに full_name がありません（name: ${name}）`,
		);
	}

	const visibility =
		typeof record["visibility"] === "string"
			? (record["visibility"] as string)
			: deriveVisibility(record);

	return {
		name,
		fullName,
		archived: record["archived"] === true,
		disabled: record["disabled"] === true,
		fork: record["fork"] === true,
		visibility,
	};
}

/** visibility フィールドが無い古いレスポンス形式向けに private フラグから推定する。 */
function deriveVisibility(record: Record<string, unknown>): string {
	if (record["private"] === true) {
		return "private";
	}
	if (record["private"] === false) {
		return "public";
	}
	return "unknown";
}

export function createGithubClient(
	token: string,
	options?: GithubClientOptions,
): GithubClient {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
	const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const sleepImpl = options?.sleepImpl ?? ((ms: number) => Bun.sleep(ms));
	const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;

	/** Authorization ヘッダの値を絶対に含めずにリクエストヘッダを組み立てる。 */
	function buildHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "renovate-rerunner",
		};
	}

	/** レート制限系のレスポンスから待機時間（ミリ秒）を算出する。上限を超える場合は undefined。 */
	function resolveRateLimitWaitMs(response: Response): number | undefined {
		const retryAfter = response.headers.get("retry-after");
		if (retryAfter !== null) {
			const seconds = Number(retryAfter);
			if (Number.isFinite(seconds) && seconds >= 0) {
				return seconds * 1000;
			}
		}

		const remaining = response.headers.get("x-ratelimit-remaining");
		if (remaining === "0") {
			const reset = response.headers.get("x-ratelimit-reset");
			if (reset !== null) {
				const resetEpochSeconds = Number(reset);
				if (Number.isFinite(resetEpochSeconds)) {
					const waitMs = resetEpochSeconds * 1000 - Date.now();
					return Math.max(waitMs, 0);
				}
			}
		}

		return undefined;
	}

	/**
	 * 1 回の HTTP リクエストをリトライ込みで実行する。
	 * 401/404 は即座にエラーとして throw し、それ以外の失敗はリトライ後に最後のエラーを throw する。
	 */
	async function fetchWithRetry(url: string): Promise<Response> {
		let lastError: unknown;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			let response: Response;
			try {
				response = await fetchImpl(url, { headers: buildHeaders() });
			} catch (error) {
				// fetch 自体が投げるネットワークエラーはリトライ対象。
				lastError = error;
				if (attempt < maxRetries) {
					const waitMs = Math.min(baseDelayMs * 2 ** attempt, MAX_WAIT_MS);
					await sleepImpl(waitMs);
					continue;
				}
				break;
			}

			if (response.ok) {
				return response;
			}

			if (response.status === 401) {
				throw new GithubApiError(
					"GITHUB_TOKEN が無効か権限が不足しています。'repo' または 'read:org' スコープを持つトークンを設定してください",
					401,
				);
			}

			if (response.status === 404) {
				throw new GithubApiError(
					"組織が存在しないか、トークンからアクセスできません",
					404,
				);
			}

			const isRetryable =
				response.status === 403 ||
				response.status === 429 ||
				response.status >= 500;
			if (!isRetryable || attempt >= maxRetries) {
				lastError = new GithubApiError(
					`GitHub API がエラーを返しました（status: ${response.status}）`,
					response.status,
				);
				break;
			}

			if (response.status === 403 || response.status === 429) {
				const rateLimitWaitMs = resolveRateLimitWaitMs(response);
				if (rateLimitWaitMs !== undefined) {
					if (rateLimitWaitMs > MAX_WAIT_MS) {
						// レート制限リセットが遠すぎる場合は待たずにエラーにする。
						throw new GithubApiError(
							`GitHub API のレート制限待機時間が上限を超えています（${Math.ceil(rateLimitWaitMs / 1000)} 秒）`,
							response.status,
						);
					}
					await sleepImpl(rateLimitWaitMs);
					continue;
				}
			}

			// レート制限ヘッダが無い場合や 5xx は指数バックオフ。
			const waitMs = Math.min(baseDelayMs * 2 ** attempt, MAX_WAIT_MS);
			await sleepImpl(waitMs);
		}

		if (lastError instanceof GithubApiError) {
			throw lastError;
		}

		const message =
			lastError instanceof Error ? lastError.message : String(lastError);
		throw new GithubApiError(
			`GitHub API へのリクエストがリトライ上限に達しました: ${message}`,
		);
	}

	/**
	 * 指定した名前が「organization」か「user」かを判定する。
	 * リポジトリ一覧のエンドポイントが /orgs/ と /users/ で分かれるため。
	 */
	async function resolveAccountType(
		name: string,
	): Promise<"Organization" | "User"> {
		const url = `${GITHUB_API_BASE}/users/${encodeURIComponent(name)}`;
		const response = await fetchWithRetry(url);
		const body: unknown = await response.json();
		if (typeof body !== "object" || body === null) {
			throw new GithubApiError(
				`GitHub API のレスポンスが不正です（アカウント情報がオブジェクトではありません）: ${name}`,
			);
		}
		const type = (body as Record<string, unknown>).type;
		if (type !== "Organization" && type !== "User") {
			throw new GithubApiError(
				`GitHub アカウントの種別を判定できませんでした: ${name}（type: ${String(type)}）`,
			);
		}
		return type;
	}

	async function listOrgRepos(org: string): Promise<readonly GithubRepo[]> {
		const repos: GithubRepo[] = [];
		const accountType = await resolveAccountType(org);
		const pathPrefix = accountType === "Organization" ? "orgs" : "users";
		let url: string | undefined =
			`${GITHUB_API_BASE}/${pathPrefix}/${encodeURIComponent(org)}/repos?per_page=100&type=all`;
		let page = 0;

		while (url !== undefined) {
			page++;
			if (page > maxPages) {
				throw new GithubApiError(
					`ページネーションの安全弁（maxPages: ${maxPages}）を超えました。org: ${org}`,
				);
			}

			const response = await fetchWithRetry(url);
			const body: unknown = await response.json();
			if (!Array.isArray(body)) {
				throw new GithubApiError("GitHub API のレスポンスが配列ではありません");
			}

			for (const item of body) {
				repos.push(toGithubRepo(item));
			}

			// 2 ページ目以降は Link ヘッダから得た URL をそのまま使い、クエリを自前で組み立て直さない。
			url = parseNextLink(response.headers.get("link"));
		}

		return repos;
	}

	return { listOrgRepos };
}
