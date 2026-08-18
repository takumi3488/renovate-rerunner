export class GithubApiError extends Error {
	constructor(message, status) {
		super(message);
		this.name = "GithubApiError";
		this.status = status;
	}
}

const GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
/** 待機時間の上限（ミリ秒）。レート制限リセットが遠い場合に何時間も止まらないようにする。 */
const MAX_WAIT_MS = 60_000;

/**
 * Link ヘッダから rel="next" の URL を取り出す。無ければ undefined。
 */
export function parseNextLink(linkHeader) {
	if (!linkHeader) return undefined;

	for (const segment of linkHeader.split(",")) {
		const urlMatch = segment.match(/<([^>]*)>/);
		const relMatch = segment.match(/rel\s*=\s*["']([^"']*)["']/);
		if (urlMatch?.[1] && relMatch?.[1] === "next") {
			return urlMatch[1];
		}
	}
	return undefined;
}

/**
 * GitHub 側で生存しているリポジトリ名の一覧を返す。
 * バックグラウンド専用（トークンをコンテンツスクリプトに渡さないため）。
 *
 * @param {{org:string, token:string, excludeForks?:boolean, fetchImpl?:typeof fetch, maxPages?:number, sleep?:(ms:number)=>Promise<void>}} input
 * @returns {Promise<string[]>} archived / disabled / fork を除いた repo 名
 */
export async function listAliveRepoNames({
	org,
	token,
	excludeForks = true,
	fetchImpl = fetch,
	maxPages = 50,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};

	/** レート制限系のレスポンスから待機時間（ミリ秒）を算出する。上限を超える場合は undefined。 */
	function resolveRateLimitWaitMs(response) {
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

	async function fetchWithRetry(url) {
		let lastError;

		for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
			let response;
			try {
				response = await fetchImpl(url, { headers });
			} catch (error) {
				// ネットワークエラーはリトライ対象。
				lastError = error;
				if (attempt < DEFAULT_MAX_RETRIES) {
					const waitMs = Math.min(
						DEFAULT_BASE_DELAY_MS * 2 ** attempt,
						MAX_WAIT_MS,
					);
					await sleep(waitMs);
					continue;
				}
				break;
			}

			if (response.ok) return response;

			if (response.status === 401) {
				throw new GithubApiError(
					"GitHub token が無効か権限が不足しています（classic なら repo、fine-grained なら対象 org への Metadata: Read-only）",
					401,
				);
			}

			if (response.status === 404) {
				throw new GithubApiError(
					"org が存在しないか token からアクセスできません",
					404,
				);
			}

			const isRetryable =
				response.status === 403 ||
				response.status === 429 ||
				response.status >= 500;
			if (!isRetryable || attempt >= DEFAULT_MAX_RETRIES) {
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
						throw new GithubApiError(
							`GitHub API のレート制限待機時間が上限を超えています（${Math.ceil(rateLimitWaitMs / 1000)} 秒）`,
							response.status,
						);
					}
					await sleep(rateLimitWaitMs);
					continue;
				}
			}

			// レート制限ヘッダが無い場合や 5xx は指数バックオフ。
			const waitMs = Math.min(
				DEFAULT_BASE_DELAY_MS * 2 ** attempt,
				MAX_WAIT_MS,
			);
			await sleep(waitMs);
		}

		if (lastError instanceof GithubApiError) throw lastError;

		const message =
			lastError instanceof Error ? lastError.message : String(lastError);
		throw new GithubApiError(
			`GitHub API へのリクエストがリトライ上限に達しました: ${message}`,
		);
	}

	/** /orgs/ と /users/ で一覧エンドポイントが分かれるため種別を判定する。 */
	async function resolveAccountType(name) {
		const url = `${GITHUB_API_BASE}/users/${encodeURIComponent(name)}`;
		const response = await fetchWithRetry(url);
		const body = await response.json();
		if (typeof body !== "object" || body === null) {
			throw new GithubApiError(
				`GitHub API のレスポンスが不正です（アカウント情報がオブジェクトではありません）: ${name}`,
			);
		}
		const type = body.type;
		if (type !== "Organization" && type !== "User") {
			throw new GithubApiError("GitHub アカウントの種別を判定できませんでした");
		}
		return type;
	}

	const accountType = await resolveAccountType(org);
	const pathPrefix = accountType === "Organization" ? "orgs" : "users";
	let url = `${GITHUB_API_BASE}/${pathPrefix}/${encodeURIComponent(org)}/repos?per_page=100&type=all`;
	let page = 0;
	const names = [];

	while (url !== undefined) {
		page++;
		if (page > maxPages) {
			throw new GithubApiError(
				`ページネーションの安全弁（maxPages: ${maxPages}）を超えました。org: ${org}`,
			);
		}

		const response = await fetchWithRetry(url);
		const body = await response.json();
		if (!Array.isArray(body)) {
			throw new GithubApiError("GitHub API のレスポンスが配列ではありません");
		}

		for (const item of body) {
			// 突合キーが壊れるので name が無い要素は黙って捨てない。
			if (typeof item?.name !== "string") {
				throw new GithubApiError("GitHub API のレスポンスに name がありません");
			}
			if (item.archived === true || item.disabled === true) continue;
			if (excludeForks && item.fork === true) continue;
			names.push(item.name);
		}

		// 2 ページ目以降は Link ヘッダから得た URL をそのまま使う。
		url = parseNextLink(response.headers.get("link"));
	}

	return names;
}
