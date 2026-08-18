import { describe, expect, test } from "bun:test";
import { GithubApiError, listAliveRepoNames } from "../src/github/client.js";

const NO_SLEEP = () => Promise.resolve();

function jsonResponse(body, { status = 200, headers = {} } = {}) {
	return new Response(JSON.stringify(body), { status, headers });
}

function stubFetch(handler) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url: String(url), init });
		return handler(String(url), init);
	};
	return { calls, fetchImpl };
}

const BASE = { org: "my-org", token: "t", sleep: NO_SLEEP };

describe("listAliveRepoNames", () => {
	test("type: Organization → /orgs/{org}/repos を叩く", async () => {
		const { calls, fetchImpl } = stubFetch((url) => {
			if (url === "https://api.github.com/users/my-org") {
				return jsonResponse({ type: "Organization" });
			}
			return jsonResponse([{ name: "repo-a" }]);
		});
		const repos = await listAliveRepoNames({ ...BASE, fetchImpl });

		expect(calls[1].url).toBe(
			"https://api.github.com/orgs/my-org/repos?per_page=100&type=all",
		);
		expect(calls[1].init.headers.Authorization).toBe("Bearer t");
		expect(repos).toEqual(["repo-a"]);
	});

	test("type: User → /users/{org}/repos を叩く", async () => {
		const { calls, fetchImpl } = stubFetch((url) => {
			if (url === "https://api.github.com/users/my-org") {
				return jsonResponse({ type: "User" });
			}
			return jsonResponse([{ name: "repo-a" }]);
		});
		const repos = await listAliveRepoNames({ ...BASE, fetchImpl });

		expect(calls[1].url).toBe(
			"https://api.github.com/users/my-org/repos?per_page=100&type=all",
		);
		expect(repos).toEqual(["repo-a"]);
	});

	test("Link の rel=next を辿って 2 ページ結合", async () => {
		const nextUrl = "https://api.github.com/orgs/my-org/repos?page=2";
		const { calls, fetchImpl } = stubFetch((url) => {
			if (url === "https://api.github.com/users/my-org") {
				return jsonResponse({ type: "Organization" });
			}
			if (url === nextUrl) {
				return jsonResponse([{ name: "repo-2" }]);
			}
			return jsonResponse([{ name: "repo-1" }], {
				headers: { link: `<${nextUrl}>; rel="next"` },
			});
		});
		const repos = await listAliveRepoNames({ ...BASE, fetchImpl });

		expect(calls).toHaveLength(3);
		expect(calls[2].url).toBe(nextUrl);
		expect(repos).toEqual(["repo-1", "repo-2"]);
	});

	test("archived / disabled / fork は除外される", async () => {
		const { fetchImpl } = stubFetch((url) => {
			if (url === "https://api.github.com/users/my-org") {
				return jsonResponse({ type: "Organization" });
			}
			return jsonResponse([
				{ name: "alive" },
				{ name: "archived", archived: true },
				{ name: "disabled", disabled: true },
				{ name: "forked", fork: true },
			]);
		});
		const repos = await listAliveRepoNames({ ...BASE, fetchImpl });
		expect(repos).toEqual(["alive"]);
	});

	test("excludeForks: false では fork が残る", async () => {
		const { fetchImpl } = stubFetch((url) => {
			if (url === "https://api.github.com/users/my-org") {
				return jsonResponse({ type: "Organization" });
			}
			return jsonResponse([{ name: "forked", fork: true }]);
		});
		const repos = await listAliveRepoNames({
			...BASE,
			excludeForks: false,
			fetchImpl,
		});
		expect(repos).toEqual(["forked"]);
	});

	test("401 で GithubApiError", async () => {
		const { fetchImpl } = stubFetch(() => jsonResponse({}, { status: 401 }));
		await expect(
			listAliveRepoNames({ ...BASE, fetchImpl }),
		).rejects.toBeInstanceOf(GithubApiError);
	});

	test("name が無い要素は GithubApiError", async () => {
		const { fetchImpl } = stubFetch((url) => {
			if (url === "https://api.github.com/users/my-org") {
				return jsonResponse({ type: "Organization" });
			}
			return jsonResponse([{ full_name: "my-org/no-name" }]);
		});
		await expect(
			listAliveRepoNames({ ...BASE, fetchImpl }),
		).rejects.toBeInstanceOf(GithubApiError);
	});
});
