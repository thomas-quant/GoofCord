// ─────────────────────────────────────────────────────────────────────────────
// THROWAWAY — Phase 3 delivery-path spike (GOOFCORD_DELIVERY_SPIKE). STRIP BEFORE UPSTREAM PR.
//
// Purpose: prove a non-Discord audio track, reconstructed entirely in the renderer,
// can be swapped into Discord's getDisplayMedia MediaStream and reach a remote viewer
// (SC#1), and record which reconstruction mechanism works (SC#2). Renderer-only — NO
// main→renderer PCM transport (that is a NAMED Phase 4 residual risk; never per-frame
// ipcRenderer.send of raw PCM — Phase 4 must use chunked transferables).
//
// CI-PACKAGING NOTE: this file lives in the main preload bundle (ts-out/**, which
// electron-builder DOES package) and is injected into the Discord page main-world via
// webFrame.executeJavaScript from preload.mts — NOT placed in the runtime-downloaded
// postVencord.js (which is fetched from upstream `main` and would silently not ship).
//
// KEEP/THROWAWAY split (per CONTEXT scaffolding-lifecycle decision):
//   • KEEP (Phase-4 seed): buildSyntheticAudioTrack() reconstruction (MSTG → Web Audio)
//     and the getDisplayMedia swap-seam injection — this is the real delivery wiring.
//   • THROWAWAY: the synthetic beep/sweep generator + the getStats poll logging — these
//     are spike-only diagnostics; Phase 4 feeds real captured PCM into the same seam.
// ─────────────────────────────────────────────────────────────────────────────

// Reaches window.goofcord.deliverySpike (gate bool) + window.goofcord.appendScreenshareDebug(line)
// from Plan 01's bridge. In main-world-injected context the typed bridge isn't visible, so we
// access it loosely via globalThis.
interface SpikeBridge {
	deliverySpike: boolean;
	appendScreenshareDebug: (line: string) => unknown;
}
function getBridge(): SpikeBridge | undefined {
	return (globalThis as { goofcord?: SpikeBridge }).goofcord;
}

// Module-scope teardown handles (Pitfall 5 — no leak).
let feedTimer: ReturnType<typeof setInterval> | undefined;
let statsTimer: ReturnType<typeof setInterval> | undefined;
let activeCtx: AudioContext | undefined;
let activeOsc: OscillatorNode | undefined;
let activeWriter: { releaseLock: () => void } | undefined;
let installed = false;

// Captured audio senders (Pattern 2 — addTrack wrap; also scanned from getSenders() at poll time).
const audioSenders = new Set<RTCRtpSender>();
// Live RTCPeerConnections seen, so poll-time getSenders() can scan for replaceTrack'd senders (Pitfall 4).
const peerConnections = new Set<RTCPeerConnection>();

function log(line: string): void {
	try {
		getBridge()?.appendScreenshareDebug(line);
	} catch {
		// best-effort diagnostics; never throw from the spike
	}
}

// ── KEEP (Phase-4 seed): reconstruction — MSTG probe → Web Audio fallback ──────────────
// Copied from RESEARCH §Pattern 1. Produces a distinctive, continuous 48kHz/stereo/float32
// synthetic track so the viewer can say "that is MY test audio". The synthetic-sample math
// itself is THROWAWAY (Phase 4 replaces it with real captured PCM); the MSTG/Web-Audio
// reconstruction + return-a-live-track shape is the KEEP seed.
function buildSyntheticAudioTrack(): MediaStreamTrack {
	const SAMPLE_RATE = 48000;
	const CHANNELS = 2;
	const FRAMES = 480; // 10ms @ 48k → ~100 chunks/sec

	// THROWAWAY: distinctive 440Hz beep, 200ms on / 200ms off, computed from a running sample
	// counter so the cadence is unmistakable (NOT a flat tone, NOT noise).
	function makeDistinctiveSample(sampleIndex: number): number {
		const tSec = sampleIndex / SAMPLE_RATE;
		const beatOn = tSec % 0.4 < 0.2; // 200ms on / 200ms off
		if (!beatOn) return 0;
		// gentle sweep 440→660Hz across the on-beat for extra distinctiveness
		const intoBeat = tSec % 0.4; // 0..0.2
		const freq = 440 + (660 - 440) * (intoBeat / 0.2);
		return 0.3 * Math.sin(2 * Math.PI * freq * tSec);
	}

	const MSTG = (globalThis as { MediaStreamTrackGenerator?: unknown }).MediaStreamTrackGenerator;
	const AD = (globalThis as { AudioData?: unknown }).AudioData;
	if (typeof MSTG !== "undefined" && typeof AD !== "undefined") {
		log("mechanism=MSTG present");
		try {
			// biome/type: MSTG/AudioData are non-standard Chrome globals with no TS lib types here.
			const GenCtor = MSTG as new (init: { kind: string }) => MediaStreamTrack & { writable: WritableStream };
			const AudioDataCtor = AD as new (init: Record<string, unknown>) => unknown;
			const gen = new GenCtor({ kind: "audio" });
			const writer = gen.writable.getWriter();
			activeWriter = writer as unknown as { releaseLock: () => void };

			let phase = 0; // running sample counter
			let tsUs = 0; // timestamp MUST be microseconds, monotonic (else frames silently garble)
			const dataFloats = CHANNELS * FRAMES;
			const intervalMs = (FRAMES / SAMPLE_RATE) * 1000; // ≈10ms

			feedTimer = setInterval(() => {
				const buf = new Float32Array(dataFloats); // interleaved L,R,L,R for format "f32"
				for (let i = 0; i < FRAMES; i++) {
					const s = makeDistinctiveSample(phase++);
					buf[i * 2] = s;
					buf[i * 2 + 1] = s;
				}
				const ad = new AudioDataCtor({
					format: "f32",
					sampleRate: SAMPLE_RATE,
					numberOfFrames: FRAMES,
					numberOfChannels: CHANNELS,
					timestamp: tsUs,
					data: buf,
				});
				tsUs += Math.round((FRAMES / SAMPLE_RATE) * 1e6); // advance ~10000us
				void (writer as WritableStreamDefaultWriter<unknown>).write(ad);
			}, intervalMs);

			log("mechanism=MSTG success kind=audio");
			return gen as MediaStreamTrack; // MSTG instance IS itself a MediaStreamTrack
		} catch (e) {
			log(`mechanism=MSTG failed err=${e instanceof Error ? e.message : String(e)}; falling back`);
			if (feedTimer) {
				clearInterval(feedTimer);
				feedTimer = undefined;
			}
		}
	} else {
		log("mechanism=MSTG absent (typeof undefined)");
	}

	// Fallback: Web Audio — known-good in every Chromium, no Insertable Streams.
	log("mechanism=WebAudio attempt");
	const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
	activeCtx = ctx;
	const dest = ctx.createMediaStreamDestination();
	const osc = ctx.createOscillator();
	activeOsc = osc;
	osc.type = "sine";
	osc.frequency.value = 440;
	// distinctive cadence: repeating linear sweep 440→660Hz every ~0.4s so the viewer
	// clearly hears a moving "my test tone" rather than a static beep.
	const now = ctx.currentTime;
	for (let k = 0; k < 64; k++) {
		const base = now + k * 0.4;
		osc.frequency.setValueAtTime(440, base);
		osc.frequency.linearRampToValueAtTime(660, base + 0.2);
		osc.frequency.setValueAtTime(440, base + 0.2);
	}
	osc.connect(dest);
	osc.start();
	log("mechanism=WebAudio success");
	return dest.stream.getAudioTracks()[0];
}

// ── THROWAWAY: poll getStats() for outbound-rtp audio (viewer-independent GO corroboration) ──
async function pollStats(): Promise<void> {
	// Scan getSenders() at poll time too — Discord may replaceTrack on a pre-created
	// transceiver rather than addTrack (Pitfall 4).
	const senders = new Set<RTCRtpSender>(audioSenders);
	for (const pc of peerConnections) {
		try {
			for (const s of pc.getSenders()) {
				if (s.track?.kind === "audio") senders.add(s);
			}
		} catch {
			// pc may be closed
		}
	}
	log(`stats poll audioSenders=${senders.size}`);
	for (const sender of senders) {
		try {
			const report = await sender.getStats();
			for (const s of report.values()) {
				if (s.type === "outbound-rtp" && s.kind === "audio") {
					log(`stats outbound-rtp audio packetsSent=${s.packetsSent} bytesSent=${s.bytesSent} ssrc=${s.ssrc}`);
				}
			}
			const t = sender.track;
			if (t) log(`track kind=${t.kind} readyState=${t.readyState} muted=${t.muted}`);
		} catch (e) {
			log(`stats error err=${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

// Teardown — clear BOTH timers, stop oscillator, close AudioContext, release MSTG writer.
function teardownSpike(): void {
	if (feedTimer) {
		clearInterval(feedTimer);
		feedTimer = undefined;
	}
	if (statsTimer) {
		clearInterval(statsTimer);
		statsTimer = undefined;
	}
	try {
		activeOsc?.stop();
	} catch {
		// already stopped
	}
	activeOsc = undefined;
	try {
		void activeCtx?.close();
	} catch {
		// already closed
	}
	activeCtx = undefined;
	try {
		activeWriter?.releaseLock();
	} catch {
		// already released
	}
	activeWriter = undefined;
	log("spike teardown complete");
}

// Entry point: runs the full spike. Idempotent (install monkeypatches once).
export function installDeliverySpike(): void {
	if (installed) return;
	installed = true;

	const bridge = getBridge();

	// 1. Packaging-reachability proof (RESEARCH §Pitfall 1) — FIRST observable signal.
	//    An empty/absent screenshare-debug.log at runtime ⇒ packaging gap, NOT a delivery failure.
	//    Log the Chromium version (A1). `process` may be absent in main-world-injected context.
	let chromeVer = "unknown";
	try {
		const proc = (globalThis as { process?: { versions?: { chrome?: string } } }).process;
		chromeVer = proc?.versions?.chrome ?? `ua:${navigator.userAgent}`;
	} catch {
		chromeVer = `ua:${navigator.userAgent}`;
	}
	if (!bridge) {
		// No bridge ⇒ nothing to log to; bail (still byte-identical to off state for the page).
		return;
	}
	log(`spike-loaded chrome=${chromeVer}`);

	// 2. Capture audio RTCRtpSender via RTCPeerConnection.prototype.addTrack wrap
	//    (shape copied from domOptimizer.ts:21; logic from RESEARCH §Pattern 2).
	try {
		const PC = RTCPeerConnection;
		const origAddTrack = PC.prototype.addTrack;
		PC.prototype.addTrack = function (this: RTCPeerConnection, track: MediaStreamTrack, ...streams: MediaStream[]) {
			const sender = origAddTrack.call(this, track, ...streams);
			peerConnections.add(this);
			if (track.kind === "audio") audioSenders.add(sender);
			return sender;
		};
	} catch (e) {
		log(`addTrack-wrap failed err=${e instanceof Error ? e.message : String(e)}`);
	}

	// 3. Monkeypatch getDisplayMedia (mirrors screensharePatch.ts:2,22-25,87). Pass-through
	//    when the gate is off so the normal "loopback" path stays byte-identical.
	const md = navigator.mediaDevices;
	const originalGDM = md.getDisplayMedia.bind(md);
	md.getDisplayMedia = async function (this: MediaDevices, opts?: DisplayMediaStreamOptions): Promise<MediaStream> {
		const stream = await originalGDM(opts);

		// GATED — only reconstruct + swap when the spike is on.
		if (getBridge()?.deliverySpike) {
			try {
				const synthetic = buildSyntheticAudioTrack();
				// SWAP SEAM (screensharePatch.ts:79-84): stop/remove existing audio, add synthetic.
				for (const t of stream.getAudioTracks()) {
					t.stop();
					stream.removeTrack(t);
				}
				stream.addTrack(synthetic);
				log("swap-seam injected synthetic audio track");

				// Plainer teardown trigger than Vencord's FluxDispatcher STREAM_CLOSE (Common is
				// unavailable in preload-injected main-world code — PATTERNS §(c) note). The synthetic
				// track ending or the video track ending tears the spike down.
				const videoTrack = stream.getVideoTracks()[0];
				const onEnd = () => teardownSpike();
				synthetic.addEventListener("ended", onEnd);
				if (videoTrack) videoTrack.addEventListener("ended", onEnd);

				// 4. getStats poll — every ~2s, log climbing outbound-rtp audio packetsSent/bytesSent.
				if (!statsTimer) {
					statsTimer = setInterval(() => void pollStats(), 2000);
				}
			} catch (e) {
				log(`swap-seam failed err=${e instanceof Error ? e.message : String(e)}`);
			}
		}

		return stream;
	};

	log("spike installed (getDisplayMedia + addTrack wrapped)");
}

// Auto-run when injected as a main-world script string (preload.mts wraps the bundled source
// and calls this). Also exported for direct import in tests/other hosts.
installDeliverySpike();
