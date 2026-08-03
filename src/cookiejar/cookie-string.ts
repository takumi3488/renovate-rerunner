/**
 * cookiejar-reader（gRPC）が返す Cookie ヘッダー連結文字列と、Playwright の Cookie 配列を
 * 相互変換する純粋関数群。
 *
 * Reader は Go の `http.Cookie.String()` を `"; "` で連結した文字列を返す。これは
 * `Set-Cookie` ヘッダーの値そのものではなく、複数の Cookie がフラットに並んだ独自形式なので、
 * 標準の Cookie パーサをそのまま流用できない（属性がどの Cookie に属するかを自前で追う必要がある）。
 */

import type { Cookie } from "playwright";

/** Writer（HTTP）に送る 1 Cookie 分のペイロード。フィールド名は Writer 側の JSON に合わせて小文字。 */
export interface WriterCookie {
	readonly name: string;
	readonly value: string;
	readonly path?: string;
	readonly domain?: string;
	readonly maxAge?: number;
	readonly secure?: boolean;
	readonly httpOnly?: boolean;
	readonly sameSite?: "None" | "Lax" | "Strict";
}

/**
 * 属性キーワード（大文字小文字を無視して比較する）。
 * これ以外のトークンは新しい Cookie の開始として扱う。
 */
const ATTRIBUTE_KEYWORDS = new Set([
	"path",
	"domain",
	"expires",
	"max-age",
	"samesite",
	"httponly",
	"secure",
	"partitioned",
]);

/** パース途中で使う可変な中間表現。属性トークンを読むたびにこれへ書き足していく。 */
interface PendingCookie {
	name: string;
	value: string;
	domain?: string;
	path?: string;
	httpOnly: boolean;
	secure: boolean;
	sameSite?: "None" | "Lax" | "Strict";
	maxAgeSec?: number;
	expiresRaw?: string;
}

/**
 * SameSite の表記ゆれ（小文字・混在）を Playwright の型に正規化する。
 * 未知の値は仕様の指示通り安全側の "Lax" にフォールバックする。
 */
function normalizeSameSite(raw: string): "None" | "Lax" | "Strict" {
	const normalized = raw.trim().toLowerCase();
	if (normalized === "strict") return "Strict";
	if (normalized === "none") return "None";
	if (normalized === "lax") return "Lax";
	return "Lax";
}

/**
 * Reader が返す Cookie ヘッダー連結文字列を Playwright の Cookie 配列に変換する。
 *
 * @param raw Reader が返した連結文字列
 * @param fallbackDomain 属性に domain が無かった Cookie に使う host（呼び出し側が問い合わせた host）
 */
export function parseCookieString(
	raw: string,
	fallbackDomain: string,
): Cookie[] {
	if (raw.trim() === "") return [];

	// ";" 単体や不揃いな空白にも対応するため、区切りは正規表現で行う。
	const tokens = raw.split(/;\s*/).filter((token) => token !== "");
	const pending: PendingCookie[] = [];

	for (const token of tokens) {
		const eqIndex = token.indexOf("=");
		// 属性キーワードかどうかの判定にだけ使う名前。trim して比較のブレを防ぐ。
		const rawKey = (eqIndex === -1 ? token : token.slice(0, eqIndex)).trim();
		const keyLower = rawKey.toLowerCase();

		if (ATTRIBUTE_KEYWORDS.has(keyLower)) {
			const current = pending[pending.length - 1];
			// 属性トークンより前に Cookie が 1 つも無ければ、対応する Cookie が無いので無視する。
			if (!current) continue;

			const attrValue = eqIndex === -1 ? "" : token.slice(eqIndex + 1).trim();
			switch (keyLower) {
				case "path":
					current.path = attrValue;
					break;
				case "domain":
					current.domain = attrValue;
					break;
				case "expires":
					current.expiresRaw = attrValue;
					break;
				case "max-age": {
					const seconds = Number(attrValue);
					if (Number.isFinite(seconds)) current.maxAgeSec = seconds;
					break;
				}
				case "samesite":
					current.sameSite = normalizeSameSite(attrValue);
					break;
				case "httponly":
					current.httpOnly = true;
					break;
				case "secure":
					current.secure = true;
					break;
				case "partitioned":
					// Playwright の Cookie 型では partitionKey は別概念（パーティション分割の識別子）
					// であり、CHIPS の Partitioned フラグをそのまま流用できないため意図的に無視する。
					break;
			}
			continue;
		}

		// 属性キーワードでなければ新しい Cookie の開始。名前が空のトークンは無視する。
		if (rawKey === "") continue;
		// Cookie 値には base64 由来の "=" が含まれうるため、分割は最初の "=" のみで行う。
		const value = eqIndex === -1 ? "" : token.slice(eqIndex + 1);
		pending.push({
			name: rawKey,
			value,
			httpOnly: false,
			secure: false,
		});
	}

	// "now" はパース1回につき1回だけ評価する。複数 Cookie の Max-Age 計算基準を揃えるため。
	const nowEpochSec = Math.floor(Date.now() / 1000);

	return pending.map((cookie): Cookie => {
		let expires = -1;
		if (cookie.maxAgeSec !== undefined) {
			expires = nowEpochSec + cookie.maxAgeSec;
		} else if (cookie.expiresRaw !== undefined) {
			const parsedMs = Date.parse(cookie.expiresRaw);
			if (!Number.isNaN(parsedMs)) expires = Math.floor(parsedMs / 1000);
		}

		return {
			name: cookie.name,
			value: cookie.value,
			domain: cookie.domain || fallbackDomain,
			path: cookie.path || "/",
			expires,
			httpOnly: cookie.httpOnly,
			secure: cookie.secure,
			sameSite: cookie.sameSite ?? "Lax",
		};
	});
}

/**
 * Playwright の Cookie を cookiejar Writer の JSON ペイロードに変換する。
 *
 * @param nowEpochSec maxAge 計算の基準時刻。省略時は現在時刻。
 */
export function toWriterCookies(
	cookies: readonly Cookie[],
	nowEpochSec: number = Math.floor(Date.now() / 1000),
): WriterCookie[] {
	const result: WriterCookie[] = [];

	for (const cookie of cookies) {
		// domain は Writer 側の保存キーになるため必須。空の Cookie は書き戻しようがないので捨てる。
		if (!cookie.domain) continue;

		const base: WriterCookie = {
			name: cookie.name,
			value: cookie.value,
			path: cookie.path,
			domain: cookie.domain,
			secure: cookie.secure,
			httpOnly: cookie.httpOnly,
			sameSite: cookie.sameSite,
		};

		// expires <= 0 はセッション Cookie を意味するので maxAge は付けない。
		result.push(
			cookie.expires > 0
				? {
						...base,
						maxAge: Math.max(0, Math.floor(cookie.expires - nowEpochSec)),
					}
				: base,
		);
	}

	return result;
}
