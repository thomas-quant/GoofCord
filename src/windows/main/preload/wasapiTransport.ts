// ─────────────────────────────────────────────────────────────────────────────
// Windows WASAPI EXCLUDE-tree echo fix (the #46 fix) — renderer-side PCM feeder + swap seam.
//
// The main process (wasapiLoopback.ts) captures the EXCLUDE-tree PCM and forwards it over a
// MessagePort. This file is the renderer half: a MessagePort-fed MediaStreamTrackGenerator feeder
// that reconstructs a live audio track and swaps it into Discord's getDisplayMedia stream at the
// proven seam, so the viewer hears shared desktop audio but NOT the Discord call echoed back.
//
// CI-PACKAGING NOTE: this file lives in the main preload bundle (ts-out/**, which electron-builder
// packages). preload.mts injects installWasapiTransport into the Discord page MAIN WORLD via
// webFrame.executeJavaScript (serialized to a string via `.toString()`) ONLY when the wasapi gate is
// on — NOT placed in the runtime-downloaded postVencord.js. The injected function closes over the
// page's own globals (MediaStreamTrackGenerator, AudioData, window) which only exist in the main world.
//
// HOP-2 (preload isolated world → page main world): preload.mts receives the MessagePort (hop-1) and
// forwards it via window.postMessage(..., [port]) AFTER this main-world script posts
// "goofcord:wasapi-ready" (the load-bearing readiness handshake: a port forwarded before the listener
// exists silently loses the port + first chunks → viewer hears silence).
// ─────────────────────────────────────────────────────────────────────────────

// The entire main-world feeder. Authored as ONE function so it can be serialized with `.toString()`
// and executed in the page main world (where MediaStreamTrackGenerator, AudioData, and the
// getDisplayMedia stream live). It reaches the preload bridge via `window.goofcord`
// (stopWasapiLoopback, to tear the main-process capture down when the share ends).
export function installWasapiTransport(): void {
	interface TransportBridge {
		stopWasapiLoopback: () => unknown;
	}
	const bridge = (globalThis as { goofcord?: TransportBridge }).goofcord;

	// Idempotence guard on the page window — injection runs once per page.
	const flag = "__goofcordWasapiTransportInstalled";
	if ((globalThis as Record<string, unknown>)[flag]) return;
	(globalThis as Record<string, unknown>)[flag] = true;
	if (!bridge) return; // no bridge ⇒ no teardown signal channel; bail (page stays byte-identical)

	const SAMPLE_RATE = 48000;
	const CHANNELS = 2;
	const FRAMES = 480; // 10ms @ 48k → ~100 chunks/sec
	// T4: bounded ring, latency-first. 4-chunk (~40ms) depth absorbs jitter between the main-
	// process post cadence and the MSTG writer.write() consumption without latency creep.
	const RING_DEPTH = 4;

	// ── MSTG feeder fed externally from a MessagePort ────────────────────────────────────
	const MSTG = (globalThis as { MediaStreamTrackGenerator?: unknown }).MediaStreamTrackGenerator;
	const AD = (globalThis as { AudioData?: unknown }).AudioData;
	if (typeof MSTG === "undefined" || typeof AD === "undefined") {
		return; // Insertable Streams unavailable on this build — cannot feed; leave the page untouched.
	}
	const GenCtor = MSTG as new (init: { kind: string }) => MediaStreamTrack & { writable: WritableStream };
	const AudioDataCtor = AD as new (init: Record<string, unknown>) => unknown;

	const gen = new GenCtor({ kind: "audio" });
	const writer = gen.writable.getWriter() as WritableStreamDefaultWriter<unknown>;
	let tsUs = 0; // timestamp MUST be microseconds, monotonic (else frames silently garble)

	// One bounded ring PER SOURCE (each chunk = 480*2 interleaved f32 = 3840 bytes). "app" mode
	// runs one WASAPI INCLUDE session per selected app, so several independent streams arrive
	// interleaved on the same port, tagged with their source index; they are summed on drain.
	// "system" mode simply has a single source (index 0).
	const rings = new Map<number, ArrayBuffer[]>();
	let drainTimer: ReturnType<typeof setInterval> | undefined;
	let activePort: MessagePort | undefined;

	function pushChunk(index: number, ab: ArrayBuffer): void {
		let ring = rings.get(index);
		if (ring === undefined) {
			ring = [];
			rings.set(index, ring);
		}
		if (ring.length >= RING_DEPTH) {
			ring.shift(); // drop-oldest on overflow (T4)
		}
		ring.push(ab);
	}

	function writeAudioData(data: Float32Array): void {
		const ad = new AudioDataCtor({
			format: "f32",
			sampleRate: SAMPLE_RATE,
			numberOfFrames: FRAMES,
			numberOfChannels: CHANNELS,
			timestamp: tsUs,
			data,
		});
		tsUs += Math.round((FRAMES / SAMPLE_RATE) * 1e6); // advance ~10000us, monotonic
		void writer.write(ad);
	}

	// Drain loop: consume one chunk per source per ~10ms and SUM them into a single frame. A
	// source that has nothing queued contributes silence, so the MSTG timeline stays monotonic
	// whether we have zero, one, or several live sources.
	const intervalMs = (FRAMES / SAMPLE_RATE) * 1000; // ≈10ms
	const MIX_LEN = CHANNELS * FRAMES;
	drainTimer = setInterval(() => {
		const mixed = new Float32Array(MIX_LEN);
		let contributors = 0;

		for (const ring of rings.values()) {
			const ab = ring.shift();
			if (ab === undefined) continue;
			const src = new Float32Array(ab);
			if (src.length !== MIX_LEN) continue; // defensive: ignore a malformed chunk
			for (let i = 0; i < MIX_LEN; i++) mixed[i] += src[i];
			contributors++;
		}

		// Summing independent streams can exceed [-1, 1] when several apps are loud at once.
		// Hard-clamp rather than normalise: a moving gain would pump audibly as apps start/stop.
		if (contributors > 1) {
			for (let i = 0; i < MIX_LEN; i++) {
				const v = mixed[i];
				mixed[i] = v > 1 ? 1 : v < -1 ? -1 : v;
			}
		}

		writeAudioData(mixed);
	}, intervalMs);

	function teardown(): void {
		if (drainTimer) {
			clearInterval(drainTimer);
			drainTimer = undefined;
		}
		rings.clear();
		try {
			activePort?.close();
		} catch {
			// already closed
		}
		activePort = undefined;
		try {
			writer.releaseLock();
		} catch {
			// already released
		}
		try {
			void bridge?.stopWasapiLoopback();
		} catch {
			// best-effort
		}
	}

	// Publish the reconstructed track + the feeder API on the page window so the swap seam below
	// (same main world) can swap the track in and tear down on STREAM_CLOSE.
	interface WasapiFeeder {
		track: MediaStreamTrack;
		teardown: () => void;
	}
	(globalThis as { __goofcordWasapiFeeder?: WasapiFeeder }).__goofcordWasapiFeeder = {
		track: gen as MediaStreamTrack,
		teardown,
	};

	// ── HOP-2 receiver: the zero-copy port-forward path ──────────────────────────────────
	// The preload forwards the MessagePort via window.postMessage(..., [port]) AFTER it sees our
	// "goofcord:wasapi-ready" handshake below. activePort is set ONLY here — i.e. only after the
	// main process forwarded the port, which it does only when startWasapiCapture() succeeded.
	window.addEventListener("message", (e: MessageEvent) => {
		if (e.data !== "goofcord:wasapi-pcm-port") return;
		const port = e.ports[0];
		if (!port) return;
		activePort = port;
		port.onmessage = (msg: MessageEvent) => {
			// { index, pcm } — index identifies the capture session so N app streams can be mixed.
			const data = msg.data as { index?: number; pcm?: unknown } | null;
			if (data == null || !(data.pcm instanceof ArrayBuffer)) return;
			pushChunk(typeof data.index === "number" ? data.index : 0, data.pcm);
		};
		port.start();
	});

	// ── SWAP SEAM: wrap getDisplayMedia HERE, in this preload-injected main-world script —
	// NOT in screensharePatch.ts. postVencord.js is fetched at runtime from upstream `main`
	// (settingsSchema PostVencord URL), so fork edits to screensharePatch.ts would silently not
	// ship; only this ts-out-packaged preload reliably reaches the artifact. Injection only happens
	// when the wasapi gate is on, so with the gate OFF this script is never injected ⇒ the page is
	// byte-identical to upstream.
	const md = navigator.mediaDevices;
	const originalGDM = md.getDisplayMedia.bind(md);
	md.getDisplayMedia = async function (this: MediaDevices, opts?: DisplayMediaStreamOptions): Promise<MediaStream> {
		const stream = await originalGDM(opts);

		// ECHO-03 (D-11): only swap when capture is actually active. activePort is set only after
		// startWasapiCapture() succeeded and the main process forwarded the port. If it's unset
		// (unsupported build / --no-wasapi / activation returned false), leave the original Chromium
		// "loopback" track in place so the viewer hears audio instead of a silence-filled gen track.
		if (!activePort) return stream;

		try {
			// On Windows the upstream path leaves the captured "loopback" audio track in the stream
			// (no virtmic), which is what echoes the call back to viewers. Swap it for the
			// reconstructed transport track (fed from the main-process MessagePort).
			for (const t of stream.getAudioTracks()) {
				t.stop();
				stream.removeTrack(t);
			}
			stream.addTrack(gen as MediaStreamTrack);

			// Teardown trigger: FluxDispatcher STREAM_CLOSE is unavailable in preload-injected
			// main-world code, so the swapped track or the video track ending tears the feeder + the
			// main-process native capture down.
			const videoTrack = stream.getVideoTracks()[0];
			const onEnd = () => teardown();
			(gen as MediaStreamTrack).addEventListener("ended", onEnd);
			if (videoTrack) videoTrack.addEventListener("ended", onEnd);
		} catch {
			// Swap failed; leave the original stream as captured (never break the share).
		}
		return stream;
	};

	// READINESS HANDSHAKE (load-bearing): now that the message listener, the feeder, AND the
	// getDisplayMedia swap seam are registered, signal the preload that the main world is ready to
	// receive the port. The preload buffers the port until it sees this.
	window.postMessage("goofcord:wasapi-ready", "*");
}

// Self-contained main-world script string: serialize the feeder and self-invoke it. preload.mts
// passes this to webFrame.executeJavaScript ONLY when the wasapi gate is on, so it ships from
// ts-out/** (packaged) yet runs in the page main world.
export const wasapiTransportMainWorldSource = `(${installWasapiTransport.toString()})();`;
