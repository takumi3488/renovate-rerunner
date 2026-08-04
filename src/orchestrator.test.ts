import { describe, expect, test } from "bun:test";
import type { GithubClient } from "./github";
import { createLogger } from "./logger";
import { MendAuthError, MendUiError } from "./mend/types";
import { run } from "./orchestrator";
import { createFakeMendClient, mendRepo } from "./testing/fake-mend-client";
import type { GithubRepo } from "./types";

const ORG_A = "org-a";
const ORG_B = "org-b";

// テストの見通しを良くするための最小限のファクトリ。呼び出し側は差分だけ指定すればよい。
function githubRepo(
	overrides: Partial<GithubRepo> & { name: string },
): GithubRepo {
	return {
		name: overrides.name,
		fullName: overrides.fullName ?? `org/${overrides.name}`,
		archived: overrides.archived ?? false,
		disabled: overrides.disabled ?? false,
		fork: overrides.fork ?? false,
		visibility: overrides.visibility ?? "public",
	};
}

/** listOrgRepos を返すだけの最小限のフェイク。org ごとに異なるリストを返せる。 */
function fakeGithubClient(
	reposByOrg: Readonly<Record<string, readonly GithubRepo[]>>,
	options?: { readonly errorOnOrg?: string },
): GithubClient {
	return {
		async listOrgRepos(org: string): Promise<readonly GithubRepo[]> {
			if (options?.errorOnOrg === org) {
				throw new Error(`fake github: ${org} の一覧取得に失敗しました`);
			}
			return reposByOrg[org] ?? [];
		},
	};
}

/** ログを配列に集めるだけのテスト用ロガー。console.log のスパイは使わない。 */
function collectingLogger() {
	const lines: string[] = [];
	const logger = createLogger({
		verbose: true,
		json: true,
		sink: (line) => lines.push(line),
	});
	return { logger, lines };
}

describe("run", () => {
	test("dry-run: triggerScan は 1 度も呼ばれず、targetCount は正しく数えられ、results は空", async () => {
		const github = fakeGithubClient({
			[ORG_A]: [githubRepo({ name: "repo-a" }), githubRepo({ name: "repo-b" })],
		});
		const mend = createFakeMendClient({
			reposByOrg: {
				[ORG_A]: [
					mendRepo("repo-a", "disabled"),
					mendRepo("repo-b", "enabled"),
				],
			},
		});
		const { logger } = collectingLogger();

		const summary = await run({
			orgs: [ORG_A],
			githubClient: github,
			mendClient: mend,
			logger,
			dryRun: true,
		});

		expect(mend.triggeredScans).toEqual([]);
		expect(summary.results).toEqual([]);
		expect(summary.triggeredCount).toBe(0);
		// enabled の repo-b は対象外なので、検出されるのは repo-a の 1 件のみ
		expect(summary.targetCount).toBe(1);
	});

	test("通常実行: 対象が正しく trigger され、triggeredScans に記録される", async () => {
		const github = fakeGithubClient({
			[ORG_A]: [githubRepo({ name: "repo-a" })],
		});
		const mend = createFakeMendClient({
			reposByOrg: { [ORG_A]: [mendRepo("repo-a", "disabled")] },
		});
		const { logger } = collectingLogger();

		const summary = await run({
			orgs: [ORG_A],
			githubClient: github,
			mendClient: mend,
			logger,
			dryRun: false,
		});

		expect(mend.triggeredScans).toEqual([`${ORG_A}/repo-a`]);
		expect(summary.results).toEqual([{ ok: true }]);
		expect(summary.triggeredCount).toBe(1);
		expect(summary.failedCount).toBe(0);
		expect(summary.targetCount).toBe(1);
	});

	test("複数 org: 両方の org が処理され、結果が合算される", async () => {
		const github = fakeGithubClient({
			[ORG_A]: [githubRepo({ name: "repo-a" })],
			[ORG_B]: [githubRepo({ name: "repo-c" })],
		});
		const mend = createFakeMendClient({
			reposByOrg: {
				[ORG_A]: [mendRepo("repo-a", "disabled")],
				[ORG_B]: [mendRepo("repo-c", "disabled")],
			},
		});
		const { logger } = collectingLogger();

		const summary = await run({
			orgs: [ORG_A, ORG_B],
			githubClient: github,
			mendClient: mend,
			logger,
			dryRun: false,
		});

		expect(mend.listedOrgs).toEqual([ORG_A, ORG_B]);
		expect(mend.triggeredScans).toEqual([`${ORG_A}/repo-a`, `${ORG_B}/repo-c`]);
		expect(summary.targetCount).toBe(2);
		expect(summary.triggeredCount).toBe(2);
		expect(summary.results.length).toBe(2);
	});

	test("limit: limit: 1 で 2 件検出されたとき 1 件しか trigger されず skippedByLimit が 1 になる", async () => {
		const github = fakeGithubClient({
			[ORG_A]: [githubRepo({ name: "repo-a" }), githubRepo({ name: "repo-b" })],
		});
		const mend = createFakeMendClient({
			reposByOrg: {
				[ORG_A]: [
					mendRepo("repo-a", "disabled"),
					mendRepo("repo-b", "disabled"),
				],
			},
		});
		const { logger } = collectingLogger();

		const summary = await run({
			orgs: [ORG_A],
			githubClient: github,
			mendClient: mend,
			logger,
			dryRun: false,
			limit: 1,
		});

		expect(mend.triggeredScans).toEqual([`${ORG_A}/repo-a`]);
		expect(summary.targetCount).toBe(2);
		expect(summary.triggeredCount).toBe(1);
		expect(summary.skippedByLimit).toBe(1);
	});

	test("limit は org 横断の合計: org A で 1 件使ったら org B では 0 件 trigger される", async () => {
		const github = fakeGithubClient({
			[ORG_A]: [githubRepo({ name: "repo-a" })],
			[ORG_B]: [githubRepo({ name: "repo-c" })],
		});
		const mend = createFakeMendClient({
			reposByOrg: {
				[ORG_A]: [mendRepo("repo-a", "disabled")],
				[ORG_B]: [mendRepo("repo-c", "disabled")],
			},
		});
		const { logger } = collectingLogger();

		const summary = await run({
			orgs: [ORG_A, ORG_B],
			githubClient: github,
			mendClient: mend,
			logger,
			dryRun: false,
			limit: 1,
		});

		expect(mend.triggeredScans).toEqual([`${ORG_A}/repo-a`]);
		expect(summary.targetCount).toBe(2);
		expect(summary.triggeredCount).toBe(1);
		expect(summary.skippedByLimit).toBe(1);
	});

	test("一部失敗: triggerFailures で 1 件失敗させても残りが実行され、failedCount が 1 になる", async () => {
		const github = fakeGithubClient({
			[ORG_A]: [githubRepo({ name: "repo-a" }), githubRepo({ name: "repo-b" })],
		});
		const mend = createFakeMendClient({
			reposByOrg: {
				[ORG_A]: [
					mendRepo("repo-a", "disabled"),
					mendRepo("repo-b", "disabled"),
				],
			},
			triggerFailures: { [`${ORG_A}/repo-a`]: "ボタンが見つかりません" },
		});
		const { logger } = collectingLogger();

		const summary = await run({
			orgs: [ORG_A],
			githubClient: github,
			mendClient: mend,
			logger,
			dryRun: false,
		});

		expect(mend.triggeredScans).toEqual([`${ORG_A}/repo-a`, `${ORG_A}/repo-b`]);
		expect(summary.failedCount).toBe(1);
		expect(summary.triggeredCount).toBe(1);
		expect(summary.results).toEqual([
			{ ok: false, reason: "ボタンが見つかりません" },
			{ ok: true },
		]);
	});

	test("org 単位のエラー: listErrorOnOrg で org A が失敗しても org B は処理され、orgErrors に記録される", async () => {
		const github = fakeGithubClient({
			[ORG_A]: [githubRepo({ name: "repo-a" })],
			[ORG_B]: [githubRepo({ name: "repo-c" })],
		});
		const mend = createFakeMendClient({
			reposByOrg: {
				[ORG_A]: [mendRepo("repo-a", "disabled")],
				[ORG_B]: [mendRepo("repo-c", "disabled")],
			},
			listErrorOnOrg: ORG_A,
		});
		const { logger, lines } = collectingLogger();

		const summary = await run({
			orgs: [ORG_A, ORG_B],
			githubClient: github,
			mendClient: mend,
			logger,
			dryRun: false,
		});

		expect(mend.listedOrgs).toEqual([ORG_A, ORG_B]);
		expect(mend.triggeredScans).toEqual([`${ORG_B}/repo-c`]);
		expect(summary.orgErrors).toEqual([
			{ org: ORG_A, message: `fake: 一覧取得に失敗しました (${ORG_A})` },
		]);
		const errorLines = lines.filter(
			(line) => JSON.parse(line).level === "error",
		);
		expect(errorLines.length).toBeGreaterThan(0);
	});

	test("MendAuthError: authErrorOnListOrg で org A が失敗したら org B は処理されず、run が例外を投げる", async () => {
		const github = fakeGithubClient({
			[ORG_A]: [githubRepo({ name: "repo-a" })],
			[ORG_B]: [githubRepo({ name: "repo-c" })],
		});
		const mend = createFakeMendClient({
			reposByOrg: {
				[ORG_A]: [mendRepo("repo-a", "disabled")],
				[ORG_B]: [mendRepo("repo-c", "disabled")],
			},
			authErrorOnListOrg: ORG_A,
		});
		const { logger } = collectingLogger();

		await expect(
			run({
				orgs: [ORG_A, ORG_B],
				githubClient: github,
				mendClient: mend,
				logger,
				dryRun: false,
			}),
		).rejects.toBeInstanceOf(MendAuthError);

		expect(mend.listedOrgs).toEqual([ORG_A]);
		expect(mend.triggeredScans).toEqual([]);
	});

	test("MendAuthError: triggerScan での authErrorOnTrigger でも例外が伝播し、以降の target は処理されない", async () => {
		const github = fakeGithubClient({
			[ORG_A]: [githubRepo({ name: "repo-a" }), githubRepo({ name: "repo-b" })],
		});
		const mend = createFakeMendClient({
			reposByOrg: {
				[ORG_A]: [
					mendRepo("repo-a", "disabled"),
					mendRepo("repo-b", "disabled"),
				],
			},
			authErrorOnTrigger: `${ORG_A}/repo-a`,
		});
		const { logger } = collectingLogger();

		await expect(
			run({
				orgs: [ORG_A],
				githubClient: github,
				mendClient: mend,
				logger,
				dryRun: false,
			}),
		).rejects.toBeInstanceOf(MendAuthError);

		// repo-a で例外が飛ぶため、repo-b の trigger には到達しない
		expect(mend.triggeredScans).toEqual([]);
	});

	test("unknown ステータス: warn ログが出る", async () => {
		const github = fakeGithubClient({
			[ORG_A]: [githubRepo({ name: "repo-a" })],
		});
		const mend = createFakeMendClient({
			reposByOrg: { [ORG_A]: [mendRepo("repo-a", "onboarding")] },
		});
		const { logger, lines } = collectingLogger();

		await run({
			orgs: [ORG_A],
			githubClient: github,
			mendClient: mend,
			logger,
			dryRun: false,
		});

		const warnLines = lines
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.level === "warn");
		expect(warnLines.length).toBeGreaterThan(0);
		expect(
			warnLines.some((entry) =>
				JSON.stringify(entry.unknownStatuses ?? "").includes("onboarding"),
			),
		).toBe(true);
	});

	test("archived の除外: GitHub で archived なリポジトリは Mend で disabled でも trigger されない（match.ts との結合確認）", async () => {
		const github = fakeGithubClient({
			[ORG_A]: [githubRepo({ name: "repo-a", archived: true })],
		});
		const mend = createFakeMendClient({
			reposByOrg: { [ORG_A]: [mendRepo("repo-a", "disabled")] },
		});
		const { logger } = collectingLogger();

		const summary = await run({
			orgs: [ORG_A],
			githubClient: github,
			mendClient: mend,
			logger,
			dryRun: false,
		});

		expect(mend.triggeredScans).toEqual([]);
		expect(summary.targetCount).toBe(0);
		expect(summary.triggeredCount).toBe(0);
	});

	test("409: alreadyQueued の結果は alreadyQueuedCount に数え、triggeredCount には含めない", async () => {
		const github = fakeGithubClient({
			[ORG_A]: [githubRepo({ name: "repo-a" }), githubRepo({ name: "repo-b" })],
		});
		const mend = createFakeMendClient({
			reposByOrg: {
				[ORG_A]: [
					mendRepo("repo-a", "disabled"),
					mendRepo("repo-b", "disabled"),
				],
			},
			alreadyQueuedOnTrigger: [`${ORG_A}/repo-a`],
		});
		const { logger, lines } = collectingLogger();

		const summary = await run({
			orgs: [ORG_A],
			githubClient: github,
			mendClient: mend,
			logger,
			dryRun: false,
		});

		expect(mend.triggeredScans).toEqual([`${ORG_A}/repo-a`, `${ORG_A}/repo-b`]);
		expect(summary.results).toEqual([
			{ ok: true, alreadyQueued: true },
			{ ok: true },
		]);
		expect(summary.alreadyQueuedCount).toBe(1);
		expect(summary.triggeredCount).toBe(1);
		expect(summary.failedCount).toBe(0);
		const infoLines = lines
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.level === "info");
		expect(
			infoLines.some((entry) =>
				entry.msg.includes("既にキューにあるためスキップ"),
			),
		).toBe(true);
	});

	test("triggerIntervalMs: 2 件目の trigger 前にだけ sleep が呼ばれる", async () => {
		const github = fakeGithubClient({
			[ORG_A]: [githubRepo({ name: "repo-a" }), githubRepo({ name: "repo-b" })],
		});
		const mend = createFakeMendClient({
			reposByOrg: {
				[ORG_A]: [
					mendRepo("repo-a", "disabled"),
					mendRepo("repo-b", "disabled"),
				],
			},
		});
		const { logger } = collectingLogger();
		const sleepCalls: { ms: number; triggeredSoFar: number }[] = [];

		await run({
			orgs: [ORG_A],
			githubClient: github,
			mendClient: mend,
			logger,
			dryRun: false,
			triggerIntervalMs: 100,
			sleep: (ms) => {
				sleepCalls.push({ ms, triggeredSoFar: mend.triggeredScans.length });
				return Promise.resolve();
			},
		});

		// 1 件目の前には待機せず、2 件目の前に 1 回だけ待機する
		expect(sleepCalls).toEqual([{ ms: 100, triggeredSoFar: 1 }]);
		expect(mend.triggeredScans).toEqual([`${ORG_A}/repo-a`, `${ORG_A}/repo-b`]);
	});

	test("triggerIntervalMs が 0 なら sleep は呼ばれない", async () => {
		const github = fakeGithubClient({
			[ORG_A]: [githubRepo({ name: "repo-a" }), githubRepo({ name: "repo-b" })],
		});
		const mend = createFakeMendClient({
			reposByOrg: {
				[ORG_A]: [
					mendRepo("repo-a", "disabled"),
					mendRepo("repo-b", "disabled"),
				],
			},
		});
		const { logger } = collectingLogger();
		let sleepCalled = false;

		await run({
			orgs: [ORG_A],
			githubClient: github,
			mendClient: mend,
			logger,
			dryRun: false,
			triggerIntervalMs: 0,
			sleep: () => {
				sleepCalled = true;
				return Promise.resolve();
			},
		});

		expect(sleepCalled).toBe(false);
	});

	test("MendUiError: listRepos で投げられたら fatal として伝播し、以降の org は処理されない", async () => {
		const github = fakeGithubClient({
			[ORG_A]: [githubRepo({ name: "repo-a" })],
			[ORG_B]: [githubRepo({ name: "repo-c" })],
		});
		const mend = createFakeMendClient({
			reposByOrg: {
				[ORG_A]: [mendRepo("repo-a", "disabled")],
				[ORG_B]: [mendRepo("repo-c", "disabled")],
			},
			uiErrorOnListOrg: ORG_A,
		});
		const { logger } = collectingLogger();

		await expect(
			run({
				orgs: [ORG_A, ORG_B],
				githubClient: github,
				mendClient: mend,
				logger,
				dryRun: false,
			}),
		).rejects.toBeInstanceOf(MendUiError);

		expect(mend.listedOrgs).toEqual([ORG_A]);
		expect(mend.triggeredScans).toEqual([]);
	});
});
