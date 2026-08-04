import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
	InMemorySpanExporter,
	NodeTracerProvider,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type { CookiejarClient } from "../cookiejar/client";
import { createLogger } from "../logger";
import type { Cookie } from "./types";
import { createMendClient, parseRenovateStatus } from "./client";
import { MendApiError, MendAuthError, MendUiError } from "./types";

describe("parseRenovateStatus", () => {
	test.each([
		"disabled",
		"Disabled",
		"  DISABLED  ",
		"inactive",
		"Not Activated",
	])("%s を disabled と判定する", (raw) => {
		expect(parseRenovateStatus(raw)).toEqual({ kind: "disabled" });
	});

	test.each(["enabled", "Activated", "onboarded", "Onboarding", "active"])(
		"%s を enabled と判定する",
		(raw) => {
			expect(parseRenovateStatus(raw)).toEqual({ kind: "enabled" });
		},
	);

	test("onboarding は enabled 扱いにする", () => {
		// オンボーディング中は Renovate が既に動いているので scan を撃つ対象ではない。
		expect(parseRenovateStatus("Onboarding").kind).toBe("enabled");
	});

	test("知らない文字列は unknown として raw を残す", () => {
		expect(parseRenovateStatus("  Resource Limit  ")).toEqual({
			kind: "unknown",
			raw: "Resource Limit",
		});
	});

	test("空文字も unknown として扱う", () => {
		expect(parseRenovateStatus("   ")).toEqual({ kind: "unknown", raw: "" });
	});
});

/** HTTP まわりのテスト用の足場。fetch は差し替え、span はインメモリに集める。 */
describe("createMendClient", () => {
	const MEND_COOKIE: Cookie = {
		name: "mend_session",
		value: "secret",
		domain: ".developer.mend.io",
		path: "/",
		expires: 0,
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
	};

	const originalFetch = globalThis.fetch;
	let fetchCalls: { url: string; init?: RequestInit }[];
	let fetchImpl: () => Promise<Response>;
	let exporter: InMemorySpanExporter;

	const cookiejar: CookiejarClient = {
		fetchCookies: () => Promise.resolve([MEND_COOKIE]),
		writeBack: () => Promise.resolve(true),
	};
	const emptyCookiejar: CookiejarClient = {
		fetchCookies: () => Promise.resolve([]),
		writeBack: () => Promise.resolve(true),
	};
	const logger = createLogger({ verbose: false, json: true, sink: () => {} });

	async function makeClient(jar: CookiejarClient = cookiejar) {
		return createMendClient({
			logger,
			cookiejar: jar,
			config: { baseUrl: "https://developer.mend.io", triggerIntervalMs: 0 },
		});
	}

	function spansNamed(name: string) {
		return exporter.getFinishedSpans().filter((span) => span.name === name);
	}

	beforeEach(() => {
		fetchCalls = [];
		fetchImpl = () =>
			Promise.resolve(
				Response.json({ content: [], totalElements: 0, totalPages: 1 }),
			);
		globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
			fetchCalls.push({ url: String(url), init });
			return fetchImpl();
		}) as typeof fetch;

		exporter = new InMemorySpanExporter();
		const provider = new NodeTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		provider.register();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		// グローバル provider をリセットし、他のテストファイルへ影響させない。
		trace.disable();
	});

	describe("triggerScan", () => {
		test("200 なら ok: true。必須のリクエスト契約（パス・ヘッダ・ボディ）を守って送信する", async () => {
			fetchImpl = () => Promise.resolve(new Response("", { status: 200 }));
			const client = await makeClient();

			const result = await client.triggerScan("org-a", "repo-a");

			expect(result).toEqual({ ok: true });
			expect(fetchCalls[0]?.url).toBe(
				"https://developer.mend.io/api/repos/github/org-a/repo-a/renovate/job/add",
			);
			expect(fetchCalls[0]?.init?.method).toBe("POST");
			// x-app-id が無いと 401 になる必須ヘッダ。Cookie・Content-Type・ボディも契約どおりか。
			expect(fetchCalls[0]?.init?.headers).toMatchObject({
				"x-app-id": "1",
				Cookie: "mend_session=secret",
				"Content-Type": "application/json",
			});
			expect(fetchCalls[0]?.init?.body).toBe(
				JSON.stringify({ selectedBranches: [] }),
			);
		});

		test("mend.io 以外の Cookie は送信しない（buildCookieHeader のドメインフィルタ）", async () => {
			const mixedJar: CookiejarClient = {
				fetchCookies: () =>
					Promise.resolve([
						MEND_COOKIE,
						{ ...MEND_COOKIE, name: "_gh_sess", domain: ".github.com" },
					]),
				writeBack: () => Promise.resolve(true),
			};
			fetchImpl = () => Promise.resolve(new Response("", { status: 200 }));
			const client = await makeClient(mixedJar);

			await client.triggerScan("org-a", "repo-a");

			const headers = fetchCalls[0]?.init?.headers as Record<string, string>;
			expect(headers.Cookie).toBe("mend_session=secret");
			expect(headers.Cookie).not.toContain("_gh_sess");
		});

		test("200 でも content-type が text/html ならログインリダイレクトとみなして MendAuthError を投げる", async () => {
			fetchImpl = () =>
				Promise.resolve(
					new Response("<html>login</html>", {
						status: 200,
						headers: { "content-type": "text/html; charset=utf-8" },
					}),
				);
			const client = await makeClient();

			await expect(
				client.triggerScan("org-a", "repo-a"),
			).rejects.toBeInstanceOf(MendAuthError);
		});

		test("409 は「既にキュー済み」として ok: true + alreadyQueued で返し、span を ERROR にしない", async () => {
			fetchImpl = () =>
				Promise.resolve(new Response("job already exists", { status: 409 }));
			const client = await makeClient();

			const result = await client.triggerScan("org-a", "repo-a");

			expect(result).toEqual({ ok: true, alreadyQueued: true });
			const spans = spansNamed("mend.trigger_scan");
			expect(spans.length).toBe(1);
			expect(spans[0]?.status.code).not.toBe(SpanStatusCode.ERROR);
			expect(spans[0]?.attributes["rerunner.trigger.already_queued"]).toBe(
				true,
			);
		});

		test("500 は ok: false で処理継続し、reason にボディを含め、span を ERROR にしない", async () => {
			fetchImpl = () =>
				Promise.resolve(
					new Response('{"error":"cannot add job"}', { status: 500 }),
				);
			const client = await makeClient();

			const result = await client.triggerScan("org-a", "mycca");

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toContain("500");
				expect(result.reason).toContain("cannot add job");
			}
			const spans = spansNamed("mend.trigger_scan");
			expect(spans.length).toBe(1);
			expect(spans[0]?.status.code).not.toBe(SpanStatusCode.ERROR);
			expect(spans[0]?.attributes["rerunner.trigger.ok"]).toBe(false);
			// span 属性の reason には未検証のボディを載せない（status + path のみ）
			expect(spans[0]?.attributes["rerunner.trigger.reason"]).toBe(
				"Mend API が 500 を返しました: /api/repos/github/org-a/mycca/renovate/job/add",
			);
		});

		test("エラーボディの秘密値らしきキーの値は伏字にする（key=value / JSON 両形式）", async () => {
			fetchImpl = () =>
				Promise.resolve(
					new Response(
						'{"error":"failed","mend_session":"topsecret"} echo: mend_session=hunter2; other=1',
						{ status: 500 },
					),
				);
			const client = await makeClient();

			const result = await client.triggerScan("org-a", "repo-a");

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).not.toContain("topsecret");
				expect(result.reason).not.toContain("hunter2");
				expect(result.reason).toContain("[REDACTED]");
				// 秘密値でない部分は診断のために残る
				expect(result.reason).toContain("failed");
				expect(result.reason).toContain("other=1");
			}
		});

		test("エラーボディは 500 文字に切り詰め、改行は 1 スペースに畳む", async () => {
			fetchImpl = () =>
				Promise.resolve(
					new Response(`line1\nline2   ${"x".repeat(600)}`, { status: 500 }),
				);
			const client = await makeClient();

			const result = await client.triggerScan("org-a", "repo-a");

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toContain("line1 line2");
				expect(result.reason).not.toContain("\n");
				// prefix + 500 文字 + … まで。600 文字分は入らない
				expect(result.reason.endsWith("…")).toBe(true);
				expect(result.reason.length).toBeLessThan(600);
			}
		});

		test("403 も MendAuthError を投げる（セッション失効）", async () => {
			fetchImpl = () => Promise.resolve(new Response("", { status: 403 }));
			const client = await makeClient();

			await expect(
				client.triggerScan("org-a", "repo-a"),
			).rejects.toBeInstanceOf(MendAuthError);
		});

		test("401 は MendAuthError を投げ（fatal）、span は ERROR になる", async () => {
			fetchImpl = () => Promise.resolve(new Response("", { status: 401 }));
			const client = await makeClient();

			await expect(
				client.triggerScan("org-a", "repo-a"),
			).rejects.toBeInstanceOf(MendAuthError);
			const spans = spansNamed("mend.trigger_scan");
			expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
		});

		test("ネットワークエラーは ok: false で処理継続し、span を ERROR にしない", async () => {
			fetchImpl = () => Promise.reject(new Error("socket hang up"));
			const client = await makeClient();

			const result = await client.triggerScan("org-a", "repo-a");

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toContain("socket hang up");
			}
			const spans = spansNamed("mend.trigger_scan");
			// length を先に確定させないと spans[0] が undefined でも not.toBe が通ってしまう
			expect(spans.length).toBe(1);
			expect(spans[0]?.status.code).not.toBe(SpanStatusCode.ERROR);
		});

		test("cookiejar に Cookie が無ければ fetch せず MendAuthError を投げる", async () => {
			const client = await makeClient(emptyCookiejar);

			await expect(
				client.triggerScan("org-a", "repo-a"),
			).rejects.toBeInstanceOf(MendAuthError);
			expect(fetchCalls.length).toBe(0);
		});
	});

	describe("listRepos", () => {
		test("ページをまたいで全件返す。各ページを正しいクエリで要求する", async () => {
			let call = 0;
			globalThis.fetch = (async (url: unknown) => {
				fetchCalls.push({ url: String(url) });
				call++;
				if (call === 1) {
					return Response.json({
						content: [{ name: "repo-a", renovateStatus: "disabled" }],
						totalElements: 2,
						totalPages: 2,
					});
				}
				return Response.json({
					content: [{ name: "repo-b", renovateStatus: "disabled" }],
					totalElements: 2,
					totalPages: 2,
				});
			}) as typeof fetch;
			const client = await makeClient();

			const repos = await client.listRepos("org-a");

			expect(repos.map((repo) => repo.name)).toEqual(["repo-a", "repo-b"]);
			expect(fetchCalls.length).toBe(2);
			expect(fetchCalls[0]?.url).toContain("page=0");
			expect(fetchCalls[1]?.url).toContain("page=1");
			expect(fetchCalls[0]?.url).toContain("size=50");
			expect(fetchCalls[0]?.url).toContain("renovateStatuses=disabled");
		});

		test("401 は MendApiError ではなく MendAuthError を投げる（fatal 扱いにするため）", async () => {
			fetchImpl = () => Promise.resolve(new Response("", { status: 401 }));
			const client = await makeClient();

			await expect(client.listRepos("org-a")).rejects.toBeInstanceOf(
				MendAuthError,
			);
		});

		test("500 は MendApiError を投げ、メッセージと bodyPreview にボディの先頭を保持する", async () => {
			fetchImpl = () =>
				Promise.resolve(new Response("internal server error", { status: 500 }));
			const client = await makeClient();

			const error = await client.listRepos("org-a").catch((e: unknown) => e);
			expect(error).toBeInstanceOf(MendApiError);
			expect((error as MendApiError).status).toBe(500);
			expect((error as MendApiError).bodyPreview).toBe("internal server error");
			// 呼び出し側は message しかログに出さないので、message にも含まれている必要がある
			expect((error as MendApiError).message).toContain(
				"internal server error",
			);
		});

		test("200 でもエンベロープのキーが無ければ MendUiError（構造変更）", async () => {
			fetchImpl = () => Promise.resolve(Response.json({}));
			const client = await makeClient();

			await expect(client.listRepos("org-a")).rejects.toBeInstanceOf(
				MendUiError,
			);
		});

		test("200 でも content が配列でなければ MendUiError（構造変更）", async () => {
			fetchImpl = () =>
				Promise.resolve(
					Response.json({ content: "unexpected", totalElements: 1 }),
				);
			const client = await makeClient();

			await expect(client.listRepos("org-a")).rejects.toBeInstanceOf(
				MendUiError,
			);
		});

		test("200 で JSON が null でも生の TypeError ではなく MendUiError になる", async () => {
			fetchImpl = () => Promise.resolve(new Response("null", { status: 200 }));
			const client = await makeClient();

			await expect(client.listRepos("org-a")).rejects.toBeInstanceOf(
				MendUiError,
			);
		});

		test("content: null は空ページの揺れとして許容する（totalElements があれば MendUiError にしない）", async () => {
			fetchImpl = () =>
				Promise.resolve(Response.json({ content: null, totalElements: 0 }));
			const client = await makeClient();

			const repos = await client.listRepos("org-a");

			expect(repos).toEqual([]);
		});

		test("totalPages が無くても totalElements からページ数を導出する", async () => {
			let call = 0;
			globalThis.fetch = (async (url: unknown) => {
				fetchCalls.push({ url: String(url) });
				call++;
				if (call === 1) {
					return Response.json({
						content: [{ name: "repo-a", renovateStatus: "disabled" }],
						// 51 件あれば 50 件/ページで 2 ページと導出できる
						totalElements: 51,
					});
				}
				return Response.json({
					content: [{ name: "repo-b", renovateStatus: "disabled" }],
					totalElements: 51,
				});
			}) as typeof fetch;
			const client = await makeClient();

			const repos = await client.listRepos("org-a");

			expect(repos.map((repo) => repo.name)).toEqual(["repo-a", "repo-b"]);
			expect(fetchCalls[1]?.url).toContain("page=1");
		});

		test("200 でも JSON でなければ MendUiError（構造変更）。メッセージにボディ先頭を含む", async () => {
			fetchImpl = () =>
				Promise.resolve(new Response("<html>error</html>", { status: 200 }));
			const client = await makeClient();

			const error = await client.listRepos("org-a").catch((e: unknown) => e);
			expect(error).toBeInstanceOf(MendUiError);
			expect((error as MendUiError).message).toContain("<html>error</html>");
		});
	});
});
