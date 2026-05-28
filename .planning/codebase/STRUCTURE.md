# Codebase Structure

**Analysis Date:** 2026-05-28

## Directory Layout

```
GoofCord/
├── src/                            # All application source code
│   ├── main.ts                     # Electron main entry point
│   ├── loader.ts                   # Startup orchestration
│   ├── migration.ts                # Version-gated config migrations
│   ├── settingsSchema.ts           # Config schema, types, defaults (single source of truth)
│   ├── utils.ts                    # Shared utilities for main process
│   ├── ipc/                        # IPC infrastructure
│   │   ├── registry.main.ts        # registerHandle / registerOn helpers
│   │   ├── client.preload.ts       # invoke / sendSync typed wrappers (preload side)
│   │   ├── gen.ts                  # AUTO-GENERATED — ipcMain handler registrations
│   │   └── types.ts                # AUTO-GENERATED — channel/param/return type map
│   ├── modules/                    # Self-contained main-process feature modules
│   │   ├── arrpc/
│   │   │   ├── arrpc.ts            # Worker thread manager for arRPC rich presence
│   │   │   └── arrpcWorker.ts      # Worker entry — excluded from tsconfig, built separately
│   │   ├── assets/
│   │   │   ├── assetDownloader.ts  # Fetches/caches external mod JS+CSS from URLs
│   │   │   └── assetLoader.ts      # Reads, categorizes, and hot-reloads assets
│   │   ├── menus/
│   │   │   ├── applicationMenu.ts  # Electron application menu bar
│   │   │   └── contextMenu.ts      # Right-click context menu
│   │   ├── native/
│   │   │   ├── patchcord.ts        # Linux PipeWire audio capture for screenshare
│   │   │   └── venbind.ts          # Global keybind native module wrapper
│   │   ├── autostart.ts            # OS login-item / autostart management
│   │   ├── cacheManager.ts         # Clears Electron session cache
│   │   ├── chromeSpoofer.ts        # User-Agent and platform spoofing
│   │   ├── dynamicIcon.ts          # Taskbar/tray badge count updates
│   │   ├── firewall.ts             # webRequest URL blocking and CSP relaxation
│   │   ├── logger.preload.ts       # Shared logger for preload scripts
│   │   ├── messageEncryption.ts    # StegCloak encrypt/decrypt via IPC
│   │   ├── proxy.ts                # Electron proxy configuration
│   │   ├── tray.ts                 # System tray icon and menu
│   │   ├── updateCheck.ts          # GitHub release update checker
│   │   └── windowStateManager.ts   # Save/restore window size and position
│   ├── stores/                     # Shared state stores (main + preload variants)
│   │   ├── config/
│   │   │   ├── config.main.ts      # Config host: disk I/O, safeStorage encryption
│   │   │   └── config.preload.ts   # Config client: read/write from preload context
│   │   └── localization/
│   │       ├── localization.main.ts  # Loads and merges lang JSON files
│   │       └── localization.preload.ts # Localization client for preload/renderer
│   └── windows/                    # One subdirectory per BrowserWindow
│       ├── main/                   # Main Discord window
│       │   ├── main.ts             # BrowserWindow creation and lifecycle
│       │   ├── quickCssFix.ts      # Quick CSS editor window
│       │   ├── preload/            # Sandboxed preload for main window
│       │   │   ├── preload.mts     # Entry — injects scripts/styles, waits for config
│       │   │   ├── bridge.ts       # contextBridge.exposeInMainWorld("goofcord", api)
│       │   │   ├── assets.ts       # loadScripts() / loadStyles() implementations
│       │   │   ├── vencordPatcher.ts # Regex-patches Vencord bundle for patch hook
│       │   │   ├── keybinds.ts     # Keybind event listener
│       │   │   ├── titlebarFlash.ts # Flashbar titlebar animation
│       │   │   ├── discord.css     # GoofCord base Discord stylesheet
│       │   │   └── global.d.ts     # window.goofcord type declaration
│       │   └── renderer/           # Scripts injected into Discord's renderer
│       │       ├── preVencord/     # Runs before Vencord is loaded
│       │       │   ├── preVencord.ts  # Entry — loads patches, fixes
│       │       │   ├── patchManager.ts # Registers Vencord webpack patches
│       │       │   ├── domOptimizer.ts
│       │       │   ├── notificationFix.ts
│       │       │   └── patches/    # Individual Vencord patch definitions
│       │       │       ├── devtoolsFix.ts
│       │       │       ├── invidiousEmbeds.ts
│       │       │       ├── keybinds.ts
│       │       │       ├── screenshare.ts
│       │       │       └── titlebar.ts
│       │       └── postVencord/    # Runs after Vencord webpack is ready
│       │           ├── postVencord.ts # Entry — initializes all post features
│       │           ├── dynamicIcon.ts
│       │           ├── invidiousEmbeds.ts
│       │           ├── keybinds.ts
│       │           ├── messageEncryption.ts
│       │           ├── quickCssFix.ts
│       │           ├── richPresence.ts
│       │           ├── screensharePatch.ts
│       │           └── settings.ts
│       ├── settings/               # GoofCord settings window
│       │   ├── settings.ts         # BrowserWindow creation, cloud auto-save
│       │   ├── cloud/
│       │   │   └── cloud.ts        # Cloud settings sync (load/save/delete)
│       │   ├── preload/            # Settings window preload (Preact app entry)
│       │   │   ├── preload.tsx     # Entry — mounts Preact App
│       │   │   ├── App.tsx         # Root settings UI component
│       │   │   ├── SettingField.tsx # Per-setting field renderer
│       │   │   ├── MultiSelect.tsx
│       │   │   ├── inputs.tsx      # Input type components
│       │   │   ├── config.ts       # Preload-side config helpers for settings UI
│       │   │   ├── settings.css    # Settings window stylesheet
│       │   │   └── settings.html   # Static HTML shell for settings window
│       │   └── renderer/           # (empty — settings UI lives in preload)
│       └── screenshare/            # Screen share source picker window
│           ├── screenshare.ts      # ipcMain handlers and BrowserWindow creation
│           ├── preload/
│           │   └── preload.mts     # Screenshare UI — source list, audio config
│           └── renderer/
│               └── screenshare.html # Static HTML shell for screenshare picker
├── build/                          # Build tooling (not shipped)
│   ├── build.ts                    # Main build script (Bun)
│   ├── genIpcHandlers.ts           # Codegen: IPC handlers from TypeScript annotations
│   ├── genSettingsLangFile.ts      # Codegen: settings key → lang file
│   ├── globbyGlob.ts               # Bun plugin: glob-import and glob-filenames
│   ├── nativeImport.ts             # Bun plugin: platform-specific native .node imports
│   ├── entitlements.mac.plist      # macOS sandbox entitlements
│   └── installer.nsh               # Windows NSIS installer script
├── assets/                         # Static assets bundled with the app
│   ├── lang/                       # Localization JSON files (*.json per locale)
│   ├── preVencord.js               # Built output of src/windows/main/renderer/preVencord/
│   ├── postVencord.js              # Built output of src/windows/main/renderer/postVencord/
│   ├── adblocker.js                # YouTube in-embed ad blocker script
│   ├── gf_icon.png / .ico / .icns  # App icons
│   ├── gf_logo.svg
│   ├── gf_symbolic_black.png / gf_symbolic_white.png  # Tray icon variants
│   └── InterVariable.woff2         # Bundled font
├── assetsDev/                      # Development-only assets (not shipped)
├── .planning/
│   └── codebase/                   # GSD codebase map documents
├── electron-builder.ts             # electron-builder packaging config
├── package.json                    # Dependencies, scripts, version
├── tsconfig.json                   # TypeScript config (noEmit; Bun handles emit)
├── bunfig.toml                     # Bun runtime config
├── .oxlintrc.json                  # Oxlint (ESLint-compatible) rules
├── .oxfmtrc.json                   # Oxfmt formatter config
└── bun.lock                        # Bun lockfile
```

## Directory Purposes

**`src/`:**
- Purpose: All application source. Subdivided by Electron process boundary and feature domain.
- Key files: `main.ts` (entry), `loader.ts` (orchestrator), `settingsSchema.ts` (config contract)

**`src/ipc/`:**
- Purpose: IPC channel infrastructure. `gen.ts` and `types.ts` are generated; do not edit manually.
- Contains: Type-safe handler registry, typed preload client, auto-generated channel definitions

**`src/modules/`:**
- Purpose: Feature modules that run exclusively in the main process.
- Contains: One file (or subdirectory) per feature — firewall, proxy, assets, arrpc, native bindings, etc.
- Key rule: No window creation here. Windows live in `src/windows/`.

**`src/stores/`:**
- Purpose: Shared reactive state (config + localization) accessible from both main and preload contexts.
- Pattern: Each store has a `.main.ts` (host) and a `.preload.ts` (client) file.

**`src/windows/`:**
- Purpose: One subdirectory per BrowserWindow. Each window has:
  - A main-process file creating the `BrowserWindow` (e.g., `main/main.ts`)
  - A `preload/` subdirectory with the sandboxed preload entry (`preload.mts` or `preload.tsx`)
  - Optionally a `renderer/` subdirectory for injected renderer scripts or static HTML

**`src/windows/main/renderer/preVencord/patches/`:**
- Purpose: Individual Vencord webpack patch definitions. Each file exports a `PatchDefinition`.
- Glob-imported at build time: `glob-import:./patches/**/*.ts` in `preVencord.ts`

**`build/`:**
- Purpose: Build tooling — not shipped in the production package. Bundled only during CI/local builds.
- Generated: No (source-controlled)
- Committed: Yes

**`assets/`:**
- Purpose: Static files bundled into the Electron app package. `preVencord.js` and `postVencord.js` are build outputs.
- `lang/*.json` — Localization strings (committed source)
- `preVencord.js`, `postVencord.js` — Built renderer scripts (committed build outputs)

## Key File Locations

**Entry Points:**
- `src/main.ts`: Electron main entry
- `src/windows/main/preload/preload.mts`: Main window preload entry
- `src/windows/settings/preload/preload.tsx`: Settings window preload entry (Preact)
- `src/windows/screenshare/preload/preload.mts`: Screenshare picker preload entry
- `src/windows/main/renderer/preVencord/preVencord.ts`: PreVencord renderer script entry
- `src/windows/main/renderer/postVencord/postVencord.ts`: PostVencord renderer script entry

**Configuration:**
- `src/settingsSchema.ts`: All config keys, types, defaults, UI metadata — edit here first
- `src/stores/config/config.main.ts`: Main-process config host
- `src/stores/config/config.preload.ts`: Preload-context config client
- `electron-builder.ts`: Packaging/distribution configuration
- `tsconfig.json`: TypeScript compiler options

**IPC (auto-generated — do not edit):**
- `src/ipc/gen.ts`: Generated ipcMain handler registrations
- `src/ipc/types.ts`: Generated channel type map

**Core Logic:**
- `src/loader.ts`: Startup sequence
- `src/modules/firewall.ts`: Request blocking
- `src/modules/assets/assetLoader.ts`: Asset categorization and injection
- `src/windows/main/preload/bridge.ts`: `window.goofcord` API surface

**Build:**
- `build/build.ts`: Bun build orchestrator
- `build/genIpcHandlers.ts`: IPC codegen (run before compile)

## Naming Conventions

**Files:**
- Main-process files: `camelCase.ts` (e.g., `assetLoader.ts`, `chromeSpoofer.ts`)
- Preload entries: `preload.mts` or `preload.tsx` (always named `preload`)
- Store files: `<name>.main.ts` and `<name>.preload.ts` (dual files per store)
- Renderer scripts: `preVencord.ts` / `postVencord.ts` (camelCase matching the asset marker)
- Patch files: `camelCase.ts` one feature per file under `patches/`

**IPC channel names:**
- Format: `"module:functionName"` (e.g., `"settings:createSettingsWindow"`, `"assetLoader:getAssets"`)
- Derived automatically by codegen from file path and function name

**Config keys:**
- camelCase string literals (e.g., `"discordUrl"`, `"minimizeToTray"`)
- Window state keys use colon: `"windowState:main"`
- Button entries prefixed with `"button-"` (excluded from `Config` type)
- Encrypted keys: declared with `encrypted: true` in schema

**Directories:**
- Windows: lowercase noun (`main`, `settings`, `screenshare`)
- Window subdirs: lowercase (`preload`, `renderer`)
- Renderer subdirs: camelCase lifecycle name (`preVencord`, `postVencord`)

## Where to Add New Code

**New main-process feature (no IPC needed):**
- Implementation: `src/modules/<featureName>.ts`
- Import and call in `src/loader.ts:load()` at the appropriate point in the startup sequence

**New IPC-exposed function:**
- Implementation: Add to an existing `src/modules/*.ts` or appropriate file
- Annotate the function with `<IPCHandle>` (async, invoke) or `<IPCOn>` (sync, sendSync)
- Run `bun run build --onlyGenerators` to regenerate `src/ipc/gen.ts` and `src/ipc/types.ts`
- Preload callers use `invoke(channel, ...args)` or `sendSync(channel, ...args)` from `src/ipc/client.preload.ts`

**New config setting:**
- Add entry to `settingsSchema` in `src/settingsSchema.ts` using `setting()`, `hidden()`, or `button()`
- No other registration needed; `Config` type, `getDefaults()`, and the settings UI derive from the schema automatically
- If the setting maps to an IPC `onChange` channel, that channel must exist in `gen.ts`

**New Vencord webpack patch:**
- Create `src/windows/main/renderer/preVencord/patches/<featureName>.ts`
- Export a `PatchDefinition` (use `definePatch()` from `patchManager.ts`)
- Automatically glob-imported by `preVencord.ts` at build time — no manual registration required

**New postVencord feature:**
- Create `src/windows/main/renderer/postVencord/<featureName>.ts`
- Export an `init<FeatureName>()` function
- Import and call it in `src/windows/main/renderer/postVencord/postVencord.ts` inside `runSafe([...])`

**New localization key:**
- Add key to `assets/lang/en-US.json` (base language)
- Optionally add to other `assets/lang/*.json` files
- Access via `i("key")` in main process or preload (after localization is initialized)

**New BrowserWindow:**
- Create `src/windows/<name>/` directory
- Add `<name>.ts` (main-process window file)
- Add `preload/preload.mts` or `preload/preload.tsx` (sandboxed preload)
- Add `renderer/<name>.html` if a static HTML shell is needed
- Register screenshare-style `ipcMain.handle` directly or use the `<IPCHandle>` codegen pattern

## Special Directories

**`src/ipc/` (generated files):**
- Purpose: `gen.ts` and `types.ts` are outputs of `build/genIpcHandlers.ts`
- Generated: Yes (at build time)
- Committed: Yes (checked into git as build artifacts for IDE type support)
- Never edit `gen.ts` or `types.ts` manually

**`assets/preVencord.js` and `assets/postVencord.js`:**
- Purpose: Built outputs of the renderer script compilation, shipped as static assets
- Generated: Yes (by `build/build.ts:buildRendererScripts()`)
- Committed: Yes (these are the versions downloaded by users who haven't opted for custom assets)

**`ts-out/` (runtime output, not in tree):**
- Purpose: Bun build output directory — compiled JS for the Electron main process and preloads
- Generated: Yes
- Committed: No (gitignored)

---

*Structure analysis: 2026-05-28*
