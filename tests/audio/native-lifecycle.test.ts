import { beforeEach, describe, expect, test } from "bun:test";

import { addon, appEvents, chunk, flush, nextOrder, OWN_CHILD_PIDS, quitCalls, renderer, reset, wasapi } from "./nativeHarness.ts";

const FAST = { readyTimeoutMs: 30 };

beforeEach(reset);

describe("startWasapiCapture transport handshake", () => {
	test("transfers the port only after native start, tagged with captureId, and waits for ready", async () => {
		let startOrder = 0;
		addon.onStart = () => {
			startOrder = nextOrder();
		};

		const outcome = await wasapi.startWasapiCapture({ mode: "system", pids: [] });

		expect(outcome).toBe("started");
		expect(addon.calls).toEqual([`exclude:${process.pid}`]);
		expect(renderer.transfers).toHaveLength(1);
		const [t] = renderer.transfers;
		expect(t.channel).toBe("wasapi:pcm-port");
		expect(typeof t.message.captureId).toBe("number");
		expect(t.order).toBeGreaterThan(startOrder);
		expect(wasapi.currentWasapiCaptureId()).toBe(t.message.captureId);
	});

	test("captureIds increase monotonically per attempt", async () => {
		await wasapi.startWasapiCapture({ mode: "system", pids: [] });
		await wasapi.startWasapiCapture({ mode: "system", pids: [] });
		const [a, b] = renderer.transfers.map((t) => t.message.captureId);
		expect(b).toBeGreaterThan(a);
	});

	test("PCM before the ready ack is dropped; after it, forwarded as {index, pcm}", async () => {
		renderer.autoAck = false;
		const pending = wasapi.startWasapiCapture({ mode: "system", pids: [] }, { readyTimeoutMs: 1000 });
		const [session] = addon.sessions.values();
		const [t] = renderer.transfers;

		session.cb(null, chunk());
		await flush();
		expect(renderer.received.get(t.message.captureId)).toEqual([]);

		t.port.postMessage({ type: "ready", captureId: t.message.captureId });
		expect(await pending).toBe("started");

		session.cb(null, chunk(0.25));
		await flush();
		const got = renderer.received.get(t.message.captureId)!;
		expect(got).toHaveLength(1);
		expect(got[0].index).toBe(0);
		expect(got[0].pcm).toBeInstanceOf(ArrayBuffer);
		expect(new Float32Array(got[0].pcm)[0]).toBe(0.25);
	});

	test("a ready ack for a different captureId does not count", async () => {
		renderer.autoAck = false;
		const pending = wasapi.startWasapiCapture({ mode: "system", pids: [] }, FAST);
		const [t] = renderer.transfers;
		t.port.postMessage({ type: "ready", captureId: t.message.captureId + 1000 });
		expect(await pending).toBe("unsupported");
	});

	test("ready timeout stops native capture and falls back (system → unsupported)", async () => {
		renderer.autoAck = false;
		const outcome = await wasapi.startWasapiCapture({ mode: "system", pids: [] }, FAST);
		expect(outcome).toBe("unsupported");
		expect(addon.sessions.size).toBe(0);
		expect(wasapi.currentWasapiCaptureId()).toBeUndefined();
		const [t] = renderer.transfers;
		await flush();
		expect(renderer.received.get(t.message.captureId)).toContainEqual({ type: "stopped", captureId: t.message.captureId });
	});

	test("ready timeout in app mode fails closed", async () => {
		renderer.autoAck = false;
		addon.apps = [{ processId: 5000, displayName: "a", binary: "a.exe" }];
		expect(await wasapi.startWasapiCapture({ mode: "app", pids: [5000] }, FAST)).toBe("failed-closed");
		expect(addon.sessions.size).toBe(0);
	});

	test("native start failure transfers no port and falls back", async () => {
		addon.failExclude = true;
		expect(await wasapi.startWasapiCapture({ mode: "system", pids: [] })).toBe("unsupported");
		expect(renderer.transfers).toHaveLength(0);
	});

	test("a destroyed main window is a transport failure, not a started capture", async () => {
		renderer.destroyed = true;
		expect(await wasapi.startWasapiCapture({ mode: "system", pids: [] })).toBe("unsupported");
		expect(addon.sessions.size).toBe(0);
	});

	test("renderer page going away (port close) stops the capture", async () => {
		await wasapi.startWasapiCapture({ mode: "system", pids: [] });
		renderer.transfers[0].port.close();
		await flush();
		expect(addon.sessions.size).toBe(0);
		expect(wasapi.currentWasapiCaptureId()).toBeUndefined();
	});
});

describe("app-mode target validation", () => {
	test("dedupes, drops invalid, own main/child/parent, and stale PIDs; fails closed when nothing is left", async () => {
		addon.apps = [5000, 6000, ...OWN_CHILD_PIDS].map((processId) => ({ processId, displayName: "x", binary: "x.exe" }));
		const outcome = await wasapi.startWasapiCapture({
			mode: "app",
			pids: [5000, 5000, -1, 0, 1.5, Number.NaN, "6000" as any, process.pid, process.ppid, ...OWN_CHILD_PIDS, 7777 /* not listed any more */, 6000],
		});
		expect(outcome).toBe("started");
		expect(addon.calls).toEqual(["include:5000", "include:6000"]);
	});

	test("only own/stale targets → failed-closed without touching native capture", async () => {
		addon.apps = OWN_CHILD_PIDS.map((processId) => ({ processId, displayName: "x", binary: "x.exe" }));
		expect(await wasapi.startWasapiCapture({ mode: "app", pids: [...OWN_CHILD_PIDS, 4242] })).toBe("failed-closed");
		expect(addon.calls).toEqual([]);
		expect(renderer.transfers).toHaveLength(0);
	});

	test("every selected app failing to activate fails closed", async () => {
		addon.apps = [{ processId: 5000, displayName: "a", binary: "a.exe" }];
		addon.failPids.add(5000);
		expect(await wasapi.startWasapiCapture({ mode: "app", pids: [5000] })).toBe("failed-closed");
		expect(renderer.transfers).toHaveLength(0);
	});

	test("listWasapiAudioApps hides our own main and child processes", () => {
		addon.apps = [5000, process.pid, ...OWN_CHILD_PIDS].map((processId) => ({ processId, displayName: "x", binary: "x.exe" }));
		expect(wasapi.listWasapiAudioApps().map((a) => a.processId)).toEqual([5000]);
	});
});

describe("stop / restart isolation", () => {
	test("a new start replaces the old capture; late PCM from the old sessions never reaches a port", async () => {
		await wasapi.startWasapiCapture({ mode: "system", pids: [] });
		const [oldSession] = addon.sessions.values();
		const oldT = renderer.transfers[0];

		await wasapi.startWasapiCapture({ mode: "system", pids: [] });
		const newT = renderer.transfers[1];

		expect(addon.calls).toContain(`stop:${oldSession.id}`);
		expect(oldT.port.closed || oldT.port.other!.closed).toBe(true);
		await flush();
		expect(renderer.received.get(oldT.message.captureId)).toContainEqual({ type: "stopped", captureId: oldT.message.captureId });

		oldSession.cb(null, chunk()); // late chunk from a stopped session
		await flush();
		expect(renderer.received.get(newT.message.captureId)!.filter((m) => m.pcm)).toHaveLength(0);
	});

	test("a stale captureId stop does not touch the newer capture", async () => {
		await wasapi.startWasapiCapture({ mode: "system", pids: [] });
		const oldId = renderer.transfers[0].message.captureId;
		await wasapi.startWasapiCapture({ mode: "system", pids: [] });
		const newId = renderer.transfers[1].message.captureId;
		addon.calls = [];

		await wasapi.stopWasapiLoopback(oldId);
		await wasapi.stopWasapiLoopback("junk" as any);
		expect(addon.calls).toEqual([]);
		expect(wasapi.currentWasapiCaptureId()).toBe(newId);

		await wasapi.stopWasapiLoopback(newId);
		expect(wasapi.currentWasapiCaptureId()).toBeUndefined();
		expect(addon.sessions.size).toBe(0);
	});

	test("unscoped stop is a full shutdown", async () => {
		await wasapi.startWasapiCapture({ mode: "system", pids: [] });
		await wasapi.stopWasapiLoopback();
		expect(addon.calls).toContain("stopAll");
		expect(wasapi.currentWasapiCaptureId()).toBeUndefined();
	});

	test("an attempt superseded while waiting for ready fails closed and leaves the newer capture alone", async () => {
		renderer.autoAck = false;
		const first = wasapi.startWasapiCapture({ mode: "system", pids: [] }, { readyTimeoutMs: 1000 });
		renderer.autoAck = true;
		const second = await wasapi.startWasapiCapture({ mode: "system", pids: [] });

		expect(await first).toBe("failed-closed");
		expect(second).toBe("started");
		expect(wasapi.currentWasapiCaptureId()).toBe(renderer.transfers[1].message.captureId);
		expect(addon.sessions.size).toBe(1);
	});

	test("a native device error on every session ends the capture", async () => {
		addon.apps = [5000, 6000].map((processId) => ({ processId, displayName: "x", binary: "x.exe" }));
		await wasapi.startWasapiCapture({ mode: "app", pids: [5000, 6000] });
		const [a, b] = addon.sessions.values();
		const id = renderer.transfers[0].message.captureId;

		a.cb(new Error("device invalidated"));
		expect(wasapi.currentWasapiCaptureId()).toBe(id);
		b.cb(new Error("device invalidated"));
		expect(wasapi.currentWasapiCaptureId()).toBeUndefined();
	});
});

describe("before-quit", () => {
	test("stops a live capture once and does not recurse after app.quit()", async () => {
		await wasapi.startWasapiCapture({ mode: "system", pids: [] });

		let prevented = 0;
		const event = { preventDefault: () => prevented++ };
		appEvents.emit("before-quit", event);
		expect(prevented).toBe(1);
		await new Promise((r) => setTimeout(r, 10));
		expect(quitCalls).toHaveLength(1);
		expect(addon.sessions.size).toBe(0);

		// app.quit() re-emits before-quit; the addon is still loaded but nothing is running.
		appEvents.emit("before-quit", event);
		expect(prevented).toBe(1);
	});

	test("does nothing when no capture is running even though the addon is loaded", () => {
		let prevented = 0;
		appEvents.emit("before-quit", { preventDefault: () => prevented++ });
		expect(prevented).toBe(0);
	});
});
