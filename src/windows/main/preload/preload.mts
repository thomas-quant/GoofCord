import "./bridge.ts";
import { getConfig, whenConfigReady } from "@root/src/stores/config/config.preload.ts";
import { ipcRenderer, webFrame } from "electron";

import { sendSync } from "../../../ipc/client.preload.ts";
import { error, log } from "../../../modules/logger.preload.ts";
import { loadScripts, loadStyles } from "./assets.ts";
import { startKeybindWatcher } from "./keybinds.ts";
import { injectFlashbar } from "./titlebarFlash.ts";
// Windows WASAPI EXCLUDE-tree echo fix (the #46 fix): the main-world PCM feeder + getDisplayMedia swap seam.
import { createWasapiPortForwarder, wasapiTransportMainWorldSource } from "./wasapiTransport.ts";

const preloadStart = performance.now();

function init() {
	if (!document.location.hostname.includes("discord") || document.location.href.includes("/popout")) return;

	loadScripts();
	loadStyles();

	injectWasapiTransport();

	measureDiscordStartup();
	injectFlashbar();
	startKeybindWatcher();
	disableAltMenu();
}

// Windows WASAPI EXCLUDE-tree echo fix (the #46 fix).
// Hop-2 (preload isolated world → page main world): inject the MessagePort-fed MSTG feeder +
// getDisplayMedia swap seam into the Discord page MAIN WORLD, then forward the hop-1 MessagePort
// into it via window.postMessage(..., [port]) — but ONLY after the main world signals it has
// registered its listener (the load-bearing readiness handshake).
// The gate `shouldInjectWasapiTransport` is true on the win32 wasapi path (not --no-wasapi) so the
// addon's chunks have a feeder to land in. Off-Windows or --no-wasapi ⇒ no injection, byte-identical
// to upstream.
function injectWasapiTransport() {
	if (!sendSync("wasapiLoopback:shouldInjectWasapiTransport")) return;

	// Holds the newest port until the main world posts "goofcord:wasapi-ready", then forwards it
	// with its captureId. Registered before injection so the readiness message can't be missed.
	const forwardPort = createWasapiPortForwarder(window);

	// Electron delivers the main-process webContents.postMessage (message { captureId } + the
	// transferred port) to the preload's ipcRenderer as a native DOM MessagePort in this world.
	ipcRenderer.on("wasapi:pcm-port", (event, message: { captureId?: unknown } | null) => {
		const port = (event as unknown as { ports: MessagePort[] }).ports[0];
		if (!port) return;
		forwardPort(port, message?.captureId);
	});

	webFrame
		.executeJavaScript(wasapiTransportMainWorldSource)
		.then(() => log("Loaded WASAPI Transport"))
		.catch((err) => error(`Failed WASAPI Transport: ${err}`));
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
