/**
 * エントリポイント。ロジックは持たず、各モジュールの配線に徹する。
 * 制御フロー本体は orchestrator.ts の run() に集約されている。
 */

import type { Span } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
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
import { initTelemetry, type Telemetry, withSpan } from "./telemetry";

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

async function main(rootSpan: Span, telemetry: Telemetry): Promise<number> {
	let options: CliOptions;
	try {
		options = parseCliArgs(process.argv.slice(2));
	} catch (err) {
		if (err instanceof CliError) {
			console.error(err.message);
			console.error(HELP_TEXT);
			rootSpan.setAttribute("rerunner.exit_code", EXIT_CODES.fatal);
			return EXIT_CODES.fatal;
		}
		throw err;
	}

	if (options.help) {
		console.log(HELP_TEXT);
		return EXIT_CODES.success;
	}

	rootSpan.setAttribute("rerunner.dry_run", options.dryRun);
	if (options.limit !== undefined) {
		rootSpan.setAttribute("rerunner.limit", options.limit);
	}

	const logger = createLogger({ verbose: options.verbose });
	if (telemetry.enabled) {
		logger.debug("OpenTelemetry のトレース送信が有効です", {
			serviceName: telemetry.serviceName,
		});
	}

	// 後続のどの失敗でも通知できるよう、設定読み込みより前に notifier を作る。
	const notifier = createNotifier({ webhookUrl: loadWebhookUrl(), logger });

	// 通知の fields に含めるため catch 節でも参照できるよう、try の外で宣言しておく。
	let orgs: readonly string[] = [];

	try {
		const config = loadConfig();
		// --org が指定されていれば GITHUB_ORGS より優先する
		orgs = options.orgs ?? config.orgs;
		rootSpan.setAttribute("rerunner.orgs", [...orgs]);

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
		rootSpan.setAttributes({
			"rerunner.target_count": summary.targetCount,
			"rerunner.triggered_count": summary.triggeredCount,
			"rerunner.failed_count": summary.failedCount,
			"rerunner.skipped_by_limit": summary.skippedByLimit,
			"rerunner.org_error_count": summary.orgErrors.length,
		});

		const exitCode = decideExitCode(summary.results, options.dryRun);
		// org がまるごと処理できなかった場合、trigger が全成功していても成功扱いにはしない
		const finalExitCode =
			summary.orgErrors.length > 0 && exitCode === EXIT_CODES.success
				? EXIT_CODES.partialFailure
				: exitCode;
		rootSpan.setAttribute("rerunner.exit_code", finalExitCode);
		if (finalExitCode !== EXIT_CODES.success) {
			// CronJob の異常をトレース側から拾えるよう、非ゼロ終了は ERROR ステータスにする。
			rootSpan.setStatus({
				code: SpanStatusCode.ERROR,
				message: `exit code: ${finalExitCode}`,
			});
		}
		// summary.orgErrors や failedCount が示す個別 org・リポジトリ単位の失敗は Discord に
		// 通知しない。CronJob は 6 時間おきに動く前提であり、個別の scan 失敗まで通知すると
		// ノイズになるため、ログと終了コードで表現すれば十分と判断した。通知は致命的エラー
		// （下の catch 節）でのみ行う。
		return finalExitCode;
	} catch (err) {
		const { code, message, hint } = describeFatalError(err);
		rootSpan.setAttribute("rerunner.exit_code", code);
		rootSpan.setStatus({ code: SpanStatusCode.ERROR, message });
		if (err instanceof Error) {
			rootSpan.recordException(err);
		}
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

const telemetry = await initTelemetry();
// main は自分で全例外を catch して終了コードを返す設計だが、万が一投げた場合に
// 未初期化のまま process.exit へ進まないよう fatal で初期化しておく。
let exitCode: number = EXIT_CODES.fatal;
try {
	// ルート span。org 処理・各 API 呼び出しの span はすべてこの子孫になる。
	exitCode = await withSpan("renovate-rerunner.run", {}, (span) =>
		main(span, telemetry),
	);
} finally {
	// BatchSpanProcessor のキューに残った span を flush してから終了する。
	// process.exit を先に呼ぶと finally が実行されないため、順序が重要。
	await telemetry.shutdown();
}
process.exit(exitCode);
