import { describe, expect, test } from "bun:test";
import {
	GithubApiError,
	createGithubClient,
	parseNextLink,
	toGithubRepo,
} from "./github";

/**
 * fetch の呼び出しを記録するモック。
 * globalThis.fetch を書き換えず DI で差し替えるため、テスト間の後始末が不要になる。
 */
interface RecordedCall {
	readonly url: string;
	readonly init?: RequestInit;
}

function createFetchMock(
	responder: (url: string, callIndex: number) => Response,
): {
	readonly fetchImpl: typeof fetch;
	readonly calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const handler = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url, init });
		return responder(url, calls.length - 1);
	};
	// Bun の fetch は呼び出しシグネチャに加えて静的メソッド preconnect を持ち、
	// typeof fetch の型としてそれが必須になるためスタブを生やしておく。
	const fetchImpl = Object.assign(handler, {
		preconnect: () => {},
	});
	return { fetchImpl, calls };
}

interface MockResponseInit {
	readonly status?: number;
	readonly headers?: Record<string, string>;
}

function makeResponse(body: unknown, init: MockResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: init.headers,
	});
}

/** テストを高速化するための no-op 待機。 */
function noopSleep(): Promise<void> {
	return Promise.resolve();
}

/** sleepImpl に渡された待機時間を記録するモック。 */
function createSleepMock(): {
	readonly sleepImpl: (ms: number) => Promise<void>;
	readonly calls: number[];
} {
	const calls: number[] = [];
	const sleepImpl = async (ms: number): Promise<void> => {
		calls.push(ms);
	};
	return { sleepImpl, calls };
}

describe("parseNextLink", () => {
	test("rel=next の URL を抽出する", () => {
		const header =
			'<https://api.github.com/orgs/foo/repos?page=2>; rel="next", <https://api.github.com/orgs/foo/repos?page=5>; rel="last"';
		expect(parseNextLink(header)).toBe(
			"https://api.github.com/orgs/foo/repos?page=2",
		);
	});

	test("rel=next が無ければ undefined を返す", () => {
		const header =
			'<https://api.github.com/orgs/foo/repos?page=1>; rel="prev", <https://api.github.com/orgs/foo/repos?page=5>; rel="last"';
		expect(parseNextLink(header)).toBeUndefined();
	});

	test("null なら undefined を返す", () => {
		expect(parseNextLink(null)).toBeUndefined();
	});

	test("空文字なら undefined を返す", () => {
		expect(parseNextLink("")).toBeUndefined();
	});

	test("rel=next が最後の要素にあっても抽出できる", () => {
		const header =
			'<https://api.github.com/orgs/foo/repos?page=5>; rel="last", <https://api.github.com/orgs/foo/repos?page=2>; rel="next"';
		expect(parseNextLink(header)).toBe(
			"https://api.github.com/orgs/foo/repos?page=2",
		);
	});

	test("シングルクォートの rel=next でも抽出できる", () => {
		const header = "<https://api.github.com/orgs/foo/repos?page=2>; rel='next'";
		expect(parseNextLink(header)).toBe(
			"https://api.github.com/orgs/foo/repos?page=2",
		);
	});

	test("余分な空白があっても抽出できる", () => {
		const header =
			'<https://api.github.com/orgs/foo/repos?page=2>;   rel = "next"  , <https://api.github.com/orgs/foo/repos?page=5>; rel="last"';
		expect(parseNextLink(header)).toBe(
			"https://api.github.com/orgs/foo/repos?page=2",
		);
	});
});

describe("toGithubRepo", () => {
	test("正常なレスポンスを変換する", () => {
		const raw = {
			name: "repo-a",
			full_name: "my-org/repo-a",
			archived: true,
			disabled: false,
			fork: true,
			visibility: "internal",
		};
		expect(toGithubRepo(raw)).toEqual({
			name: "repo-a",
			fullName: "my-org/repo-a",
			archived: true,
			disabled: false,
			fork: true,
			visibility: "internal",
		});
	});

	test("archived/fork/disabled が欠落していれば false になる", () => {
		const raw = {
			name: "repo-a",
			full_name: "my-org/repo-a",
			visibility: "public",
		};
		const repo = toGithubRepo(raw);
		expect(repo.archived).toBe(false);
		expect(repo.disabled).toBe(false);
		expect(repo.fork).toBe(false);
	});

	test("name が欠落していればエラーになる", () => {
		const raw = { full_name: "my-org/repo-a" };
		expect(() => toGithubRepo(raw)).toThrow(GithubApiError);
	});

	test("full_name が欠落していればエラーになる", () => {
		// name から補うと突合キーの信頼性が落ちるため、フォールバックせずエラーにする。
		const raw = { name: "repo-a" };
		expect(() => toGithubRepo(raw)).toThrow(GithubApiError);
	});

	test("visibility 欠落時は private: true から private を導出する", () => {
		const raw = { name: "repo-a", full_name: "my-org/repo-a", private: true };
		expect(toGithubRepo(raw).visibility).toBe("private");
	});

	test("visibility も private も無ければ unknown になる", () => {
		const raw = { name: "repo-a", full_name: "my-org/repo-a" };
		expect(toGithubRepo(raw).visibility).toBe("unknown");
	});
});

describe("createGithubClient / listOrgRepos", () => {
	test("単一ページの結果を返す", async () => {
		const { fetchImpl } = createFetchMock(() =>
			makeResponse([{ name: "repo-a", full_name: "org/repo-a" }]),
		);
		const client = createGithubClient("token", {
			fetchImpl,
			sleepImpl: noopSleep,
			baseDelayMs: 0,
		});

		const repos = await client.listOrgRepos("org");

		expect(repos).toHaveLength(1);
		expect(repos[0]?.name).toBe("repo-a");
	});

	test("リクエストヘッダに Authorization / Accept / API バージョン / UA を付与する", async () => {
		const { fetchImpl, calls } = createFetchMock(() => makeResponse([]));
		const client = createGithubClient("secret-token", {
			fetchImpl,
			sleepImpl: noopSleep,
			baseDelayMs: 0,
		});

		await client.listOrgRepos("org");

		expect(calls[0]?.init?.headers).toEqual({
			Authorization: "Bearer secret-token",
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "renovate-rerunner",
		});
	});

	test("org 名の特殊文字を URL エスケープする", async () => {
		const { fetchImpl, calls } = createFetchMock(() => makeResponse([]));
		const client = createGithubClient("token", {
			fetchImpl,
			sleepImpl: noopSleep,
			baseDelayMs: 0,
		});

		await client.listOrgRepos("foo/bar baz");

		expect(calls[0]?.url).toContain(encodeURIComponent("foo/bar baz"));
		expect(calls[0]?.url).not.toContain("foo/bar baz");
	});

	test("Link ヘッダを追従して複数ページを結合する", async () => {
		const page1 = [{ name: "repo-a", full_name: "org/repo-a" }];
		const page2 = [{ name: "repo-b", full_name: "org/repo-b" }];
		const nextUrl =
			"https://api.github.com/orgs/org/repos?per_page=100&type=all&page=2";

		const { fetchImpl, calls } = createFetchMock((url) => {
			if (url === nextUrl) {
				return makeResponse(page2);
			}
			return makeResponse(page1, {
				headers: { link: `<${nextUrl}>; rel="next"` },
			});
		});

		const client = createGithubClient("token", {
			fetchImpl,
			sleepImpl: noopSleep,
			baseDelayMs: 0,
		});
		const repos = await client.listOrgRepos("org");

		expect(repos.map((repo) => repo.name)).toEqual(["repo-a", "repo-b"]);
		expect(calls).toHaveLength(2);
		// 2 ページ目は Link ヘッダの URL をそのまま使い、クエリを組み立て直さないこと。
		expect(calls[1]?.url).toBe(nextUrl);
	});

	test("maxPages を超えたらエラーになる", async () => {
		const alwaysNextUrl = "https://api.github.com/orgs/org/repos?page=999";
		const { fetchImpl } = createFetchMock(() =>
			makeResponse([{ name: "repo", full_name: "org/repo" }], {
				headers: { link: `<${alwaysNextUrl}>; rel="next"` },
			}),
		);

		const client = createGithubClient("token", {
			fetchImpl,
			sleepImpl: noopSleep,
			baseDelayMs: 0,
			maxPages: 2,
		});

		await expect(client.listOrgRepos("org")).rejects.toThrow(GithubApiError);
	});

	test("レスポンスが配列でなければエラーになる", async () => {
		const { fetchImpl } = createFetchMock(() =>
			makeResponse({ message: "not an array" }),
		);
		const client = createGithubClient("token", {
			fetchImpl,
			sleepImpl: noopSleep,
			baseDelayMs: 0,
		});

		await expect(client.listOrgRepos("org")).rejects.toThrow(GithubApiError);
	});

	test("500 が 2 回続いた後 200 で成功する", async () => {
		const { fetchImpl, calls } = createFetchMock((_url, callIndex) => {
			if (callIndex < 2) {
				return makeResponse({}, { status: 500 });
			}
			return makeResponse([{ name: "repo-a", full_name: "org/repo-a" }]);
		});

		const client = createGithubClient("token", {
			fetchImpl,
			sleepImpl: noopSleep,
			baseDelayMs: 0,
		});
		const repos = await client.listOrgRepos("org");

		expect(repos).toHaveLength(1);
		expect(calls).toHaveLength(3);
	});

	test("ネットワークエラーもリトライする", async () => {
		const { fetchImpl, calls } = createFetchMock((_url, callIndex) => {
			if (callIndex === 0) {
				throw new Error("network down");
			}
			return makeResponse([{ name: "repo-a", full_name: "org/repo-a" }]);
		});

		const client = createGithubClient("token", {
			fetchImpl,
			sleepImpl: noopSleep,
			baseDelayMs: 0,
		});
		const repos = await client.listOrgRepos("org");

		expect(repos).toHaveLength(1);
		expect(calls).toHaveLength(2);
	});

	test("Retry-After ヘッダを尊重して待機する", async () => {
		const { fetchImpl } = createFetchMock((_url, callIndex) => {
			if (callIndex === 0) {
				return makeResponse(
					{},
					{ status: 429, headers: { "retry-after": "2" } },
				);
			}
			return makeResponse([]);
		});

		const { sleepImpl, calls: sleepCalls } = createSleepMock();
		const client = createGithubClient("token", {
			fetchImpl,
			sleepImpl,
			baseDelayMs: 0,
		});
		await client.listOrgRepos("org");

		expect(sleepCalls).toEqual([2000]);
	});

	test("レート制限の待機時間が上限を超える場合は待たずにエラーになる", async () => {
		const { fetchImpl } = createFetchMock(() =>
			makeResponse({}, { status: 429, headers: { "retry-after": "3600" } }),
		);

		const { sleepImpl, calls: sleepCalls } = createSleepMock();
		const client = createGithubClient("token", {
			fetchImpl,
			sleepImpl,
			baseDelayMs: 0,
		});

		await expect(client.listOrgRepos("org")).rejects.toThrow(GithubApiError);
		expect(sleepCalls).toHaveLength(0);
	});

	test("401 はリトライせず 1 回しか fetch されない", async () => {
		const { fetchImpl, calls } = createFetchMock(() =>
			makeResponse({}, { status: 401 }),
		);
		const client = createGithubClient("bad-token", {
			fetchImpl,
			sleepImpl: noopSleep,
			baseDelayMs: 0,
		});

		await expect(client.listOrgRepos("org")).rejects.toThrow(GithubApiError);
		expect(calls).toHaveLength(1);
	});

	test("401 のエラーメッセージにトークンの値を含めない", async () => {
		const secretToken = "super-secret-token-value";
		const { fetchImpl } = createFetchMock(() =>
			makeResponse({}, { status: 401 }),
		);
		const client = createGithubClient(secretToken, {
			fetchImpl,
			sleepImpl: noopSleep,
			baseDelayMs: 0,
		});

		const error = await client
			.listOrgRepos("org")
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(GithubApiError);
		expect((error as GithubApiError).status).toBe(401);
		expect((error as GithubApiError).message).not.toContain(secretToken);
	});

	test("404 はリトライせず即座にエラーになる", async () => {
		const { fetchImpl, calls } = createFetchMock(() =>
			makeResponse({}, { status: 404 }),
		);
		const client = createGithubClient("token", {
			fetchImpl,
			sleepImpl: noopSleep,
			baseDelayMs: 0,
		});

		await expect(client.listOrgRepos("org")).rejects.toThrow(GithubApiError);
		expect(calls).toHaveLength(1);
	});

	test("リトライ上限に達したら最後のエラーを throw する", async () => {
		const { fetchImpl, calls } = createFetchMock(() =>
			makeResponse({}, { status: 500 }),
		);
		const client = createGithubClient("token", {
			fetchImpl,
			sleepImpl: noopSleep,
			baseDelayMs: 0,
			maxRetries: 2,
		});

		await expect(client.listOrgRepos("org")).rejects.toThrow(GithubApiError);
		// 初回 + リトライ 2 回 = 3 回。
		expect(calls).toHaveLength(3);
	});
});
