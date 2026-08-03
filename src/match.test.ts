import { describe, expect, test } from "bun:test";
import { findScanTargets } from "./match";
import type { MendRepo, MendRenovateStatus } from "./mend/types";
import type { GithubRepo } from "./types";

const ORG = "acme";

// テストの見通しを良くするための最小限のファクトリ。
// 呼び出し側は差分だけ指定すればよい。
function githubRepo(
	overrides: Partial<GithubRepo> & { name: string },
): GithubRepo {
	return {
		name: overrides.name,
		fullName: overrides.fullName ?? `${ORG}/${overrides.name}`,
		archived: overrides.archived ?? false,
		disabled: overrides.disabled ?? false,
		fork: overrides.fork ?? false,
		visibility: overrides.visibility ?? "public",
	};
}

function mendRepo(name: string, status: MendRenovateStatus): MendRepo {
	return { name, renovateStatus: status };
}

const enabled: MendRenovateStatus = { kind: "enabled" };
const disabled: MendRenovateStatus = { kind: "disabled" };
function unknown(raw: string): MendRenovateStatus {
	return { kind: "unknown", raw };
}

describe("findScanTargets", () => {
	test("基本: GitHub に生きていて Mend が disabled なら target になる", () => {
		const result = findScanTargets(
			ORG,
			[githubRepo({ name: "repo-a" })],
			[mendRepo("repo-a", disabled)],
		);

		expect(result.targets).toEqual([
			{ org: ORG, githubRepoName: "repo-a", mendRepoName: "repo-a" },
		]);
		expect(result.unknownStatuses).toEqual([]);
		expect(result.skippedNotInGithub).toEqual([]);
	});

	test("archived 除外: GitHub で archived なリポジトリは Mend で disabled でも target にならない", () => {
		const result = findScanTargets(
			ORG,
			[githubRepo({ name: "repo-a", archived: true })],
			[mendRepo("repo-a", disabled)],
		);

		expect(result.targets).toEqual([]);
		// archived で GitHub 側の対象集合から除外されているため「GitHub 側に見つからない」扱いになる。
		expect(result.skippedNotInGithub).toEqual(["repo-a"]);
	});

	test("GitHub disabled 除外: disabled: true のリポジトリは target にならない", () => {
		const result = findScanTargets(
			ORG,
			[githubRepo({ name: "repo-a", disabled: true })],
			[mendRepo("repo-a", disabled)],
		);

		expect(result.targets).toEqual([]);
		expect(result.skippedNotInGithub).toEqual(["repo-a"]);
	});

	test("fork: 既定では excludeForks 未指定でも fork は除外される", () => {
		const result = findScanTargets(
			ORG,
			[githubRepo({ name: "repo-a", fork: true })],
			[mendRepo("repo-a", disabled)],
		);

		expect(result.targets).toEqual([]);
		expect(result.skippedNotInGithub).toEqual(["repo-a"]);
	});

	test("fork: excludeForks: false を渡すと fork も含まれる", () => {
		const result = findScanTargets(
			ORG,
			[githubRepo({ name: "repo-a", fork: true })],
			[mendRepo("repo-a", disabled)],
			{ excludeForks: false },
		);

		expect(result.targets).toEqual([
			{ org: ORG, githubRepoName: "repo-a", mendRepoName: "repo-a" },
		]);
	});

	test("Mend ステータス: enabled は対象外", () => {
		const result = findScanTargets(
			ORG,
			[githubRepo({ name: "repo-a" })],
			[mendRepo("repo-a", enabled)],
		);

		expect(result.targets).toEqual([]);
		expect(result.unknownStatuses).toEqual([]);
		expect(result.skippedNotInGithub).toEqual([]);
	});

	test("Mend ステータス: unknown は対象外かつ unknownStatuses に raw 付きで記録される", () => {
		const result = findScanTargets(
			ORG,
			[githubRepo({ name: "repo-a" })],
			[mendRepo("repo-a", unknown("onboarding"))],
		);

		expect(result.targets).toEqual([]);
		expect(result.unknownStatuses).toEqual([
			{ name: "repo-a", raw: "onboarding" },
		]);
		// unknown は「見つからなかった」わけではないので skippedNotInGithub には入らない。
		expect(result.skippedNotInGithub).toEqual([]);
	});

	test("大小文字: GitHub MyRepo と Mend myrepo が一致し、各システムの元表記が保持される", () => {
		const result = findScanTargets(
			ORG,
			[githubRepo({ name: "MyRepo" })],
			[mendRepo("myrepo", disabled)],
		);

		expect(result.targets).toEqual([
			{ org: ORG, githubRepoName: "MyRepo", mendRepoName: "myrepo" },
		]);
	});

	test("片側にしか存在しない: Mend にだけある disabled は skippedNotInGithub に入り例外は出ない", () => {
		const result = findScanTargets(ORG, [], [mendRepo("ghost-repo", disabled)]);

		expect(result.targets).toEqual([]);
		expect(result.skippedNotInGithub).toEqual(["ghost-repo"]);
	});

	test("片側にしか存在しない: GitHub にだけあるリポジトリは何も起きない", () => {
		const result = findScanTargets(ORG, [githubRepo({ name: "repo-a" })], []);

		expect(result.targets).toEqual([]);
		expect(result.unknownStatuses).toEqual([]);
		expect(result.skippedNotInGithub).toEqual([]);
	});

	test("重複: Mend 側に Foo と foo が両方 disabled で現れても target は 1 件だけになる", () => {
		const result = findScanTargets(
			ORG,
			[githubRepo({ name: "Foo" })],
			[mendRepo("Foo", disabled), mendRepo("foo", disabled)],
		);

		expect(result.targets).toEqual([
			{ org: ORG, githubRepoName: "Foo", mendRepoName: "Foo" },
		]);
	});

	test("異常入力: 空配列同士でも例外を投げず空の結果を返す", () => {
		const result = findScanTargets(ORG, [], []);

		expect(result).toEqual({
			targets: [],
			unknownStatuses: [],
			skippedNotInGithub: [],
		});
	});

	test("異常入力: GitHub だけ空でも例外を投げず空の結果を返す", () => {
		const result = findScanTargets(ORG, [], [mendRepo("repo-a", enabled)]);

		expect(result).toEqual({
			targets: [],
			unknownStatuses: [],
			skippedNotInGithub: [],
		});
	});

	test("異常入力: Mend だけ空でも例外を投げず空の結果を返す", () => {
		const result = findScanTargets(ORG, [githubRepo({ name: "repo-a" })], []);

		expect(result).toEqual({
			targets: [],
			unknownStatuses: [],
			skippedNotInGithub: [],
		});
	});

	test("順序: targets は mendRepos の入力順を保つ", () => {
		const result = findScanTargets(
			ORG,
			[githubRepo({ name: "repo-b" }), githubRepo({ name: "repo-a" })],
			[mendRepo("repo-b", disabled), mendRepo("repo-a", disabled)],
		);

		expect(result.targets.map((t) => t.mendRepoName)).toEqual([
			"repo-b",
			"repo-a",
		]);
	});

	test("org: 返る ScanTarget.org が引数の org と一致する", () => {
		const result = findScanTargets(
			"another-org",
			[githubRepo({ name: "repo-a" })],
			[mendRepo("repo-a", disabled)],
		);

		expect(result.targets[0]?.org).toBe("another-org");
	});
});
