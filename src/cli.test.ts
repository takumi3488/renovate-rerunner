import { describe, expect, test } from "bun:test";
import { CliError, parseCliArgs } from "./cli";

describe("parseCliArgs", () => {
	test("空配列ならデフォルト値になる", () => {
		const options = parseCliArgs([]);
		expect(options).toEqual({
			dryRun: false,
			orgs: undefined,
			limit: undefined,
			verbose: false,
			help: false,
		});
	});

	test("--dry-run が反映される", () => {
		expect(parseCliArgs(["--dry-run"]).dryRun).toBe(true);
	});

	test("--verbose が反映される", () => {
		expect(parseCliArgs(["--verbose"]).verbose).toBe(true);
	});

	test("-v が --verbose の別名として反映される", () => {
		expect(parseCliArgs(["-v"]).verbose).toBe(true);
	});

	test("--help が反映される", () => {
		expect(parseCliArgs(["--help"]).help).toBe(true);
	});

	test("-h が --help の別名として反映される", () => {
		expect(parseCliArgs(["-h"]).help).toBe(true);
	});

	test("--limit が反映される", () => {
		expect(parseCliArgs(["--limit", "5"]).limit).toBe(5);
	});

	test("--org が trim・空要素除去・重複除去した上で反映される", () => {
		expect(parseCliArgs(["--org", " a , b , a"]).orgs).toEqual(["a", "b"]);
	});

	test("--limit 0 は CliError", () => {
		expect(() => parseCliArgs(["--limit", "0"])).toThrow(CliError);
	});

	test("--limit abc は CliError", () => {
		expect(() => parseCliArgs(["--limit", "abc"])).toThrow(CliError);
	});

	test("--limit -1 は CliError", () => {
		expect(() => parseCliArgs(["--limit", "-1"])).toThrow(CliError);
	});

	test("--limit 1.5 は CliError", () => {
		expect(() => parseCliArgs(["--limit", "1.5"])).toThrow(CliError);
	});

	test("--org に空要素しかなければ CliError", () => {
		expect(() => parseCliArgs(["--org", " , , "])).toThrow(CliError);
	});

	test("未知のフラグ --nope は CliError", () => {
		expect(() => parseCliArgs(["--nope"])).toThrow(CliError);
	});

	test("位置引数は CliError", () => {
		expect(() => parseCliArgs(["positional"])).toThrow(CliError);
	});

	test("複数フラグを同時に指定できる", () => {
		const options = parseCliArgs([
			"--dry-run",
			"--verbose",
			"--org",
			"acme",
			"--limit",
			"3",
		]);
		expect(options).toEqual({
			dryRun: true,
			orgs: ["acme"],
			limit: 3,
			verbose: true,
			help: false,
		});
	});
});
