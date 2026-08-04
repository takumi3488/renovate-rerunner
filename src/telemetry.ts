/**
 * OpenTelemetry の初期化と span 付与のヘルパー。
 *
 * トレース送信はデフォルト無効。OTEL_EXPORTER_OTLP_ENDPOINT（または
 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT）が設定されているときだけ OTLP/HTTP
 * エクスポータを有効化する。未設定の通常実行では SDK を動的 import すらせず、
 * NoopTracer のまま動くためオーバーヘッドはほぼゼロ。
 *
 * span 属性に Cookie・トークン・Authorization ヘッダなどの認証情報は
 * 絶対に含めないこと（logger.ts の redactFields と同じ方針）。
 */

import {
	type Attributes,
	type Span,
	type SpanKind,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";

/** 既定のサービス名。OTEL_SERVICE_NAME で上書きできる。 */
const DEFAULT_SERVICE_NAME = "renovate-rerunner";

export interface Telemetry {
	/** OTLP 送信が有効かどうか。無効時は shutdown() も何もしない。 */
	readonly enabled: boolean;
	readonly serviceName: string;
	/** BatchSpanProcessor のフラッシュを含む終了処理。失敗しても例外は投げない。 */
	shutdown(): Promise<void>;
}

const NOOP_TELEMETRY: Telemetry = {
	enabled: false,
	serviceName: DEFAULT_SERVICE_NAME,
	shutdown: () => Promise.resolve(),
};

/**
 * 環境変数を見てテレメトリを初期化する。
 *
 * @param env テスト容易性のため差し替え可能にしている。省略時は `process.env`。
 */
export async function initTelemetry(
	env: Record<string, string | undefined> = process.env,
): Promise<Telemetry> {
	if (env.OTEL_SDK_DISABLED === "true") {
		return NOOP_TELEMETRY;
	}
	// エンドポイント未設定の環境（手元実行の既定状態）で localhost に勝手に
	// 送信しないよう、明示設定があるときだけ有効化する。
	if (
		!env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() &&
		!env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
	) {
		return NOOP_TELEMETRY;
	}

	const serviceName = env.OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME;

	// 無効時は import 自体を発生させないよう、有効化が決まってから読み込む。
	const [
		{ NodeTracerProvider, BatchSpanProcessor },
		{ OTLPTraceExporter },
		{ defaultResource, detectResources, envDetector, resourceFromAttributes },
		{ ATTR_SERVICE_NAME },
	] = await Promise.all([
		import("@opentelemetry/sdk-trace-node"),
		import("@opentelemetry/exporter-trace-otlp-http"),
		import("@opentelemetry/resources"),
		import("@opentelemetry/semantic-conventions"),
	]);

	// OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_TRACES_ENDPOINT /
	// OTEL_EXPORTER_OTLP_HEADERS の解決はエクスポータ側の標準実装に任せる。
	const exporter = new OTLPTraceExporter();
	const resource = defaultResource()
		.merge(detectResources({ detectors: [envDetector] }))
		.merge(resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }));

	const provider = new NodeTracerProvider({
		resource,
		spanProcessors: [new BatchSpanProcessor(exporter)],
	});
	// AsyncLocalStorage のコンテキストマネージャと W3C プロパゲータを設定する。
	provider.register();

	return {
		enabled: true,
		serviceName,
		shutdown: async () => {
			// 送信失敗で CLI 本体の終了コードを変えないため、ここで例外は握りつぶす。
			try {
				await provider.shutdown();
			} catch {
				// コレクター未到達など。本体の成否には影響させない。
			}
		},
	};
}

/**
 * 処理を span で包んで実行する。
 *
 * SDK が未初期化（NoopTracer）のときは span 生成コストがほぼ無いまま
 * fn をそのまま実行する。fn が例外を投げた場合は recordException と
 * ERROR ステータスを記録してから再 throw する。
 * 例外ではなく戻り値で失敗を表す処理（triggerScan など）は、fn に渡される
 * span へ呼び出し側が自分でステータスを設定する。
 */
export async function withSpan<T>(
	name: string,
	options: {
		readonly attributes?: Attributes;
		/** 外部サービスへの呼び出しは CLIENT。省略時は INTERNAL。 */
		readonly kind?: SpanKind;
	},
	fn: (span: Span) => Promise<T>,
): Promise<T> {
	const tracer = trace.getTracer(DEFAULT_SERVICE_NAME);
	return tracer.startActiveSpan(name, { kind: options.kind }, async (span) => {
		try {
			if (options.attributes) {
				span.setAttributes(options.attributes);
			}
			const result = await fn(span);
			return result;
		} catch (err) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: err instanceof Error ? err.message : String(err),
			});
			if (err instanceof Error) {
				span.recordException(err);
			}
			throw err;
		} finally {
			span.end();
		}
	});
}
