/**
 * 観測スクリプト共通のヘルパー。
 * CLI 本体（src/）からは import しない。
 */

/** Cookie ヘッダーから値を伏せたままキー名だけを取り出す。どの Cookie が必要かの判断材料になる。 */
export function cookieNames(cookieHeader: string | undefined): string[] {
	if (!cookieHeader) return [];
	return cookieHeader
		.split(";")
		.map((part) => part.split("=")[0]?.trim() ?? "")
		.filter((name) => name.length > 0);
}

/** 人間向けの区切り見出し。 */
export function banner(title: string): string {
	return `\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`;
}
