import { describe, expect, test } from "bun:test";
import type { Cookie } from "playwright";
import { haveCookiesChanged, partitionCookiesForInjection } from "./auth";

/** テスト用に最小限のフィールドを埋めた Cookie を作る。 */
function makeCookie(overrides: Partial<Cookie> & Pick<Cookie, "name">): Cookie {
	return {
		name: overrides.name,
		value: overrides.value ?? "value",
		domain: overrides.domain ?? "developer.mend.io",
		path: overrides.path ?? "/",
		expires: overrides.expires ?? -1,
		httpOnly: overrides.httpOnly ?? true,
		secure: overrides.secure ?? true,
		sameSite: overrides.sameSite ?? "Lax",
	};
}

describe("partitionCookiesForInjection", () => {
	test("空配列は addable も skipped も空", () => {
		expect(partitionCookiesForInjection([])).toEqual({
			addable: [],
			skipped: [],
		});
	});

	test("domain がある Cookie は addable に入る", () => {
		const cookie = makeCookie({ name: "mend_session" });
		expect(partitionCookiesForInjection([cookie])).toEqual({
			addable: [cookie],
			skipped: [],
		});
	});

	test("domain が空文字の Cookie は skipped に入る", () => {
		const cookie = makeCookie({ name: "broken", domain: "" });
		expect(partitionCookiesForInjection([cookie])).toEqual({
			addable: [],
			skipped: [cookie],
		});
	});

	test("domain が空白のみの Cookie も skipped に入る", () => {
		const cookie = makeCookie({ name: "broken", domain: "   " });
		expect(partitionCookiesForInjection([cookie])).toEqual({
			addable: [],
			skipped: [cookie],
		});
	});

	test("1 件が壊れていても他は addable に残る", () => {
		const good = makeCookie({ name: "mend_session" });
		const broken = makeCookie({ name: "broken", domain: "" });
		expect(partitionCookiesForInjection([good, broken])).toEqual({
			addable: [good],
			skipped: [broken],
		});
	});
});

describe("haveCookiesChanged", () => {
	test("空配列同士は変化なし", () => {
		expect(haveCookiesChanged([], [])).toBe(false);
	});

	test("完全に同じ内容なら変化なし", () => {
		const cookie = makeCookie({ name: "mend_session", value: "abc" });
		expect(haveCookiesChanged([cookie], [{ ...cookie }])).toBe(false);
	});

	test("順序だけ違う場合は変化なし扱い", () => {
		const a = makeCookie({ name: "a", value: "1" });
		const b = makeCookie({ name: "b", value: "2" });
		expect(haveCookiesChanged([a, b], [b, a])).toBe(false);
	});

	test("value だけ変わっていれば変化あり", () => {
		const before = makeCookie({ name: "mend_session", value: "old" });
		const after = makeCookie({ name: "mend_session", value: "new" });
		expect(haveCookiesChanged([before], [after])).toBe(true);
	});

	test("Cookie が増えていれば変化あり", () => {
		const a = makeCookie({ name: "a", value: "1" });
		const b = makeCookie({ name: "b", value: "2" });
		expect(haveCookiesChanged([a], [a, b])).toBe(true);
	});

	test("Cookie が減っていれば変化あり", () => {
		const a = makeCookie({ name: "a", value: "1" });
		const b = makeCookie({ name: "b", value: "2" });
		expect(haveCookiesChanged([a, b], [a])).toBe(true);
	});

	test("片方が空配列なら変化あり", () => {
		const cookie = makeCookie({ name: "mend_session" });
		expect(haveCookiesChanged([], [cookie])).toBe(true);
		expect(haveCookiesChanged([cookie], [])).toBe(true);
	});
});
