import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkWasapiExports, removeStaleAddonFile, validateWasapiAddon, WasapiValidationError } from "../../build/validateWasapiAddon.ts";

// A fully-shaped fake addon matching src/modules/native/wasapiLoopback.ts's WasapiAddon contract.
function fakeAddon(overrides: Record<string, unknown> = {}) {
	return {
		startExcludeProcessTree: () => 1,
		startIncludeProcessTree: () => 1,
		startEndpointMinusSelf: () => 1,
		getSubtractionStatus: () => null,
		getLastSubtractionStartError: () => null,
		stopSession: () => {},
		stopAll: () => {},
		listAudioApps: () => [],
		listRenderEndpoints: () => [],
		getCaptureStats: () => undefined,
		...overrides,
	};
}

const noopLog = { warn: () => {} };

describe("checkWasapiExports", () => {
	test("reports nothing missing for a fully-shaped addon", () => {
		expect(checkWasapiExports(fakeAddon())).toEqual({ missingRequired: [], missingDiagnostic: [] });
	});

	test("buckets a missing product-required export separately from a missing diagnostic one", () => {
		const addon = fakeAddon({ stopSession: undefined, getCaptureStats: undefined });
		expect(checkWasapiExports(addon)).toEqual({
			missingRequired: ["stopSession"],
			missingDiagnostic: ["getCaptureStats"],
		});
	});

	test("treats a null/undefined addon as missing every export", () => {
		const result = checkWasapiExports(undefined);
		expect(result.missingRequired.length).toBeGreaterThan(0);
		expect(result.missingDiagnostic.length).toBeGreaterThan(0);
	});

	test("the endpoint-minus-self API is required; EXCLUDE is diagnostics-only now", () => {
		const addon = fakeAddon({ startEndpointMinusSelf: undefined, getSubtractionStatus: undefined, getLastSubtractionStartError: undefined, startExcludeProcessTree: undefined });
		expect(checkWasapiExports(addon)).toEqual({
			missingRequired: ["startEndpointMinusSelf", "getSubtractionStatus", "getLastSubtractionStartError"],
			missingDiagnostic: ["startExcludeProcessTree"],
		});
	});

	test("does not accept a non-function property with the right name", () => {
		const addon = fakeAddon({ listAudioApps: "not a function" });
		expect(checkWasapiExports(addon).missingRequired).toContain("listAudioApps");
	});
});

describe("validateWasapiAddon", () => {
	const winX64 = { targetPlatform: "win32", targetArch: "x64" };

	test("is a no-op for a non-win32/x64 target even when the addon file is absent", () => {
		expect(() =>
			validateWasapiAddon({
				targetPlatform: "linux",
				targetArch: "x64",
				addonPath: "/does/not/exist.node",
				fileExists: () => false,
			}),
		).not.toThrow();
	});

	test("is a no-op for win32/ia32 (no committed prebuild for that arch)", () => {
		expect(() =>
			validateWasapiAddon({
				targetPlatform: "win32",
				targetArch: "ia32",
				addonPath: "/does/not/exist.node",
				fileExists: () => false,
			}),
		).not.toThrow();
	});

	test("fails closed when win32/x64 is targeted but nothing was staged", () => {
		expect(() =>
			validateWasapiAddon({
				...winX64,
				addonPath: "/staged/wasapi-loopback-win32-x64.node",
				fileExists: () => false,
				log: noopLog,
			}),
		).toThrow(WasapiValidationError);
	});

	test("skips export loading (without failing) when building win32/x64 from a non-Windows host", () => {
		let warned = "";
		expect(() =>
			validateWasapiAddon({
				...winX64,
				addonPath: "/staged/wasapi-loopback-win32-x64.node",
				fileExists: () => true,
				hostPlatform: "linux",
				loadAddon: () => {
					throw new Error("must not attempt to load a win32 addon from a linux host");
				},
				log: { warn: (msg: string) => (warned = msg) },
			}),
		).not.toThrow();
		expect(warned).toContain("linux");
	});

	test("fails when the staged addon throws on load (corrupt / wrong ABI)", () => {
		expect(() =>
			validateWasapiAddon({
				...winX64,
				addonPath: "/staged/wasapi-loopback-win32-x64.node",
				fileExists: () => true,
				hostPlatform: "win32",
				loadAddon: () => {
					throw new Error("The specified module could not be found.");
				},
				log: noopLog,
			}),
		).toThrow(WasapiValidationError);
	});

	test("fails when the staged addon is missing a product-required session export", () => {
		expect(() =>
			validateWasapiAddon({
				...winX64,
				addonPath: "/staged/wasapi-loopback-win32-x64.node",
				fileExists: () => true,
				hostPlatform: "win32",
				loadAddon: () => fakeAddon({ startIncludeProcessTree: undefined }),
				log: noopLog,
			}),
		).toThrow(/startIncludeProcessTree/);
	});

	test("fails for a staged addon that predates endpoint-minus-self (system audio would be silent)", () => {
		expect(() =>
			validateWasapiAddon({
				...winX64,
				addonPath: "/staged/wasapi-loopback-win32-x64.node",
				fileExists: () => true,
				hostPlatform: "win32",
				loadAddon: () => fakeAddon({ startEndpointMinusSelf: undefined }),
				log: noopLog,
			}),
		).toThrow(/startEndpointMinusSelf/);
	});

	test("warns but does not fail when only diagnostics-only exports are missing", () => {
		let warned = "";
		expect(() =>
			validateWasapiAddon({
				...winX64,
				addonPath: "/staged/wasapi-loopback-win32-x64.node",
				fileExists: () => true,
				hostPlatform: "win32",
				loadAddon: () => fakeAddon({ listRenderEndpoints: undefined, getCaptureStats: undefined }),
				log: { warn: (msg: string) => (warned = msg) },
			}),
		).not.toThrow();
		expect(warned).toContain("listRenderEndpoints");
		expect(warned).toContain("getCaptureStats");
	});

	test("passes cleanly for a fully-shaped addon on a win32 host", () => {
		expect(() =>
			validateWasapiAddon({
				...winX64,
				addonPath: "/staged/wasapi-loopback-win32-x64.node",
				fileExists: () => true,
				hostPlatform: "win32",
				loadAddon: () => fakeAddon(),
				log: noopLog,
			}),
		).not.toThrow();
	});
});

describe("removeStaleAddonFile (staging behavior)", () => {
	const tmpFiles: string[] = [];

	afterEach(async () => {
		await Promise.all(tmpFiles.splice(0).map((f) => fs.promises.rm(f, { force: true })));
	});

	test("deletes a leftover staged file from a previous, now-failed build", async () => {
		const dest = path.join(os.tmpdir(), `goofcord-wasapi-stale-${Date.now()}-${Math.random().toString(36).slice(2)}.node`);
		tmpFiles.push(dest);
		await fs.promises.writeFile(dest, "stale-previous-build");

		await removeStaleAddonFile(dest);

		expect(fs.existsSync(dest)).toBe(false);
	});

	test("is a no-op when there is nothing staged to remove", async () => {
		const dest = path.join(os.tmpdir(), `goofcord-wasapi-missing-${Date.now()}-${Math.random().toString(36).slice(2)}.node`);
		await expect(removeStaleAddonFile(dest)).resolves.toBeUndefined();
	});
});
