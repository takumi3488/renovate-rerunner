#!/usr/bin/env bun
/**
 * developer.mend.io の内部 API を観測するための使い捨てスクリプト。
 *
 *   bun run observe
 *
 * Mend は「リポジトリ一覧の取得」「Run Renovate scan」に相当する公開 API を提供しておらず
 * （公開 API は GitHub Secrets 管理専用）、UI が叩いている内部 API のパスも公開されていない。
 * そのため実物の通信を一度観測して確定させる必要がある。
 *
 * Cookie は本体（src/mend）と同じく cookiejar-server から取得する。ブラウザ拡張が
 * developer.mend.io にログインした際に自動保存したものが読めるはずなので、事前に
 * ブラウザで一度ログインしておくこと。
 *
 * ■ 誤爆防止（重要）
 * このスクリプトは意図的に page.click / locator.click を一切呼ばない。
 * scan のトリガーは実際に Renovate ジョブを起動してしまうため、必ず人間がブラウザ上で
 * 「1 リポジトリだけ」クリックすること。可能なら影響の小さいリポジトリを選ぶこと。
 */

import { chromium } from "playwright";
import type { Request, Response } from "playwright";
import { createCookiejarClient } from "../src/cookiejar/client";
import { loadCookiejarConfig } from "../src/cookiejar/config";
import { createLogger } from "../src/logger";
import { partitionCookiesForInjection } from "../src/mend/auth";
import { loadMendConfig } from "../src/mend/config";
import {
	banner,
	cookieNames,
	ensureParentDir,
	maskHeaders,
	waitForEnter,
} from "./_shared";

const HAR_PATH = "./.mend/observe.har";
const RECORDS_PATH = "./.mend/observed-api.json";
/** レスポンスボディをそのまま保存すると巨大になるので先頭のみ残す。 */
const BODY_PREVIEW_LIMIT = 20_000;

interface ObservedCall {
	readonly phase: string;
	readonly method: string;
	readonly url: string;
	readonly status: number;
	readonly resourceType: string;
	readonly requestHeaders: Record<string, string>;
	readonly cookieNames: string[];
	readonly requestBody: string | null;
	readonly responseContentType: string | undefined;
	readonly responseBody: string | null;
}

/** 内部 API の候補か判定する。HTML/画像/CSS などは除外し XHR と fetch だけを見る。 */
function isApiCandidate(request: Request): boolean {
	const type = request.resourceType();
	if (type !== "xhr" && type !== "fetch") return false;
	return request.url().includes("mend.io");
}

async function main(): Promise<void> {
	const config = loadMendConfig();
	const logger = createLogger({ verbose: true });
	const cookiejar = createCookiejarClient({
		config: loadCookiejarConfig(),
		logger,
	});

	const cookies = await cookiejar.fetchCookies();
	if (cookies.length === 0) {
		console.error(
			"cookiejar に Mend の Cookie がありません。ブラウザで developer.mend.io にログインしてください（拡張が自動で保存します）。",
		);
		process.exit(1);
	}

	const { addable, skipped } = partitionCookiesForInjection(cookies);
	if (skipped.length > 0) {
		console.warn(
			`domain が空の Cookie を ${skipped.length} 件スキップしました: ${skipped
				.map((cookie) => cookie.name)
				.join(", ")}`,
		);
	}

	await ensureParentDir(HAR_PATH);

	console.log(banner("Mend 内部 API 観測"));
	console.log(`ベース URL : ${config.baseUrl}`);
	console.log(`HAR        : ${HAR_PATH}`);
	console.log(`記録        : ${RECORDS_PATH}`);

	const browser = await chromium.launch({ headless: false });
	const context = await browser.newContext({
		viewport: null,
		// content: "embed" を指定しないとレスポンスボディが別ファイル参照になり単一ファイルで完結しない。
		recordHar: { path: HAR_PATH, mode: "full", content: "embed" },
	});
	await context.addCookies(addable);

	const records: ObservedCall[] = [];
	/** いまどの操作を観測中かのラベル。あとから一覧取得と scan トリガーを切り分けるために使う。 */
	let phase = "startup";

	// page 単位ではなく context 単位で購読する。Mend UI が popup や新規タブを開いても取りこぼさない。
	context.on("response", async (response: Response) => {
		const request = response.request();
		if (!isApiCandidate(request)) return;

		let body: string | null = null;
		try {
			const text = await response.text();
			body =
				text.length > BODY_PREVIEW_LIMIT
					? `${text.slice(0, BODY_PREVIEW_LIMIT)}…[truncated]`
					: text;
		} catch {
			// リダイレクトなどボディを取得できないレスポンスがある。観測の失敗で全体を止めない。
			body = null;
		}

		const headers = await request.allHeaders();
		records.push({
			phase,
			method: request.method(),
			url: response.url(),
			status: response.status(),
			resourceType: request.resourceType(),
			requestHeaders: maskHeaders(headers),
			cookieNames: cookieNames(headers.cookie),
			requestBody: request.postData(),
			responseContentType: response.headers()["content-type"],
			responseBody: body,
		});

		console.log(
			`  [${phase}] ${request.method()} ${response.status()} ${response.url()}`,
		);
	});

	try {
		const page = await context.newPage();
		page.setDefaultNavigationTimeout(config.navigationTimeoutMs);

		phase = "load-dashboard";
		await page.goto(config.baseUrl);

		console.log(`
--------------------------------------------------------------------
【手順 1/2】リポジトリ一覧を表示してください

  ブラウザで、Renovate の enabled/disabled 列が見えるリポジトリ一覧
  ページまで移動してください。ページングがある場合は 2 ページ目も
  開いてください（ページネーション方式を確定させるため）。

  ※ ログイン画面が出た場合は cookiejar の Cookie が失効しています。
     Ctrl-C で中断し、ブラウザで developer.mend.io にログインし直して
     から（拡張が保存し直します）やり直してください。
--------------------------------------------------------------------`);
		await waitForEnter("一覧を表示し終えたら Enter");

		phase = "trigger-scan";
		console.log(`
--------------------------------------------------------------------
【手順 2/2】Run Renovate scan を「1 件だけ」実行してください

  ⚠ ここでクリックしたリポジトリでは実際に Renovate ジョブが走ります。
     必ず 1 リポジトリだけにしてください。
--------------------------------------------------------------------`);
		await waitForEnter("クリックし終えたら Enter");

		phase = "done";
	} finally {
		// HAR は context.close() で初めてディスクに書き出される。ここを飛ばすと観測結果が消える。
		await context.close();
		await browser.close();
	}

	await Bun.write(RECORDS_PATH, JSON.stringify(records, null, "\t"));

	console.log(banner("観測結果"));
	const byPhase = new Map<string, ObservedCall[]>();
	for (const record of records) {
		const list = byPhase.get(record.phase) ?? [];
		list.push(record);
		byPhase.set(record.phase, list);
	}
	for (const [phaseName, calls] of byPhase) {
		console.log(`\n[${phaseName}] ${calls.length} 件`);
		for (const call of calls) {
			console.log(`  ${call.method} ${call.status} ${call.url}`);
		}
	}

	console.log(`
確定させるべき項目（${RECORDS_PATH} と ${HAR_PATH} を読んで埋めること）:

  [ ] リポジトリ一覧のパス・メソッド・クエリパラメータ
  [ ] ページネーション方式（page 番号 / カーソル / 全件一括 / 無限スクロール）
  [ ] Renovate の有効無効を表すフィールド名と、取りうる値の集合
      （SCA / SAST のフィールドと混同しないこと）
  [ ] scan トリガーのメソッド・パス・リクエストボディ
  [ ] 必要なヘッダー（CSRF トークン・mend-appId など Cookie 以外に要るもの）
  [ ] 複数 org の扱い（1 回で横断して見えるか、org 切り替えが要るか）
`);
}

await main();
