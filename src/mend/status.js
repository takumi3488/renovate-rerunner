/**
 * UI に表示されている文字列を Renovate の状態に変換する。
 *
 * Mend のステータス値は公開されていないが、コミュニティで確認されているのは
 * onboarding / onboarded / activated / disabled の 4 つ。
 * onboarding 中のリポジトリは Renovate が既に動いているので scan の対象にしない。
 */
export const DISABLED_LABELS = new Set([
	"disabled",
	"inactive",
	"not activated",
]);
export const ENABLED_LABELS = new Set([
	"enabled",
	"activated",
	"onboarded",
	"onboarding",
	"active",
]);

/**
 * @param {string} raw
 * @returns {{kind:"enabled"}|{kind:"disabled"}|{kind:"unknown",raw:string}}
 */
export function parseRenovateStatus(raw) {
	const normalized = raw.trim().toLowerCase();
	if (DISABLED_LABELS.has(normalized)) return { kind: "disabled" };
	if (ENABLED_LABELS.has(normalized)) return { kind: "enabled" };
	// 判別できない値は握りつぶさず raw を残す。突合側が安全側に倒して対象外にする。
	return { kind: "unknown", raw: raw.trim() };
}
