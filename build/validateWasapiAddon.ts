// Build-time guard for the Windows WASAPI echo-fix addon (the #46 fix, see
// src/modules/native/wasapiLoopback.ts). The addon arrives as a prebuilt optionalDependency
// (github:thomas-quant/wasapi-loopback) that build.ts's copyNativeModules() stages into
// assets/native/ on a best-effort basis (a missing prebuild off-Windows must never fail the
// build). That best-effort copy means an incompatible or absent win32/x64 addon previously went
// unnoticed until runtime, where wasapiLoopback.ts now fails closed — every Windows system-audio
// share silently loses its audio. This module makes that failure happen loudly, at build time,
// only for the one target that ships a prebuild at all.
//
// "Required" vs "diagnostic" exports are split by actual product usage (grepped from src/):
// listAudioApps backs the per-app include picker, startIncludeProcessTree backs app mode,
// startEndpointMinusSelf/getSubtractionStatus/getLastSubtractionStartError back system mode
// (start, aligning/running status, refusal reason) and stopSession/stopAll back stop — all
// product-required. startExcludeProcessTree (no longer used by src/ — system mode never falls
// back to EXCLUDE), listRenderEndpoints and getCaptureStats are only called from
// tools/wasapi-echo-test and research harnesses, so their absence is a diagnostics regression,
// not a shippability one.
import fs from "node:fs";

export const WASAPI_REQUIRED_EXPORTS = ["startIncludeProcessTree", "startEndpointMinusSelf", "getSubtractionStatus", "getLastSubtractionStartError", "stopSession", "stopAll", "listAudioApps"] as const;

export const WASAPI_DIAGNOSTIC_EXPORTS = ["startExcludeProcessTree", "listRenderEndpoints", "getCaptureStats"] as const;

export type WasapiExportName = (typeof WASAPI_REQUIRED_EXPORTS)[number] | (typeof WASAPI_DIAGNOSTIC_EXPORTS)[number];

export interface WasapiExportCheck {
	missingRequired: string[];
	missingDiagnostic: string[];
}

/** Pure export-shape check: does `addon` look like a usable wasapi-loopback session API? */
export function checkWasapiExports(addon: Record<string, unknown> | null | undefined): WasapiExportCheck {
	const isFn = (name: string) => typeof addon?.[name] === "function";
	return {
		missingRequired: WASAPI_REQUIRED_EXPORTS.filter((name) => !isFn(name)),
		missingDiagnostic: WASAPI_DIAGNOSTIC_EXPORTS.filter((name) => !isFn(name)),
	};
}

/**
 * Delete a staged addon file after a failed copy, so a build that fails to fetch/copy a fresh
 * prebuild can never ship whatever was staged by a previous, unrelated build. assets/native/ is
 * never cleaned between builds, so without this a stale .node silently rides along.
 */
export async function removeStaleAddonFile(destPath: string, rm: (path: string, opts: { force: boolean }) => Promise<void> = fs.promises.rm): Promise<void> {
	await rm(destPath, { force: true }).catch(() => {});
}

export class WasapiValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WasapiValidationError";
	}
}

export interface ValidateWasapiAddonOptions {
	/** Build target, e.g. from build.ts's TARGET_PLATFORM/TARGET_ARCH. */
	targetPlatform: string;
	targetArch: string;
	/** Where copyNativeModules() staged (or would stage) the addon, e.g. assets/native/wasapi-loopback-win32-x64.node. */
	addonPath: string;
	/** The host actually running this build step. Defaults to process.platform; overridable for tests. */
	hostPlatform?: string;
	fileExists?: (path: string) => boolean;
	/** require()-like loader, overridable so tests can inject fake exports without a real .node. */
	loadAddon?: (path: string) => unknown;
	log?: Pick<Console, "warn">;
}

/**
 * Throws WasapiValidationError for anything a real GoofCord build must not ship silently:
 * a win32/x64 build target with no staged addon, or a staged addon missing product-required
 * exports. Missing diagnostic-only exports are logged, not fatal. Any other build target
 * (non-Windows, or Windows on an arch with no committed prebuild) is a no-op: no prebuild is
 * expected there, so its absence is normal.
 */
export function validateWasapiAddon(options: ValidateWasapiAddonOptions): void {
	const { targetPlatform, targetArch, addonPath, hostPlatform = process.platform, fileExists = fs.existsSync, loadAddon, log = console } = options;

	if (targetPlatform !== "win32" || targetArch !== "x64") return;

	if (!fileExists(addonPath)) {
		throw new WasapiValidationError(`wasapi-loopback addon is required for a win32/x64 build but is missing at ${addonPath}. Check that the "wasapi-loopback" optionalDependency installed its win32-x64 prebuild (bun install on a clean node_modules may be needed).`);
	}

	if (hostPlatform !== "win32") {
		log.warn(`[validateWasapiAddon] Staged ${addonPath} for a win32/x64 target, but this build is running on ${hostPlatform} which cannot load a Windows .node. Skipping export validation — only a Windows build host can verify the addon is loadable.`);
		return;
	}

	if (!loadAddon) {
		throw new WasapiValidationError(`wasapi-loopback addon at ${addonPath} exists but no loader was provided to validate it on a win32 host.`);
	}

	let addon: unknown;
	try {
		addon = loadAddon(addonPath);
	} catch (e: unknown) {
		throw new WasapiValidationError(`wasapi-loopback addon at ${addonPath} failed to load: ${e instanceof Error ? e.message : String(e)}. The staged .node is likely corrupt or built for a different Node/Electron ABI.`);
	}

	const { missingRequired, missingDiagnostic } = checkWasapiExports(addon as Record<string, unknown>);

	if (missingRequired.length > 0) {
		throw new WasapiValidationError(`wasapi-loopback addon at ${addonPath} is missing required session API export(s): ${missingRequired.join(", ")}. This addon build is incompatible with src/modules/native/wasapiLoopback.ts, which fails closed at runtime (screenshares without audio).`);
	}

	if (missingDiagnostic.length > 0) {
		log.warn(`[validateWasapiAddon] wasapi-loopback addon at ${addonPath} is missing diagnostics-only export(s): ${missingDiagnostic.join(", ")}. Capture will still work; test tooling under tools/wasapi-echo-test may not.`);
	}
}
