/**
 * エントリポイント。ロジックは持たず、各モジュールの配線に徹する。
 * 制御フロー本体は orchestrator.ts の run() に集約されている。
 */

import type { CliOptions } from "./cli";
import { CliError, HELP_TEXT, parseCliArgs } from "./cli";
import { loadConfig } from "./config";
import { createCookiejarClient } from "./cookiejar/client";
import { loadCookiejarConfig } from "./cookiejar/config";
import { decideExitCode, describeFatalError, EXIT_CODES } from "./errors";
import { createGithubClient } from "./github";
import { createLogger } from "./logger";
import { createMendClient } from "./mend/client";
import type { Notifier } from "./notify/discord";
import { createNotifier, loadWebhookUrl } from "./notify/discord";
import { run } from "./orchestrator";

/**
 * エラーの name プロパティを取り出す。
 *
 * errors.ts の describeFatalError と同じ方針で、instanceof ではなく name の文字列比較で
 * エラー種別を判別する（モジュール間の import 循環や Bun のバンドル境界をまたぐと
 * instanceof が期待通りに働かないケースがあるため）。
 */
function errorName(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null || !("name" in err))
		return undefined;
	const name = (err as { name?: unknown }).name;
	return typeof name === "string" ? name : undefined;
}

/**
 * 致命的エラーを Discord に通知する。
 *
 * - MendAuthError（cookiejar に Cookie が無い／セッション失効）はこの仕組みの中心的な
 *   ユースケースなので login-required として通知し、人間にログインを促す。
 * - CookiejarError（cookiejar-server に到達できない等）・MendUiError・その他の想定外の
 *   例外は error として通知する。
 * - ConfigError / CliError は人間が手元実行したときの設定不備・引数ミスであり、
 *   Discord に流してもノイズになるだけなので通知しない（ログにのみ残す）。
 */
async function notifyFatalError(
	notifier: Notifier,
	err: unknown,
	message: string,
	hint: string | undefined,
	fields: Record<string, string>,
): Promise<void> {
	const name = errorName(err);
	if (name === "ConfigError" || name === "CliError") return;

	if (name === "MendAuthError") {
		await notifier.notify({
			kind: "login-required",
			title: "Mend のログインが必要です",
			message,
			hint,
			fields,
		});
		return;
	}

	await notifier.notify({
		kind: "error",
		title: "renovate-rerunner が異常終了しました",
		message,
		hint,
		fields,
	});
}

async function main(): Promise<number> {
	let options: CliOptions;
	try {
		options = parseCliArgs(process.argv.slice(2));
	} catch (err) {
		if (err instanceof CliError) {
			console.error(err.message);
			console.error(HELP_TEXT);
			return EXIT_CODES.fatal;
		}
		throw err;
	}

	if (options.help) {
		console.log(HELP_TEXT);
		return EXIT_CODES.success;
	}

	const logger = createLogger({ verbose: options.verbose });

	// 後続のどの失敗でも通知できるよう、設定読み込みより前に notifier を作る。
	const notifier = createNotifier({ webhookUrl: loadWebhookUrl(), logger });

	// 通知の fields に含めるため catch 節でも参照できるよう、try の外で宣言しておく。
	let orgs: readonly string[] = [];

	try {
		const config = loadConfig();
		// --org が指定されていれば GITHUB_ORGS より優先する
		orgs = options.orgs ?? config.orgs;

		const githubClient = createGithubClient(config.githubToken);
		const cookiejarClient = createCookiejarClient({
			config: loadCookiejarConfig(),
			logger,
		});
		// AsyncDisposable なので、この後の処理で例外が飛んでもブラウザは必ず閉じる
		await using mendClient = await createMendClient({
			logger,
			cookiejar: cookiejarClient,
		});

		const summary = await run({
			orgs,
			githubClient,
			mendClient,
			logger,
			dryRun: options.dryRun,
			limit: options.limit,
		});

		// Mend を操作した結果セッション Cookie が更新されている可能性があるため書き戻す。
		// 書き戻しの失敗は本処理（scan のトリガー）の成否とは無関係なので、終了コードには
		// 反映せず warn ログのみに留める。
		const persisted = await mendClient.persistCookies();
		if (!persisted) {
			logger.warn("Mend セッション Cookie の書き戻しに失敗しました");
		}

		const exitCode = decideExitCode(summary.results, options.dryRun);
		// org がまるごと処理できなかった場合、trigger が全成功していても成功扱いにはしない
		if (summary.orgErrors.length > 0 && exitCode === EXIT_CODES.success) {
			return EXIT_CODES.partialFailure;
		}
		// summary.orgErrors や failedCount が示す個別 org・リポジトリ単位の失敗は Discord に
		// 通知しない。CronJob は 6 時間おきに動く前提であり、個別の scan 失敗まで通知すると
		// ノイズになるため、ログと終了コードで表現すれば十分と判断した。通知は致命的エラー
		// （下の catch 節）でのみ行う。
		return exitCode;
	} catch (err) {
		const { code, message, hint } = describeFatalError(err);
		logger.error(message);
		if (hint) {
			logger.error(hint);
		}
		// notify は例外を投げず boolean を返す契約なので、通知の成否で終了コードは変えない。
		await notifyFatalError(notifier, err, message, hint, {
			orgs: orgs.join(","),
			dryRun: String(options.dryRun),
		});
		return code;
	}
}

process.exit(await main());
