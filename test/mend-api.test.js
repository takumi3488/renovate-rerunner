import { describe, expect, test } from "bun:test";
import { createMendApi, MendApiError, MendAuthError } from "../src/mend/api.js";

const ORIGIN = "https://developer.mend.io";

function jsonResponse(body, { status = 200, headers = {} } = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/** 呼び出しを記録する fetchImpl スタブを作る。handler は (url, init) => Response。 */
function stubFetch(handler) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url: String(url), init });
		return handler(String(url), init);
	};
	return { calls, fetchImpl };
}

describe("listDisabledRepos", () => {
	test("last: true で 1 ページで終わる", async () => {
		const { calls, fetchImpl } = stubFetch(() =>
			jsonResponse({
				content: [{ name: "repo-a", renovateStatus: "disabled" }],
				last: true,
			}),
		);
		const api = createMendApi({ origin: ORIGIN, fetchImpl });
		const { repos, unknownStatuses } = await api.listDisabledRepos({
			platform: "github",
			org: "my-org",
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(
			`${ORIGIN}/api/orgs/github/my-org/repos?page=0&size=50&renovateStatuses=disabled`,
		);
		expect(calls[0].init.headers["x-app-id"]).toBe("1");
		expect(calls[0].init.credentials).toBe("include");
		expect(repos).toEqual([{ name: "repo-a", status: "disabled" }]);
		expect(unknownStatuses).toEqual([]);
	});

	test("totalPages: 3 で 3 ページ舐める", async () => {
		const { calls, fetchImpl } = stubFetch((url) => {
			const page = Number(new URL(url).searchParams.get("page"));
			return jsonResponse({
				content: [{ name: `repo-${page}`, renovateStatus: "disabled" }],
				totalPages: 3,
			});
		});
		const api = createMendApi({ origin: ORIGIN, fetchImpl });
		const { repos } = await api.listDisabledRepos({
			platform: "github",
			org: "my-org",
		});

		expect(calls).toHaveLength(3);
		expect(repos.map((r) => r.name)).toEqual(["repo-0", "repo-1", "repo-2"]);
	});

	test("activated は repos に入らず、paused は unknownStatuses に入る", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse({
				content: [
					{ name: "off", renovateStatus: "disabled" },
					{ name: "on", renovateStatus: "activated" },
					{ name: "mystery", renovateStatus: "paused" },
				],
				last: true,
			}),
		);
		const api = createMendApi({ origin: ORIGIN, fetchImpl });
		const { repos, unknownStatuses } = await api.listDisabledRepos({
			platform: "github",
			org: "my-org",
		});

		expect(repos.map((r) => r.name)).toEqual(["off"]);
		expect(unknownStatuses).toEqual([{ name: "mystery", raw: "paused" }]);
	});

	test("構造が想定外なら MendApiError", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse(["not", "an", "object"]),
		);
		const api = createMendApi({ origin: ORIGIN, fetchImpl });
		await expect(
			api.listDisabledRepos({ platform: "github", org: "my-org" }),
		).rejects.toBeInstanceOf(MendApiError);
	});
});

describe("triggerScan", () => {
	const target = { platform: "github", org: "my-org", repo: "my-repo" };

	test("200 → ok、POST 先と body とヘッダが正しい", async () => {
		const { calls, fetchImpl } = stubFetch(() => jsonResponse({}));
		const api = createMendApi({ origin: ORIGIN, fetchImpl });
		const result = await api.triggerScan(target);

		expect(result).toEqual({ ok: true });
		expect(calls[0].url).toBe(
			`${ORIGIN}/api/repos/github/my-org/my-repo/renovate/job/add`,
		);
		expect(calls[0].init.method).toBe("POST");
		expect(calls[0].init.body).toBe('{"selectedBranches":[]}');
		expect(calls[0].init.headers["x-app-id"]).toBe("1");
	});

	test("409 → alreadyQueued として成功", async () => {
		const { fetchImpl } = stubFetch(() => jsonResponse({}, { status: 409 }));
		const api = createMendApi({ origin: ORIGIN, fetchImpl });
		expect(await api.triggerScan(target)).toEqual({
			ok: true,
			alreadyQueued: true,
		});
	});

	test("500 → ok:false", async () => {
		const { fetchImpl } = stubFetch(() => jsonResponse({}, { status: 500 }));
		const api = createMendApi({ origin: ORIGIN, fetchImpl });
		const result = await api.triggerScan(target);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("500");
	});

	test("500 + no-package-files → スキップ扱い", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse({ data: { error: "no-package-files" } }, { status: 500 }),
		);
		const api = createMendApi({ origin: ORIGIN, fetchImpl });
		expect(await api.triggerScan(target)).toEqual({
			ok: true,
			skipped: true,
		});
	});

	test("401 → MendAuthError を throw", async () => {
		const { fetchImpl } = stubFetch(() => jsonResponse({}, { status: 401 }));
		const api = createMendApi({ origin: ORIGIN, fetchImpl });
		await expect(api.triggerScan(target)).rejects.toBeInstanceOf(MendAuthError);
	});

	test("200 + text/html → MendAuthError を throw", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response("<html>login</html>", {
					status: 200,
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		);
		const api = createMendApi({ origin: ORIGIN, fetchImpl });
		await expect(api.triggerScan(target)).rejects.toBeInstanceOf(MendAuthError);
	});
});

describe("listOrgs", () => {
	test("配列レスポンスを読める", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse([
				{ platform: "github", slug: "my-org", displayName: "My Org" },
			]),
		);
		const api = createMendApi({ origin: ORIGIN, fetchImpl });
		expect(await api.listOrgs()).toEqual([
			{ platform: "github", slug: "my-org", label: "My Org" },
		]);
	});

	test("{content:[...]} でも読める", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse({
				content: [{ platform: "github", slug: "my-org", name: "my-org-name" }],
			}),
		);
		const api = createMendApi({ origin: ORIGIN, fetchImpl });
		expect(await api.listOrgs()).toEqual([
			{ platform: "github", slug: "my-org", label: "my-org-name" },
		]);
	});

	test("platform !== github は落とす", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse([
				{ platform: "github", slug: "gh-org" },
				{ platform: "gitlab", slug: "gl-org" },
				{ platform: "bitbucket", slug: "bb-org" },
			]),
		);
		const api = createMendApi({ origin: ORIGIN, fetchImpl });
		const orgs = await api.listOrgs();
		expect(orgs).toEqual([
			{ platform: "github", slug: "gh-org", label: "gh-org" },
		]);
	});

	test("想定外構造で MendApiError", async () => {
		const { fetchImpl } = stubFetch(() => jsonResponse({ orgs: [] }));
		const api = createMendApi({ origin: ORIGIN, fetchImpl });
		await expect(api.listOrgs()).rejects.toBeInstanceOf(MendApiError);
	});
});
