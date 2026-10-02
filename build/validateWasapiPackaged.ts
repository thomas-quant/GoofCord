// Validate each fresh target output, including ASAR contents, not stale files elsewhere in dist.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { validateWasapiAddon, wasapiTargetFilename, WASAPI_REQUIRED_EXPORTS } from "./validateWasapiAddon.ts";

const require = createRequire(import.meta.url);

function findAsars(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(root, entry.name);
		return entry.isDirectory() ? findAsars(full) : entry.name === "app.asar" ? [full] : [];
	});
}

export function validateWasapiPackaged(appOutDir: string, platform: string, arch: string): void {
	const asars = findAsars(appOutDir);
	if (asars.length !== 1) throw new Error(`Expected one app.asar in fresh target output ${appOutDir}; found ${asars.length}`);
	const asar = asars[0];
	const { listPackage } = require("@electron/asar") as { listPackage(file: string): string[] };
	const entries = listPackage(asar).filter((entry) => /wasapi-loopback.*\.node$/.test(entry));
	const expected = wasapiTargetFilename(platform, arch);
	if (!expected) {
		if (entries.length || existsSync(path.join(`${asar}.unpacked`, "ts-out", "native", "wasapi-loopback-win32-x64.node"))) throw new Error(`Unexpected WASAPI addon in ${platform}/${arch}: ${entries.join(", ")}`);
		console.log(`[WASAPI packaged] ${platform}/${arch}: no Windows addon in ${asar} or unpacked native path`);
		return;
	}
	if (entries.length !== 1 || entries[0].replaceAll("\\", "/") !== `/ts-out/native/${expected}`) throw new Error(`Wrong WASAPI entries in ${asar}: ${entries.join(", ")}`);
	const addonPath = path.resolve(`${asar}.unpacked`, "ts-out", "native", expected);
	const dependencyPath = path.resolve("node_modules/wasapi-loopback/prebuilds/windows-x86_64", expected);
	const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
	const hash = sha256(addonPath);
	if (hash !== sha256(dependencyPath)) throw new Error("Packaged WASAPI addon differs from the installed optionalDependency");
	validateWasapiAddon({ targetPlatform: platform, targetArch: arch, addonPath, loadAddon: require });
	console.log(`[WASAPI packaged] ${platform}/${arch}: ${addonPath}; SHA256=${hash}; required=${WASAPI_REQUIRED_EXPORTS.join(",")}`);
}

if (import.meta.main) {
	const [appOutDir, platform = "win32", arch = "x64"] = process.argv.slice(2);
	if (!appOutDir) throw new Error("Usage: validateWasapiPackaged.ts <fresh-target-output> [platform] [arch]");
	validateWasapiPackaged(appOutDir, platform, arch);
}
