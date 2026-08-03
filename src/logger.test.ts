import { describe, expect, test } from "bun:test";
import { createLogger, redactFields } from "./logger";

const FIXED_NOW = "2024-01-01T00:00:00.000Z";

describe("createLogger", () => {
	test("verbose=false のとき debug は出力されない", () => {
		const lines: string[] = [];
		const logger = createLogger({
			verbose: false,
			json: true,
			sink: (line) => lines.push(line),
			now: () => FIXED_NOW,
		});
		logger.debug("hidden");
		logger.info("shown");
		expect(lines).toEqual([
			JSON.stringify({ ts: FIXED_NOW, level: "info", msg: "shown" }),
		]);
	});

	test("verbose=true のとき debug も出力される", () => {
		const lines: string[] = [];
		const logger = createLogger({
			verbose: true,
			json: true,
			sink: (line) => lines.push(line),
			now: () => FIXED_NOW,
		});
		logger.debug("visible");
		expect(lines).toEqual([
			JSON.stringify({ ts: FIXED_NOW, level: "debug", msg: "visible" }),
		]);
	});

	test("JSON モードのキー構成（ts/level/msg + fields）", () => {
		const lines: string[] = [];
		const logger = createLogger({
			verbose: true,
			json: true,
			sink: (line) => lines.push(line),
			now: () => FIXED_NOW,
		});
		logger.info("hello", { org: "acme", count: 3 });
		expect(JSON.parse(lines[0] ?? "")).toEqual({
			ts: FIXED_NOW,
			level: "info",
			msg: "hello",
			org: "acme",
			count: 3,
		});
	});

	test("JSON モードで fields に予約キーがあっても上書きされない", () => {
		const lines: string[] = [];
		const logger = createLogger({
			verbose: true,
			json: true,
			sink: (line) => lines.push(line),
			now: () => FIXED_NOW,
		});
		logger.info("hello", {
			ts: "fake-ts",
			level: "fake-level",
			msg: "fake-msg",
			extra: 1,
		});
		expect(JSON.parse(lines[0] ?? "")).toEqual({
			ts: FIXED_NOW,
			level: "info",
			msg: "hello",
			extra: 1,
		});
	});

	test("人間可読モードで fields が空なら余分な空白を付けない", () => {
		const lines: string[] = [];
		const logger = createLogger({
			verbose: true,
			json: false,
			sink: (line) => lines.push(line),
			now: () => FIXED_NOW,
		});
		logger.warn("no fields");
		expect(lines).toEqual(["[warn] no fields"]);
	});

	test("人間可読モードで fields を key=value 形式で整形する", () => {
		const lines: string[] = [];
		const logger = createLogger({
			verbose: true,
			json: false,
			sink: (line) => lines.push(line),
			now: () => FIXED_NOW,
		});
		logger.info("hello", { org: "acme", count: 3 });
		expect(lines).toEqual(["[info] hello org=acme count=3"]);
	});

	test("人間可読モードで文字列でない値は JSON.stringify される", () => {
		const lines: string[] = [];
		const logger = createLogger({
			verbose: true,
			json: false,
			sink: (line) => lines.push(line),
			now: () => FIXED_NOW,
		});
		logger.info("hello", { list: [1, 2], flag: true });
		expect(lines).toEqual(["[info] hello list=[1,2] flag=true"]);
	});

	test("sink が渡されれば warn/error も含めて全レベルそこに流れる", () => {
		const lines: string[] = [];
		const logger = createLogger({
			verbose: true,
			json: true,
			sink: (line) => lines.push(line),
			now: () => FIXED_NOW,
		});
		logger.warn("w");
		logger.error("e");
		expect(lines.length).toBe(2);
	});
});

describe("redactFields", () => {
	test("cookie を含むキーは伏せ字にする", () => {
		expect(redactFields({ cookie: "secret-value" })).toEqual({
			cookie: "[REDACTED]",
		});
	});

	test("大文字小文字を無視して Authorization を伏せ字にする", () => {
		expect(redactFields({ Authorization: "Bearer xxx" })).toEqual({
			Authorization: "[REDACTED]",
		});
	});

	test("MEND_GITHUB_PASSWORD のように password を含むキーを伏せ字にする", () => {
		expect(redactFields({ MEND_GITHUB_PASSWORD: "hunter2" })).toEqual({
			MEND_GITHUB_PASSWORD: "[REDACTED]",
		});
	});

	test("totpSecret のように totp/secret を含むキーを伏せ字にする", () => {
		expect(redactFields({ totpSecret: "JBSWY3DPEHPK3PXP" })).toEqual({
			totpSecret: "[REDACTED]",
		});
	});

	test("token を含むキーを伏せ字にする", () => {
		expect(redactFields({ githubToken: "ghp_xxx" })).toEqual({
			githubToken: "[REDACTED]",
		});
	});

	test("関係ないキーはそのまま通す", () => {
		expect(redactFields({ org: "acme", count: 3, active: true })).toEqual({
			org: "acme",
			count: 3,
			active: true,
		});
	});

	test("元のオブジェクトを変更しない", () => {
		const original = { cookie: "secret" };
		redactFields(original);
		expect(original).toEqual({ cookie: "secret" });
	});
});
