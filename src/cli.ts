import { parseArgs } from "node:util";
import { parseOrgList } from "./config";

export interface CliOptions {
	readonly dryRun: boolean;
	/** 指定時は GITHUB_ORGS を上書きする。 */
	readonly orgs?: readonly string[];
	/** scan をトリガーする最大件数（org 横断の合計）。誤爆防止の安全弁。 */
	readonly limit?: number;
	readonly verbose: boolean;
	readonly help: boolean;
}

export class CliError extends Error {
	override readonly name = "CliError";
}

export const HELP_TEXT = `renovate-rerunner - GitHub と Mend の Renovate 有効状態を突き合わせ、
GitHub では生きているのに Mend 側で Renovate が disabled なリポジトリに対して scan をトリガーする CLI。

使い方:
  bun run start [フラグ]

  警告: 引数なしで実行すると、対象 org 全件に対して実際に scan がトリガーされます（dry-run ではありません）。
        挙動を確認したい場合は必ず --dry-run を付けてください。

フラグ:
  --dry-run          実際には scan をトリガーせず、対象になるリポジトリ一覧だけを表示する
  --org <a,b>        GITHUB_ORGS を上書きする（カンマ区切り、前後の空白は無視、重複は除去）
  --limit <n>        scan をトリガーする最大件数（org 横断の合計）。誤爆防止の安全弁。1以上の整数
  --verbose, -v       debug レベルのログも出力する
  --help, -h          このヘルプを表示する

Mend セッションについて:
  Mend の Cookie はこの CLI 自身がログインして取得するのではなく、ブラウザ拡張
  （putting-cookie-in-jar）が cookiejar-server に保存したものを読んで使う。
  セッションが失効した場合は、人間がブラウザで developer.mend.io を開いて
  ログインし直せば拡張が自動で cookiejar-server に保存し直す。
  この CLI 単体ではログインできないので注意すること
  （DISCORD_WEBHOOK_URL を設定していれば失効時に通知が届く）。

環境変数（必須）:
  GITHUB_TOKEN                 GitHub の Personal Access Token
  GITHUB_ORGS                  対象 org（カンマ区切り。--org で上書き可能）

環境変数（cookiejar 連携）:
  COOKIEJAR_READER_ENDPOINT    cookiejar Reader の gRPC エンドポイント
                               既定 http://cookiejar-reader.default.svc.cluster.local:50051
  COOKIEJAR_WRITER_ENDPOINT    cookiejar Writer の HTTP エンドポイント
                               既定 https://cookiejar.onara.boo
  COOKIEJAR_HOSTS              Cookie を読み出す host（カンマ区切り。先頭が Mend の host）
                               既定 developer.mend.io
  COOKIEJAR_WRITE_BACK         更新された Cookie を書き戻すか。既定 true
  COOKIEJAR_TIMEOUT_MS         cookiejar への通信タイムアウト（ミリ秒）。既定 10000

環境変数（Discord 通知）:
  DISCORD_WEBHOOK_URL          任意。Mend のログインが必要になったときなどの通知先
                               未設定なら通知は送らない（ログのみ）

環境変数（Mend 側の調整用）:
  MEND_BASE_URL                既定 https://developer.mend.io（EU リージョンなどで変更）
  MEND_TRIGGER_INTERVAL_MS     scan トリガー間に挟む待機時間（ミリ秒）。既定 1000、0 で無効
                               Mend 側のレート制限・過負荷を避けるためのもの

環境変数（ログ）:
  LOG_FORMAT                   json を指定すると常に JSON Lines で出力する
                               （既定は非 TTY のとき自動で JSON になる）

環境変数（OpenTelemetry）:
  OTEL_EXPORTER_OTLP_ENDPOINT  設定するとトレースを OTLP/HTTP で送信する
                               （例: http://otel-collector:4318）。未設定なら計測は無効
  OTEL_SERVICE_NAME            service.name。既定 renovate-rerunner
  OTEL_SDK_DISABLED            true を指定するとエンドポイント設定時も計測を無効化
                               このほか OTEL_EXPORTER_OTLP_TRACES_ENDPOINT /
                               OTEL_EXPORTER_OTLP_HEADERS / OTEL_RESOURCE_ATTRIBUTES
                               などの標準変数も SDK の既定通りに解釈する

終了コード:
  0  正常終了（検出 0 件 / 全件成功 / dry-run）
  1  一部の scan トリガーが失敗した
  2  検出はしたが全件のトリガーに失敗した
  3  継続不能な致命的エラー（設定不備・GitHub 認証エラー・Mend セッション確立不能）
`;

/** --limit の値が1以上の整数表記かどうかを判定する正規表現。符号・小数点・空文字を弾く。 */
const INTEGER_PATTERN = /^\d+$/;

/**
 * CLI フラグを解析する。
 *
 * @param argv フラグのみの配列（`process.argv.slice(2)` を呼び出し側で渡す）。
 */
export function parseCliArgs(argv: readonly string[]): CliOptions {
	const { values } = safeParseArgs(argv);

	let orgs: readonly string[] | undefined;
	if (values.org !== undefined) {
		const parsed = parseOrgList(values.org);
		if (parsed.length === 0) {
			throw new CliError(
				"--org には最低1件の org を指定してください（例: --org org-a,org-b）。",
			);
		}
		orgs = parsed;
	}

	const limit =
		values.limit !== undefined ? parseLimit(values.limit) : undefined;

	return {
		dryRun: values["dry-run"],
		orgs,
		limit,
		verbose: values.verbose,
		help: values.help,
	};
}

/**
 * node:util の parseArgs を呼び出す。未知のフラグや位置引数を渡すと Node 独自の
 * TypeError（ERR_PARSE_ARGS_*）が飛んでくるが、利用者に生の Node エラーを見せず
 * CliError に包み直す。
 */
function safeParseArgs(argv: readonly string[]) {
	try {
		return parseArgs({
			args: argv as string[],
			options: {
				"dry-run": { type: "boolean", default: false },
				org: { type: "string" },
				limit: { type: "string" },
				verbose: { type: "boolean", short: "v", default: false },
				help: { type: "boolean", short: "h", default: false },
			},
			strict: true,
			allowPositionals: false,
		});
	} catch (err) {
		throw new CliError(`引数の解析に失敗しました: ${toMessage(err)}`);
	}
}

function parseLimit(raw: string): number {
	const trimmed = raw.trim();
	if (!INTEGER_PATTERN.test(trimmed)) {
		throw new CliError(
			`--limit には1以上の整数を指定してください（受け取った値: "${raw}"）。`,
		);
	}
	const n = Number(trimmed);
	if (n <= 0) {
		throw new CliError(
			`--limit には1以上の整数を指定してください（受け取った値: "${raw}"）。`,
		);
	}
	return n;
}

function toMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
