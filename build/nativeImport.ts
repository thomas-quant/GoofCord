import fs from "node:fs/promises";
import path from "node:path";

import type { BunPlugin, OnLoadArgs } from "bun";

interface NativePluginOptions {
	targetPlatform?: string;
	targetArch?: string;
}

export const nativeModulePlugin = (options: NativePluginOptions = {}): BunPlugin => ({
	name: "bun-plugin-native-loader",
	setup(build) {
		const namespace = "native-module-loader";
		const filter = /^native-module:/;

		build.onResolve({ filter }, (args) => {
			if (!args.importer) return null;

			const globPattern = args.path.replace(filter, "");
			const absoluteDir = path.dirname(args.importer);

			return {
				path: `${absoluteDir}\0${globPattern}`,
				namespace,
			};
		});

		build.onLoad({ filter: /.*/, namespace }, async (args: OnLoadArgs): Promise<import("bun").OnLoadResult> => {
			const [importerDir, globPattern] = args.path.split("\0");

			const targetPlatform = options.targetPlatform || process.platform;
			const targetArch = options.targetArch || process.arch;

			// Resolve the glob's directory to an ABSOLUTE path and enumerate it with fs.readdir + a regex
			// derived from the basename pattern — NOT Bun.Glob. Bun.Glob.scan() silently matches nothing
			// when the build HOST is Windows (both for `../` traversal AND for an absolute backslash cwd),
			// so every native addon resolved to `export default null` → silent runtime fallback on Windows
			// builds (venbind too). fs.readdir + a precompiled regex is deterministic across Linux/macOS/
			// Windows hosts. The `*` in the pattern (e.g. "venbind-*.node") becomes `.*`; other chars are
			// escaped. The platform/arch substring filter below then picks the right artifact.
			const searchDir = path.resolve(importerDir, path.dirname(globPattern));
			const filePattern = path.basename(globPattern);
			const patternRe = new RegExp(`^${filePattern.split("*").map((seg) => seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

			let files: string[] = [];
			try {
				files = await fs.readdir(searchDir);
			} catch {
				files = []; // dir absent (e.g. no native module staged for this build) → null export below
			}

			const matchedFile = files.filter((file) => patternRe.test(file)).find((file) => {
				const lower = file.toLowerCase();
				return lower.includes(targetPlatform.toLowerCase()) && lower.includes(targetArch.toLowerCase());
			});

			if (!matchedFile) {
				return {
					contents: "export default null;",
					loader: "js",
				};
			}

			const absolutePath = path.resolve(searchDir, matchedFile);

			const contents = `
                import path from ${JSON.stringify(absolutePath)} with { type: "file" };
                export default path;
            `;

			return {
				contents,
				loader: "js",
			};
		});
	},
});
