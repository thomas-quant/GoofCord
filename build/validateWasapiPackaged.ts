// Post-packaging safeguard, run in CI after `electron-builder` has produced the win32/x64 output.
// validateWasapiAddon() in build.ts already checks the addon staged into ts-out/native BEFORE
// packaging; this script re-checks the addon actually shipped in the packaged app, at its final
// app.asar.unpacked location, the same way Electron's own require()/dlopen would load it at
// runtime. Node napi-loads it (no capture is started) so a packaging step that dropped or
// corrupted the .node — asarUnpack misconfiguration, a bad electron-builder `files` filter — fails
// the build instead of shipping a silent echoing fallback.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import pc from "picocolors";

import { checkWasapiExports, WASAPI_REQUIRED_EXPORTS } from "./validateWasapiAddon.ts";

const ADDON_FILENAME = "wasapi-loopback-win32-x64.node";

async function main() {
	if (!existsSync("dist")) {
		console.error(pc.red("ASSERT FAIL: dist/ does not exist. Run electron-builder before this check."));
		process.exit(1);
	}

	const glob = new Bun.Glob(`**/app.asar.unpacked/**/${ADDON_FILENAME}`);
	const matches = await Array.fromAsync(glob.scan({ cwd: "dist", absolute: true }));

	if (matches.length === 0) {
		console.error(pc.red(`ASSERT FAIL: ${ADDON_FILENAME} not found under dist/**/app.asar.unpacked/. The packaged Windows build would silently fall back to the echoing capture path at runtime.`));
		process.exit(1);
	}

	const require = createRequire(import.meta.url);
	let failed = false;

	for (const addonPath of matches) {
		console.log(pc.cyan("Checking packaged addon:"), addonPath);

		let addon: unknown;
		try {
			addon = require(addonPath);
		} catch (e: unknown) {
			console.error(pc.red(`ASSERT FAIL: ${addonPath} failed to load: ${e instanceof Error ? e.message : String(e)}`));
			failed = true;
			continue;
		}

		const { missingRequired, missingDiagnostic } = checkWasapiExports(addon as Record<string, unknown>);

		if (missingRequired.length > 0) {
			console.error(pc.red(`ASSERT FAIL: ${addonPath} is missing required session API export(s): ${missingRequired.join(", ")}`));
			failed = true;
			continue;
		}

		if (missingDiagnostic.length > 0) {
			console.warn(pc.yellow(`WARN: ${addonPath} is missing diagnostics-only export(s): ${missingDiagnostic.join(", ")}`));
		}

		console.log(pc.green(`OK: all ${WASAPI_REQUIRED_EXPORTS.length} required session API export(s) present and loadable.`));
	}

	if (failed) process.exit(1);
}

await main();
