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

			// Resolve the glob's directory to an ABSOLUTE path and scan by basename only. Bun.Glob does
			// not reliably traverse `../` segments when the build HOST is Windows (the pattern silently
			// matches nothing → `export default null` → the native addon never loads at runtime, a silent
			// fallback). Splitting dir + basename keeps resolution portable across Linux/macOS/Windows
			// build hosts. (Linux-host builds matched fine either way; this only changes Windows-host behavior.)
			const searchDir = path.resolve(importerDir, path.dirname(globPattern));
			const filePattern = path.basename(globPattern);

			const glob = new Bun.Glob(filePattern);
			const files = await Array.fromAsync(glob.scan(searchDir));

			const matchedFile = files.find((file) => {
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
