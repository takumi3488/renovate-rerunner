import { describe, expect, test } from "bun:test";
import { createLogger } from "../logger";
import { createNotifier, loadWebhookUrl, truncateText } from "./discord";
import type { Notification } from "./discord";

// トークンを含む本物っぽい形の URL。ログに漏れていないことの検証に使う。
const WEBHOOK_URL =
	"https://discord.com/api/webhooks/1234567890/super-secret-token";

const baseNotification: Notification = {
	kind: "login-required",
	title: "Mend へのログインが必要です",
	message: "storageState の Cookie が失効しました。",
};

/**
 * fetch の呼び出しを記録するモック。
 * globalThis.fetch を書き換えず DI で差し替えるため、テスト間の後始末が不要になる。
 */
interface RecordedCall {
	readonly url: string;
	readonly init?: RequestInit;
}

function createFetchMock(responder: () => Response): {
	readonly fetchImpl: typeof fetch;
	readonly calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const handler = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url, init });
		return responder();
	};
	// Bun の fetch は呼び出しシグネチャに加えて静的メソッド preconnect を持ち、
	// typeof fetch の型としてそれが必須になるためスタブを生やしておく。
	const fetchImpl = Object.assign(handler, {
		preconnect: () => {},
	});
	return { fetchImpl, calls };
}

function createThrowingFetchMock(error: unknown): typeof fetch {
	const handler = async (): Promise<Response> => {
		throw error;
	};
	return Object.assign(handler, { preconnect: () => {} });
}

/** ボディを読まないため status だけ意味を持つレスポンス。204 でも body は null にする。 */
function makeResponse(status: number): Response {
	return new Response(null, { status });
}

function createTestLogger(): {
	logger: ReturnType<typeof createLogger>;
	lines: string[];
} {
	const lines: string[] = [];
	const logger = createLogger({
		verbose: true,
		json: true,
		sink: (line) => lines.push(line),
		now: () => "2024-01-01T00:00:00.000Z",
	});
	return { logger, lines };
}

function parseBody(call: RecordedCall | undefined): {
	embeds: Array<{
		title: string;
		description: string;
		color: number;
		fields: Array<{ name: string; value: string; inline: boolean }>;
	}>;
} {
	if (!call?.init?.body || typeof call.init.body !== "string") {
		throw new Error("リクエストボディが記録されていません");
	}
	return JSON.parse(call.init.body);
}

describe("createNotifier", () => {
	test("webhookUrl 未設定なら notify は false を返し fetch を呼ばない", async () => {
		const { logger, lines } = createTestLogger();
		let fetchCalled = false;
		const fetchImpl = Object.assign(
			async (): Promise<Response> => {
				fetchCalled = true;
				return makeResponse(200);
			},
			{ preconnect: () => {} },
		);

		const notifier = createNotifier({ logger, fetchImpl });
		const result = await notifier.notify(baseNotification);

		expect(result).toBe(false);
		expect(fetchCalled).toBe(false);
		expect(
			lines.some((line) =>
				line.includes("Discord 通知は未設定のためスキップした"),
			),
		).toBe(true);
	});

	test("正常系: POST され、embeds の構造が期待通りになる", async () => {
		const { logger } = createTestLogger();
		const { fetchImpl, calls } = createFetchMock(() => makeResponse(200));
		const notifier = createNotifier({
			logger,
			webhookUrl: WEBHOOK_URL,
			fetchImpl,
		});

		const notification: Notification = {
			kind: "login-required",
			title: "Mend へのログインが必要です",
			message: "storageState の Cookie が失効しました。",
			hint: "ブラウザで developer.mend.io にログインしてください。",
			fields: { org: "acme", repo: "acme/service" },
		};

		const result = await notifier.notify(notification);

		expect(result).toBe(true);
		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe(WEBHOOK_URL);
		expect(calls[0]?.init?.method).toBe("POST");
		expect(calls[0]?.init?.headers).toEqual({
			"Content-Type": "application/json",
		});

		const body = parseBody(calls[0]);
		expect(body).toEqual({
			embeds: [
				{
					title: "Mend へのログインが必要です",
					description: "storageState の Cookie が失効しました。",
					color: 16753920,
					fields: [
						{
							name: "対処",
							value: "ブラウザで developer.mend.io にログインしてください。",
							inline: false,
						},
						{ name: "org", value: "acme", inline: true },
						{ name: "repo", value: "acme/service", inline: true },
					],
				},
			],
		});
	});

	test("kind: login-required は色 16753920（オレンジ）になる", async () => {
		const { logger } = createTestLogger();
		const { fetchImpl, calls } = createFetchMock(() => makeResponse(200));
		const notifier = createNotifier({
			logger,
			webhookUrl: WEBHOOK_URL,
			fetchImpl,
		});

		await notifier.notify({ ...baseNotification, kind: "login-required" });

		const body = parseBody(calls[0]);
		expect(body.embeds[0]?.color).toBe(16753920);
	});

	test("kind: error は色 15158332（赤）になる", async () => {
		const { logger } = createTestLogger();
		const { fetchImpl, calls } = createFetchMock(() => makeResponse(200));
		const notifier = createNotifier({
			logger,
			webhookUrl: WEBHOOK_URL,
			fetchImpl,
		});

		await notifier.notify({ ...baseNotification, kind: "error" });

		const body = parseBody(calls[0]);
		expect(body.embeds[0]?.color).toBe(15158332);
	});

	test("hint が fields の先頭に「対処」として入る", async () => {
		const { logger } = createTestLogger();
		const { fetchImpl, calls } = createFetchMock(() => makeResponse(200));
		const notifier = createNotifier({
			logger,
			webhookUrl: WEBHOOK_URL,
			fetchImpl,
		});

		await notifier.notify({
			...baseNotification,
			hint: "bun run auth を実行してください。",
			fields: { org: "acme" },
		});

		const body = parseBody(calls[0]);
		expect(body.embeds[0]?.fields[0]).toEqual({
			name: "対処",
			value: "bun run auth を実行してください。",
			inline: false,
		});
	});

	test("非 2xx（429）→ false を返し例外を投げない", async () => {
		const { logger, lines } = createTestLogger();
		const { fetchImpl } = createFetchMock(() => makeResponse(429));
		const notifier = createNotifier({
			logger,
			webhookUrl: WEBHOOK_URL,
			fetchImpl,
		});

		const result = await notifier.notify(baseNotification);

		expect(result).toBe(false);
		expect(lines.some((line) => line.includes("429"))).toBe(true);
	});

	test("非 2xx（500）→ false を返し例外を投げない", async () => {
		const { logger, lines } = createTestLogger();
		const { fetchImpl } = createFetchMock(() => makeResponse(500));
		const notifier = createNotifier({
			logger,
			webhookUrl: WEBHOOK_URL,
			fetchImpl,
		});

		const result = await notifier.notify(baseNotification);

		expect(result).toBe(false);
		expect(lines.some((line) => line.includes("500"))).toBe(true);
	});

	test("204 No Content は成功扱いになる", async () => {
		const { logger } = createTestLogger();
		const { fetchImpl } = createFetchMock(() => makeResponse(204));
		const notifier = createNotifier({
			logger,
			webhookUrl: WEBHOOK_URL,
			fetchImpl,
		});

		const result = await notifier.notify(baseNotification);

		expect(result).toBe(true);
	});

	test("fetch が throw → false を返し例外を投げない", async () => {
		const { logger } = createTestLogger();
		const fetchImpl = createThrowingFetchMock(new Error("network down"));
		const notifier = createNotifier({
			logger,
			webhookUrl: WEBHOOK_URL,
			fetchImpl,
		});

		const result = await notifier.notify(baseNotification);

		expect(result).toBe(false);
	});

	test("ログに webhookUrl が一切含まれない（fetch 例外の message に URL が含まれるケース）", async () => {
		const { logger, lines } = createTestLogger();
		const fetchImpl = createThrowingFetchMock(
			new Error(
				`request to ${WEBHOOK_URL} failed, reason: connect ECONNREFUSED`,
			),
		);
		const notifier = createNotifier({
			logger,
			webhookUrl: WEBHOOK_URL,
			fetchImpl,
		});

		await notifier.notify(baseNotification);

		for (const line of lines) {
			expect(line).not.toContain(WEBHOOK_URL);
			expect(line).not.toContain("super-secret-token");
		}
	});

	test("ログに webhookUrl が一切含まれない（非 2xx のケース）", async () => {
		const { logger, lines } = createTestLogger();
		const { fetchImpl } = createFetchMock(() => makeResponse(500));
		const notifier = createNotifier({
			logger,
			webhookUrl: WEBHOOK_URL,
			fetchImpl,
		});

		await notifier.notify(baseNotification);

		for (const line of lines) {
			expect(line).not.toContain(WEBHOOK_URL);
			expect(line).not.toContain("super-secret-token");
		}
	});

	test("title / description / fields の上限を超える場合は切り詰められる", async () => {
		const { logger } = createTestLogger();
		const { fetchImpl, calls } = createFetchMock(() => makeResponse(200));
		const notifier = createNotifier({
			logger,
			webhookUrl: WEBHOOK_URL,
			fetchImpl,
		});

		const longTitle = "t".repeat(300);
		const longDescription = "d".repeat(5000);
		const manyFields: Record<string, string> = {};
		for (let i = 0; i < 26; i += 1) {
			manyFields[`field-${i}`] = `value-${i}`;
		}

		await notifier.notify({
			kind: "error",
			title: longTitle,
			message: longDescription,
			fields: manyFields,
		});

		const body = parseBody(calls[0]);
		const embed = body.embeds[0];
		expect(embed?.title.length).toBe(256);
		expect(embed?.title.endsWith("…")).toBe(true);
		expect(embed?.description.length).toBe(4096);
		expect(embed?.description.endsWith("…")).toBe(true);
		expect(embed?.fields.length).toBe(25);
	});
});

describe("truncateText", () => {
	test("maxLength 以下ならそのまま返す", () => {
		expect(truncateText("hello", 10)).toBe("hello");
	});

	test("maxLength ちょうどならそのまま返す", () => {
		expect(truncateText("hello", 5)).toBe("hello");
	});

	test("超える場合は maxLength に収まるよう末尾を省略記号にする", () => {
		const result = truncateText("a".repeat(10), 5);
		expect(result.length).toBe(5);
		expect(result).toBe(`${"a".repeat(4)}…`);
	});

	test("空文字は空文字のまま", () => {
		expect(truncateText("", 5)).toBe("");
	});
});

describe("loadWebhookUrl", () => {
	test("未設定なら undefined", () => {
		expect(loadWebhookUrl({})).toBeUndefined();
	});

	test("空文字なら undefined", () => {
		expect(loadWebhookUrl({ DISCORD_WEBHOOK_URL: "" })).toBeUndefined();
	});

	test("空白のみなら undefined", () => {
		expect(loadWebhookUrl({ DISCORD_WEBHOOK_URL: "   " })).toBeUndefined();
	});

	test("正常値は trim されて返る", () => {
		expect(loadWebhookUrl({ DISCORD_WEBHOOK_URL: `  ${WEBHOOK_URL}  ` })).toBe(
			WEBHOOK_URL,
		);
	});
});
