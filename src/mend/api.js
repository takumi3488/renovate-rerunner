import { parseRenovateStatus } from "./status.js";

export class MendAuthError extends Error {
	name = "MendAuthError";
}

export class MendApiError extends Error {
	constructor(message, status) {
		super(message);
		this.name = "MendApiError";
		this.status = status;
	}
}

export const PAGE_SIZE = 50;
/** ページネーション情報が壊れたときの安全弁。 */
export const MAX_PAGES = 100;

// package file が無い repo の job add は Mend が 500 (no-package-files) を返す。

const NO_PACKAGE_FILES_PATTERN = /no[\s_-]*package[\s_-]*files?/i;
async function isNoPackageFilesResponse(response) {
	if (response.status !== 500) return false;
	try {
		return NO_PACKAGE_FILES_PATTERN.test(await response.text());
	} catch {
		return false;
	}
}

/**
 * Mend 内部 API クライアント。ブラウザが Cookie を付けるのでトークン管理は不要。
 *
 * @param {{origin:string, fetchImpl?:typeof fetch}} input
 * @returns {{
 *   listOrgs: () => Promise<{platform:string, slug:string, label:string}[]>,
 *   listDisabledRepos: (input:{platform:string, org:string}) => Promise<{repos:{name:string, status:string}[], unknownStatuses:{name:string, raw:string}[]}>,
 *   triggerScan: (target:{platform:string, org:string, repo:string}) => Promise<{ok:true, alreadyQueued?:boolean, skipped?:boolean}|{ok:false, reason:string}>,
 * }}
 */
export function createMendApi({ origin, fetchImpl = fetch } = {}) {
	async function mendFetch(path, init) {
		const response = await fetchImpl(new URL(path, origin), {
			...init,
			credentials: "include",
			headers: {
				Accept: "application/json",
				"x-app-id": "1",
				...init?.headers,
			},
		});

		if (response.status === 401 || response.status === 403) {
			throw new MendAuthError(
				"Mend のセッションが失効しています。developer.mend.io にログインし直してください。",
			);
		}

		// ログインページへのリダイレクトは 2xx + text/html で返ってくる。
		const contentType = response.headers.get("content-type") ?? "";
		if (response.ok && contentType.includes("text/html")) {
			throw new MendAuthError(
				"Mend のセッションが失効しています。developer.mend.io にログインし直してください。",
			);
		}

		return response;
	}

	async function listOrgs() {
		const response = await mendFetch("/api/user/orgs");
		if (!response.ok) {
			throw new MendApiError(
				`org 一覧の取得に失敗しました（status: ${response.status}）`,
				response.status,
			);
		}

		let data;
		try {
			data = await response.json();
		} catch {
			throw new MendApiError("org 一覧のレスポンスが JSON ではありません");
		}

		const items = Array.isArray(data)
			? data
			: Array.isArray(data?.content)
				? data.content
				: null;
		if (items === null) {
			throw new MendApiError("org 一覧のレスポンス構造が想定と異なります");
		}

		const orgs = [];
		for (const item of items) {
			if (typeof item !== "object" || item === null) continue;
			const { platform, slug } = item;
			if (typeof platform !== "string" || typeof slug !== "string") continue;
			// GitHub 生存チェックが必須条件のため、判定できないプラットフォームは対象にしない。
			if (platform !== "github") continue;
			const label =
				typeof item.displayNamePath === "string" && item.displayNamePath
					? item.displayNamePath
					: typeof item.displayName === "string" && item.displayName
						? item.displayName
						: typeof item.name === "string" && item.name
							? item.name
							: slug;
			orgs.push({ platform, slug, label });
		}
		return orgs;
	}

	async function listDisabledRepos({ platform, org }) {
		const repos = [];
		const unknownStatuses = [];

		for (let page = 0; page < MAX_PAGES; page++) {
			const path = `/api/orgs/${encodeURIComponent(platform)}/${encodeURIComponent(org)}/repos?page=${page}&size=${PAGE_SIZE}&renovateStatuses=disabled`;
			const response = await mendFetch(path);
			if (!response.ok) {
				throw new MendApiError(
					`リポジトリ一覧の取得に失敗しました（status: ${response.status}）`,
					response.status,
				);
			}

			let data;
			try {
				data = await response.json();
			} catch {
				throw new MendApiError(
					"リポジトリ一覧のレスポンスが JSON ではありません",
				);
			}

			if (
				typeof data !== "object" ||
				data === null ||
				Array.isArray(data) ||
				(!Array.isArray(data.content) &&
					data.content !== null &&
					data.content !== undefined)
			) {
				throw new MendApiError(
					"リポジトリ一覧のレスポンス構造が想定と異なります",
				);
			}

			const content = Array.isArray(data.content) ? data.content : [];
			for (const item of content) {
				const name = typeof item?.name === "string" ? item.name : "";
				const status = parseRenovateStatus(
					typeof item?.renovateStatus === "string" ? item.renovateStatus : "",
				);
				if (status.kind === "disabled") {
					repos.push({ name, status: status.kind });
				} else if (status.kind === "unknown") {
					unknownStatuses.push({ name, raw: status.raw });
				}
				// enabled は捨てる
			}

			// 終了条件（この順で判定）
			if (data.last === true) break;
			if (content.length === 0) break;
			if (typeof data.totalPages === "number" && page + 1 >= data.totalPages)
				break;
			if (
				typeof data.totalElements === "number" &&
				page + 1 >= Math.ceil(data.totalElements / PAGE_SIZE)
			)
				break;
		}

		return { repos, unknownStatuses };
	}

	async function triggerScan({ platform, org, repo }) {
		const path = `/api/repos/${encodeURIComponent(platform)}/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/renovate/job/add`;
		let response;
		try {
			response = await mendFetch(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ selectedBranches: [] }),
			});
		} catch (error) {
			// MendAuthError はそのまま throw（呼び出し側が全体を中断する）
			if (error instanceof MendAuthError) throw error;
			const reason = error instanceof Error ? error.message : String(error);
			return { ok: false, reason };
		}

		if (response.ok) return { ok: true };
		if (response.status === 409) return { ok: true, alreadyQueued: true };
		if (await isNoPackageFilesResponse(response))
			return { ok: true, skipped: true };
		return {
			ok: false,
			reason: `Mend API が ${response.status} を返しました`,
		};
	}

	return { listOrgs, listDisabledRepos, triggerScan };
}
