#!/usr/bin/env bun
/**
 * developer.mend.io の内部 API の疎通確認・再調査スクリプト。
 *
 *   bun run observe [--org org-a,org-b]
 *
 * Mend の内部 API の構造が変わった兆候（MendUiError）が出たときに、現在の API が
 * どんなレスポンスを返すのかを確認するための道具。cookiejar-server に保存された
 * セッション Cookie を使ってリポジトリ一覧 API を実際に叩き、ステータスと
 * レスポンスの構造（キー一覧・ステータス値の集合）を表示する。
 *
 * 事前にブラウザで developer.mend.io にログインしておくこと（拡張が自動で保存する）。
 *
 * ■ scan のトリガー（POST /renovate/job/add）は実行しない
 * 実際に Renovate ジョブが走ってしまうため、このスクリプトは GET だけを行う。
 * トリガー時のリクエストを再調査したい場合は、ブラウザの DevTools で
 * developer.mend.io の Network タブを開き、UI 上で「Run Renovate scan」を
 * 1 件だけ実行して通信内容を確認すること。
 */

import { parseOrgList } from "../src/config";
import { createCookiejarClient } from "../src/cookiejar/client";
import { loadCookiejarConfig } from "../src/cookiejar/config";
import { createLogger } from "../src/logger";
import { loadMendConfig } from "../src/mend/config";
import { banner, cookieNames } from "./_shared";

/** レスポンスボディの表示は先頭だけ。巨大な一覧をそのまま出さないため。 */
const BODY_PREVIEW_LIMIT = 2_000;

/** CLI 本体が期待している内部 API の契約。食い違いの発見はこことの比較で行う。 */
const EXPECTED_CONTRACT = `
CLI が期待している内部 API の契約（src/mend/client.ts より）:

  一覧: GET  /api/orgs/github/{org}/repos?page=0&size=50&renovateStatuses=disabled
        レスポンス: { "content": [ { "name": string, "renovateStatus": string } ], "totalElements": number, "totalPages": number }
  scan: POST /api/repos/github/{org}/{repo}/renovate/job/add
        body: {"selectedBranches":[]}
        409 = ジョブが既にキューにある（既にトリガー済み）
  必須ヘッダ: x-app-id: 1、Cookie: mend_session=...

scan のトリガーはこのスクリプトでは実行しません（ジョブが実際に走るため）。
再調査する場合はブラウザの DevTools の Network タブで UI の通信を確認してください。
`;

function preview(text: string): string {
	return text.length > BODY_PREVIEW_LIMIT
		? `${text.slice(0, BODY_PREVIEW_LIMIT)}…[truncated]`
		: text;
}

async function main(): Promise<number> {
	// --org があればそれを、なければ GITHUB_ORGS を使う。CLI 本体と同じ解釈。
	// `--org a,b` と `--org=a,b` の両方を受け付ける。
	const args = process.argv.slice(2);
	const orgFlagIndex = args.indexOf("--org");
	const orgEqArg = args.find((arg) => arg.startsWith("--org="));
	const orgArg =
		orgFlagIndex >= 0
			? args[orgFlagIndex + 1]
			: orgEqArg?.slice("--org=".length);
	const orgs = parseOrgList(orgArg ?? process.env.GITHUB_ORGS ?? "");
	if (orgs.length === 0) {
		console.error(
			"対象 org がありません。--org org-a,org-b を渡すか GITHUB_ORGS を設定してください。",
		);
		return 1;
	}

	const config = loadMendConfig();
	const logger = createLogger({ verbose: false });
	const cookiejar = createCookiejarClient({
		config: loadCookiejarConfig(),
		logger,
	});

	const cookies = await cookiejar.fetchCookies();
	const mendCookies = cookies.filter((c) => c.domain.includes("mend.io"));
	if (mendCookies.length === 0) {
		console.error(
			"cookiejar に Mend の Cookie がありません。ブラウザで developer.mend.io にログインしてください（拡張が自動で保存します）。",
		);
		return 1;
	}
	const cookieHeader = mendCookies
		.map((c) => `${c.name}=${c.value}`)
		.join("; ");

	console.log(banner("Mend 内部 API 疎通確認"));
	console.log(`ベース URL : ${config.baseUrl}`);
	console.log(`対象 org   : ${orgs.join(", ")}`);
	console.log(
		`送信 Cookie: ${cookieNames(cookieHeader).join(", ")}（値は表示しません）`,
	);

	let failures = 0;

	for (const org of orgs) {
		const path = `/api/orgs/github/${encodeURIComponent(org)}/repos?page=0&size=50&renovateStatuses=disabled`;
		const url = `${config.baseUrl}${path}`;
		console.log(banner(`GET ${path}`));

		let response: Response;
		try {
			response = await fetch(url, {
				headers: {
					Cookie: cookieHeader,
					"x-app-id": "1",
					Accept: "application/json",
				},
			});
		} catch (error) {
			console.error(
				`  リクエスト自体が失敗しました: ${error instanceof Error ? error.message : String(error)}`,
			);
			failures++;
			continue;
		}

		console.log(`  ステータス: ${response.status}`);
		const body = await response.text();

		if (!response.ok) {
			console.log(`  ボディ先頭: ${preview(body)}`);
			failures++;
			continue;
		}

		try {
			const data = JSON.parse(body) as Record<string, unknown>;
			console.log(`  トップレベルのキー: ${Object.keys(data).join(", ")}`);
			const content = data.content;
			if (Array.isArray(content)) {
				console.log(`  content の件数: ${content.length}`);
				if (content.length > 0 && typeof content[0] === "object") {
					console.log(
						`  content[0] のキー: ${Object.keys(content[0] as object).join(", ")}`,
					);
				}
				const statuses = new Set<string>();
				for (const item of content) {
					const status = (item as { renovateStatus?: unknown }).renovateStatus;
					statuses.add(typeof status === "string" ? status : String(status));
				}
				console.log(`  renovateStatus の値の集合: ${[...statuses].join(", ")}`);
			} else {
				console.log("  ⚠ content が配列ではありません（構造が変わった可能性）");
				console.log(`  ボディ先頭: ${preview(body)}`);
				// 構造変化の第一のシグナルなので、終了コードにも反映する。
				failures++;
			}
			console.log(
				`  totalElements: ${String(data.totalElements)} / totalPages: ${String(data.totalPages)}`,
			);
		} catch {
			console.log(
				"  ⚠ レスポンスが JSON ではありません（構造が変わった可能性）",
			);
			console.log(`  ボディ先頭: ${preview(body)}`);
			failures++;
		}
	}

	console.log(EXPECTED_CONTRACT);

	if (failures > 0) {
		console.log(`${failures} 件の org で確認に失敗しました。`);
		return 1;
	}
	console.log("全 org で一覧 API の疎通を確認しました。");
	return 0;
}

process.exit(await main());
