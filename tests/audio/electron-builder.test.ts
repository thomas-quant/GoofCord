import { describe, expect, test } from "bun:test";

import config from "../../electron-builder.ts";

describe("electron-builder reconciliation", () => {
	test("keeps native addons unpacked using the pinned builder's v27 schema", () => {
		expect(config.asar).toEqual({ unpack: ["**/*.node"] });
		expect(config).not.toHaveProperty("asarUnpack");
	});

	test("does not ship Windows native addons on other platforms", () => {
		expect(config.linux?.files).toContain("!ts-out/native/*-win32-*.node");
		expect(config.mac?.files).toContain("!ts-out/native/*-win32-*.node");
		expect(config.win?.files).toContain("ts-out");
	});
});
