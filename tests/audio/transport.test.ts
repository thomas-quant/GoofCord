// Runs the exact serialized main-world source (what preload injects) inside a vm context whose only
// global is a fake `window`. Fakes follow real MediaStreamTrack semantics: stop() does NOT fire "ended".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import vm from "node:vm";

import { createWasapiPortForwarder, wasapiTransportMainWorldSource } from "../../src/windows/main/preload/wasapiTransport.ts";

const ORIGIN = "https://discord.com";
const MIX_LEN = 960;

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
beforeAll(() => process.on("unhandledRejection", onUnhandled));
afterAll(() => process.off("unhandledRejection", onUnhandled));

const flush = () => new Promise((r) => setTimeout(r, 0));

class FakeTrack extends EventTarget {
	readyState = "live";
	stopCalls = 0;
	constructor(public kind: string) {
		super();
	}
	stop() {
		this.stopCalls++;
		this.readyState = "ended"; // real tracks: no "ended" event on stop()
	}
}

class FakeAudioData {
	closed = false;
	constructor(public init: Record<string, unknown>) {}
	close() {
		this.closed = true;
	}
}

class FakeWriter {
	written: FakeAudioData[] = [];
	manual: { resolve: () => void; reject: (e: unknown) => void }[] = [];
	mode: "resolve" | "manual" | "reject" = "resolve";
	aborted = false;
	private rejectClosed!: (e: unknown) => void;
	closed = new Promise<void>((_, reject) => {
		this.rejectClosed = reject;
	});
	write(ad: FakeAudioData): Promise<void> {
		if (this.aborted) return Promise.reject(new TypeError("aborted"));
		this.written.push(ad);
		if (this.mode === "reject") return Promise.reject(new DOMException("write failed", "InvalidStateError"));
		if (this.mode === "manual") return new Promise((resolve, reject) => this.manual.push({ resolve, reject }));
		return Promise.resolve();
	}
	abort() {
		this.aborted = true;
		this.rejectClosed(new TypeError("aborted"));
		return Promise.resolve();
	}
}

class FakeGenerator extends FakeTrack {
	writer = new FakeWriter();
	writable = { getWriter: () => this.writer };
	endedEvents = 0;
	constructor(init: { kind: string }) {
		super(init.kind);
		this.addEventListener("ended", () => this.endedEvents++);
	}
}

class FakeStream {
	constructor(public tracks: FakeTrack[]) {}
	getAudioTracks() {
		return this.tracks.filter((t) => t.kind === "audio");
	}
	getVideoTracks() {
		return this.tracks.filter((t) => t.kind === "video");
	}
	getTracks() {
		return [...this.tracks];
	}
	addTrack(t: FakeTrack) {
		this.tracks.push(t);
	}
	removeTrack(t: FakeTrack) {
		this.tracks = this.tracks.filter((x) => x !== t);
	}
}

class FakePort extends EventTarget {
	onmessage: ((e: { data: unknown }) => void) | null = null;
	sent: unknown[] = [];
	closed = false;
	start() {}
	postMessage(m: unknown) {
		this.sent.push(m);
	}
	close() {
		this.closed = true;
	}
	// what main would send down its end of the channel
	deliver(data: unknown) {
		this.onmessage?.({ data });
	}
}

class FakeWindow extends EventTarget {
	location = { origin: ORIGIN };
	Event = Event;
	posted: unknown[] = [];
	postMessage(data: unknown, _target: string, ports: unknown[] = []) {
		this.posted.push(data);
		this.dispatchFrom(this, ORIGIN, data, ports);
	}
	dispatchFrom(source: unknown, origin: string, data: unknown, ports: unknown[] = []) {
		const e = new Event("message");
		Object.assign(e, { data, ports, origin, source });
		this.dispatchEvent(e);
	}
}

interface Deferred {
	resolve: (s: FakeStream) => void;
	reject: (e: unknown) => void;
}

function makeEnv(opts: { generator?: boolean; bridge?: boolean } = {}) {
	const win = new FakeWindow() as FakeWindow & Record<string, unknown>;
	const generators: FakeGenerator[] = [];
	const stops: (number | undefined)[] = [];
	const gdmCalls: Deferred[] = [];
	const intervals = new Map<number, () => void>();
	const timeouts = new Map<number, () => void>();
	let nextTimer = 1;

	if (opts.bridge !== false) win.goofcord = { stopWasapiLoopback: (id?: number) => (stops.push(id), Promise.resolve()) };
	if (opts.generator !== false) {
		win.MediaStreamTrackGenerator = class extends FakeGenerator {
			constructor(init: { kind: string }) {
				super(init);
				generators.push(this);
			}
		};
		win.AudioData = FakeAudioData;
	}
	win.setInterval = (fn: () => void) => (intervals.set(nextTimer, fn), nextTimer++);
	win.clearInterval = (id: number) => intervals.delete(id);
	win.setTimeout = (fn: () => void) => (timeouts.set(nextTimer, fn), nextTimer++);
	win.clearTimeout = (id: number) => timeouts.delete(id);
	win.navigator = {
		mediaDevices: {
			getDisplayMedia: () => new Promise<FakeStream>((resolve, reject) => gdmCalls.push({ resolve, reject })),
		},
	};

	vm.runInContext(wasapiTransportMainWorldSource, vm.createContext({ window: win }));

	return {
		win,
		generators,
		stops,
		gdmCalls,
		intervals,
		timeouts,
		gdm: () => (win.navigator as { mediaDevices: { getDisplayMedia: () => Promise<FakeStream> } }).mediaDevices.getDisplayMedia(),
		// real ticks are ~10ms apart, so settled writes resolve between them
		async drain(n = 1) {
			for (let i = 0; i < n; i++) {
				for (const fn of Array.from(intervals.values())) fn(); // snapshot: ticks add/clear timers
				await flush();
			}
		},
		fireTimeouts() {
			for (const [id, fn] of Array.from(timeouts)) {
				timeouts.delete(id);
				fn();
			}
		},
		// main: native capture started → forward the port (preload hop included)
		port(captureId: number) {
			const p = new FakePort();
			win.postMessage({ type: "goofcord:wasapi-pcm-port", captureId }, "*", [p]);
			return p;
		},
	};
}

function pcm(value: number): ArrayBuffer {
	return new Float32Array(MIX_LEN).fill(value).buffer;
}

function videoStream() {
	const video = new FakeTrack("video");
	return { video, stream: new FakeStream([video]) };
}

// One full share with audio: request → port+ack → stream resolves with our generator attached.
async function audioShare(env: ReturnType<typeof makeEnv>, captureId: number) {
	const request = env.gdm();
	const port = env.port(captureId);
	const { video, stream } = videoStream();
	env.gdmCalls.at(-1)!.resolve(stream);
	await request;
	return { port, video, stream, gen: env.generators.at(-1)! };
}

describe("main-world transport", () => {
	test("page load: readiness only — no generator, no timers", () => {
		const env = makeEnv();
		expect(env.win.posted).toEqual(["goofcord:wasapi-ready"]);
		expect(env.generators.length).toBe(0);
		expect(env.intervals.size).toBe(0);
		expect(env.timeouts.size).toBe(0);
	});

	test("port arrival creates fresh state, then acks with its captureId", async () => {
		const env = makeEnv();
		const port = env.port(1);
		expect(env.generators.length).toBe(1);
		expect(env.intervals.size).toBe(1);
		expect(port.sent).toEqual([{ type: "ready", captureId: 1 }]);
		// handlers were installed before the ack: the first chunk after it is fed
		port.deliver({ index: 0, pcm: pcm(0.5) });
		await env.drain();
		const init = env.generators[0].writer.written[0].init;
		expect((init.data as Float32Array)[0]).toBe(0.5);
		expect(init.timestamp).toBe(0);
	});

	test("two share cycles with realistic track.stop(): fresh generator each time", async () => {
		const env = makeEnv();

		const one = await audioShare(env, 1);
		expect(one.stream.getAudioTracks()).toEqual([one.gen]);
		await env.drain(3);
		expect(one.gen.writer.written.map((a) => a.init.timestamp)).toEqual([0, 10000, 20000]);

		// Discord's normal stop: stop() every track, no "ended" events
		for (const t of one.stream.getTracks()) t.stop();
		expect(env.stops).toEqual([1]);
		expect(env.intervals.size).toBe(0);
		expect(one.port.closed).toBe(true);
		// video stopped first, so the audio source ended under the track: exactly one real "ended",
		// and the gen.stop() that follows is a no-op
		expect(one.gen.endedEvents).toBe(1);
		expect(one.gen.readyState).toBe("ended");

		const two = await audioShare(env, 2);
		expect(two.gen).not.toBe(one.gen);
		expect(two.stream.getAudioTracks()).toEqual([two.gen]);
		await env.drain(2);
		expect(two.gen.writer.written.map((a) => a.init.timestamp)).toEqual([0, 10000]);
		expect(one.gen.writer.written.length).toBe(3);
	});

	test("stale stops and late messages from an old session never touch the new one", async () => {
		const env = makeEnv();
		const one = await audioShare(env, 1);
		const oldHandler = one.port.onmessage!;
		one.gen.stop();
		expect(one.gen.endedEvents).toBe(0); // consumer stopped the track itself: stop() fires no ended
		expect(env.stops).toEqual([1]);
		const two = await audioShare(env, 2);

		one.gen.stop();
		one.video.stop();
		one.video.dispatchEvent(new Event("ended"));
		oldHandler({ data: { index: 0, pcm: pcm(0.9) } });
		oldHandler({ data: { type: "stopped", captureId: 2 } });
		two.port.deliver({ type: "stopped", captureId: 1 }); // wrong id on the live port

		expect(env.stops).toEqual([1]);
		expect(two.gen.readyState).toBe("live");
		expect(env.intervals.size).toBe(1);
		await env.drain();
		expect((two.gen.writer.written[0].init.data as Float32Array)[0]).toBe(0);

		// an older or malformed port is closed and ignored
		const stale = env.port(1);
		const bad = env.port(Number.NaN);
		expect(stale.closed && bad.closed).toBe(true);
		expect(stale.sent.length + bad.sent.length).toBe(0);
		expect(env.generators.length).toBe(2);
	});

	test("main 'stopped' ends the session with a real ended event and no stop echo", async () => {
		const env = makeEnv();
		const { port, gen } = await audioShare(env, 1);
		port.deliver({ type: "stopped", captureId: 1 });
		expect(gen.readyState).toBe("ended");
		expect(gen.endedEvents).toBe(1);
		expect(env.stops).toEqual([]);
		expect(env.intervals.size).toBe(0);
		expect(port.closed).toBe(true);
	});

	test("replacement port ends the previous session and the old track", async () => {
		const env = makeEnv();
		const one = await audioShare(env, 1);
		env.port(2);
		expect(one.gen.readyState).toBe("ended");
		expect(one.gen.endedEvents).toBe(1);
		expect(env.stops).toEqual([]);
		expect(env.intervals.size).toBe(1);
	});

	test("an audio-none share never inherits a live or orphaned session", async () => {
		const env = makeEnv();
		const live = await audioShare(env, 1);

		const req = env.gdm();
		const none = videoStream();
		env.gdmCalls.at(-1)!.resolve(none.stream);
		expect(await req).toBe(none.stream);
		expect(none.stream.getAudioTracks()).toEqual([]);
		expect(live.gen.readyState).toBe("live");

		// a port that arrived with no request pending is not claimed by a later request
		live.gen.stop();
		const orphan = env.port(2);
		const req2 = env.gdm();
		const none2 = videoStream();
		env.gdmCalls.at(-1)!.resolve(none2.stream);
		await req2;
		expect(none2.stream.getAudioTracks()).toEqual([]);
		expect(orphan.closed).toBe(true);
		expect(env.stops).toEqual([1, 2]);
	});

	test("unclaimed port with nothing pending is reaped by the claim timeout", () => {
		const env = makeEnv();
		const port = env.port(1);
		env.fireTimeouts();
		expect(port.closed).toBe(true);
		expect(env.stops).toEqual([1]);
		expect(env.intervals.size).toBe(0);
	});

	test("rejected request stops its capture, but not while another request is pending", async () => {
		const env = makeEnv();

		const rejected = env.gdm();
		const port1 = env.port(1);
		env.gdmCalls[0].reject(new DOMException("denied", "NotAllowedError"));
		await expect(rejected).rejects.toThrow("denied");
		expect(port1.closed).toBe(true);
		expect(env.stops).toEqual([1]);

		// concurrent: A pending, B pending; B rejects, A's session must survive and attach
		const a = env.gdm();
		const b = env.gdm();
		const port2 = env.port(2);
		env.gdmCalls[2].reject(new DOMException("cancelled", "AbortError"));
		await expect(b).rejects.toThrow("cancelled");
		env.fireTimeouts(); // claim timeout must not reap while A is still pending
		expect(port2.closed).toBe(false);
		const { stream } = videoStream();
		env.gdmCalls[1].resolve(stream);
		await a;
		expect(stream.getAudioTracks()).toEqual([env.generators.at(-1)!]);
		expect(env.stops).toEqual([1]);
	});

	test("fallback: no port ⇒ Chromium's audio is left in place", async () => {
		const env = makeEnv();
		const req = env.gdm();
		const loopback = new FakeTrack("audio");
		const stream = new FakeStream([new FakeTrack("video"), loopback]);
		env.gdmCalls[0].resolve(stream);
		await req;
		expect(stream.getAudioTracks()).toEqual([loopback]);
		expect(loopback.readyState).toBe("live");
	});

	test("without Insertable Streams or bridge the page is untouched and never ready", () => {
		for (const env of [makeEnv({ generator: false }), makeEnv({ bridge: false })]) {
			expect(env.win.posted).toEqual([]);
			const p = new FakePort();
			env.win.postMessage({ type: "goofcord:wasapi-pcm-port", captureId: 1 }, "*", [p]);
			expect(p.sent).toEqual([]);
		}
	});

	test("messages from another origin/source cannot inject a port", () => {
		const env = makeEnv();
		const p = new FakePort();
		env.win.dispatchFrom({}, "https://evil.discordsays.com", { type: "goofcord:wasapi-pcm-port", captureId: 99 }, [p]);
		expect(p.sent).toEqual([]);
		expect(env.generators.length).toBe(0);
		expect(env.port(1).sent).toEqual([{ type: "ready", captureId: 1 }]);
	});

	test("failed write tears down, closes the frame, and leaves no unhandled rejection", async () => {
		const env = makeEnv();
		const { gen, port } = await audioShare(env, 1);
		gen.writer.mode = "reject";
		await env.drain();
		await flush();
		expect(gen.writer.written[0].closed).toBe(true);
		expect(gen.readyState).toBe("ended");
		expect(gen.endedEvents).toBe(1);
		expect(port.closed).toBe(true);
		expect(env.stops).toEqual([1]);
		expect(env.intervals.size).toBe(0);
		expect(unhandled).toEqual([]);
	});

	test("backpressure: stalled writes cap in-flight frames and rings stay bounded", async () => {
		const env = makeEnv();
		const { gen, port } = await audioShare(env, 1);
		gen.writer.mode = "manual";
		port.deliver({ index: 0, pcm: pcm(0) });
		port.deliver({ index: 0, pcm: pcm(0.1) });
		await env.drain(2); // two writes now in flight and unresolved
		for (let i = 2; i < 10; i++) port.deliver({ index: 0, pcm: pcm(i / 10) });
		await env.drain(10);
		expect(gen.writer.written.length).toBe(2);

		for (const w of gen.writer.manual.splice(0)) w.resolve();
		await flush();
		expect(gen.writer.written.every((a) => a.closed)).toBe(true);
		gen.writer.mode = "resolve";
		await env.drain(10);
		// 2 consumed before the stall, then only the newest 4 (ring depth) survived it
		const firstSample = gen.writer.written.map((a) => Math.round((a.init.data as Float32Array)[0] * 10));
		expect(firstSample).toEqual([0, 1, 6, 7, 8, 9, 0, 0, 0, 0, 0, 0]);
	});

	test("app mode: independent sources are summed and clamped", async () => {
		const env = makeEnv();
		const { gen, port } = await audioShare(env, 1);
		port.deliver({ index: 0, pcm: pcm(0.75) });
		port.deliver({ index: 1, pcm: pcm(0.75) });
		port.deliver({ index: 2, pcm: pcm(0.25) });
		await env.drain();
		expect((gen.writer.written[0].init.data as Float32Array)[0]).toBe(1);
	});

	test("pagehide ends the current capture", async () => {
		const env = makeEnv();
		const { gen } = await audioShare(env, 3);
		env.win.dispatchEvent(new Event("pagehide"));
		expect(gen.readyState).toBe("ended");
		expect(env.stops).toEqual([3]);
	});
});

describe("preload port forwarder", () => {
	test("holds the newest port until ready, closing superseded ones", () => {
		const win = new FakeWindow();
		const forwarded: { data: unknown; ports: unknown[] }[] = [];
		win.addEventListener("message", (e) => {
			const ev = e as unknown as { data: unknown; ports: unknown[] };
			if (ev.data !== "goofcord:wasapi-ready") forwarded.push({ data: ev.data, ports: ev.ports });
		});
		const forward = createWasapiPortForwarder(win as unknown as Window);

		const p1 = new FakePort();
		const p2 = new FakePort();
		forward(p1 as unknown as MessagePort, 1);
		forward(p2 as unknown as MessagePort, 2);
		expect(p1.closed).toBe(true);
		expect(forwarded).toEqual([]);

		win.dispatchFrom({}, "https://evil.discordsays.com", "goofcord:wasapi-ready");
		expect(forwarded).toEqual([]);

		win.postMessage("goofcord:wasapi-ready", "*");
		expect(forwarded).toEqual([{ data: { type: "goofcord:wasapi-pcm-port", captureId: 2 }, ports: [p2] }]);

		const p3 = new FakePort();
		forward(p3 as unknown as MessagePort, 3);
		expect(forwarded.at(-1)).toEqual({ data: { type: "goofcord:wasapi-pcm-port", captureId: 3 }, ports: [p3] });

		const noId = new FakePort();
		forward(noId as unknown as MessagePort, undefined);
		expect(noId.closed).toBe(true);
		expect(forwarded.length).toBe(2);
	});
});
