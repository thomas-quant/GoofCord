import { beforeEach, describe, expect, test } from "bun:test";

import * as harness from "./nativeHarness.ts";

const { addon, createdWindows, ipcHandlers, reset, screenshare, wasapi } = harness;

screenshare.registerScreenshareHandler();

beforeEach(reset);

// Open a picker the way Chromium would and return a function that resolves it.
function openRequest() {
	let result: any;
	harness.displayMediaHandler!({ frame: null }, (res: any) => {
		result = res;
	});
	const wcId = createdWindows.at(-1)!.webContents.id;
	return {
		select: async (id: string, audioConfig: { mode: string; pids: number[] }) => {
			await ipcHandlers.get("selectScreenshareSource")!({ sender: { id: wcId } }, id, "name", audioConfig, "motion", 720, 30);
			return result;
		},
	};
}

describe("selectScreenshareSource ↔ WASAPI ownership", () => {
	test("system audio that starts natively leaves result.audio unset", async () => {
		const res = await openRequest().select("screen:0", { mode: "system", pids: [] });
		expect(res.video.id).toBe("screen:0");
		expect(res.audio).toBeUndefined();
		expect(wasapi.currentWasapiCaptureId()).toBeDefined();
	});

	test("unsupported native capture falls back to Chromium loopback", async () => {
		addon.failExclude = true;
		const res = await openRequest().select("screen:0", { mode: "system", pids: [] });
		expect(res.audio).toBe("loopback");
	});

	test("choosing no audio stops the capture that was live when this request opened", async () => {
		await openRequest().select("screen:0", { mode: "system", pids: [] });
		expect(wasapi.currentWasapiCaptureId()).toBeDefined();

		const res = await openRequest().select("window:1", { mode: "none", pids: [] });
		expect(res.audio).toBeUndefined();
		expect(wasapi.currentWasapiCaptureId()).toBeUndefined();
	});

	test("choosing no audio on an older request never kills a newer capture", async () => {
		const older = openRequest(); // opened while nothing is capturing
		await openRequest().select("screen:0", { mode: "system", pids: [] });
		const newer = wasapi.currentWasapiCaptureId();

		await older.select("window:1", { mode: "none", pids: [] });
		expect(wasapi.currentWasapiCaptureId()).toBe(newer);
	});

	test("cancelling the picker leaves a running share's audio alone", async () => {
		await openRequest().select("screen:0", { mode: "system", pids: [] });
		const live = wasapi.currentWasapiCaptureId();

		const res = await openRequest().select("", { mode: "none", pids: [] });
		expect(res).toEqual({});
		expect(wasapi.currentWasapiCaptureId()).toBe(live);
	});
});
