import { describe, expect, test } from "bun:test";
import { parseCookieString, toWriterCookies } from "./cookie-string";

// 実地検証で cookiejar-reader から実際に取得した文字列（Go の http.Cookie.String() を "; " で連結したもの）。
const REAL_WORLD_RAW =
	"mend_session=testvalue123; Path=/; Domain=developer.mend.io; HttpOnly; Secure; SameSite=Lax; other=xyz; Path=/; Domain=developer.mend.io";

describe("parseCookieString", () => {
	test("実地検証で得た連結文字列を2つの Cookie に正しく分解する", () => {
		const cookies = parseCookieString(REAL_WORLD_RAW, "developer.mend.io");
		expect(cookies).toHaveLength(2);

		const mendSession = cookies[0];
		expect(mendSession).toMatchObject({
			name: "mend_session",
			value: "testvalue123",
			domain: "developer.mend.io",
			path: "/",
			httpOnly: true,
			secure: true,
			sameSite: "Lax",
		});

		const other = cookies[1];
		expect(other).toMatchObject({
			name: "other",
			value: "xyz",
			domain: "developer.mend.io",
			path: "/",
			httpOnly: false,
			secure: false,
		});
	});

	test("単一 Cookie で属性が無い", () => {
		const cookies = parseCookieString("foo=bar", "example.com");
		expect(cookies).toEqual([
			{
				name: "foo",
				value: "bar",
				domain: "example.com",
				path: "/",
				expires: -1,
				httpOnly: false,
				secure: false,
				sameSite: "Lax",
			},
		]);
	});

	test("値に = を含む Cookie は最初の = だけで分割する", () => {
		const cookies = parseCookieString("token=abc==", "example.com");
		expect(cookies[0]?.name).toBe("token");
		expect(cookies[0]?.value).toBe("abc==");
	});

	test("Max-Age=3600 は expires を now+3600 にする", () => {
		const before = Math.floor(Date.now() / 1000);
		const cookies = parseCookieString("foo=bar; Max-Age=3600", "example.com");
		const after = Math.floor(Date.now() / 1000);

		const expires = cookies[0]?.expires ?? 0;
		expect(expires).toBeGreaterThanOrEqual(before + 3600);
		expect(expires).toBeLessThanOrEqual(after + 3600);
	});

	test("Expires に RFC1123 日付を指定すると epoch 秒にパースされる", () => {
		const cookies = parseCookieString(
			"foo=bar; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
			"example.com",
		);
		expect(cookies[0]?.expires).toBe(
			Math.floor(Date.parse("Wed, 21 Oct 2026 07:28:00 GMT") / 1000),
		);
	});

	test("属性が無いときの既定値", () => {
		const cookies = parseCookieString("foo=bar", "fallback.example.com");
		expect(cookies[0]).toMatchObject({
			expires: -1,
			path: "/",
			domain: "fallback.example.com",
			httpOnly: false,
			secure: false,
		});
	});

	test("SameSite=none のような小文字表記を先頭大文字に正規化する", () => {
		const cookies = parseCookieString("foo=bar; SameSite=none", "example.com");
		expect(cookies[0]?.sameSite).toBe("None");
	});

	test("SameSite=strict も先頭大文字に正規化する", () => {
		const cookies = parseCookieString(
			"foo=bar; SameSite=strict",
			"example.com",
		);
		expect(cookies[0]?.sameSite).toBe("Strict");
	});

	test("未知の SameSite 値は Lax にフォールバックする", () => {
		const cookies = parseCookieString(
			"foo=bar; SameSite=Unknown",
			"example.com",
		);
		expect(cookies[0]?.sameSite).toBe("Lax");
	});

	test.each(["", "   ", ";", "  ;  "])(
		"入力が %j なら例外を投げず空配列を返す",
		(raw) => {
			expect(parseCookieString(raw, "example.com")).toEqual([]);
		},
	);

	test("domain 属性が無ければ fallbackDomain を使う", () => {
		const cookies = parseCookieString(
			"foo=bar; Path=/x",
			"fallback.example.com",
		);
		expect(cookies[0]?.domain).toBe("fallback.example.com");
	});

	test("domain 属性があればそちらを優先する", () => {
		const cookies = parseCookieString(
			"foo=bar; Domain=explicit.example.com",
			"fallback.example.com",
		);
		expect(cookies[0]?.domain).toBe("explicit.example.com");
	});

	test("ラウンドトリップ: parseCookieString -> toWriterCookies で name/value/domain/path が保たれる", () => {
		const cookies = parseCookieString(REAL_WORLD_RAW, "developer.mend.io");
		const writerCookies = toWriterCookies(cookies);

		expect(writerCookies).toHaveLength(2);
		expect(writerCookies[0]).toMatchObject({
			name: "mend_session",
			value: "testvalue123",
			domain: "developer.mend.io",
			path: "/",
		});
		expect(writerCookies[1]).toMatchObject({
			name: "other",
			value: "xyz",
			domain: "developer.mend.io",
			path: "/",
		});
	});
});

describe("toWriterCookies", () => {
	function makeCookie(
		overrides: Partial<Parameters<typeof toWriterCookies>[0][number]> = {},
	) {
		return {
			name: "foo",
			value: "bar",
			domain: "example.com",
			path: "/",
			expires: -1,
			httpOnly: false,
			secure: false,
			sameSite: "Lax" as const,
			...overrides,
		};
	}

	test("セッション Cookie（expires <= 0）では maxAge を省略する", () => {
		const result = toWriterCookies([makeCookie({ expires: -1 })]);
		expect(result[0]).not.toHaveProperty("maxAge");
	});

	test("expires が 0 のときも maxAge を省略する", () => {
		const result = toWriterCookies([makeCookie({ expires: 0 })]);
		expect(result[0]).not.toHaveProperty("maxAge");
	});

	test("期限付き Cookie では正しい maxAge を出す", () => {
		const now = 1_000_000;
		const result = toWriterCookies([makeCookie({ expires: now + 120 })], now);
		expect(result[0]?.maxAge).toBe(120);
	});

	test("期限が過去でも maxAge は 0 未満にならない", () => {
		const now = 1_000_000;
		const result = toWriterCookies([makeCookie({ expires: now - 120 })], now);
		expect(result[0]?.maxAge).toBe(0);
	});

	test("domain が空の Cookie はスキップする", () => {
		const result = toWriterCookies([makeCookie({ domain: "" })]);
		expect(result).toEqual([]);
	});

	test("sameSite はそのまま渡す", () => {
		const result = toWriterCookies([makeCookie({ sameSite: "Strict" })]);
		expect(result[0]?.sameSite).toBe("Strict");
	});

	test("nowEpochSec を省略すると現在時刻が使われる", () => {
		const before = Math.floor(Date.now() / 1000);
		const result = toWriterCookies([makeCookie({ expires: before + 60 })]);
		const after = Math.floor(Date.now() / 1000);

		const maxAge = result[0]?.maxAge ?? -1;
		expect(maxAge).toBeGreaterThanOrEqual(before + 60 - after);
		expect(maxAge).toBeLessThanOrEqual(after + 60 - before);
	});
});
