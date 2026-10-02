import { describe, expect, test } from "bun:test";

import { listPackage } from "@electron/asar";

import config from "../../electron-builder.ts";
import manifest from "../../package.json";

describe("electron-builder reconciliation", () => {
	test("declares the ASAR reader directly for isolated dependency installs", () => {
		expect(manifest.devDependencies["@electron/asar"]).toBe("4.1.1");
		expect(typeof listPackage).toBe("function");
	});
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
