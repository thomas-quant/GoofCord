import "./bridge.ts";
import { getConfig, whenConfigReady } from "@root/src/stores/config/config.preload.ts";
import { webFrame } from "electron";

import { sendSync } from "../../../ipc/client.preload.ts";
import { error, log } from "../../../modules/logger.preload.ts";
import { loadScripts, loadStyles } from "./assets.ts";
// THROWAWAY — Phase 3 delivery-path spike (GOOFCORD_DELIVERY_SPIKE); strip before upstream PR.
import { spikeMainWorldSource } from "./deliverySpike.ts";
import { startKeybindWatcher } from "./keybinds.ts";
import { injectFlashbar } from "./titlebarFlash.ts";

const preloadStart = performance.now();

function init() {
	if (!document.location.hostname.includes("discord") || document.location.href.includes("/popout")) return;

	loadScripts();
	loadStyles();

	injectDeliverySpike();

	measureDiscordStartup();
	injectFlashbar();
	startKeybindWatcher();
	disableAltMenu();
}

// THROWAWAY — Phase 3 delivery-path spike (GOOFCORD_DELIVERY_SPIKE); strip before upstream PR.
// Inject the packaged spike into the Discord page MAIN WORLD via webFrame.executeJavaScript
// (the loadScripts() mechanism) ONLY when the gate is on. Off ⇒ byte-identical to today.
function injectDeliverySpike() {
	// Read the gate from main (the sandboxed preload has no process.env). Same sync channel
	// the goofcord bridge's `deliverySpike` field reads. Off-by-default ⇒ no injection.
	if (!sendSync("screenshareDebug:isDeliverySpikeEnabled")) return;
	webFrame
		.executeJavaScript(spikeMainWorldSource)
		.then(() => log("Loaded Delivery Spike"))
		.catch((err) => error(`Failed Delivery Spike: ${err}`));
}

function measureDiscordStartup() {
	const observer = new MutationObserver((_mutations, obs) => {
		const guildList = document.querySelector('nav[class*="guilds"]');

		if (guildList) {
			const duration = performance.now() - preloadStart;
			log(`Discord Interactive in: ${duration.toFixed(2)}ms`);
			obs.disconnect();
		}
	});

	observer.observe(document, {
		childList: true,
		subtree: true,
	});
}

function disableAltMenu() {
	if (getConfig("disableAltMenu")) {
		// https://github.com/electron/electron/issues/34211
		window.addEventListener("keydown", (e) => {
			if (e.code === "AltLeft") e.preventDefault();
		});
	}
}

void whenConfigReady().then(init);
