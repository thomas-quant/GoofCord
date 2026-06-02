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
