/**
 * cookiejar-server 連携モジュール専用の設定。
 *
 * src/mend/config.ts と同様、この機能の環境変数（COOKIEJAR_*）はここでだけ読む。
 * CLI 全体の設定（src/config.ts）や Mend 側の設定に変更を波及させないための切り分け。
 */
export interface CookiejarConfig {
	/** Reader の gRPC エンドポイント。例: http://cookiejar-reader.default.svc.cluster.local:50051 */
	readonly readerBaseUrl: string;
	/** Writer の HTTP エンドポイント。例: https://cookiejar.onara.boo */
	readonly writerBaseUrl: string;
	/** Cookie を読み出す host のリスト。先頭が Mend の host（書き戻し対象）。 */
	readonly hosts: readonly string[];
	/** 書き戻しを行うか。既定 true。 */
	readonly writeBack: boolean;
	readonly timeoutMs: number;
}

const DEFAULT_READER_ENDPOINT =
	"http://cookiejar-reader.default.svc.cluster.local:50051";
const DEFAULT_WRITER_ENDPOINT = "https://cookiejar.onara.boo";
const DEFAULT_HOSTS: readonly string[] = ["developer.mend.io"];
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * `1/true/yes` / `0/false/no` を真偽値にパースする。
 *
 * src/mend/config.ts の同名関数と同じ書き方に揃えている（export されていないため
 * import はできず、このファイル用にコピーしたもの）。
 */
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value.trim() === "") return fallback;
	const normalized = value.trim().toLowerCase();
	if (normalized === "1" || normalized === "true" || normalized === "yes")
		return true;
	if (normalized === "0" || normalized === "false" || normalized === "no")
		return false;
	return fallback;
}

/** src/mend/config.ts の parsePositiveInt と同じ書き方に揃えたコピー。 */
function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
	return parsed;
}

/**
 * カンマ区切りの host リストを正規化する。
 *
 * 先頭が Mend の host（書き戻し対象）という呼び出し側の前提を壊さないよう、
 * 重複除去やフィルタリングをしても順序は維持する。
 */
function parseHosts(value: string | undefined): string[] {
	if (value === undefined) return [];
	const seen = new Set<string>();
	const hosts: string[] = [];
	for (const rawHost of value.split(",")) {
		const host = rawHost.trim();
		if (host === "") continue;
		if (seen.has(host)) continue;
		seen.add(host);
		hosts.push(host);
	}
	return hosts;
}

export function loadCookiejarConfig(
	env: Record<string, string | undefined> = process.env,
): CookiejarConfig {
	const hosts = parseHosts(env.COOKIEJAR_HOSTS);

	return {
		readerBaseUrl: (
			env.COOKIEJAR_READER_ENDPOINT?.trim() || DEFAULT_READER_ENDPOINT
		).replace(/\/+$/, ""),
		writerBaseUrl: (
			env.COOKIEJAR_WRITER_ENDPOINT?.trim() || DEFAULT_WRITER_ENDPOINT
		).replace(/\/+$/, ""),
		// 1件も残らなければ既定の developer.mend.io 1件にフォールバックする（エラーにはしない）。
		hosts: hosts.length > 0 ? hosts : DEFAULT_HOSTS,
		writeBack: parseBoolean(env.COOKIEJAR_WRITE_BACK, true),
		timeoutMs: parsePositiveInt(env.COOKIEJAR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
	};
}
