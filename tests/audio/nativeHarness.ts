// Shared mocks for the main-process WASAPI lifecycle tests. Bun's module mocks are process-wide,
// so every native*.test.ts imports this one harness (evaluated once) instead of mocking twice.
import { EventEmitter } from "node:events";
import path from "node:path";

import { mock } from "bun:test";

const root = path.resolve(import.meta.dir, "../..");
const abs = (p: string) => path.join(root, p);

// wasapiLoopback.ts gates on process.platform; pretend to be Windows before it is imported.
Object.defineProperty(process, "platform", { value: "win32" });

export const OWN_CHILD_PIDS = [process.pid + 101, process.pid + 102];

// ── MessagePortMain stand-in: close() on one end emits "close" on the other (Electron semantics) ──
export class FakePort extends EventEmitter {
	other?: FakePort;
	closed = false;
	started = false;
	sent: any[] = [];

	postMessage(data: any) {
		if (this.closed) throw new Error("port closed");
		this.sent.push(data);
		const other = this.other;
		if (other && !other.closed) queueMicrotask(() => other.emit("message", { data, ports: [] }));
	}
	start() {
		this.started = true;
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		const other = this.other;
		if (other && !other.closed) queueMicrotask(() => other.emit("close"));
	}
}

class FakeMessageChannelMain {
	port1 = new FakePort();
	port2 = new FakePort();
	constructor() {
		this.port1.other = this.port2;
		this.port2.other = this.port1;
	}
}

// ── Fake addon ──
export interface FakeSession {
	id: number;
	kind: "include" | "exclude";
	pid: number;
	cb: (err: unknown, chunk?: Buffer) => void;
}

export const addon = {
	nextId: 1,
	sessions: new Map<number, FakeSession>(),
	calls: [] as string[],
	failPids: new Set<number>(),
	failExclude: false,
	apps: [] as { processId: number; displayName: string; binary: string }[],
	// Record the order of native starts vs port transfers.
	onStart: undefined as undefined | ((s: FakeSession) => void),

	start(kind: "include" | "exclude", pid: number, cb: FakeSession["cb"]) {
		this.calls.push(`${kind}:${pid}`);
		if ((kind === "exclude" && this.failExclude) || this.failPids.has(pid)) return 0;
		const s: FakeSession = { id: this.nextId++, kind, pid, cb };
		this.sessions.set(s.id, s);
		this.onStart?.(s);
		return s.id;
	},
	startExcludeProcessTree(pid: number, cb: FakeSession["cb"]) {
		return this.start("exclude", pid, cb);
	},
	startIncludeProcessTree(pid: number, cb: FakeSession["cb"]) {
		return this.start("include", pid, cb);
	},
	stopSession(id: number) {
		this.calls.push(`stop:${id}`);
		this.sessions.delete(id);
	},
	stopAll() {
		this.calls.push("stopAll");
		this.sessions.clear();
	},
	listAudioApps() {
		return this.apps;
	},
};

// ── Fake main window: records port transfers and (optionally) acks like the renderer would ──
export interface Transfer {
	channel: string;
	message: any;
	port: FakePort;
	order: number;
}

export const renderer = {
	transfers: [] as Transfer[],
	autoAck: true,
	// Messages the renderer end of each port received, keyed by captureId.
	received: new Map<number, any[]>(),
	destroyed: false,
};

let orderCounter = 0;
export const nextOrder = () => ++orderCounter;

export const mainWindow = {
	isDestroyed: () => renderer.destroyed,
	webContents: {
		isDestroyed: () => renderer.destroyed,
		postMessage(channel: string, message: any, ports: FakePort[]) {
			const port = ports[0];
			renderer.transfers.push({ channel, message, port, order: nextOrder() });
			const log: any[] = [];
			renderer.received.set(message?.captureId, log);
			port.on("message", (e: any) => log.push(e.data));
			port.start();
			if (renderer.autoAck) queueMicrotask(() => port.postMessage({ type: "ready", captureId: message.captureId }));
		},
	},
};

// ── Fake electron ──
export const appEvents = new EventEmitter();
export const quitCalls: number[] = [];

export const app = {
	getAppPath: () => "/nonexistent-goofcord",
	getAppMetrics: () => [{ pid: process.pid }, ...OWN_CHILD_PIDS.map((pid) => ({ pid }))],
	on: (event: string, fn: (...args: any[]) => void) => appEvents.on(event, fn),
	quit: () => {
		quitCalls.push(Date.now());
	},
};

export const ipcHandlers = new Map<string, (...args: any[]) => any>();
export let displayMediaHandler: ((request: any, callback: (res: any) => void) => void) | undefined;

let nextWcId = 1;
export const createdWindows: FakeBrowserWindow[] = [];
export class FakeBrowserWindow extends EventEmitter {
	webContents = { id: nextWcId++ };
	destroyed = false;
	constructor(_opts?: unknown) {
		super();
		createdWindows.push(this);
	}
	isDestroyed() {
		return this.destroyed;
	}
	close() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.emit("closed");
	}
	center() {}
	show() {}
	focus() {}
	loadFile() {
		return Promise.resolve();
	}
}

mock.module("electron", () => ({
	app,
	MessageChannelMain: FakeMessageChannelMain,
	BrowserWindow: FakeBrowserWindow,
	desktopCapturer: { getSources: async () => [] },
	ipcMain: {
		handle: (channel: string, fn: (...args: any[]) => any) => ipcHandlers.set(channel, fn),
		removeHandler: (channel: string) => ipcHandlers.delete(channel),
	},
	session: {
		defaultSession: {
			setDisplayMediaRequestHandler: (fn: typeof displayMediaHandler) => {
				displayMediaHandler = fn;
			},
		},
	},
}));

mock.module(abs("src/windows/main/main.ts"), () => ({ mainWindow }));
mock.module(abs("src/utils.ts"), () => ({ dirname: () => root, isWayland: false, relToAbs: (p: string) => p }));
mock.module(abs("src/windows/screenshare/renderer/screenshare.html"), () => ({ default: { index: "screenshare.html" } }));
mock.module(abs("src/modules/native/patchcord.ts"), () => ({
	hasPipewirePulse: false,
	patchcordList: async () => [],
	patchcordStartApp: async () => {},
	patchcordStartSystem: async () => {},
}));

export const wasapi = await import("../../src/modules/native/wasapiLoopback.ts");
wasapi.__setWasapiAddonForTesting(addon);

export const screenshare = await import("../../src/windows/screenshare/screenshare.ts");

/** Stop everything and forget recorded calls so each test starts from a clean slate. */
export async function reset() {
	await wasapi.stopWasapiLoopback();
	addon.sessions.clear();
	addon.calls = [];
	addon.failPids.clear();
	addon.failExclude = false;
	addon.apps = [];
	addon.onStart = undefined;
	renderer.transfers = [];
	renderer.received.clear();
	renderer.autoAck = true;
	renderer.destroyed = false;
	quitCalls.length = 0;
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
export const chunk = (fill = 0.5) => Buffer.from(new Float32Array(960).fill(fill).buffer);
