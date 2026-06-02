// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — main-process transport host for the Windows WASAPI EXCLUDE-tree echo fix.
//
// SPIKE STATE (Slice 1, gated by GOOFCORD_TRANSPORT_SPIKE): this file currently ships a
// SYNTHETIC 48k/stereo/f32 tone (THROWAWAY) instead of a real WASAPI capture. The file
// NAME and SHAPE are the KEEP — Slice 2 (Plan 02/03) swaps the real clean-room `.node`
// addon in behind the exact same transport (MessageChannelMain → webContents.postMessage).
// The synthetic tone proves the last-unproven half of the make-or-break delivery path
// (the main→renderer PCM transport, Phase 3 residual risk #1) before any native investment.
//
// Diagnostics → userData screenshare-debug.log (no DevTools on the Windows test box).
// All spike code is gated; with the gate OFF this module's start path is a no-op (returns
// false immediately) so the normal Windows "loopback" path is byte-identical to upstream.
// ─────────────────────────────────────────────────────────────────────────────

import { app, MessageChannelMain, type MessagePortMain } from "electron";
import pc from "picocolors";

import { appendScreenshareDebug, isTransportSpikeEnabled } from "@root/src/modules/screenshareDebug.ts";
import { getErrorMessage } from "@root/src/utils.ts";

import { mainWindow } from "../../windows/main/main.ts";

const LOG_PREFIX = pc.cyan("[Screenshare]");

// 48k / stereo / f32, 480-frame (~10ms) chunks — matches the Phase 3 renderer contract.
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const FRAMES = 480;
const CHUNK_BYTES = FRAMES * CHANNELS * 4; // 480 * 2 * 4 = 3840 bytes

// ── State (nulled by stopWasapiLoopback; safe to call stop twice) ────────────────────────
let port1: MessagePortMain | undefined;
let synthInterval: NodeJS.Timeout | undefined;
let chunkCount = 0;
let logCount = 0;

// THROWAWAY: synthesize a distinctive 440→660Hz sweep (200ms on / 200ms off) from a running
// sample counter so the cadence is unmistakable to the viewer (NOT a flat tone, NOT noise).
// Mirrors deliverySpike.ts:85-91 makeDistinctiveSample, but generated in the MAIN process.
function makeDistinctiveSample(sampleIndex: number): number {
	const tSec = sampleIndex / SAMPLE_RATE;
	const intoBeat = tSec % 0.4; // 0..0.4
	if (intoBeat >= 0.2) return 0; // 200ms on / 200ms off
	const freq = 440 + (660 - 440) * (intoBeat / 0.2);
	return 0.3 * Math.sin(2 * Math.PI * freq * tSec);
}

/**
 * Start the transport host. For the spike: synthesize a tone in the main process and ship it
 * over a MessageChannelMain port to the renderer (hop-1). Returns false (no-op) when the spike
 * gate is off or on any failure — never crashes (the byte-identical-fallback discipline ECHO-03
 * will later rely on this).
 */
export async function tryStartWasapiLoopback(): Promise<boolean> {
	if (!isTransportSpikeEnabled()) return false;

	try {
		// PID discipline (ECHO-02) exercised early even in the spike: resolve the EXCLUDE-tree
		// root (Electron main) and log the Audio Service child so the first CI artifact confirms
		// the tree layout. RESEARCH §Code Examples L423-435.
		const rootPid = process.pid;
		const metrics = app.getAppMetrics();
		const audioService = metrics.find((p) => p.name === "Audio Service");
		void appendScreenshareDebug(`wasapi exclude-root=${rootPid} audioService=${audioService?.pid ?? "not-found"} procs=${metrics.map((p) => `${p.name}:${p.pid}`).join(",")}`);

		// Make start idempotent across re-clicks: tear down any prior synthetic source first.
		await stopWasapiLoopback();

		// Hop-1: create the channel, keep port1, transfer port2 to the renderer's preload
		// (isolated world). MessageChannelMain is the canonical Electron zero-copy audio path —
		// NEVER per-frame ipcRenderer.send of raw PCM (locked anti-pattern T2).
		const channel = new MessageChannelMain();
		port1 = channel.port1;
		mainWindow.webContents.postMessage("wasapi:pcm-port", null, [channel.port2]);
		port1.start();

		chunkCount = 0;
		logCount = 0;
		let phase = 0; // running sample counter for the synthetic tone

		const intervalMs = (FRAMES / SAMPLE_RATE) * 1000; // ≈10ms
		synthInterval = setInterval(() => {
			const port = port1;
			if (!port) return;

			// Pack a fresh interleaved-stereo f32 buffer (L,R,L,R...) for THIS chunk.
			const buf = new ArrayBuffer(CHUNK_BYTES);
			const view = new Float32Array(buf);
			for (let i = 0; i < FRAMES; i++) {
				const s = makeDistinctiveSample(phase++);
				view[i * 2] = s;
				view[i * 2 + 1] = s;
			}
			// Transfer list [buf] → zero-copy, NOT structured clone (RESEARCH line 264).
			// @ts-expect-error Electron types MessagePortMain.postMessage's transfer list as
			// MessagePortMain[], but the runtime accepts (and is documented for) ArrayBuffer
			// transferables — the canonical zero-copy audio path this spike is proving.
			port.postMessage(buf, [buf]);
			chunkCount++;

			// Periodic auditable chunk-count line (every ~1s) — required for honest verification.
			if (chunkCount - logCount >= 100) {
				logCount = chunkCount;
				void appendScreenshareDebug(`wasapi activation=spike-synthetic hop1=messageport chunks=${chunkCount}`);
			}
		}, intervalMs);

		console.log(LOG_PREFIX, "Transport spike: synthetic tone streaming over MessageChannelMain");
		return true;
	} catch (e) {
		void appendScreenshareDebug(`wasapi start threw: ${getErrorMessage(e)}`);
		return false; // → "loopback" fallback, never crash (ECHO-03)
	}
}

/**
 * Idempotent teardown: clear the synthetic interval, close the kept port, null state.
 * Safe to call twice (mirrors stopPatchcord; composes with the single-owner finishRequest).
 */
export async function stopWasapiLoopback<IPCHandle>() {
	if (synthInterval) {
		clearInterval(synthInterval);
		synthInterval = undefined;
	}
	const port = port1;
	port1 = undefined;
	if (port) {
		try {
			port.close();
		} catch {
			// already closed
		}
		void appendScreenshareDebug(`wasapi activation=spike-synthetic hop1=messageport chunks=${chunkCount}`);
		console.log(LOG_PREFIX, "Transport spike: stopped synthetic tone");
	}
}

// A hung stop must not wedge quit (mirror patchcord.ts:168-184 Promise.race([dispose, timeout])).
app.on("before-quit", (event) => {
	if (!port1 && !synthInterval) return;

	event.preventDefault();
	Promise.race([stopWasapiLoopback(), new Promise((resolve) => setTimeout(resolve, 1500))])
		.catch((err) => console.error(LOG_PREFIX, "WASAPI stop failed:", err))
		.finally(() => app.quit());
});
