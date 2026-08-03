/**
 * 観測・認証スクリプト共通のヘルパー。
 * CLI 本体（src/）からは import しない。
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** 値をログに出してはいけないヘッダー名（小文字で比較）。 */
const SENSITIVE_HEADERS = new Set([
	"cookie",
	"set-cookie",
	"authorization",
	"proxy-authorization",
	"x-csrf-token",
	"x-xsrf-token",
]);

/**
 * ヘッダーをログ出力用にマスクする。
 *
 * 観測スクリプトはリクエストヘッダーを丸ごと出力するため、これを通さないと
 * mend_session Cookie がそのままターミナルとログファイルに残ってしまう。
 * ただし「そのヘッダーが存在したか」「値の長さ」は内部 API を再現するうえで重要な情報なので、
 * 完全に消さずプレースホルダに置き換える。
 */
export function maskHeaders(
	headers: Record<string, string>,
): Record<string, string> {
	const masked: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		masked[key] = SENSITIVE_HEADERS.has(key.toLowerCase())
			? `[REDACTED len=${value.length}]`
			: value;
	}
	return masked;
}

/** Cookie ヘッダーから値を伏せたままキー名だけを取り出す。どの Cookie が必要かの判断材料になる。 */
export function cookieNames(cookieHeader: string | undefined): string[] {
	if (!cookieHeader) return [];
	return cookieHeader
		.split(";")
		.map((part) => part.split("=")[0]?.trim() ?? "")
		.filter((name) => name.length > 0);
}

/** ターミナルで Enter が押されるまで待つ。 */
export async function waitForEnter(message: string): Promise<void> {
	process.stdout.write(`\n${message}\n> `);
	for await (const _line of console) {
		break;
	}
}

/** ファイルパスの親ディレクトリを作る。 */
export async function ensureParentDir(filePath: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
}

/** 人間向けの区切り見出し。 */
export function banner(title: string): string {
	return `\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`;
}
