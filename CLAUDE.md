<!-- GSD:project-start source:PROJECT.md -->
## Project

**GoofCord — Windows Streaming Fixes (Fork)**

A fork of GoofCord (an Electron-based custom Discord client that wraps Vencord) whose purpose is to fix **Windows screenshare/streaming bugs** that affect the upstream project. Fixes are intended to be clean and minimal so they can be **submitted back upstream** to the main GoofCord repo. This milestone targets one in-flight bug plus a closely-related Windows audio issue — it is a focused bug-fix fork, not a feature fork.

**Core Value:** On Windows, a user can start a screenshare, cancel the source picker, and start again — and the stream works — without the app getting stuck or requiring a restart. If everything else fails, restarting a stream after cancelling must work.

### Constraints

- **Tech stack**: Electron 41.3.0, TypeScript 6.x (strict, `noEmit`), Bun (runtime + bundler + package manager), Preact for settings UI — must work within the existing build (`build/build.ts`), no new build tooling.
- **Compatibility / Upstream**: Fixes must be **PR-ready for the main GoofCord repo** — follow existing conventions, minimize divergence, keep diffs surgical. Avoid fork-only hacks that couldn't be upstreamed.
- **Platform**: Bug is **Windows-specific** behaviour (`desktopCapturer`, `setDisplayMediaRequestHandler`, `"loopback"` audio). Must not regress Linux (patchcord) or macOS paths.
- **Verification**: No automated repro for screenshare on Windows. Verification is **manual**: trigger the Windows x64 CI build (`.github/workflows/testBuild.yml`) and test the picker/cancel/re-click flow by hand.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

## Languages
- TypeScript 6.0.3 - All source code in `src/` and `build/`
- CSS - Renderer styling in `src/windows/*/renderer/*.css`
- HTML - Static renderer shells in `src/windows/*/renderer/*.html`
## Runtime
- Electron 41.3.0 - Desktop app host (Chromium + Node.js)
- Node.js 24.x (CI target) - Main process runtime inside Electron
- Bun (latest in CI; `bun.lock` lockfile present)
- Lockfile: `bun.lock` (committed)
## Frameworks
- Electron 41.3.0 - Cross-platform desktop shell; provides main process, renderer process, preload bridging
- Preact ^10.29.1 - UI framework for the settings window (`src/windows/settings/preload/*.tsx`)
- Bun (bundler) - Drives all builds via `build/build.ts`; uses `Bun.build()` API directly — no Webpack/Vite
- electron-builder 26.8.1 - Packaging and installer generation (AppImage, NSIS, DMG)
- TypeScript compiler (`tsgo` / `@typescript/native-preview ^7.0.0-dev`) - Type checking only (no emit); `noEmit: true`
- oxlint ^1.61.0 - Linter (`bun run lint`)
- oxfmt ^0.46.0 - Formatter (`bun run fmt`)
- oxlint-tsgolint ^0.21.1 - TypeScript-aware oxlint rules
## Key Dependencies
- `electron` 41.3.0 - The entire app runs inside Electron's main/renderer/preload model
- `preact` ^10.29.1 - Settings window UI; JSX configured with `jsxImportSource: "preact"` in `tsconfig.json`
- `arrpc` (github:Milkshiift/arrpc) - Rich Presence (Discord game activity detection); runs in a worker thread via `src/modules/arrpc/arrpcWorker.ts`
- `electron-sync-store` (github:Milkshiift/electron-sync-store) - Typed synchronous config store bridged across main/preload; used in `src/stores/config/config.main.ts`
- `stegcloak` (github:Milkshiift/stegcloak-rs) - Steganographic message encryption; used in `src/modules/messageEncryption.ts`
- `picocolors` 1.1.1 - Terminal color output in all console logging
- `patchcord` (github:Milkshiift/patchcord) - Linux PipeWire/PulseAudio audio routing for screen share system audio; used in `src/modules/native/patchcord.ts`
- `venbind` 0.1.7 - Native Node addon for global keybinds on Windows/Linux; used in `src/modules/native/venbind.ts`
- `@vencord/types` 1.14.1 - Type definitions for the Vencord mod API (used in renderer scripts referencing `window.Vencord`)
- `@types/bun` 1.3.13 - Bun global types for build scripts
- `@types/node` 25.6.0 - Node.js types for main process code
## Configuration
- `module: "esnext"`, `moduleResolution: "bundler"` - ESM-first, Bun bundler resolution
- `jsx: "react-jsx"`, `jsxImportSource: "preact"` - Preact JSX without explicit imports
- `paths: { "@root/*": ["./*"] }` - Absolute path alias from project root
- `strict: true`, `noImplicitReturns: true` - Full strict mode
- `noEmit: true` - TypeScript used for type checking only; Bun handles transpilation
- `[install] linker = "isolated"` - Isolated module linker for installs
- Produces three output categories: main process (`ts-out/`), renderer scripts (`assets/preVencord.js`, `assets/postVencord.js`), and preloads (`ts-out/windows/*/preload/`)
- Main process: ESM, target `node`, code splitting enabled
- Preloads: CJS format (`cjs`), target `node`
- Renderer scripts: browser target, ESM
- Custom plugins: `globImporterPlugin` (glob file imports), `nativeModulePlugin` (platform-specific `.node` binary path resolution)
- `GOOFCORD_PATCHCORD_PATH` - Override path for patchcord native binary
- `GOOFCORD_VENBIND_PATH` - Override path for venbind native binary
## Platform Requirements
- Bun installed (used as runtime, bundler, and package manager)
- Node.js 24.x for Electron compatibility
- Linux: PipeWire/PulseAudio for patchcord audio features
- Windows/Linux: Platform-specific `.node` native addons (venbind, patchcord)
- Linux: AppImage (x64, arm64, armv7l), plus `.tar.xz`, `.deb`, `.rpm`
- Windows: NSIS installer (x64, ia32, arm64)
- macOS: DMG (x64, arm64)
- Electron Fuses: `runAsNode: false`, `onlyLoadAppFromAsar: true`
- App ID: `io.github.milkshiift.GoofCord`
- Config stored at OS user data path: `~/.config/goofcord/settings.json` (Linux example)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

## Naming Patterns
- Electron process suffix required: `config.main.ts` (main process), `config.preload.ts` (preload), `localization.main.ts`, `localization.preload.ts`
- Preload entry points use `.mts` extension: `preload.mts` (forces CommonJS output via build)
- Settings UI preloads use `.tsx`: `preload.tsx`
- Feature modules use plain camelCase: `assetLoader.ts`, `assetDownloader.ts`, `chromeSpoofer.ts`
- Renderer scripts grouped by lifecycle: `preVencord/`, `postVencord/`
- Auto-generated files are labeled at top: `// This file is auto-generated by genIpcHandlers, any changes will be lost`
- camelCase for all functions: `getConfig`, `loadConfig`, `initFirewall`, `createMainWindow`
- Boolean-returning functions use `is*` / `has*` prefix: `isWayland`, `isDev`, `isPathAccessible`, `hasPipewirePulse`, `isEncrypted`
- Init functions use `init*` prefix: `initFirewall`, `initLocalization`, `initConfigEncryption`, `initArrpc`
- Getter functions use `get*` prefix: `getConfig`, `getDefaultValue`, `getGoofCordFolderPath`, `getCustomIcon`
- Create functions use `create*` prefix: `createMainWindow`, `createSettingsWindow`, `createTray`
- camelCase for locals and module-level: `configHost`, `firstLaunch`, `stegcloak`, `chosenPassword`
- SCREAMING_SNAKE_CASE for true constants: `LOG_PREFIX`, `ASSETS_FOLDER`, `SCAN_LENGTH`, `DEFAULT_CONFIG`, `MARKERS`
- Module-level log prefix pattern: `const LOG_PREFIX = pc.yellowBright("[Config]");` (in `src/stores/config/config.main.ts`)
- PascalCase for all type aliases and interfaces: `Config`, `ConfigKey`, `IpcHandler`, `AssetTuple`, `ScriptContainer`, `PatchDefinition`
- Generic type params are single uppercase letters or descriptive: `<K extends ConfigKey>`, `<T>`, `<Args extends unknown[], Return>`
- Distributive union types for schema: `SettingEntry<K extends keyof InputTypeMap = keyof InputTypeMap>`
- Channel names use `module:functionName` format: `"config:getConfig"`, `"utils:saveFileToGCFolder"`, `"assetLoader:getAssets"`
- Registered (manual) channels use `window:Action` or `feature:action` format: `"window:Maximize"`, `"flashTitlebar"`
## Code Style
- Tool: `oxfmt` (oxc formatter)
- Tabs for indentation (not spaces): `"useTabs": true`
- Print width: 320 (very long lines allowed — not enforced aggressively)
- Import sorting: enabled via `"sortImports": {}`
- Ignored patterns: `.github`, `assets/`, `assetsDev/`, `ts-out/`, generated files (`src/ipc/types.ts`, `src/ipc/gen.ts`, `src/settingsSchema.ts`)
- Tool: `oxlint` with type-aware mode (`--type-aware`)
- Plugins: `eslint`, `typescript`, `react`, `unicorn`, `oxc`, `promise`, `node`
- Key rules explicitly allowed (turned off): `no-unused-vars`, `no-unused-expressions`, `no-useless-escape`, `unbound-method`, `restrict-template-expressions`
- Config: `.oxlintrc.json`
- Tool: `tsgo` (TypeScript native preview) — invoked via `bun run check`
- Strict mode enabled: `"strict": true`, `"noImplicitReturns": true`
- No `.js` emit (`"noEmit": true`)
- JSX: `react-jsx` with `preact` as the JSX import source
## Import Organization
- `@root/*` maps to the project root: `@root/src/stores/...`, `@root/src/windows/...`
- Always include `.ts`/`.tsx` extension in import paths (required by `allowImportingTsExtensions: true`)
## IPC Handler Registration Pattern
## Error Handling
- Catch errors typed as `unknown`, then use `getErrorMessage(e)` from `src/utils.ts` to extract a string safely
- Pattern for safe message extraction:
- Use `instanceof Error` narrowing when accessing specific error properties: `if (e instanceof Error && "code" in e && e.code === "ENOENT")`
- Use `NodeJS.ErrnoException` cast for filesystem errors: `const nodeErr = err as NodeJS.ErrnoException;`
- Swallow expected missing-file errors (`ENOENT`) silently when appropriate
- For async functions that are fire-and-forget, use the `void` operator: `void createSettingsWindow()`, `void checkForUpdate()`
- Top-level async entry: `main().catch(console.error)` and `init().catch(console.error)`
## Logging
- Module prefix as colored string: `const LOG_PREFIX = pc.yellowBright("[Config]");`
- Log call: `console.log(LOG_PREFIX, "message", value)`
- Timing with `console.time`/`console.timeEnd` for startup performance
- Use `console.warn` for non-fatal unexpected states, `console.error` for failures
- Colored tags: `pc.red("[!]")` for flags/warnings, `pc.blue("[Window]")` for window events, `pc.red("[Firewall]")` for firewall
- `console.log` — normal informational events
- `console.warn` — unexpected but recoverable conditions
- `console.error` — errors (always followed by the actual error object)
- `console.info` — detailed operational information (e.g., UA spoofing)
## Comments
- Inline comments explain non-obvious decisions: `// Shaves off ~100ms`, `// Vulkan doesn't support Wayland`
- Section dividers in longer files using ASCII rule: `// ─── State & Initialization ─────────────────────────────────────────────`
- `// @ts-expect-error` always followed by an explanation on the next line or same line
- Build markers embedded in output files: `// prevencordmarker` (used for asset categorization)
- Not used. No function-level documentation comments.
## Function Design
- `async/await` throughout — no raw Promise chains except for simple `.catch(() => false)` guards
- Use `void` for intentional fire-and-forget calls that would otherwise cause unhandled-rejection lint warnings
## Module Design
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

## System Overview
```text
```
## Component Responsibilities
| Component | Responsibility | File |
|-----------|----------------|------|
| Main Entry | App initialization, Chromium flags, single-instance lock | `src/main.ts` |
| Loader | Sequential startup orchestration, window creation | `src/loader.ts` |
| Main Window | Discord BrowserWindow lifecycle and window IPC handlers | `src/windows/main/main.ts` |
| Settings Window | Settings BrowserWindow, cloud auto-save on close | `src/windows/settings/settings.ts` |
| Screenshare | Display media request handler, source picker window | `src/windows/screenshare/screenshare.ts` |
| IPC Registry | Type-safe handler registration for main process | `src/ipc/registry.main.ts` |
| IPC Codegen | Auto-generates `gen.ts` and `types.ts` at build time | `build/genIpcHandlers.ts` |
| IPC Client | Preload-side `invoke` / `sendSync` typed wrappers | `src/ipc/client.preload.ts` |
| Config (main) | Persistent JSON config, safeStorage encryption, hydration | `src/stores/config/config.main.ts` |
| Config (preload) | electron-sync-store client for renderer-side config reads | `src/stores/config/config.preload.ts` |
| Settings Schema | Single source of truth for all config keys, types, defaults | `src/settingsSchema.ts` |
| Firewall | webRequest blocking of telemetry/tracking URLs | `src/modules/firewall.ts` |
| Asset Downloader | Fetches/caches external JS+CSS mods from URLs in config | `src/modules/assets/assetDownloader.ts` |
| Asset Loader | Categorizes cached assets (pre/vencord/post/others), hot-reloads CSS | `src/modules/assets/assetLoader.ts` |
| arRPC | Rich presence via Worker thread running arrpc server | `src/modules/arrpc/arrpc.ts` |
| Message Encryption | StegCloak steganographic encrypt/decrypt over IPC | `src/modules/messageEncryption.ts` |
| Chrome Spoofer | Rewrites User-Agent to appear as Chrome | `src/modules/chromeSpoofer.ts` |
| Localization | JSON lang file merging with en-US fallback | `src/stores/localization/localization.main.ts` |
| PreVencord Script | Webpack patch injection before Vencord loads | `src/windows/main/renderer/preVencord/preVencord.ts` |
| PostVencord Script | GoofCord feature init after Vencord's webpack is ready | `src/windows/main/renderer/postVencord/postVencord.ts` |
| Vencord Patcher | Regex-patches Vencord bundle to expose `__GOOFCORD_PATCHES__` | `src/windows/main/preload/vencordPatcher.ts` |
| Migration | Version-gated config migrations on startup | `src/migration.ts` |
## Pattern Overview
- Strict process separation: main, preload (sandboxed), and renderer each have distinct module boundaries
- Type-safe IPC: channels are auto-generated from TypeScript function signatures via `build/genIpcHandlers.ts`; callers and handlers share a single `types.ts` contract
- Mod injection pipeline: downloaded external JS assets are categorized (pre/vencord/post) and injected in order into Discord's renderer via `webFrame.executeJavaScript`
- Config is shared across process boundaries via `electron-sync-store` (main = host, preload = client), with `settingsSchema.ts` as the schema/defaults source
- Two render-time script bundles (`preVencord.js`, `postVencord.js`) are built by Bun and shipped as static assets; all other assets are downloaded at runtime
## Layers
- Purpose: OS integration, window management, module orchestration, IPC handling
- Location: `src/main.ts`, `src/loader.ts`, `src/modules/`, `src/windows/*/` (non-preload files), `src/stores/*/config.main.ts`, `src/stores/*/localization.main.ts`
- Contains: BrowserWindow creation, session management, firewall, proxy, tray, autostart, asset management
- Depends on: Electron APIs, Node.js
- Used by: Nothing (top of stack)
- Purpose: Bridge between sandboxed renderer and main process; exposes `goofcord` API via contextBridge
- Location: `src/windows/main/preload/`, `src/windows/settings/preload/`, `src/windows/screenshare/preload/`
- Contains: contextBridge exposure, script/style injection, config client access, IPC invocation wrappers
- Depends on: `src/ipc/client.preload.ts`, `src/stores/config/config.preload.ts`, Electron preload APIs
- Used by: Renderer code (via `window.goofcord`)
- Purpose: Discord UI modifications, settings UI, screenshare picker UI
- Location: `src/windows/main/renderer/`, `src/windows/settings/preload/App.tsx` (runs in settings renderer), `src/windows/screenshare/preload/preload.mts`
- Contains: Vencord webpack patches, postVencord feature hooks, Preact settings UI
- Depends on: `window.goofcord` API (exposed by preload bridge)
- Used by: End user
- Purpose: Typed config persistence and localization data, shared across main/preload boundaries
- Location: `src/stores/config/`, `src/stores/localization/`
- Contains: `config.main.ts` (host), `config.preload.ts` (client), `localization.main.ts`, `localization.preload.ts`
- Depends on: `electron-sync-store`, `src/settingsSchema.ts`
- Used by: Main process modules, preload scripts
- Purpose: Asset generation, IPC type generation, Bun bundling
- Location: `build/`
- Contains: `genIpcHandlers.ts` (scans src for `<IPCHandle>`/`<IPCOn>` type annotations, emits `gen.ts` + `types.ts`), `genSettingsLangFile.ts`, `globbyGlob.ts`, `nativeImport.ts`
- Depends on: Bun, TypeScript compiler API
- Used by: CI and local `bun run build`
## Data Flow
### Startup Sequence
### IPC Request Path (renderer → main)
### IPC Codegen Flow (build time)
### Asset Injection Pipeline
- Config: persisted to JSON on disk via `electron-sync-store`; main process is host, preload is client; changes propagate bidirectionally
- Window state: stored as a config key `windowState:main` (maximized, position, size tuple)
- Assets: stored in `GoofCord/assets/` directory; ETags cached in config to avoid redundant downloads
## Key Abstractions
- Purpose: Mark a function as an IPC handler without any decorator or registration call
- Examples: `export function createSettingsWindow<IPCHandle>()` in `src/windows/settings/settings.ts`
- Pattern: Build-time codegen reads the generic type parameter name; `IPCHandle` → `ipcMain.handle`, `IPCOn` → `ipcMain.on` with `event.returnValue`
- Purpose: Single declaration of all config keys, UI input types, default values, labels, and onChange channel names
- File: `src/settingsSchema.ts`
- Pattern: `setting()`, `hidden()`, `button()` builder functions produce typed schema entries; `Config` type and `getDefaults()` are derived from it via mapped types
- Purpose: Synchronized config store across Electron process boundaries without serialized IPC for every read
- Main: `createHost<Config>("config", { onHydrate, onPersist })` in `src/stores/config/config.main.ts`
- Preload: `createClient<Config>("config")` in `src/stores/config/config.preload.ts`
- Purpose: Distinguish asset roles without file naming conventions
- Files: `preVencord.js` starts with `// prevencordmarker`, `postVencord.js` starts with `// postvencordmarker`
- Used by: `src/modules/assets/assetLoader.ts:categorizeScript()`
## Entry Points
- Location: `src/main.ts`
- Triggers: Electron launch (`electron ./ts-out/main.js`)
- Responsibilities: Single-instance lock, config loading, flag setup, delegates to `loader.ts`
- Location: `src/windows/main/preload/preload.mts`
- Triggers: BrowserWindow load with `preload:` webPreference path
- Responsibilities: Script/style injection, `goofcord` API bridge via contextBridge
- Location: `src/windows/settings/preload/preload.tsx`
- Triggers: Settings BrowserWindow load
- Responsibilities: Renders `App.tsx` Preact component tree into settings HTML
- `preVencord.ts` — `src/windows/main/renderer/preVencord/preVencord.ts` — runs before Vencord
- `postVencord.ts` — `src/windows/main/renderer/postVencord/postVencord.ts` — runs after Vencord is ready
- Location: `build/build.ts`
- Triggers: `bun run build`
- Responsibilities: Runs codegen, type-checks, bundles main + preloads + renderer scripts via Bun
## Architectural Constraints
- **Process isolation:** Preloads run with `sandbox: true`; no Node.js APIs available in renderer. All main-process calls must go through `ipcRenderer.invoke`/`ipcRenderer.sendSync`.
- **IPC codegen dependency:** `src/ipc/gen.ts` and `src/ipc/types.ts` are auto-generated. Never edit them manually. Re-run `bun run build --onlyGenerators` after adding/removing `<IPCHandle>`/`<IPCOn>` functions.
- **Asset ordering:** Vencord-based mods must load before postVencord. The asset categorization enforces this; only one Vencord-based asset may exist (duplicate triggers a warning dialog).
- **safeStorage dependency:** `initConfigEncryption()` must be called after `app.whenReady()`. Encrypted config keys cannot be read before `decryptSettings()` completes in `loader.ts`.
- **Global state:** `mainWindow` is a module-level export from `src/windows/main/main.ts`. Multiple modules import it directly; it is `undefined` until `createMainWindow()` resolves.
- **Preload format:** All preload entry files use `.mts` or `.tsx` extensions and are built as CJS (`format: "cjs"`) by the build script's `buildPreloads()` function.
## Anti-Patterns
### Directly importing `mainWindow` before it is created
### Manually editing generated IPC files
## Error Handling
- Config load failure: interactive dialog offering retry, open folder, reset, or exit (`src/stores/config/config.main.ts:handleConfigError`)
- Asset load failure: non-blocking warning dialog; app continues without the asset
- arRPC worker error: error dialog shown, worker reference cleared
- Renderer injection (`webFrame.executeJavaScript`): `.catch()` logs the error, other scripts continue loading
- `postVencord` feature init: `runSafe()` wraps each init function in try/catch so one failure doesn't block others
## Cross-Cutting Concerns
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
