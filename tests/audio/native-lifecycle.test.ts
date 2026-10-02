import { beforeEach, describe, expect, test } from "bun:test";

import { addon, appEvents, chunk, flush, mainWindow, nextOrder, notifications, OWN_CHILD_PIDS, quitCalls, renderer, reset, startCapture, processes, identities, wasapi } from "./nativeHarness.ts";

const FAST = { readyTimeoutMs: 30 };
const EXCLUDE_SELF = `exclude:${process.pid}`;
const noSubtraction = () => expect(addon.calls.filter((c) => c.startsWith("subtract:"))).toEqual([]);

beforeEach(reset);

describe("startWasapiCapture transport handshake", () => {
	test("transfers the port only after native start, tagged with captureId, and waits for ready", async () => {
		let startOrder = 0;
		addon.onStart = () => {
			startOrder = nextOrder();
		};

		const outcome = await startCapture({ mode: "system", pids: [] });

		expect(outcome).toBe("started");
		expect(addon.calls).toEqual([EXCLUDE_SELF]);
		expect(renderer.transfers).toHaveLength(1);
		const [t] = renderer.transfers;
		expect(t.channel).toBe("wasapi:pcm-port");
		expect(typeof t.message.captureId).toBe("number");
		expect(t.order).toBeGreaterThan(startOrder);
		expect(wasapi.currentWasapiCaptureId()).toBe(t.message.captureId);
	});

	test("captureIds increase monotonically per attempt", async () => {
		await startCapture({ mode: "system", pids: [] });
		await startCapture({ mode: "system", pids: [] });
		const [a, b] = renderer.transfers.map((t) => t.message.captureId);
		expect(b).toBeGreaterThan(a);
	});

	test("PCM before the ready ack is dropped; after it, forwarded as {index, pcm}", async () => {
		renderer.autoAck = false;
		const pending = startCapture({ mode: "system", pids: [] }, { readyTimeoutMs: 1000 });
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
		const pending = startCapture({ mode: "system", pids: [] }, FAST);
		const [t] = renderer.transfers;
		t.port.postMessage({ type: "ready", captureId: t.message.captureId + 1000 });
		expect(await pending).toBe("failed-closed");
	});

	test("ready timeout stops native capture and fails closed in system mode too", async () => {
		renderer.autoAck = false;
		const outcome = await startCapture({ mode: "system", pids: [] }, FAST);
		expect(outcome).toBe("failed-closed");
		expect(addon.sessions.size).toBe(0);
		expect(wasapi.currentWasapiCaptureId()).toBeUndefined();
		const [t] = renderer.transfers;
		await flush();
		expect(renderer.received.get(t.message.captureId)).toContainEqual({ type: "stopped", captureId: t.message.captureId });
		expect(notifications).toHaveLength(1);
		noSubtraction();
	});

	test("ready timeout in app mode fails closed", async () => {
		renderer.autoAck = false;
		addon.apps = [{ processId: 5000, displayName: "a", binary: "a.exe" }];
		expect(await startCapture({ mode: "app", pids: [5000] }, FAST)).toBe("failed-closed");
		expect(addon.sessions.size).toBe(0);
		expect(notifications).toHaveLength(1);
	});

	test("a destroyed main window is a transport failure, not a started capture", async () => {
		renderer.destroyed = true;
		expect(await startCapture({ mode: "system", pids: [] })).toBe("failed-closed");
		expect(addon.sessions.size).toBe(0);
	});

	test("renderer page going away (port close) stops the capture", async () => {
		await startCapture({ mode: "system", pids: [] });
		renderer.transfers[0].port.close();
		await flush();
		expect(addon.sessions.size).toBe(0);
		expect(wasapi.currentWasapiCaptureId()).toBeUndefined();
	});
});

describe("system mode: EXCLUDE own main tree, never subtraction", () => {
	test("starts one EXCLUDE session for the main PID", async () => {
		expect(await startCapture({ mode: "system", pids: [] })).toBe("started");
		expect(addon.calls).toEqual([EXCLUDE_SELF]);
		expect([...addon.sessions.values()].map((s) => s.kind)).toEqual(["exclude"]);
		expect(notifications).toEqual([]);
	});

	test("refused activation fails closed with a visible reason", async () => {
		addon.failPids.add(process.pid);
		expect(await startCapture({ mode: "system", pids: [] })).toBe("failed-closed");
		expect(addon.calls).toEqual([EXCLUDE_SELF]);
		expect(renderer.transfers).toHaveLength(0);
		expect(notifications[0].body).toContain("Windows refused");
	});

	test("missing EXCLUDE fails closed", async () => {
		(addon as any).startExcludeProcessTree = undefined;
		expect(await startCapture({ mode: "system", pids: [] })).toBe("failed-closed");
		expect(addon.calls).toEqual([]);
		expect(notifications[0].body).toContain("startExcludeProcessTree");
	});

	test("native fault stops system audio and notifies once", async () => {
		await startCapture({ mode: "system", pids: [] });
		const [session] = addon.sessions.values();
		session.cb(new Error("device invalidated"));
		session.cb(new Error("late"));
		expect(wasapi.currentWasapiCaptureId()).toBeUndefined();
		expect(addon.sessions.size).toBe(0);
		expect(notifications).toHaveLength(1);
		expect(notifications[0].body).toContain("device invalidated");
	});

	test("--no-wasapi keeps the explicit Chromium override without touching the addon", async () => {
		process.argv.push("--no-wasapi");
		try {
			expect(await startCapture({ mode: "system", pids: [] })).toBe("unsupported");
		} finally {
			process.argv.splice(process.argv.indexOf("--no-wasapi"), 1);
		}
		expect(addon.calls).toEqual([]);
		expect(notifications).toEqual([]);
	});
});

describe("win32 arches without a shipped addon", () => {
	for (const arch of ["arm64", "ia32"]) {
		test(`${arch} keeps Chromium loopback: unsupported, no addon call, no notification`, async () => {
			Object.defineProperty(process, "arch", { value: arch, configurable: true });
			try {
				expect(await startCapture({ mode: "system", pids: [] })).toBe("unsupported");
				expect(wasapi.isWasapiAvailable()).toBe(false);
				expect(wasapi.shouldInjectWasapiTransport()).toBe(false);
				expect(wasapi.listWasapiAudioApps()).toEqual([]);
			} finally {
				Object.defineProperty(process, "arch", { value: "x64", configurable: true });
			}
			expect(addon.calls).toEqual([]);
			expect(notifications).toEqual([]);
		});
	}
});

describe("app-mode target validation", () => {
	test("dedupes selected identities without adding roots", async () => {
		addon.apps = [5000, 6000].map((processId) => ({ processId, displayName: "x", binary: "x.exe" }));
		expect(await startCapture({ mode: "app", pids: [5000, 5000, 6000] })).toBe("started");
		expect(addon.calls).toEqual(["include:5000", "include:6000"]);
	});

	test("only own/stale targets → failed-closed without touching native capture", async () => {
		addon.apps = OWN_CHILD_PIDS.map((processId) => ({ processId, displayName: "x", binary: "x.exe" }));
		expect(await startCapture({ mode: "app", pids: [...OWN_CHILD_PIDS, 4242] })).toBe("failed-closed");
		expect(addon.calls).toEqual([]);
		expect(renderer.transfers).toHaveLength(0);
		expect(notifications).toHaveLength(1);
		expect(notifications[0].body).toContain("re-pick");
	});

	test("every selected app failing to activate fails closed", async () => {
		addon.apps = [{ processId: 5000, displayName: "a", binary: "a.exe" }];
		addon.failPids.add(5000);
		expect(await startCapture({ mode: "app", pids: [5000] })).toBe("failed-closed");
		expect(renderer.transfers).toHaveLength(0);
		expect(notifications).toHaveLength(1);
		expect(notifications[0].body).toContain("refused to capture audio from the selected app.");
	});

	test("a partial app start keeps successful apps and notifies", async () => {
		addon.apps = [5000, 6000].map((processId) => ({ processId, displayName: "x", binary: "x.exe" }));
		addon.failPids.add(5000);
		expect(await startCapture({ mode: "app", pids: [5000, 6000] })).toBe("started");
		expect(notifications).toHaveLength(1);
	});

	test("listWasapiAudioApps hides our own main and child processes", () => {
		addon.apps = [5000, process.pid, ...OWN_CHILD_PIDS].map((processId) => ({ processId, displayName: "x", binary: "x.exe" }));
		expect(wasapi.listWasapiAudioApps().map((a) => a.processId)).toEqual([5000]);
	});
});

describe("stop / restart isolation", () => {
	test("a new start replaces the old capture; late PCM from the old sessions never reaches a port", async () => {
		await startCapture({ mode: "system", pids: [] });
		const [oldSession] = addon.sessions.values();
		const oldT = renderer.transfers[0];

		await startCapture({ mode: "system", pids: [] });
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
		await startCapture({ mode: "system", pids: [] });
		const oldId = renderer.transfers[0].message.captureId;
		await startCapture({ mode: "system", pids: [] });
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
		await startCapture({ mode: "system", pids: [] });
		await wasapi.stopWasapiLoopback();
		expect(addon.calls).toContain("stopAll");
		expect(wasapi.currentWasapiCaptureId()).toBeUndefined();
	});

	test("an attempt superseded while waiting for ready fails closed and leaves the newer capture alone", async () => {
		renderer.autoAck = false;
		const first = startCapture({ mode: "system", pids: [] }, { readyTimeoutMs: 1000 });
		renderer.autoAck = true;
		const second = await startCapture({ mode: "system", pids: [] });

		expect(await first).toBe("failed-closed");
		expect(second).toBe("started");
		expect(wasapi.currentWasapiCaptureId()).toBe(renderer.transfers[1].message.captureId);
		expect(addon.sessions.size).toBe(1);
	});

	test("a native device error on every session ends the capture", async () => {
		addon.apps = [5000, 6000].map((processId) => ({ processId, displayName: "x", binary: "x.exe" }));
		await startCapture({ mode: "app", pids: [5000, 6000] });
		const [a, b] = addon.sessions.values();
		const id = renderer.transfers[0].message.captureId;

		a.cb(new Error("device invalidated"));
		expect(wasapi.currentWasapiCaptureId()).toBe(id);
		expect(notifications).toHaveLength(1);
		b.cb(new Error("device invalidated"));
		expect(wasapi.currentWasapiCaptureId()).toBeUndefined();
		expect(notifications).toHaveLength(2);
		expect(notifications[0].body).toContain("device invalidated");
	});
});

describe("before-quit", () => {
	test("stops a live capture once and does not recurse after app.quit()", async () => {
		await startCapture({ mode: "system", pids: [] });

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

describe("request-bound identity and async lifecycle", () => {
	beforeEach(() => {
		addon.apps = [{ processId: 5000, displayName: "a", binary: "a.exe" }];
	});

	test("a recycled PID between picker and activation fails closed", async () => {
		const trusted = identities();
		processes.query = async () => {
			const s = identities();
			s.get(5000)!.created = "200";
			return s;
		};
		expect(await wasapi.startWasapiCapture({ mode: "app", pids: [5000] }, { identities: trusted })).toBe("failed-closed");
		expect(addon.calls).toEqual([]);
	});

	test("no trusted picker snapshot, failed OS lookup, or missing session enumeration never captures", async () => {
		expect(await wasapi.startWasapiCapture({ mode: "app", pids: [5000] })).toBe("failed-closed");
		processes.query = async () => {
			throw new Error("CIM denied");
		};
		expect(await startCapture({ mode: "app", pids: [5000] })).toBe("failed-closed");
		processes.query = async () => identities();
		(addon as any).listAudioApps = undefined;
		expect(await startCapture({ mode: "app", pids: [5000] })).toBe("failed-closed");
		expect(addon.calls).toEqual([]);
	});

	for (const action of ["replace", "stop"] as const) {
		test(`${action} during identity lookup cannot revive the old attempt`, async () => {
			let release!: (s: ReturnType<typeof identities>) => void;
			processes.query = () =>
				new Promise((resolve) => {
					release = resolve;
				});
			const first = startCapture({ mode: "app", pids: [5000] });
			if (action === "replace") await startCapture({ mode: "system", pids: [] });
			else await wasapi.stopWasapiLoopback();
			release(identities());
			expect(await first).toBe("failed-closed");
			expect(addon.calls).not.toContain("include:5000");
			expect(addon.sessions.size).toBe(action === "replace" ? 1 : 0);
		});
	}

	test("explicit override and unsupported arch do not broaden app-only requests", async () => {
		process.argv.push("--no-wasapi");
		try {
			expect(await startCapture({ mode: "app", pids: [5000] })).toBe("failed-closed");
		} finally {
			process.argv.splice(process.argv.indexOf("--no-wasapi"), 1);
		}
		Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
		try {
			expect(await startCapture({ mode: "app", pids: [5000] })).toBe("failed-closed");
		} finally {
			Object.defineProperty(process, "arch", { value: "x64", configurable: true });
		}
		expect(addon.calls).toEqual([]);
	});
});

describe("main renderer document lifecycle", () => {
	const events = ["did-start-navigation", "render-process-gone", "destroyed"];
	const expectDetached = () => {
		for (const event of events) expect(mainWindow.webContents.listenerCount(event)).toBe(0);
	};
	for (const event of events) {
		test(`${event} cancels pending identity lookup before a port exists`, async () => {
			addon.apps = [{ processId: 5000, displayName: "a", binary: "a.exe" }];
			let release!: (s: ReturnType<typeof identities>) => void;
			processes.query = () =>
				new Promise((resolve) => {
					release = resolve;
				});
			const pending = startCapture({ mode: "app", pids: [5000] });
			expect(mainWindow.webContents.listenerCount(event)).toBe(1);
			mainWindow.webContents.emit(event, { isMainFrame: true, isSameDocument: false });
			expect(wasapi.currentWasapiCaptureId()).toBeUndefined();
			expectDetached();
			release(identities());
			expect(await pending).toBe("failed-closed");
			expect(addon.sessions.size).toBe(0);
			expect(renderer.transfers).toHaveLength(0);
		});
	}

	test("iframe and same-document SPA navigation leave capture running", async () => {
		await startCapture({ mode: "system", pids: [] });
		const id = wasapi.currentWasapiCaptureId();
		mainWindow.webContents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
		mainWindow.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
		expect(wasapi.currentWasapiCaptureId()).toBe(id);
		mainWindow.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
		expect(addon.sessions.size).toBe(0);
		expectDetached();
	});

	test("replacement detaches old listeners; late old events do not kill the new capture", async () => {
		await startCapture({ mode: "system", pids: [] });
		const oldListeners = mainWindow.webContents.listeners("render-process-gone");
		await startCapture({ mode: "system", pids: [] });
		const id = wasapi.currentWasapiCaptureId();
		for (const listener of oldListeners) listener();
		expect(wasapi.currentWasapiCaptureId()).toBe(id);
		for (const event of events) expect(mainWindow.webContents.listenerCount(event)).toBe(1);
		await wasapi.stopWasapiLoopback();
		await wasapi.stopWasapiLoopback();
		expectDetached();
	});

	test("activation refusal and readiness timeout also detach listeners", async () => {
		addon.failPids.add(process.pid);
		expect(await startCapture({ mode: "system", pids: [] })).toBe("failed-closed");
		expectDetached();
		addon.failPids.clear();
		renderer.autoAck = false;
		expect(await startCapture({ mode: "system", pids: [] }, FAST)).toBe("failed-closed");
		expectDetached();
	});
});
