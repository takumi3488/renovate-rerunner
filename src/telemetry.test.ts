import { describe, expect, test } from "bun:test";
import { initTelemetry, withSpan } from "./telemetry";

describe("initTelemetry", () => {
	test("エンドポイント未設定なら無効のまま", async () => {
		const telemetry = await initTelemetry({});
		expect(telemetry.enabled).toBe(false);
		expect(telemetry.serviceName).toBe("renovate-rerunner");
		await telemetry.shutdown();
	});

	test("OTEL_SDK_DISABLED=true ならエンドポイントが設定されていても無効", async () => {
		const telemetry = await initTelemetry({
			OTEL_SDK_DISABLED: "true",
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
		});
		expect(telemetry.enabled).toBe(false);
	});

	test("OTEL_EXPORTER_OTLP_ENDPOINT 設定時は有効化され、OTEL_SERVICE_NAME でサービス名を上書きできる", async () => {
		const telemetry = await initTelemetry({
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
			OTEL_SERVICE_NAME: "rerunner-test",
		});
		expect(telemetry.enabled).toBe(true);
		expect(telemetry.serviceName).toBe("rerunner-test");
		// コレクター不在でも shutdown は例外を投げないこと
		await telemetry.shutdown();
	});

	test("OTEL_SERVICE_NAME 未設定なら既定のサービス名になる", async () => {
		const telemetry = await initTelemetry({
			OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4318/v1/traces",
		});
		expect(telemetry.enabled).toBe(true);
		expect(telemetry.serviceName).toBe("renovate-rerunner");
		await telemetry.shutdown();
	});
});

describe("withSpan", () => {
	test("fn の戻り値をそのまま返す", async () => {
		const result = await withSpan("test.span", {}, async () => 42);
		expect(result).toBe(42);
	});

	test("fn が投げた例外をそのまま再 throw する", async () => {
		await expect(
			withSpan("test.span", {}, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});

	test("fn に span が渡され、属性を設定できる", async () => {
		await withSpan(
			"test.span",
			{ attributes: { "test.key": "value" } },
			async (span) => {
				expect(span).toBeDefined();
				span.setAttribute("test.another", 1);
			},
		);
	});
});
