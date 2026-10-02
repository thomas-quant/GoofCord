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

	test("a refused subtraction ships the share without audio, never Chromium loopback", async () => {
		addon.failSubtract = "process-loopback INCLUDE unavailable";
		const res = await openRequest().select("screen:0", { mode: "system", pids: [] });
		expect(res.video.id).toBe("screen:0");
		expect(res.audio).toBeUndefined();
		expect(addon.calls.some((c) => c.startsWith("exclude:"))).toBe(false);
	});

	test("an addon without the subtraction API ships the share without audio", async () => {
		(addon as any).startEndpointMinusSelf = undefined;
		const res = await openRequest().select("screen:0", { mode: "system", pids: [] });
		expect(res.audio).toBeUndefined();
		expect(wasapi.currentWasapiCaptureId()).toBeUndefined();
	});

	test("only the explicit --no-wasapi override uses Chromium loopback", async () => {
		process.argv.push("--no-wasapi");
		try {
			const res = await openRequest().select("screen:0", { mode: "system", pids: [] });
			expect(res.audio).toBe("loopback");
		} finally {
			process.argv.splice(process.argv.indexOf("--no-wasapi"), 1);
		}
		expect(addon.calls).toEqual([]);
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

	test("cancelling closes the picker even if Electron rejects the empty callback", async () => {
		await openRequest().select("screen:0", { mode: "system", pids: [] });
		const live = wasapi.currentWasapiCaptureId();
		harness.displayMediaHandler!({ frame: null }, () => {
			throw new Error("missing video");
		});
		const picker = createdWindows.at(-1)!;
		await ipcHandlers.get("selectScreenshareSource")!({ sender: { id: picker.webContents.id } }, "", "name", { mode: "none", pids: [] });
		expect(picker.isDestroyed()).toBe(true);
		expect(wasapi.currentWasapiCaptureId()).toBe(live);
	});

	test("a source enumeration failure closes the picker without stopping the running capture", async () => {
		await openRequest().select("screen:0", { mode: "system", pids: [] });
		const live = wasapi.currentWasapiCaptureId();
		harness.desktopCapturer.getSources = async () => {
			throw new Error("portal dismissed");
		};
		let cancellations = 0;
		harness.displayMediaHandler!({ frame: null }, () => {
			cancellations++;
			throw new Error("missing video");
		});
		const picker = createdWindows.at(-1)!;
		await harness.flush();
		expect(picker.isDestroyed()).toBe(true);
		expect(cancellations).toBe(1);
		expect(wasapi.currentWasapiCaptureId()).toBe(live);
	});

	test("cancelling the picker leaves a running share's audio alone", async () => {
		await openRequest().select("screen:0", { mode: "system", pids: [] });
		const live = wasapi.currentWasapiCaptureId();

		const res = await openRequest().select("", { mode: "none", pids: [] });
		expect(res).toEqual({});
		expect(wasapi.currentWasapiCaptureId()).toBe(live);
	});
});
