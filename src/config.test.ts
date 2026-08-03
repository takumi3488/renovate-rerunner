import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig, parseOrgList } from "./config";

const validEnv = { GITHUB_TOKEN: "ghp_valid", GITHUB_ORGS: "org-a,org-b" };

describe("loadConfig", () => {
	test("両方揃っていれば Config を返す", () => {
		const config = loadConfig(validEnv);
		expect(config).toEqual({
			githubToken: "ghp_valid",
			orgs: ["org-a", "org-b"],
		});
	});

	test("GITHUB_TOKEN が未設定なら ConfigError", () => {
		expect(() => loadConfig({ GITHUB_ORGS: "org-a" })).toThrow(ConfigError);
	});

	test("GITHUB_TOKEN が空文字なら ConfigError", () => {
		expect(() =>
			loadConfig({ GITHUB_TOKEN: "", GITHUB_ORGS: "org-a" }),
		).toThrow(ConfigError);
	});

	test("GITHUB_TOKEN が空白のみなら ConfigError", () => {
		expect(() =>
			loadConfig({ GITHUB_TOKEN: "   ", GITHUB_ORGS: "org-a" }),
		).toThrow(ConfigError);
	});

	test("GITHUB_ORGS が未設定なら ConfigError", () => {
		expect(() => loadConfig({ GITHUB_TOKEN: "ghp_valid" })).toThrow(
			ConfigError,
		);
	});

	test("GITHUB_ORGS が空文字なら ConfigError", () => {
		expect(() =>
			loadConfig({ GITHUB_TOKEN: "ghp_valid", GITHUB_ORGS: "" }),
		).toThrow(ConfigError);
	});

	test("GITHUB_ORGS が空白のみなら ConfigError", () => {
		expect(() =>
			loadConfig({ GITHUB_TOKEN: "ghp_valid", GITHUB_ORGS: "   " }),
		).toThrow(ConfigError);
	});

	test("GITHUB_ORGS がカンマと空白のみなら ConfigError（trim 後に0件）", () => {
		expect(() =>
			loadConfig({ GITHUB_TOKEN: "ghp_valid", GITHUB_ORGS: " , , " }),
		).toThrow(ConfigError);
	});

	test("エラーメッセージに何が足りないか・どう直すかが含まれる", () => {
		try {
			loadConfig({ GITHUB_ORGS: "org-a" });
			throw new Error("unreachable");
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigError);
			expect((err as ConfigError).message).toContain("GITHUB_TOKEN");
		}
	});
});

describe("parseOrgList", () => {
	test("trim と空要素除去を行う", () => {
		expect(parseOrgList(" a , ,b ,")).toEqual(["a", "b"]);
	});

	test("重複を除去する", () => {
		expect(parseOrgList("org-a,org-b,org-a")).toEqual(["org-a", "org-b"]);
	});

	test("要素が1件もなければ空配列を返す", () => {
		expect(parseOrgList(" , , ")).toEqual([]);
	});

	test("単一要素の正規化", () => {
		expect(parseOrgList(" only-one ")).toEqual(["only-one"]);
	});
});
