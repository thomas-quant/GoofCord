<!-- refreshed: 2026-05-28 -->
# Architecture

**Analysis Date:** 2026-05-28

## System Overview

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Electron Main Process                            │
│  src/main.ts → src/loader.ts                                           │
├──────────────┬──────────────────┬──────────────────┬───────────────────┤
│   Windows    │    Modules       │     Stores       │    IPC Registry   │
│ src/windows/ │  src/modules/    │  src/stores/     │  src/ipc/         │
│  main/       │  firewall.ts     │  config/         │  registry.main.ts │
│  settings/   │  arrpc/          │  localization/   │  gen.ts (codegen) │
│  screenshare/│  assets/         │                  │  types.ts         │
└──────┬───────┴────────┬─────────┴──────────────────┴───────────────────┘
       │                │
       ▼                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  Electron Preload Scripts (sandboxed)                 │
│  src/windows/main/preload/preload.mts      (main window preload)     │
│  src/windows/settings/preload/preload.tsx  (settings window preload) │
│  src/windows/screenshare/preload/preload.mts (screenshare preload)   │
│                                                                       │
│  All preloads use: src/ipc/client.preload.ts (invoke / sendSync)     │
│  Config synced via: electron-sync-store client                        │
└──────┬───────────────────────────────────────────────────────────────┘
       │  contextBridge.exposeInMainWorld("goofcord", api)
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        Renderer / Browser Context                     │
├────────────────────┬─────────────────────────────────────────────────┤
│  Discord (main)    │  Settings UI (Preact)                           │
│  window.goofcord   │  src/windows/settings/preload/App.tsx           │
│                    │                                                  │
│  Injected scripts: │                                                  │
│  preVencord.js ──► │  Vencord (external mod) ──► postVencord.js      │
│  src/windows/main/ │  (downloaded asset)         src/windows/main/   │
│  renderer/         │                              renderer/           │
│  preVencord/       │                              postVencord/        │
└────────────────────┴─────────────────────────────────────────────────┘
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

**Overall:** Electron multi-process desktop application with a code-injection layer for modding Discord's renderer.

**Key Characteristics:**
- Strict process separation: main, preload (sandboxed), and renderer each have distinct module boundaries
- Type-safe IPC: channels are auto-generated from TypeScript function signatures via `build/genIpcHandlers.ts`; callers and handlers share a single `types.ts` contract
- Mod injection pipeline: downloaded external JS assets are categorized (pre/vencord/post) and injected in order into Discord's renderer via `webFrame.executeJavaScript`
- Config is shared across process boundaries via `electron-sync-store` (main = host, preload = client), with `settingsSchema.ts` as the schema/defaults source
- Two render-time script bundles (`preVencord.js`, `postVencord.js`) are built by Bun and shipped as static assets; all other assets are downloaded at runtime

## Layers

**Main Process Layer:**
- Purpose: OS integration, window management, module orchestration, IPC handling
- Location: `src/main.ts`, `src/loader.ts`, `src/modules/`, `src/windows/*/` (non-preload files), `src/stores/*/config.main.ts`, `src/stores/*/localization.main.ts`
- Contains: BrowserWindow creation, session management, firewall, proxy, tray, autostart, asset management
- Depends on: Electron APIs, Node.js
- Used by: Nothing (top of stack)

**Preload Layer:**
- Purpose: Bridge between sandboxed renderer and main process; exposes `goofcord` API via contextBridge
- Location: `src/windows/main/preload/`, `src/windows/settings/preload/`, `src/windows/screenshare/preload/`
- Contains: contextBridge exposure, script/style injection, config client access, IPC invocation wrappers
- Depends on: `src/ipc/client.preload.ts`, `src/stores/config/config.preload.ts`, Electron preload APIs
- Used by: Renderer code (via `window.goofcord`)

**Renderer Layer:**
- Purpose: Discord UI modifications, settings UI, screenshare picker UI
- Location: `src/windows/main/renderer/`, `src/windows/settings/preload/App.tsx` (runs in settings renderer), `src/windows/screenshare/preload/preload.mts`
- Contains: Vencord webpack patches, postVencord feature hooks, Preact settings UI
- Depends on: `window.goofcord` API (exposed by preload bridge)
- Used by: End user

**Store Layer:**
- Purpose: Typed config persistence and localization data, shared across main/preload boundaries
- Location: `src/stores/config/`, `src/stores/localization/`
- Contains: `config.main.ts` (host), `config.preload.ts` (client), `localization.main.ts`, `localization.preload.ts`
- Depends on: `electron-sync-store`, `src/settingsSchema.ts`
- Used by: Main process modules, preload scripts

**Build/Codegen Layer:**
- Purpose: Asset generation, IPC type generation, Bun bundling
- Location: `build/`
- Contains: `genIpcHandlers.ts` (scans src for `<IPCHandle>`/`<IPCOn>` type annotations, emits `gen.ts` + `types.ts`), `genSettingsLangFile.ts`, `globbyGlob.ts`, `nativeImport.ts`
- Depends on: Bun, TypeScript compiler API
- Used by: CI and local `bun run build`

## Data Flow

### Startup Sequence

1. `src/main.ts` — Electron app launched, single-instance lock acquired
2. `src/stores/config/config.main.ts:loadConfig()` — config JSON read from `~/.config/goofcord/GoofCord/settings.json`
3. `src/main.ts:setFlags()` — Chromium command-line switches applied from config
4. `src/stores/localization/localization.main.ts:initLocalization()` — lang JSON merged
5. `src/loader.ts:load()` — sequential orchestration begins
6. `src/modules/assets/assetDownloader.ts:manageAssets()` — cached mod files checked/downloaded
7. `src/ipc/gen.ts:registerAllHandlers()` — all IPC handlers registered with `ipcMain`
8. `src/modules/firewall.ts:initFirewall()` — webRequest intercept rules activated
9. `src/windows/main/main.ts:createMainWindow()` — BrowserWindow created, Discord URL loaded
10. Electron loads `src/windows/main/preload/preload.mts` in sandbox
11. Preload waits for `whenConfigReady()`, then calls `loadScripts()` / `loadStyles()`
12. `loadScripts()` executes: preVencord → Vencord (patched by `vencordPatcher.ts`) → postVencord → others

### IPC Request Path (renderer → main)

1. Renderer calls `window.goofcord.<method>()` (e.g., `openSettingsWindow()`)
2. Preload bridge (`src/windows/main/preload/bridge.ts`) calls `invoke("settings:createSettingsWindow")`
3. `src/ipc/client.preload.ts:invoke()` calls `ipcRenderer.invoke(channel, ...args)`
4. `src/ipc/gen.ts` registered handler calls the main-process function (`createSettingsWindow`)
5. Return value flows back through the promise chain to the renderer

### IPC Codegen Flow (build time)

1. `build/genIpcHandlers.ts` scans all `.ts` files in `src/`
2. Functions annotated with generic type `<IPCHandle>` or `<IPCOn>` are detected via TypeScript AST
3. Channel name: `"module:functionName"` (derived from file path + function name)
4. Emits `src/ipc/gen.ts` (ipcMain registrations) and `src/ipc/types.ts` (channel type map)

### Asset Injection Pipeline

1. `assetDownloader.ts` fetches URLs from `config.assets` dict → saves to `GoofCord/assets/`
2. `assetLoader.ts:categorizeAllAssets()` reads files, sniffs first 500 chars for markers:
   - `prevencordmarker` → `scripts.pre`
   - `postvencordmarker` → `scripts.post`
   - `vencord` → `scripts.vencord`
   - everything else → `scripts.others`
3. On IPC `assetLoader:getAssets` (sendSync), preload receives the categorized bundle
4. Preload executes in order: pre → vencord (patched) → post → others

**State Management:**
- Config: persisted to JSON on disk via `electron-sync-store`; main process is host, preload is client; changes propagate bidirectionally
- Window state: stored as a config key `windowState:main` (maximized, position, size tuple)
- Assets: stored in `GoofCord/assets/` directory; ETags cached in config to avoid redundant downloads

## Key Abstractions

**`<IPCHandle>` / `<IPCOn>` type annotations:**
- Purpose: Mark a function as an IPC handler without any decorator or registration call
- Examples: `export function createSettingsWindow<IPCHandle>()` in `src/windows/settings/settings.ts`
- Pattern: Build-time codegen reads the generic type parameter name; `IPCHandle` → `ipcMain.handle`, `IPCOn` → `ipcMain.on` with `event.returnValue`

**`settingsSchema`:**
- Purpose: Single declaration of all config keys, UI input types, default values, labels, and onChange channel names
- File: `src/settingsSchema.ts`
- Pattern: `setting()`, `hidden()`, `button()` builder functions produce typed schema entries; `Config` type and `getDefaults()` are derived from it via mapped types

**`electron-sync-store` host/client:**
- Purpose: Synchronized config store across Electron process boundaries without serialized IPC for every read
- Main: `createHost<Config>("config", { onHydrate, onPersist })` in `src/stores/config/config.main.ts`
- Preload: `createClient<Config>("config")` in `src/stores/config/config.preload.ts`

**Mod injection markers:**
- Purpose: Distinguish asset roles without file naming conventions
- Files: `preVencord.js` starts with `// prevencordmarker`, `postVencord.js` starts with `// postvencordmarker`
- Used by: `src/modules/assets/assetLoader.ts:categorizeScript()`

## Entry Points

**Main Process:**
- Location: `src/main.ts`
- Triggers: Electron launch (`electron ./ts-out/main.js`)
- Responsibilities: Single-instance lock, config loading, flag setup, delegates to `loader.ts`

**Main Window Preload:**
- Location: `src/windows/main/preload/preload.mts`
- Triggers: BrowserWindow load with `preload:` webPreference path
- Responsibilities: Script/style injection, `goofcord` API bridge via contextBridge

**Settings Window Preload (Preact App):**
- Location: `src/windows/settings/preload/preload.tsx`
- Triggers: Settings BrowserWindow load
- Responsibilities: Renders `App.tsx` Preact component tree into settings HTML

**Renderer Scripts (injected):**
- `preVencord.ts` — `src/windows/main/renderer/preVencord/preVencord.ts` — runs before Vencord
- `postVencord.ts` — `src/windows/main/renderer/postVencord/postVencord.ts` — runs after Vencord is ready

**Build:**
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

**What happens:** Modules such as `src/modules/arrpc/arrpc.ts` import `mainWindow` from `src/windows/main/main.ts` at the top level.
**Why it's wrong:** `mainWindow` is `undefined` until `createMainWindow()` is awaited in `loader.ts`. Calling methods on it before that point will throw.
**Do this instead:** Only call `mainWindow` methods inside functions that are invoked after `createMainWindow()` resolves (as all current callers do). Do not store the reference at import time.

### Manually editing generated IPC files

**What happens:** `src/ipc/gen.ts` and `src/ipc/types.ts` have a header comment: "This file is auto-generated by genIpcHandlers, any changes will be lost."
**Why it's wrong:** The next build overwrites any manual edits.
**Do this instead:** Annotate the main-process function with `<IPCHandle>` or `<IPCOn>` and run `bun run build --onlyGenerators` or a full build.

## Error Handling

**Strategy:** Fail loudly in main process with `dialog.showErrorBox` / `dialog.showMessageBox`; swallow renderer errors individually with `try/catch` and `console.error`.

**Patterns:**
- Config load failure: interactive dialog offering retry, open folder, reset, or exit (`src/stores/config/config.main.ts:handleConfigError`)
- Asset load failure: non-blocking warning dialog; app continues without the asset
- arRPC worker error: error dialog shown, worker reference cleared
- Renderer injection (`webFrame.executeJavaScript`): `.catch()` logs the error, other scripts continue loading
- `postVencord` feature init: `runSafe()` wraps each init function in try/catch so one failure doesn't block others

## Cross-Cutting Concerns

**Logging:** `picocolors` (`pc`) used throughout main process for colored `console.log`/`console.error` prefixes. Preload uses `src/modules/logger.preload.ts` (`log`/`error` helpers).
**Validation:** Input validation is minimal; config values are typed at the TypeScript level via `settingsSchema`. URL blocklist validation happens at runtime inside `firewall.ts`.
**Authentication:** Not applicable (GoofCord itself has no auth; Discord auth is handled entirely by the Discord web app inside the BrowserWindow).

---

*Architecture analysis: 2026-05-28*
