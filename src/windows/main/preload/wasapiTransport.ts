// ─────────────────────────────────────────────────────────────────────────────
// Windows WASAPI EXCLUDE-tree echo fix (the #46 fix) — renderer-side PCM feeder + swap seam.
//
// The main process (wasapiLoopback.ts) captures the PCM and forwards it over a MessagePort. This file
// is the renderer half: a MessagePort-fed MediaStreamTrackGenerator feeder that reconstructs a live
// audio track and swaps it into Discord's getDisplayMedia stream, with the process scope selected in the picker. Unrelated processes re-rendering
// call audio can still be audible.
//
// CI-PACKAGING NOTE: this file lives in the main preload bundle (ts-out/**, which electron-builder
// packages). preload.mts injects installWasapiTransport into the Discord page MAIN WORLD via
// webFrame.executeJavaScript (serialized to a string via `.toString()`) ONLY when the wasapi gate is
// on — NOT placed in the runtime-downloaded postVencord.js. Because it is serialized, the function
// must be fully self-contained: no references to module scope, and every page global goes through
// `window` (which is also what lets the tests run the exact serialized string against fakes).
//
// SESSION PROTOCOL (one capture = one session, never reused):
//   main   → preload   webContents.postMessage("wasapi:pcm-port", { captureId }, [port])  (only after
//                      native capture started)
//   preload → page     window.postMessage({ type: "goofcord:wasapi-pcm-port", captureId }, "*", [port])
//                      once the page has posted "goofcord:wasapi-ready"
//   page   → main      port.postMessage({ type: "ready", captureId }) once a fresh generator + handlers
//                      exist; main waits for this before resolving the display-media request
//   main   → page      { type: "sources", indices }, { index, pcm: ArrayBuffer } chunks, then { type: "stopped", captureId } before
//                      closing the port on stop/failure/replacement
//   page   → main      goofcord.stopWasapiLoopback(captureId) when the page ends the session itself
// ─────────────────────────────────────────────────────────────────────────────

const READY_MESSAGE = "goofcord:wasapi-ready";
const PORT_MESSAGE = "goofcord:wasapi-pcm-port";

// The entire main-world feeder. Authored as ONE function so it can be serialized with `.toString()`
// and executed in the page main world (where MediaStreamTrackGenerator, AudioData, and the
// getDisplayMedia stream live). It reaches the preload bridge via `window.goofcord`.
export function installWasapiTransport(): void {
	interface TransportBridge {
		stopWasapiLoopback: (captureId?: number) => unknown;
	}
	type GenTrack = MediaStreamTrack & { writable: WritableStream<unknown> };
	// Every page global goes through this one object (see header).
	interface TransportWindow {
		goofcord?: TransportBridge;
		MediaStreamTrackGenerator?: new (init: { kind: string }) => GenTrack;
		AudioData?: new (init: Record<string, unknown>) => { close?: () => void };
		__goofcordWasapiTransportInstalled?: boolean;
		Event: typeof Event;
		location: { origin: string };
		navigator: { mediaDevices: MediaDevices };
		setTimeout(fn: () => void, ms: number): number;
		clearTimeout(id: number): void;
		addEventListener(type: string, listener: (e: MessageEvent) => void): void;
		postMessage(message: unknown, targetOrigin: string): void;
	}
	interface Source {
		queue: ArrayBuffer[];
		missed: number;
	}
	interface Session {
		captureId: number;
		port: MessagePort;
		gen: GenTrack;
		stopGen: () => void; // the generator's own stop(), from before we intercepted it
		writer: WritableStreamDefaultWriter<unknown>;
		sources: Map<number, Source>;
		claimTimer?: number;
		tsUs: number;
		inflight: number;
		arrival: number; // ordinal of this port's arrival, compared against request start ordinals
		claimed: boolean;
		ended: boolean;
	}

	const win = window as unknown as TransportWindow;

	// Idempotence guard on the page window — injection runs once per page.
	if (win.__goofcordWasapiTransportInstalled) return;
	win.__goofcordWasapiTransportInstalled = true;

	const bridge = win.goofcord;
	const GenCtor = win.MediaStreamTrackGenerator;
	const AudioDataCtor = win.AudioData;
	// No bridge ⇒ no teardown channel; no Insertable Streams ⇒ cannot feed. Either way leave the page
	// untouched and never post readiness, so main's ack wait times out and it fails closed.
	if (!bridge || typeof GenCtor !== "function" || typeof AudioDataCtor !== "function") return;

	const SAMPLE_RATE = 48000;
	const CHANNELS = 2;
	const FRAMES = 480; // 10ms @ 48k → ~100 chunks/sec
	const MIX_LEN = CHANNELS * FRAMES;
	const FRAME_US = Math.round((FRAMES / SAMPLE_RATE) * 1e6);
	// Clocked by PCM arrival, never a page timer: hidden pages throttle timers and a second clock drops or pads audio.
	const LEAD_FRAMES = 3;
	const IDLE_FRAMES = 50;
	const MAX_INFLIGHT = 2;
	const MAX_QUEUE = 20;
	// A session nothing has claimed by now (and no request is pending to claim it) is an orphan.
	const CLAIM_TIMEOUT_MS = 10000;

	let current: Session | undefined;
	let lastCaptureId = 0;
	let arrivals = 0;
	let pendingRequests = 0;

	function fromThisPage(e: MessageEvent): boolean {
		const source: unknown = e.source;
		return source === win || e.origin === win.location.origin;
	}

	function isArrayBuffer(v: unknown): v is ArrayBuffer {
		return Object.prototype.toString.call(v) === "[object ArrayBuffer]";
	}

	function stopNative(captureId: number): void {
		try {
			Promise.resolve(bridge?.stopWasapiLoopback(captureId)).catch(() => {});
		} catch {
			// best-effort
		}
	}

	// MediaStreamTrack.stop() never fires "ended", so a consumer stopping our track is otherwise
	// invisible. Shadow stop() on this one instance only — never on the MediaStreamTrack prototype.
	function interceptStop(track: MediaStreamTrack, onStop: () => void): void {
		const own = track.stop;
		Object.defineProperty(track, "stop", {
			configurable: true,
			writable: true,
			value: () => {
				own.call(track);
				onStop();
			},
		});
	}

	function endSession(s: Session, notifyMain: boolean): void {
		if (s.ended) return;
		s.ended = true;
		if (current === s) current = undefined;
		if (s.claimTimer !== undefined) win.clearTimeout(s.claimTimer);
		s.sources.clear();
		s.port.onmessage = null;
		try {
			s.port.close();
		} catch {
			// already closed
		}
		// We are ending the track, not its consumer: stop it and dispatch "ended" ourselves (stop()
		// won't), so Discord learns its audio track died. Stopping first also means a native "ended"
		// can no longer fire, so consumers see exactly one.
		if (s.gen.readyState !== "ended") {
			s.stopGen();
			s.gen.dispatchEvent(new win.Event("ended"));
		}
		try {
			s.writer.abort().catch(() => {});
		} catch {
			// already released
		}
		if (notifyMain) stopNative(s.captureId);
	}

	function closeAudioData(ad: { close?: () => void }): void {
		// AudioData.close() is idempotent. The generator closes frames it consumes, but a rejected
		// write may never have handed the frame over, so release it here either way.
		try {
			ad.close?.();
		} catch {
			// best-effort
		}
	}

	function source(s: Session, index: number): Source {
		let src = s.sources.get(index);
		if (src === undefined) {
			src = { queue: [], missed: 0 };
			s.sources.set(index, src);
		}
		return src;
	}

	function pushChunk(s: Session, index: number, ab: ArrayBuffer): void {
		if (ab.byteLength !== MIX_LEN * 4) return; // defensive: ignore a malformed chunk
		const src = source(s, index);
		src.missed = 0;
		if (src.queue.length >= MAX_QUEUE) src.queue.shift();
		src.queue.push(ab);
		pump(s);
	}

	function pump(s: Session): void {
		while (!s.ended && s.inflight < MAX_INFLIGHT) {
			let lead = 0;
			let waiting = false;
			for (const src of s.sources.values()) {
				if (src.queue.length > lead) lead = src.queue.length;
				else if (src.queue.length === 0 && src.missed < IDLE_FRAMES) waiting = true;
			}
			if (lead === 0 || (waiting && lead < LEAD_FRAMES)) return;
			emit(s);
		}
	}

	function emit(s: Session): void {
		const mixed = new Float32Array(MIX_LEN);
		for (const src of s.sources.values()) {
			const ab = src.queue.shift();
			if (ab === undefined) {
				src.missed++;
				continue;
			}
			const pcm = new Float32Array(ab);
			for (let i = 0; i < MIX_LEN; i++) mixed[i] += pcm[i];
		}
		// Hard-clamp rather than normalise: a moving gain would pump audibly as apps start/stop.
		for (let i = 0; i < MIX_LEN; i++) {
			const v = mixed[i];
			mixed[i] = v > 1 ? 1 : v < -1 ? -1 : v;
		}

		let ad: { close?: () => void };
		try {
			ad = new AudioDataCtor!({
				format: "f32",
				sampleRate: SAMPLE_RATE,
				numberOfFrames: FRAMES,
				numberOfChannels: CHANNELS,
				timestamp: s.tsUs, // microseconds, monotonic per session (else frames silently garble)
				data: mixed,
			});
		} catch {
			endSession(s, true);
			return;
		}
		s.tsUs += FRAME_US;
		s.inflight++;

		let write: Promise<unknown>;
		try {
			write = s.writer.write(ad);
		} catch (err) {
			write = Promise.reject(err);
		}
		write.then(
			() => {
				s.inflight--;
				closeAudioData(ad);
				pump(s);
			},
			() => {
				s.inflight--;
				closeAudioData(ad);
				endSession(s, true);
			},
		);
	}

	function openSession(port: MessagePort, captureId: number): void {
		// One current capture: main replaced the old one (and told its port "stopped").
		if (current) endSession(current, false);

		let gen: GenTrack;
		let writer: WritableStreamDefaultWriter<unknown>;
		try {
			gen = new GenCtor!({ kind: "audio" });
			writer = gen.writable.getWriter();
		} catch {
			// No ack ⇒ main's readiness wait fails and it leaves the share without audio.
			try {
				port.close();
			} catch {
				// already closed
			}
			return;
		}

		const s: Session = {
			captureId,
			port,
			gen,
			stopGen: gen.stop.bind(gen),
			writer,
			sources: new Map(),
			tsUs: 0,
			inflight: 0,
			arrival: ++arrivals,
			claimed: false,
			ended: false,
		};
		interceptStop(gen, () => endSession(s, true));
		gen.addEventListener("ended", () => endSession(s, true));
		writer.closed.then(
			() => endSession(s, true),
			() => endSession(s, true),
		);

		port.onmessage = (msg: MessageEvent) => {
			if (s.ended) return;
			const data = msg.data as { type?: unknown; captureId?: unknown; index?: unknown; indices?: unknown; pcm?: unknown } | null;
			if (data == null || typeof data !== "object") return;
			if (data.type === "stopped") {
				if (data.captureId === s.captureId) endSession(s, false);
				return;
			}
			if (data.type === "sources") {
				if (Array.isArray(data.indices)) for (const index of data.indices) if (typeof index === "number") source(s, index);
				return;
			}
			if (!isArrayBuffer(data.pcm)) return;
			pushChunk(s, typeof data.index === "number" ? data.index : 0, data.pcm);
		};
		port.addEventListener?.("close", () => endSession(s, true));
		port.start();

		current = s;
		s.claimTimer = win.setTimeout(() => {
			if (!s.claimed && pendingRequests === 0) endSession(s, true);
		}, CLAIM_TIMEOUT_MS);

		// Handlers and fresh state exist: tell main it may now resolve the display-media request.
		port.postMessage({ type: "ready", captureId });
	}

	// A session left unclaimed once no request is pending belongs to no share (its request was
	// rejected, or the port arrived too late). Kill it rather than let a later share inherit it.
	function reapOrphan(): void {
		if (pendingRequests === 0 && current && !current.claimed) endSession(current, true);
	}

	function attach(s: Session, stream: MediaStream): void {
		try {
			// Chromium should add no audio when native capture started; drop any it did, since a
			// second loopback track is exactly the echo we are removing.
			for (const t of stream.getAudioTracks()) {
				t.stop();
				stream.removeTrack(t);
			}
			stream.addTrack(s.gen);
		} catch {
			return; // leave the stream as captured; the unclaimed session gets reaped
		}
		s.claimed = true;
		if (s.claimTimer !== undefined) win.clearTimeout(s.claimTimer);
		// The share is over when its video ends: source gone ("ended") or Discord stopping it.
		for (const v of stream.getVideoTracks()) {
			v.addEventListener("ended", () => endSession(s, true));
			interceptStop(v, () => endSession(s, true));
		}
	}

	// ── HOP-2 receiver: a port arrives only after main's native capture started ──────────────
	win.addEventListener("message", (e: MessageEvent) => {
		if (!fromThisPage(e)) return;
		const data = e.data as { type?: unknown; captureId?: unknown } | null;
		if (data == null || typeof data !== "object" || data.type !== "goofcord:wasapi-pcm-port") return;
		const port = e.ports?.[0];
		if (!port) return;
		const captureId = data.captureId;
		if (typeof captureId !== "number" || !(captureId > lastCaptureId)) {
			try {
				port.close(); // malformed or older than what we already have: never let it feed
			} catch {
				// already closed
			}
			return;
		}
		lastCaptureId = captureId;
		openSession(port, captureId);
	});

	// Reload/navigation: end the capture rather than orphan it in main.
	win.addEventListener("pagehide", () => {
		if (current) endSession(current, true);
	});

	// ── SWAP SEAM: wrap getDisplayMedia HERE, not in screensharePatch.ts — postVencord.js is fetched
	// at runtime from upstream, so fork edits there would silently not ship.
	const md = win.navigator.mediaDevices;
	const originalGDM = md.getDisplayMedia.bind(md);
	md.getDisplayMedia = async function (opts?: DisplayMediaStreamOptions): Promise<MediaStream> {
		// The port handshake has no request token. Never let two pending requests
		// compete for the same capture, or a cancelled picker can steal its audio.
		if (pendingRequests !== 0) {
			const error = new Error("A screen-share request is already pending");
			error.name = "InvalidStateError";
			throw error;
		}
		// Only a session whose port arrived AFTER this request began can belong to it: main acks the
		// port before resolving the request, so ours is here by the time the stream is. A request
		// with no session (audio "none", unsupported, failed-closed) keeps its stream untouched.
		const since = arrivals;
		pendingRequests++;
		let stream: MediaStream;
		try {
			stream = await originalGDM(opts);
		} catch (err) {
			pendingRequests--;
			reapOrphan();
			throw err;
		}
		pendingRequests--;
		const s = current;
		if (s && !s.claimed && !s.ended && s.arrival > since) attach(s, stream);
		reapOrphan();
		return stream;
	};

	// READINESS HANDSHAKE (load-bearing): the listener and the seam are registered, so the preload
	// may now forward ports.
	win.postMessage("goofcord:wasapi-ready", "*");
}

// Self-contained main-world script string: serialize the feeder and self-invoke it. preload.mts
// passes this to webFrame.executeJavaScript ONLY when the wasapi gate is on.
export const wasapiTransportMainWorldSource = `(${installWasapiTransport.toString()})();`;

/**
 * Preload (isolated world) half of hop-2. Holds the newest port until the page main world posts
 * READY_MESSAGE — a port forwarded before its listener exists is silently lost — then forwards it
 * zero-copy. A port superseded while still waiting is closed, never delivered late.
 */
export function createWasapiPortForwarder(win: Window): (port: MessagePort, captureId: unknown) => void {
	let pending: { port: MessagePort; captureId: number } | undefined;
	let ready = false;

	function flush() {
		if (!ready || !pending) return;
		const { port, captureId } = pending;
		pending = undefined;
		win.postMessage({ type: PORT_MESSAGE, captureId }, "*", [port]);
	}

	win.addEventListener("message", (e: MessageEvent) => {
		if (e.data !== READY_MESSAGE || !(e.source === win || e.origin === win.location.origin)) return;
		ready = true;
		flush();
	});

	return (port, captureId) => {
		if (typeof captureId !== "number") {
			port.close();
			return;
		}
		if (pending) {
			try {
				pending.port.close();
			} catch {
				// already closed
			}
		}
		pending = { port, captureId };
		flush();
	};
}
