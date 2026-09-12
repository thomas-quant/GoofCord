// ─────────────────────────────────────────────────────────────────────────────
// Windows WASAPI EXCLUDE-tree echo fix (the #46 fix) — renderer-side PCM feeder + swap seam.
//
// The main process (wasapiLoopback.ts) captures the PCM and forwards it over a MessagePort. This file
// is the renderer half: a MessagePort-fed MediaStreamTrackGenerator feeder that reconstructs a live
// audio track and swaps it into Discord's getDisplayMedia stream, so the viewer hears shared desktop
// audio but NOT the Discord call echoed back.
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
//   main   → page      { index, pcm: ArrayBuffer } chunks, then { type: "stopped", captureId } before
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
		setInterval(fn: () => void, ms: number): number;
		clearInterval(id: number): void;
		setTimeout(fn: () => void, ms: number): number;
		clearTimeout(id: number): void;
		addEventListener(type: string, listener: (e: MessageEvent) => void): void;
		postMessage(message: unknown, targetOrigin: string): void;
	}
	interface Session {
		captureId: number;
		port: MessagePort;
		gen: GenTrack;
		stopGen: () => void; // the generator's own stop(), from before we intercepted it
		writer: WritableStreamDefaultWriter<unknown>;
		rings: Map<number, ArrayBuffer[]>;
		timer?: number;
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
	// untouched and never post readiness, so main's ack wait times out and it falls back.
	if (!bridge || typeof GenCtor !== "function" || typeof AudioDataCtor !== "function") return;

	const SAMPLE_RATE = 48000;
	const CHANNELS = 2;
	const FRAMES = 480; // 10ms @ 48k → ~100 chunks/sec
	const MIX_LEN = CHANNELS * FRAMES;
	const FRAME_US = Math.round((FRAMES / SAMPLE_RATE) * 1e6);
	const INTERVAL_MS = (FRAMES / SAMPLE_RATE) * 1000;
	// Bounded ring per source, latency-first: ~40ms absorbs post-cadence jitter without creep.
	const RING_DEPTH = 4;
	// Writes allowed in flight before the drain loop stops consuming. While it waits, the rings keep
	// dropping their oldest chunk, so a stalled writer can never grow an unbounded queue.
	const MAX_INFLIGHT = 2;
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
		if (s.timer !== undefined) win.clearInterval(s.timer);
		if (s.claimTimer !== undefined) win.clearTimeout(s.claimTimer);
		s.rings.clear();
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

	function pushChunk(s: Session, index: number, ab: ArrayBuffer): void {
		let ring = s.rings.get(index);
		if (ring === undefined) {
			ring = [];
			s.rings.set(index, ring);
		}
		if (ring.length >= RING_DEPTH) ring.shift(); // drop-oldest on overflow
		ring.push(ab);
	}

	// Drain: one chunk per source per ~10ms, SUMMED into one frame. A source with nothing queued
	// contributes silence, so the generator timeline stays monotonic with 0, 1, or N sources.
	function tick(s: Session): void {
		if (s.ended || s.inflight >= MAX_INFLIGHT) return;

		const mixed = new Float32Array(MIX_LEN);
		let contributors = 0;
		for (const ring of s.rings.values()) {
			const ab = ring.shift();
			if (ab === undefined) continue;
			const src = new Float32Array(ab);
			if (src.length !== MIX_LEN) continue; // defensive: ignore a malformed chunk
			for (let i = 0; i < MIX_LEN; i++) mixed[i] += src[i];
			contributors++;
		}
		// Hard-clamp rather than normalise: a moving gain would pump audibly as apps start/stop.
		if (contributors > 1) {
			for (let i = 0; i < MIX_LEN; i++) {
				const v = mixed[i];
				mixed[i] = v > 1 ? 1 : v < -1 ? -1 : v;
			}
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
			// No ack ⇒ main's readiness wait fails and it keeps the original audio path.
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
			rings: new Map(),
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
			const data = msg.data as { type?: unknown; captureId?: unknown; index?: unknown; pcm?: unknown } | null;
			if (data == null || typeof data !== "object") return;
			if (data.type === "stopped") {
				if (data.captureId === s.captureId) endSession(s, false);
				return;
			}
			if (!isArrayBuffer(data.pcm)) return;
			pushChunk(s, typeof data.index === "number" ? data.index : 0, data.pcm);
		};
		port.addEventListener?.("close", () => endSession(s, true));
		port.start();

		current = s;
		s.timer = win.setInterval(() => tick(s), INTERVAL_MS);
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
