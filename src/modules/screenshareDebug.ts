// THROWAWAY — Phase 3 delivery-path spike scaffolding (GOOFCORD_DELIVERY_SPIKE) +
// Phase 4 transport spike (GOOFCORD_TRANSPORT_SPIKE).
// Strip this file (and its IPC channels) before any upstream PR — the
// userData screenshare-debug.log must not ship in normal builds (UPST hygiene).

import fs from "node:fs";
import path from "node:path";

import { userDataPath } from "../utils.ts";

const LOG = path.join(userDataPath, "screenshare-debug.log");

export async function appendScreenshareDebug<IPCHandle>(line: string) {
	await fs.promises.appendFile(LOG, `${new Date().toISOString()} ${line}\n`);
}

export function isDeliverySpikeEnabled<IPCOn>() {
	return process.env.GOOFCORD_DELIVERY_SPIKE === "1" || process.argv.includes("--delivery-spike");
}

// THROWAWAY — Phase 4 transport spike (GOOFCORD_TRANSPORT_SPIKE). Mirrors isDeliverySpikeEnabled.
// Arms the main→renderer→main-world PCM transport spike (synthetic tone over the real MessagePort
// transport). Strip with the rest of the spike scaffolding before the Phase 5 upstream PR.
export function isTransportSpikeEnabled<IPCOn>() {
	return process.env.GOOFCORD_TRANSPORT_SPIKE === "1" || process.argv.includes("--transport-spike");
}

// Phase 4 (Plan 04-03) — whether preload.mts should inject the MSTG feeder + getDisplayMedia swap
// seam into the Discord page main world. The REAL Windows WASAPI EXCLUDE-tree path needs the feeder
// present whenever the addon can run (win32, not --no-wasapi) — NOT only under the spike env — so the
// addon's chunks have a feeder to land in (otherwise capture silently falls through to echoing
// "loopback"). The transport spike (synthetic tone) keeps working on any platform via the env gate.
// Read from main via sendSync (the sandboxed preload has no process.env / authoritative platform).
// Off-Windows AND spike-disabled ⇒ false ⇒ no injection ⇒ the page stays byte-identical to upstream.
export function shouldInjectWasapiTransport<IPCOn>() {
	const realWindowsPath = process.platform === "win32" && !process.argv.includes("--no-wasapi");
	return realWindowsPath || isTransportSpikeEnabled();
}
