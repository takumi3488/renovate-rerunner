import { describe, expect, test } from "bun:test";
import { parseMendLocation } from "../src/mend/location.js";

describe("parseMendLocation", () => {
	test("/github/my-org は org ページ", () => {
		expect(parseMendLocation("/github/my-org")).toEqual({
			platform: "github",
			org: "my-org",
		});
	});

	test("リポジトリページでも org を返す", () => {
		expect(parseMendLocation("/github/my-org/my-repo")).toEqual({
			platform: "github",
			org: "my-org",
		});
	});

	test("予約セグメントは null", () => {
		expect(parseMendLocation("/user/settings")).toBeNull();
	});

	test("ルートは null", () => {
		expect(parseMendLocation("/")).toBeNull();
	});

	test("platform だけでは null", () => {
		expect(parseMendLocation("/github")).toBeNull();
	});
});
