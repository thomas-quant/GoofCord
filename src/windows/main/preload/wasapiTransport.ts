// ─────────────────────────────────────────────────────────────────────────────
// THROWAWAY — Phase 4 transport spike (GOOFCORD_TRANSPORT_SPIKE). STRIP BEFORE UPSTREAM PR.
//
// Purpose: prove the SECOND half of the make-or-break delivery path (Phase 3 residual
// risk #1) — getting main-process PCM into the Discord page MAIN WORLD over the REAL
// chunked-transferable MessagePort transport, and on to a remote viewer. The synthetic
// tone source lives in the main process (wasapiLoopback.ts); this file is the renderer
// half: a MessagePort-fed MediaStreamTrackGenerator feeder that reconstructs a live audio
// track and swaps it into Discord's getDisplayMedia stream at the proven seam.
//
// KEEP/THROWAWAY split (per CONTEXT scaffolding-lifecycle decision):
//   • KEEP (Phase-4 seed → Slice 2): the MessagePort→ring→MSTG feeder + the readiness
//     handshake + the getDisplayMedia swap-seam wiring — the real transport plumbing the
//     real WASAPI addon ships PCM over.
//   • THROWAWAY: nothing extra here beyond the spike gating; the source it consumes
//     (the synthetic tone in wasapiLoopback.ts) is the throwaway half.
//
// CI-PACKAGING NOTE (mirrors deliverySpike.ts): this file lives in the main preload bundle
// (ts-out/**, which electron-builder packages). preload.mts injects installWasapiTransport
// into the Discord page MAIN WORLD via webFrame.executeJavaScript (serialized to a string
// via `.toString()`) ONLY when the gate is on — NOT placed in the runtime-downloaded
// postVencord.js. The injected function closes over the page's own globals (MediaStreamTrack-
// Generator, AudioData, window) which only exist in the main world.
//
// HOP-2 (preload isolated world → page main world): preload.mts receives the MessagePort
// (hop-1) and forwards it via window.postMessage(..., [port]) AFTER this main-world script
// posts "goofcord:wasapi-ready" (the load-bearing readiness handshake — RESEARCH §Pitfall 1:
// a port forwarded before the listener exists silently loses the port + first chunks →
// viewer hears silence). The DEFAULT mechanism is the zero-copy port-forward; the recorded
// FALLBACK is a contextBridge structured-clone callback (GoofCord.feedWasapiChunk).
// ─────────────────────────────────────────────────────────────────────────────

// The entire main-world feeder. Authored as ONE function so it can be serialized with
// `.toString()` and executed in the page main world (where MediaStreamTrackGenerator,
// AudioData, and the getDisplayMedia stream live). It reaches the preload bridge via
// `window.goofcord` (appendScreenshareDebug + stopWasapiLoopback + the swap seam owned by
// screensharePatch.ts in the same main world).
export function installWasapiTransport(): void {
	interface TransportBridge {
		appendScreenshareDebug: (line: string) => unknown;
		stopWasapiLoopback: () => unknown;
	}
	const bridge = (globalThis as { goofcord?: TransportBridge }).goofcord;

	function log(line: string): void {
		try {
			bridge?.appendScreenshareDebug(line);
		} catch {
			// best-effort diagnostics; never throw from the spike
		}
	}

	// Idempotence guard on the page window — injection runs once per page.
	const flag = "__goofcordWasapiTransportInstalled";
	if ((globalThis as Record<string, unknown>)[flag]) return;
	(globalThis as Record<string, unknown>)[flag] = true;
	if (!bridge) return; // no bridge ⇒ nothing to log to; bail (page stays byte-identical)

	const SAMPLE_RATE = 48000;
	const CHANNELS = 2;
	const FRAMES = 480; // 10ms @ 48k → ~100 chunks/sec
	// T4: bounded ring, latency-first. 4-chunk (~40ms) depth absorbs jitter between the main-
	// process post cadence and the MSTG writer.write() consumption without latency creep.
	const RING_DEPTH = 4;

	// ── KEEP (Phase-4 seed): MSTG feeder fed externally from a MessagePort ───────────────
	const MSTG = (globalThis as { MediaStreamTrackGenerator?: unknown }).MediaStreamTrackGenerator;
	const AD = (globalThis as { AudioData?: unknown }).AudioData;
	if (typeof MSTG === "undefined" || typeof AD === "undefined") {
		log("wasapi-transport mechanism=MSTG absent (typeof undefined) — cannot feed");
		return;
	}
	const GenCtor = MSTG as new (init: { kind: string }) => MediaStreamTrack & { writable: WritableStream };
	const AudioDataCtor = AD as new (init: Record<string, unknown>) => unknown;

	const gen = new GenCtor({ kind: "audio" });
	const writer = gen.writable.getWriter() as WritableStreamDefaultWriter<unknown>;
	// Expose the reconstructed track + a teardown handle for screensharePatch.ts's swap seam +
	// STREAM_CLOSE handler (both run in this same page main world).
	let tsUs = 0; // timestamp MUST be microseconds, monotonic (else frames silently garble)

	// Bounded ring of transferred ArrayBuffers (each = 480*2 interleaved f32 = 3840 bytes).
	const ring: ArrayBuffer[] = [];
	let chunkCount = 0;
	let droppedCount = 0;
	let underrunCount = 0;
	let drainTimer: ReturnType<typeof setInterval> | undefined;
	let activePort: MessagePort | undefined;

	function pushChunk(ab: ArrayBuffer): void {
		chunkCount++;
		if (ring.length >= RING_DEPTH) {
			ring.shift(); // drop-oldest on overflow (T4)
			droppedCount++;
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

	// Drain loop: consume one chunk per ~10ms from the ring; on underrun write a zero-filled
	// AudioData of the same shape to keep the MSTG timeline monotonic (RESEARCH line 531).
	const intervalMs = (FRAMES / SAMPLE_RATE) * 1000; // ≈10ms
	drainTimer = setInterval(() => {
		const ab = ring.shift();
		if (ab) {
			writeAudioData(new Float32Array(ab));
		} else {
			underrunCount++;
			writeAudioData(new Float32Array(CHANNELS * FRAMES)); // silence fill
		}
	}, intervalMs);

	function teardown(): void {
		if (drainTimer) {
			clearInterval(drainTimer);
			drainTimer = undefined;
		}
		ring.length = 0;
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
		log(`wasapi-transport teardown chunks=${chunkCount} dropped=${droppedCount} underrun=${underrunCount}`);
		try {
			void bridge?.stopWasapiLoopback();
		} catch {
			// best-effort
		}
	}

	// Publish the reconstructed track + the feeder API on the page window so screensharePatch.ts
	// (same main world) can swap the track in at its seam and tear down on STREAM_CLOSE.
	interface WasapiFeeder {
		track: MediaStreamTrack;
		teardown: () => void;
	}
	(globalThis as { __goofcordWasapiFeeder?: WasapiFeeder }).__goofcordWasapiFeeder = {
		track: gen as MediaStreamTrack,
		teardown,
	};

	// ── HOP-2 receiver: the DEFAULT zero-copy port-forward path ──────────────────────────
	// The preload forwards the MessagePort via window.postMessage(..., [port]) AFTER it sees
	// our "goofcord:wasapi-ready" handshake below.
	window.addEventListener("message", (e: MessageEvent) => {
		if (e.data !== "goofcord:wasapi-pcm-port") return;
		const port = e.ports[0];
		if (!port) return;
		activePort = port;
		port.onmessage = (msg: MessageEvent) => {
			if (msg.data instanceof ArrayBuffer) pushChunk(msg.data);
		};
		port.start();
		log("hop2=port-forward ready-handshake ok");
	});

	// ── HOP-2 FALLBACK: contextBridge structured-clone callback ──────────────────────────
	// If window.postMessage with a port transfer is not honored into this injected main world
	// on this build, the preload lands PCM in its isolated world and invokes this callback
	// (structured-clones each chunk). Exposed on the page window for the preload bridge to call.
	(globalThis as { __goofcordWasapiFeedChunk?: (ab: ArrayBuffer) => void }).__goofcordWasapiFeedChunk = (ab: ArrayBuffer) => {
		if (ab instanceof ArrayBuffer) pushChunk(ab);
	};

	// ── SWAP SEAM: wrap getDisplayMedia HERE, in this preload-injected main-world script —
	// NOT in screensharePatch.ts. postVencord.js is fetched at runtime from upstream `main`
	// (settingsSchema PostVencord URL), so fork edits to screensharePatch.ts would silently not
	// ship; only this ts-out-packaged preload reliably reaches the artifact (same reason
	// deliverySpike.ts wraps getDisplayMedia itself — see its packaging note). Mirrors
	// deliverySpike.ts:242-279. Injection only happens when the transport gate is on, so the
	// wrap is unconditional here; with the gate OFF this script is never injected ⇒ the page is
	// byte-identical to upstream.
	const md = navigator.mediaDevices;
	const originalGDM = md.getDisplayMedia.bind(md);
	md.getDisplayMedia = async function (this: MediaDevices, opts?: DisplayMediaStreamOptions): Promise<MediaStream> {
		const stream = await originalGDM(opts);
		try {
			// On Windows the upstream path leaves the captured "loopback" audio track in the stream
			// (no virtmic), which is what echoes the call back to viewers. Swap it for the
			// reconstructed transport track (fed from the main-process MessagePort).
			for (const t of stream.getAudioTracks()) {
				t.stop();
				stream.removeTrack(t);
			}
			stream.addTrack(gen as MediaStreamTrack);
			log(`wasapi swap-seam injected reconstructed audio track (chunks=${chunkCount})`);

			// Teardown trigger: FluxDispatcher STREAM_CLOSE is unavailable in preload-injected
			// main-world code (deliverySpike.ts:261), so the swapped track or the video track
			// ending tears the feeder + the main-process synthetic/native capture down.
			const videoTrack = stream.getVideoTracks()[0];
			const onEnd = () => teardown();
			(gen as MediaStreamTrack).addEventListener("ended", onEnd);
			if (videoTrack) videoTrack.addEventListener("ended", onEnd);
		} catch (e) {
			log(`wasapi swap-seam failed err=${e instanceof Error ? e.message : String(e)}`);
		}
		return stream;
	};

	// READINESS HANDSHAKE (load-bearing — RESEARCH §Pitfall 1): now that the message listener,
	// the feeder, AND the getDisplayMedia swap seam are registered, signal the preload that the
	// main world is ready to receive the port. The preload buffers the port until it sees this.
	log("wasapi-transport main-world feeder + swap seam installed; posting ready");
	window.postMessage("goofcord:wasapi-ready", "*");
}

// Self-contained main-world script string: serialize the feeder and self-invoke it. preload.mts
// passes this to webFrame.executeJavaScript ONLY when the transport spike gate is on, so it
// ships from ts-out/** (packaged) yet runs in the page main world.
export const wasapiTransportMainWorldSource = `(${installWasapiTransport.toString()})();`;
