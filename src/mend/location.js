const RESERVED_SEGMENTS = new Set([
	"app",
	"install",
	"job",
	"mock",
	"system",
	"user",
	"api",
	"_next",
	"_error",
]);

/**
 * 現在ページの URL から Mend の org を割り出す。
 * `null` は「org ページではない」＝モーダルでの org 事前選択なし、を意味するだけ。
 *
 * @param {string} pathname
 * @returns {{platform:string, org:string}|null}
 */
export function parseMendLocation(pathname) {
	const segments = pathname.split("/").filter(Boolean);
	if (segments.length < 2) return null;
	const [platform, slug] = segments;
	if (RESERVED_SEGMENTS.has(platform)) return null;
	return { platform, org: decodeURIComponent(slug) };
}
