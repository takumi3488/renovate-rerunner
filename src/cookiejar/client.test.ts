import { describe, expect, test } from "bun:test";
import type { Cookie } from "playwright";
import { createLogger } from "../logger";
import { CookiejarError, createCookiejarClient } from "./client";
import type { CookiejarConfig } from "./config";

/** ログを配列に集めるだけのテスト用ロガー。orchestrator.test.ts と同じ流儀。 */
function collectingLogger() {
	const lines: string[] = [];
	const logger = createLogger({
		verbose: true,
		json: true,
		sink: (line) => lines.push(line),
	});
	return { logger, lines };
}

interface RecordedCall {
	readonly url: string;
	readonly init?: RequestInit;
}

/**
 * fetch の呼び出しを記録するモック。github.test.ts の createFetchMock と同じ流儀。
 *
 * Bun の fetch は呼び出しシグネチャに加えて静的メソッド preconnect を持ち、
 * typeof fetch の型としてそれが必須になるためスタブを生やしておく。
 */
function createFetchMock(responder: () => Response | Promise<Response>): {
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
		return responder();
	};
	const fetchImpl = Object.assign(handler, {
		preconnect: () => {},
	});
	return { fetchImpl, calls };
}

function createThrowingFetchMock(error: unknown): typeof fetch {
	const handler = async (): Promise<Response> => {
		throw error;
	};
	return Object.assign(handler, { preconnect: () => {} });
}

const baseConfig: CookiejarConfig = {
	readerBaseUrl: "http://cookiejar-reader.example.internal:50051",
	writerBaseUrl: "https://cookiejar-writer.example.internal",
	hosts: ["developer.mend.io"],
	writeBack: true,
	timeoutMs: 5_000,
};

function oneCookie(overrides: Partial<Cookie> = {}): Cookie {
	return {
		name: "sid",
		value: "abc123",
		domain: "example.com",
		path: "/",
		expires: -1,
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		...overrides,
	};
}

const successResponse = () =>
	new Response(JSON.stringify({ status: "success", count: 1 }), {
		status: 200,
	});

describe("createCookiejarClient / fetchCookies", () => {
	test("単一 host から Cookie を取得できる", async () => {
		const { logger } = collectingLogger();
		const client = createCookiejarClient({
			config: baseConfig,
			logger,
			getCookiesImpl: async (host) => {
				expect(host).toBe("developer.mend.io");
				return "sid=abc123; Path=/; Domain=developer.mend.io; HttpOnly; Secure";
			},
		});

		const cookies = await client.fetchCookies();
		expect(cookies).toHaveLength(1);
		expect(cookies[0]).toMatchObject({
			name: "sid",
			value: "abc123",
			domain: "developer.mend.io",
		});
	});

	test("複数 host の結果が連結され、重複は後勝ちで排除される", async () => {
		const { logger } = collectingLogger();
		const client = createCookiejarClient({
			config: { ...baseConfig, hosts: ["host-a", "host-b"] },
			logger,
			getCookiesImpl: async (host) => {
				if (host === "host-a") {
					return "shared=fromA; Path=/; Domain=example.com; uniqueA=1; Path=/; Domain=example.com";
				}
				if (host === "host-b") {
					return "shared=fromB; Path=/; Domain=example.com; uniqueB=2; Path=/; Domain=example.com";
				}
				return undefined;
			},
		});

		const cookies = await client.fetchCookies();
		expect(cookies).toHaveLength(3);

		// host-b が後に処理されるため、同じ name+domain+path の shared は host-b の値が勝つ。
		const shared = cookies.find((cookie) => cookie.name === "shared");
		expect(shared?.value).toBe("fromB");

		expect(cookies.some((cookie) => cookie.name === "uniqueA")).toBe(true);
		expect(cookies.some((cookie) => cookie.name === "uniqueB")).toBe(true);
	});

	test("ある host が NotFound（undefined）でも他の host の結果が返り、例外を投げない", async () => {
		const { logger } = collectingLogger();
		const client = createCookiejarClient({
			config: {
				...baseConfig,
				hosts: ["missing.example.com", "found.example.com"],
			},
			logger,
			getCookiesImpl: async (host) => {
				if (host === "missing.example.com") return undefined;
				return "sid=abc; Domain=found.example.com";
			},
		});

		const cookies = await client.fetchCookies();
		expect(cookies).toHaveLength(1);
		expect(cookies[0]?.domain).toBe("found.example.com");
	});

	test("全 host が NotFound なら空配列を返す", async () => {
		const { logger } = collectingLogger();
		const client = createCookiejarClient({
			config: { ...baseConfig, hosts: ["a.example.com", "b.example.com"] },
			logger,
			getCookiesImpl: async () => undefined,
		});

		expect(await client.fetchCookies()).toEqual([]);
	});

	test("getCookiesImpl が例外を投げたら CookiejarError になる", async () => {
		const { logger } = collectingLogger();
		const client = createCookiejarClient({
			config: baseConfig,
			logger,
			getCookiesImpl: async () => {
				throw new Error("boom");
			},
		});

		await expect(client.fetchCookies()).rejects.toBeInstanceOf(CookiejarError);
	});

	test("ログに Cookie の値が含まれない", async () => {
		const { logger, lines } = collectingLogger();
		const SECRET_VALUE = "super-secret-cookie-value-xyz";
		const { fetchImpl } = createFetchMock(successResponse);
		const client = createCookiejarClient({
			config: baseConfig,
			logger,
			getCookiesImpl: async () =>
				`sid=${SECRET_VALUE}; Path=/; Domain=developer.mend.io; HttpOnly; Secure`,
			fetchImpl,
		});

		const cookies = await client.fetchCookies();
		await client.writeBack(cookies);

		const combined = lines.join("\n");
		expect(combined).not.toContain(SECRET_VALUE);
	});
});

describe("createCookiejarClient / writeBack", () => {
	test("正しい URL・メソッド・ボディで POST される", async () => {
		const { logger } = collectingLogger();
		const { fetchImpl, calls } = createFetchMock(successResponse);

		const client = createCookiejarClient({
			config: baseConfig,
			logger,
			getCookiesImpl: async () => undefined,
			fetchImpl,
		});

		const ok = await client.writeBack([oneCookie()]);
		expect(ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${baseConfig.writerBaseUrl}/`);
		expect(calls[0]?.init?.method).toBe("POST");

		const body = JSON.parse(String(calls[0]?.init?.body));
		expect(body).toEqual([
			{
				name: "sid",
				value: "abc123",
				path: "/",
				domain: "example.com",
				secure: true,
				httpOnly: true,
				sameSite: "Lax",
			},
		]);
	});

	test("非 200 レスポンスでは false を返し例外を投げない", async () => {
		const { logger } = collectingLogger();
		const { fetchImpl } = createFetchMock(
			() => new Response("internal error", { status: 500 }),
		);

		const client = createCookiejarClient({
			config: baseConfig,
			logger,
			getCookiesImpl: async () => undefined,
			fetchImpl,
		});

		const ok = await client.writeBack([oneCookie()]);
		expect(ok).toBe(false);
	});

	test("fetch が throw しても false を返す", async () => {
		const { logger } = collectingLogger();
		const fetchImpl = createThrowingFetchMock(new Error("network down"));

		const client = createCookiejarClient({
			config: baseConfig,
			logger,
			getCookiesImpl: async () => undefined,
			fetchImpl,
		});

		const ok = await client.writeBack([oneCookie()]);
		expect(ok).toBe(false);
	});

	test("config.writeBack が false のとき fetch は呼ばれない", async () => {
		const { logger } = collectingLogger();
		const { fetchImpl, calls } = createFetchMock(successResponse);

		const client = createCookiejarClient({
			config: { ...baseConfig, writeBack: false },
			logger,
			getCookiesImpl: async () => undefined,
			fetchImpl,
		});

		const ok = await client.writeBack([oneCookie()]);
		expect(ok).toBe(true);
		expect(calls).toHaveLength(0);
	});

	test("変換結果が空配列（domain の無い Cookie のみ）なら送信せず true を返す", async () => {
		const { logger } = collectingLogger();
		const { fetchImpl, calls } = createFetchMock(successResponse);

		const client = createCookiejarClient({
			config: baseConfig,
			logger,
			getCookiesImpl: async () => undefined,
			fetchImpl,
		});

		const ok = await client.writeBack([oneCookie({ domain: "" })]);
		expect(ok).toBe(true);
		expect(calls).toHaveLength(0);
	});
});
