import { describe, expect, test } from "bun:test";
import { findScanTargets } from "../src/content/targets.js";

describe("findScanTargets", () => {
	test("生存名に無い Mend repo は targets に出ない", () => {
		const { targets } = findScanTargets({
			platform: "github",
			org: "my-org",
			mendRepos: [{ name: "alive" }, { name: "archived" }],
			aliveRepoNames: ["alive"],
		});
		expect(targets).toEqual([
			{ platform: "github", org: "my-org", repo: "alive" },
		]);
	});

	test("大小文字違いは 1 件に畳まれ、targets[].repo は Mend 表記のまま", () => {
		const { targets } = findScanTargets({
			platform: "github",
			org: "my-org",
			mendRepos: [{ name: "My-Repo" }, { name: "my-repo" }],
			aliveRepoNames: ["MY-REPO"],
		});
		expect(targets).toEqual([
			{ platform: "github", org: "my-org", repo: "My-Repo" },
		]);
	});

	test("入力順が保たれる", () => {
		const { targets } = findScanTargets({
			platform: "github",
			org: "my-org",
			mendRepos: [{ name: "b" }, { name: "a" }, { name: "c" }],
			aliveRepoNames: ["a", "b", "c"],
		});
		expect(targets.map((t) => t.repo)).toEqual(["b", "a", "c"]);
	});
});
