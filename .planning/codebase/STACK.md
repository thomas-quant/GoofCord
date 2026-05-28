# Technology Stack

**Analysis Date:** 2026-05-28

## Languages

**Primary:**
- TypeScript 6.0.3 - All source code in `src/` and `build/`
- CSS - Renderer styling in `src/windows/*/renderer/*.css`

**Secondary:**
- HTML - Static renderer shells in `src/windows/*/renderer/*.html`

## Runtime

**Environment:**
- Electron 41.3.0 - Desktop app host (Chromium + Node.js)
- Node.js 24.x (CI target) - Main process runtime inside Electron

**Package Manager:**
- Bun (latest in CI; `bun.lock` lockfile present)
- Lockfile: `bun.lock` (committed)

## Frameworks

**Core:**
- Electron 41.3.0 - Cross-platform desktop shell; provides main process, renderer process, preload bridging
- Preact ^10.29.1 - UI framework for the settings window (`src/windows/settings/preload/*.tsx`)

**Build/Dev:**
- Bun (bundler) - Drives all builds via `build/build.ts`; uses `Bun.build()` API directly — no Webpack/Vite
- electron-builder 26.8.1 - Packaging and installer generation (AppImage, NSIS, DMG)
- TypeScript compiler (`tsgo` / `@typescript/native-preview ^7.0.0-dev`) - Type checking only (no emit); `noEmit: true`

**Linting/Formatting:**
- oxlint ^1.61.0 - Linter (`bun run lint`)
- oxfmt ^0.46.0 - Formatter (`bun run fmt`)
- oxlint-tsgolint ^0.21.1 - TypeScript-aware oxlint rules

## Key Dependencies

**Critical:**
- `electron` 41.3.0 - The entire app runs inside Electron's main/renderer/preload model
- `preact` ^10.29.1 - Settings window UI; JSX configured with `jsxImportSource: "preact"` in `tsconfig.json`
- `arrpc` (github:Milkshiift/arrpc) - Rich Presence (Discord game activity detection); runs in a worker thread via `src/modules/arrpc/arrpcWorker.ts`
- `electron-sync-store` (github:Milkshiift/electron-sync-store) - Typed synchronous config store bridged across main/preload; used in `src/stores/config/config.main.ts`
- `stegcloak` (github:Milkshiift/stegcloak-rs) - Steganographic message encryption; used in `src/modules/messageEncryption.ts`
- `picocolors` 1.1.1 - Terminal color output in all console logging

**Optional/Native:**
- `patchcord` (github:Milkshiift/patchcord) - Linux PipeWire/PulseAudio audio routing for screen share system audio; used in `src/modules/native/patchcord.ts`
- `venbind` 0.1.7 - Native Node addon for global keybinds on Windows/Linux; used in `src/modules/native/venbind.ts`

**Dev Types:**
- `@vencord/types` 1.14.1 - Type definitions for the Vencord mod API (used in renderer scripts referencing `window.Vencord`)
- `@types/bun` 1.3.13 - Bun global types for build scripts
- `@types/node` 25.6.0 - Node.js types for main process code

## Configuration

**TypeScript (`tsconfig.json`):**
- `module: "esnext"`, `moduleResolution: "bundler"` - ESM-first, Bun bundler resolution
- `jsx: "react-jsx"`, `jsxImportSource: "preact"` - Preact JSX without explicit imports
- `paths: { "@root/*": ["./*"] }` - Absolute path alias from project root
- `strict: true`, `noImplicitReturns: true` - Full strict mode
- `noEmit: true` - TypeScript used for type checking only; Bun handles transpilation

**Bun (`bunfig.toml`):**
- `[install] linker = "isolated"` - Isolated module linker for installs

**Build (`build/build.ts`):**
- Produces three output categories: main process (`ts-out/`), renderer scripts (`assets/preVencord.js`, `assets/postVencord.js`), and preloads (`ts-out/windows/*/preload/`)
- Main process: ESM, target `node`, code splitting enabled
- Preloads: CJS format (`cjs`), target `node`
- Renderer scripts: browser target, ESM
- Custom plugins: `globImporterPlugin` (glob file imports), `nativeModulePlugin` (platform-specific `.node` binary path resolution)

**Environment (`build/build.ts`):**
- `GOOFCORD_PATCHCORD_PATH` - Override path for patchcord native binary
- `GOOFCORD_VENBIND_PATH` - Override path for venbind native binary

## Platform Requirements

**Development:**
- Bun installed (used as runtime, bundler, and package manager)
- Node.js 24.x for Electron compatibility
- Linux: PipeWire/PulseAudio for patchcord audio features
- Windows/Linux: Platform-specific `.node` native addons (venbind, patchcord)

**Production / Distribution:**
- Linux: AppImage (x64, arm64, armv7l), plus `.tar.xz`, `.deb`, `.rpm`
- Windows: NSIS installer (x64, ia32, arm64)
- macOS: DMG (x64, arm64)
- Electron Fuses: `runAsNode: false`, `onlyLoadAppFromAsar: true`
- App ID: `io.github.milkshiift.GoofCord`
- Config stored at OS user data path: `~/.config/goofcord/settings.json` (Linux example)

---

*Stack analysis: 2026-05-28*
