/**
 * developer.mend.io のセッション確立。
 *
 * Mend のセッション Cookie は別途運用しているブラウザ拡張（putting-cookie-in-jar）が
 * 自動で cookiejar-server に保存する。renovate-rerunner はそれを読んで使うだけで、
 * GitHub のパスワードや TOTP を保持して自動ログインすることはしない
 * （Cookie が失効していたら人間に Discord で通知してログインしてもらう運用のため）。
 *
 * cookiejar-server は Cookie の有効期限を保存しない（サーバー側で MaxAge を保存前に
 * 破棄するため）。したがって取得した Cookie は必ずセッション Cookie（expires: -1）になり、
 * 期限による失効判定はできない。失効しているかどうかは実際に Mend を開いてログイン画面に
 * リダイレクトされるかどうかでのみ判定する。
 */

import type { Browser, BrowserContext, Cookie, Page } from "playwright";
import { chromium } from "playwright";
import type { CookiejarClient } from "../cookiejar/client";
import type { Logger } from "../logger";
import type { MendConfig } from "./config";
import { MendAuthError } from "./types";

export interface MendSession extends AsyncDisposable {
	readonly context: BrowserContext;
	/** 認証済みのページを返す（使い回し）。 */
	page(): Promise<Page>;
	/**
	 * 現在の Cookie を cookiejar に書き戻す。
	 * 取得時から変化が無ければ何もせず true を返す。失敗しても例外を投げず false を返す。
	 */
	persistCookies(): Promise<boolean>;
}

export interface OpenSessionOptions {
	readonly config: MendConfig;
	readonly cookiejar: CookiejarClient;
	readonly logger: Logger;
}

export interface CookiePartition {
	/** `context.addCookies` にそのまま渡せる Cookie。 */
	readonly addable: readonly Cookie[];
	/** `domain` が空で `addCookies` に渡せない Cookie。 */
	readonly skipped: readonly Cookie[];
}

/**
 * cookiejar から取得した Cookie を、`context.addCookies` に渡せるものと渡せないものに選り分ける。
 *
 * `addCookies` は `domain`+`path` か `url` のどちらかを要求する。`parseCookieString` は
 * 必ず `domain` と `path` を埋めるので通常は問題ないが、万一 `domain` が空の Cookie が
 * 紛れていた場合にその 1 件だけ弾けるようにするための純粋関数（ブラウザを起動せずテストできる）。
 */
export function partitionCookiesForInjection(
	cookies: readonly Cookie[],
): CookiePartition {
	const addable: Cookie[] = [];
	const skipped: Cookie[] = [];
	for (const cookie of cookies) {
		if (cookie.domain.trim() === "") {
			skipped.push(cookie);
			continue;
		}
		addable.push(cookie);
	}
	return { addable, skipped };
}

/**
 * 2 つの Cookie 配列に実質的な変化があるかを判定する（`persistCookies` の差分判定に使う）。
 *
 * name と value の組の集合で比較するため、順序の違いは変化として扱わない。
 * ブラウザを起動せずテストできる純粋関数として切り出してある。
 */
export function haveCookiesChanged(
	before: readonly Cookie[],
	after: readonly Cookie[],
): boolean {
	const toKey = (cookie: Cookie): string => `${cookie.name}\t${cookie.value}`;
	const beforeKeys = new Set(before.map(toKey));
	const afterKeys = new Set(after.map(toKey));
	if (beforeKeys.size !== afterKeys.size) return true;
	for (const key of beforeKeys) {
		if (!afterKeys.has(key)) return true;
	}
	return false;
}

function isOnMend(url: string, config: MendConfig): boolean {
	return url.startsWith(config.baseUrl);
}

/** 失効時に人間へ提示する案内文。Discord 通知にそのまま使われるので次にすべきことが分かる文言にする。 */
const LOGIN_GUIDANCE =
	"ブラウザで https://developer.mend.io を開いてログインしてください（拡張が自動で保存します）。";

/**
 * 認証済みのブラウザコンテキストを開く。
 *
 * 呼び出し側は `await using` で受けること。例外時もブラウザが確実に閉じる。
 */
export async function openMendSession({
	config,
	cookiejar,
	logger,
}: OpenSessionOptions): Promise<MendSession> {
	// CookiejarError（接続不能など）はそのまま伝播させる。呼び出し側が致命的エラーとして扱う。
	const cookies = await cookiejar.fetchCookies();
	if (cookies.length === 0) {
		throw new MendAuthError(
			`cookiejar に Mend の Cookie がありません。${LOGIN_GUIDANCE}`,
		);
	}

	const { addable, skipped } = partitionCookiesForInjection(cookies);
	if (skipped.length > 0) {
		// 1 件のせいで全体を落とさない。domain が空の Cookie だけを弾いて続行する。
		logger.warn("domain が空の Cookie をスキップしました", {
			count: skipped.length,
			names: skipped.map((cookie) => cookie.name),
		});
	}

	const browser: Browser = await chromium.launch({
		headless: config.headless,
		// headless のときは Chromium Headless Shell を使う。フル Chromium より 640MB 小さいので、
		// CronJob として毎回 pull されるコンテナイメージのサイズに直接効く（Dockerfile では
		// headless shell だけを残してフル Chromium を削除している）。
		// headful は UI をデバッグするときだけなのでフル Chromium を使う。
		...(config.headless ? { channel: "chromium-headless-shell" } : {}),
		// コンテナ内では user namespace が使えず Chromium の setuid sandbox が機能しないため無効化する。
		// 訪問先が developer.mend.io に固定された内部ツールなので許容できるトレードオフ。
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});

	let context: BrowserContext | undefined;
	try {
		context = await browser.newContext();
		await context.addCookies(addable);
		// 値は絶対に出さない。件数と name だけがログ上の判断材料になる。
		logger.debug("cookiejar から取得した Cookie を注入した", {
			count: addable.length,
			names: addable.map((cookie) => cookie.name),
		});

		context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
		context.setDefaultTimeout(config.actionTimeoutMs);

		const page = await context.newPage();
		await page.goto(config.baseUrl, { waitUntil: "domcontentloaded" });

		if (!isOnMend(page.url(), config)) {
			throw new MendAuthError(
				`Mend のセッションが失効しています（ログイン画面にリダイレクトされました）。${LOGIN_GUIDANCE}`,
			);
		}

		const activeContext = context;
		const activePage = page;

		return {
			context: activeContext,
			async page() {
				return activePage;
			},
			async persistCookies(): Promise<boolean> {
				const current = await activeContext.cookies([config.baseUrl]);
				if (!haveCookiesChanged(addable, current)) {
					logger.debug("Cookie に変化が無いため書き戻しをスキップした", {});
					return true;
				}
				return cookiejar.writeBack(current);
			},
			// dispose では persistCookies を呼ばない。例外で終了した場合に壊れた状態の Cookie を
			// cookiejar に書き戻したくないため。書き戻しは呼び出し側が正常系で明示的に呼ぶこと。
			async [Symbol.asyncDispose]() {
				await activeContext.close();
				await browser.close();
			},
		};
	} catch (error) {
		await context?.close();
		await browser.close();
		throw error;
	}
}
