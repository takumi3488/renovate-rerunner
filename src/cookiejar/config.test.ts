import { describe, expect, test } from "bun:test";
import { loadCookiejarConfig } from "./config";

describe("loadCookiejarConfig", () => {
	test("環境変数が空でも既定値で動く", () => {
		const config = loadCookiejarConfig({});
		expect(config.readerBaseUrl).toBe(
			"http://cookiejar-reader.default.svc.cluster.local:50051",
		);
		expect(config.writerBaseUrl).toBe("https://cookiejar.onara.boo");
		expect(config.hosts).toEqual(["developer.mend.io"]);
		expect(config.writeBack).toBe(true);
		expect(config.timeoutMs).toBe(10_000);
	});

	test("readerBaseUrl / writerBaseUrl を上書きできる", () => {
		const config = loadCookiejarConfig({
			COOKIEJAR_READER_ENDPOINT: "http://reader.internal:50051",
			COOKIEJAR_WRITER_ENDPOINT: "https://writer.internal",
		});
		expect(config.readerBaseUrl).toBe("http://reader.internal:50051");
		expect(config.writerBaseUrl).toBe("https://writer.internal");
	});

	test("readerBaseUrl / writerBaseUrl の末尾スラッシュを取り除く", () => {
		const config = loadCookiejarConfig({
			COOKIEJAR_READER_ENDPOINT: "http://reader.internal:50051///",
			COOKIEJAR_WRITER_ENDPOINT: "https://writer.internal/",
		});
		expect(config.readerBaseUrl).toBe("http://reader.internal:50051");
		expect(config.writerBaseUrl).toBe("https://writer.internal");
	});

	test("COOKIEJAR_HOSTS をカンマ区切りで正規化し、順序を保持する", () => {
		const config = loadCookiejarConfig({
			COOKIEJAR_HOSTS: " developer.mend.io , github.com ,developer.mend.io",
		});
		// 先頭が Mend の host という前提を壊さないよう、重複除去後も入力順を維持する。
		expect(config.hosts).toEqual(["developer.mend.io", "github.com"]);
	});

	test("COOKIEJAR_HOSTS が空要素だけなら既定値にフォールバックする", () => {
		const config = loadCookiejarConfig({ COOKIEJAR_HOSTS: " , , " });
		expect(config.hosts).toEqual(["developer.mend.io"]);
	});

	test("COOKIEJAR_HOSTS が未設定なら既定値になる", () => {
		expect(loadCookiejarConfig({}).hosts).toEqual(["developer.mend.io"]);
	});

	test.each([
		["false", false],
		["0", false],
		["no", false],
		["true", true],
		["1", true],
		["yes", true],
		["", true],
		["なにか変な値", true],
	])("COOKIEJAR_WRITE_BACK=%s を %s と解釈する", (value, expected) => {
		expect(loadCookiejarConfig({ COOKIEJAR_WRITE_BACK: value }).writeBack).toBe(
			expected,
		);
	});

	test("timeoutMs を上書きできる", () => {
		expect(
			loadCookiejarConfig({ COOKIEJAR_TIMEOUT_MS: "5000" }).timeoutMs,
		).toBe(5000);
	});

	test("不正な timeoutMs は既定値にフォールバックする", () => {
		const fallback = loadCookiejarConfig({}).timeoutMs;
		expect(loadCookiejarConfig({ COOKIEJAR_TIMEOUT_MS: "abc" }).timeoutMs).toBe(
			fallback,
		);
		expect(loadCookiejarConfig({ COOKIEJAR_TIMEOUT_MS: "0" }).timeoutMs).toBe(
			fallback,
		);
		expect(loadCookiejarConfig({ COOKIEJAR_TIMEOUT_MS: "-1" }).timeoutMs).toBe(
			fallback,
		);
	});
});
