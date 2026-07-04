import { getConfig, setConfig, whenConfigReady, getDefaultValue } from "@root/src/stores/config/config.preload.ts";
import { i, whenLocalizationReady } from "@root/src/stores/localization/localization.preload.ts";
import { ipcRenderer } from "electron";
import type { ShareableNode } from "patchcord";

import { invoke } from "../../../ipc/client.preload.ts";

interface IPCSource {
	id: string;
	name: string;
	thumbnail: string;
}

interface AudioConfig {
	mode: "none" | "system" | "app";
	pids: number[];
	// system-mode backend selector: "process-exclude" = EXCLUDE-self (default, today's #211 behavior);
	// "endpoint" = loopback of a chosen render device (Plan 04). No third/self-cancel value (that lineage is dead).
	captureSource: "process-exclude" | "endpoint";
	// endpoint mode: chosen IMMDevice id, or the "default" sentinel.
	endpointId: "default" | string;
}

export interface ScreenshareSettings {
	resolution: number;
	framerate: number;
	audioConfig: AudioConfig;
	contentHint: "motion" | "detail";
}

// A render endpoint offered in the win32 capture-source dropdown (mirrors the main-process
// RenderEndpointInfo / Rust napi shape): `id` = IMMDevice id, `name` = friendly name, `isDefault`
// flags the console default. Kept local (like AudioConfig/ScreensharePayload) so the sandboxed
// preload never imports the main-process wasapiLoopback module.
interface RenderEndpointInfo {
	id: string;
	name: string;
	isDefault: boolean;
}

interface ScreensharePayload {
	sources: IPCSource[] | null;
	audioNodes: ShareableNode[];
	isPatchcord: boolean;
	// win32: true when the native WASAPI addon can run → show the advanced audio UI (mode control +
	// app checklist) instead of the plain system checkbox. Lets the win32 path reach app mode.
	isWasapiAudio: boolean;
	// win32: active render endpoints for the capture-source dropdown ("Default" + these). Empty off-win32.
	renderEndpoints: RenderEndpointInfo[];
}

const DISPLAY_MODES = {
	Quality: { "480p": 480, "720p": 720, "1080p": 1080, "1440p": 1440, Source: 2160 },
	Framerate: { "15fps": 15, "30fps": 30, "60fps": 60 },
} as const;

// Minimalist, accessible icons for Segmented Controls
const CONTROL_ICONS: Record<string, string> = {
	motion: `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
	detail: `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`,
	none: `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" x2="17" y1="9" y2="15"/><line x1="17" x2="23" y1="9" y2="15"/></svg>`,
	system: `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>`,
	app: `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/></svg>`,
};

let isPatchcordMode = false;
let isWasapiAudio = false;
let isRefreshing = false;

const escapeMap: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text: string) => String(text ?? "").replace(/[&<>"']/g, (m) => escapeMap[m]);

const $ = <T extends HTMLElement>(id: string): T => {
	const el = document.getElementById(id);
	if (!el) throw new Error(`[Screenshare] Strict DOM Contract Failed: Missing '#${id}'`);
	return el as T;
};

// Generates accessible Segmented Control HTML with optional tasteful icons
function generateSegmentedControlHtml(name: string, options: Record<string, string | number>, selectedValue: string | number): string {
	return Object.entries(options)
		.map(
			([label, value]) => `
			<label class="segmented-control__item">
				<input type="radio" name="${escapeHtml(name)}" value="${value}" ${value === selectedValue ? "checked" : ""}>
				<span>
					${CONTROL_ICONS[value as string] || ""}
					${escapeHtml(label)}
				</span>
			</label>
		`,
		)
		.join("");
}

function createSourceItemHtml({ id, name, thumbnail }: IPCSource): string {
	const escapedName = escapeHtml(name === "unknown" ? i("screenshare-unknown-source") : name);
	return `
		<li class="desktop-capturer-selection__item">
			<button class="desktop-capturer-selection__btn" data-id="${escapeHtml(id)}" title="${escapedName}">
				<div class="desktop-capturer-selection__thumbnail-container">
					<img class="desktop-capturer-selection__thumbnail" src="${thumbnail}" alt="${escapedName}">
				</div>
				<span class="desktop-capturer-selection__name">${escapedName}</span>
			</button>
		</li>
	`;
}

function renderAudioApps(audioNodes: ShareableNode[], previousPids: number[]): string {
	const uniqueApps = new Map<number, ShareableNode>();
	for (const node of audioNodes) {
		if (node.processId) uniqueApps.set(node.processId, node);
	}

	if (uniqueApps.size === 0) {
		return `<div class="audio-apps-empty" style="grid-column: 1 / -1;">${escapeHtml(i("screenshare-audio-empty"))}</div>`;
	}

	return Array.from(uniqueApps.values())
		.sort((a, b) => a.displayName.localeCompare(b.displayName))
		.map(
			(app) => `
			<label class="audio-app-item">
				<input type="checkbox" value="${app.processId}" ${previousPids.includes(app.processId!) ? "checked" : ""}>
				<span class="audio-app-name">${escapeHtml(app.displayName)}</span>
			</label>
		`,
		)
		.join("");
}

function getFormSettings(): ScreenshareSettings | null {
	const contentHint = document.querySelector<HTMLInputElement>('input[name="contentHint"]:checked')?.value as "motion" | "detail";
	const resolution = Number(document.querySelector<HTMLInputElement>('input[name="resolution"]:checked')?.value);
	const framerate = Number(document.querySelector<HTMLInputElement>('input[name="framerate"]:checked')?.value);

	if (!contentHint || isNaN(resolution) || isNaN(framerate)) return null;

	let audioConfig: AudioConfig = { mode: "none", pids: [], captureSource: "process-exclude", endpointId: "default" };

	if (isPatchcordMode || isWasapiAudio) {
		audioConfig.mode = (document.querySelector<HTMLInputElement>('input[name="audioMode"]:checked')?.value as AudioConfig["mode"]) ?? "none";
		audioConfig.pids = Array.from(document.querySelectorAll<HTMLInputElement>("#audio-apps-list input:checked")).map((el) => Number(el.value));

		// win32 capture-source derivation: only a NON-"default" endpoint chosen in system mode flips the
		// backend to endpoint loopback. "Default" (or app/none mode) keeps the shipped zero-config
		// process-exclude behavior — normal users are never flipped into endpoint mode. audioConfig is
		// initialized with { captureSource: "process-exclude", endpointId: "default" }, so those defaults
		// stand untouched unless this branch overrides them.
		if (isWasapiAudio && audioConfig.mode === "system") {
			const chosenEndpoint = document.querySelector<HTMLSelectElement>("#endpoint-select")?.value ?? "default";
			if (chosenEndpoint !== "default") {
				audioConfig.captureSource = "endpoint";
				audioConfig.endpointId = chosenEndpoint;
			}
		}
	} else if ($<HTMLInputElement>("audio-share-checkbox").checked) {
		audioConfig.mode = "system";
	}

	return { audioConfig, contentHint, resolution, framerate };
}

async function selectSource(id: string | null, title: string | null): Promise<void> {
	const settings = getFormSettings();
	if (!settings) return;

	try {
		await invoke("flashTitlebar", "#5865F2");
		await setConfig("screensharePreviousSettings", settings);
		await ipcRenderer.invoke("selectScreenshareSource", id ?? "", title ?? "", settings.audioConfig, settings.contentHint, settings.resolution, settings.framerate);
	} catch (err) {
		console.error("[selectSource] IPC error:", err);
	}
}

async function refreshData() {
	if (isRefreshing) return;
	isRefreshing = true;

	const btn = $("refresh-btn");
	btn.classList.add("spinning");

	try {
		const { sources, audioNodes } = (await ipcRenderer.invoke("refreshScreenshareSources")) as ScreensharePayload;

		if (sources) {
			$("sources-list").innerHTML = sources.map(createSourceItemHtml).join("");
		}

		if (isPatchcordMode || isWasapiAudio) {
			const selectedPids = Array.from(document.querySelectorAll<HTMLInputElement>("#audio-apps-list input:checked")).map((el) => Number(el.value));
			$("audio-apps-list").innerHTML = renderAudioApps(audioNodes, selectedPids);
		}
	} catch (err) {
		console.error("[Screenshare] Failed to refresh sources:", err);
	} finally {
		btn.classList.remove("spinning");
		isRefreshing = false;
	}
}

async function init() {
	await Promise.all([whenLocalizationReady(), whenConfigReady()]);

	const storedSettings = getConfig("screensharePreviousSettings") as ScreenshareSettings;
	const s = !storedSettings || Array.isArray(storedSettings) ? (getDefaultValue("screensharePreviousSettings") as ScreenshareSettings) : storedSettings;
	s.audioConfig ??= { mode: "none", pids: [], captureSource: "process-exclude", endpointId: "default" };
	// Normalize older saved configs that predate the capture-source fields (locked decision).
	s.audioConfig.captureSource ??= "process-exclude";
	s.audioConfig.endpointId ??= "default";

	const payload = (await ipcRenderer.invoke("refreshScreenshareSources")) as ScreensharePayload;
	isPatchcordMode = payload.isPatchcord;
	isWasapiAudio = payload.isWasapiAudio;

	$("title-text").textContent = i("screenshare-screenshare");
	$("subtitle-text").textContent = i("screenshare-subtitle");
	$("refresh-btn").title = i("screenshare-refresh");
	$("stream-settings-title").textContent = i("screenshare-stream-settings");
	$("hint-label").textContent = i("screenshare-optimization");
	$("resolution-label").textContent = i("screenshare-resolution");
	$("framerate-label").textContent = i("screenshare-framerate");

	const contentHintOpts = {
		[i("screenshare-optimization-motion")]: "motion",
		[i("screenshare-optimization-detail")]: "detail",
	};
	$("content-hint-group").innerHTML = generateSegmentedControlHtml("contentHint", contentHintOpts, s.contentHint);
	$("resolution-group").innerHTML = generateSegmentedControlHtml("resolution", DISPLAY_MODES.Quality, s.resolution);
	$("framerate-group").innerHTML = generateSegmentedControlHtml("framerate", DISPLAY_MODES.Framerate, s.framerate);

	if (isPatchcordMode || isWasapiAudio) {
		$("linux-audio-section").style.display = "block";
		$("linux-audio-title").textContent = i("screenshare-audio-linux-title");
		$("audio-mode-label").textContent = i("screenshare-audio-mode-label");

		const audioModeOpts = {
			[i("screenshare-audio-none")]: "none",
			[i("screenshare-audio-system")]: "system",
			[i("screenshare-audio-app")]: "app",
		};

		const modeGroup = $("audio-mode-group");
		modeGroup.innerHTML = generateSegmentedControlHtml("audioMode", audioModeOpts, s.audioConfig.mode);

		const appsContainer = $("audio-apps-container");
		const appsLabel = $("audio-apps-label");
		const appsDesc = $("audio-apps-desc");

		// win32 capture-source selector: a dropdown of "Default" + the active render endpoints, built only
		// on Windows (isWasapiAudio) — patchcord/Linux has no endpoint concept — and shown only in system
		// mode (wired into updateAppListVisibility below). Choosing a non-"default" endpoint points
		// GoofCord's loopback at that clean render bus (the VAC/Sonar fix); "Default" keeps the shipped
		// zero-config process-exclude behavior. A <select> (not a segmented control) because the endpoint
		// list is arbitrary-length. Injected here rather than in screenshare.html to keep the diff surgical.
		let endpointContainer: HTMLElement | null = null;
		if (isWasapiAudio) {
			const grid = document.querySelector<HTMLElement>("#linux-audio-section .settings-grid");
			if (grid) {
				const storedEndpoint = s.audioConfig.endpointId ?? "default";
				const endpointOptions = [`<option value="default"${storedEndpoint === "default" ? " selected" : ""}>Default (system default)</option>`]
					.concat(
						payload.renderEndpoints.map((ep) => {
							const label = ep.name + (ep.isDefault ? " (default)" : "");
							return `<option value="${escapeHtml(ep.id)}"${ep.id === storedEndpoint ? " selected" : ""}>${escapeHtml(label)}</option>`;
						}),
					)
					.join("");

				endpointContainer = document.createElement("div");
				endpointContainer.className = "setting-group";
				endpointContainer.id = "endpoint-selector-container";
				endpointContainer.style.display = "none";
				endpointContainer.innerHTML = `
					<span class="settings-label">
						<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
						<span id="endpoint-select-label">Capture source</span>
					</span>
					<select id="endpoint-select" class="endpoint-select" aria-labelledby="endpoint-select-label">${endpointOptions}</select>
				`;
				grid.appendChild(endpointContainer);
			}
		}

		let previousMode = s.audioConfig.mode;

		const updateAppListVisibility = () => {
			const currentMode = document.querySelector<HTMLInputElement>('input[name="audioMode"]:checked')?.value || "none";
			const isNone = currentMode === "none";
			appsContainer.style.display = isNone ? "none" : "flex";

			// The capture-source dropdown is a system-mode concept only (endpoint loopback replaces the
			// system mix); hide it for app/none so it can't be mistaken for an app-mode control.
			if (endpointContainer) endpointContainer.style.display = currentMode === "system" ? "flex" : "none";

			if (!isNone) {
				const isSystem = currentMode === "system";
				appsLabel.textContent = i(isSystem ? "screenshare-audio-excluded" : "screenshare-audio-included");
				appsDesc.textContent = i(isSystem ? "screenshare-audio-mute-desc" : "screenshare-audio-hear-desc");
			}
		};

		modeGroup.addEventListener("change", (e) => {
			const target = e.target as HTMLInputElement;
			if (target.name === "audioMode") {
				const val = target.value as typeof s.audioConfig.mode;
				if (val !== "none" && previousMode !== "none" && val !== previousMode) {
					appsContainer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => (cb.checked = false));
				}
				previousMode = val;
				updateAppListVisibility();
			}
		});

		updateAppListVisibility();
		$("audio-apps-list").innerHTML = renderAudioApps(payload.audioNodes, s.audioConfig.pids);
	} else {
		$("standard-audio-section").style.display = "block";
		$("audio-toggle-label").textContent = i("screenshare-audio-capture");
		$("audio-toggle-desc").textContent = i("screenshare-audio-capture-desc");
		$<HTMLInputElement>("audio-share-checkbox").checked = s.audioConfig.mode !== "none";
	}

	if (payload.sources) {
		$("sources-list").innerHTML = payload.sources.map(createSourceItemHtml).join("");
	}

	$("refresh-btn").addEventListener("click", () => void refreshData());

	await ipcRenderer.invoke("showScreenshareWindow");
	document.querySelector<HTMLElement>(".desktop-capturer-selection__btn")?.focus();
}

window.addEventListener("DOMContentLoaded", () => void init());

document.addEventListener("click", (event) => {
	const button = (event.target as HTMLElement).closest(".desktop-capturer-selection__btn");
	if (button instanceof HTMLElement) {
		void selectSource(button.dataset.id ?? null, button.title ?? null);
	}
});

document.addEventListener("keydown", (event) => {
	if (event.code === "Escape") {
		void ipcRenderer.invoke("selectScreenshareSource");
	}
});
