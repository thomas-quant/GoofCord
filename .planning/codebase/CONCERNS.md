# Codebase Concerns

**Analysis Date:** 2026-05-28

## Tech Debt

**Pervasive TypeScript suppression comments:**
- Issue: 28 `// @ts-expect-error` / `// @ts-ignore` / `// @ts-nocheck` suppressions scattered across the codebase, masking real type unsafety.
- Files: `src/windows/main/renderer/postVencord/messageEncryption.ts`, `src/windows/main/renderer/postVencord/screensharePatch.ts`, `src/modules/native/venbind.ts` (entire file suppressed with `@ts-nocheck`), `src/windows/settings/cloud/encryption.ts`, `src/settingsSchema.ts`, `src/migration.ts`, `src/utils.ts`, `src/modules/windowStateManager.ts`, `src/modules/tray.ts`, `src/windows/main/main.ts`, `src/windows/main/preload/assets.ts`
- Impact: Compiler cannot catch regressions in suppressed areas; future callers may rely on wrong types.
- Fix approach: Introduce proper ambient declarations or typed wrappers; remove suppression comments case-by-case.

**Widespread `any` typing in runtime-facing code:**
- Issue: `any` used for Flux dispatch payloads, Vencord store references (`GuildReadStateStore`, `RelationshipStore`), screenshare callbacks, and safe-storage decryption return value (`decryptSafeStorage` returns `any`).
- Files: `src/windows/main/renderer/postVencord/dynamicIcon.ts`, `src/windows/main/renderer/postVencord/messageEncryption.ts`, `src/windows/screenshare/screenshare.ts`, `src/stores/config/config.main.ts:185`
- Impact: Runtime errors surface without compile-time warning; `decryptSafeStorage` callers must cast blindly.
- Fix approach: Introduce typed interfaces for Flux payloads; cast `decryptSafeStorage` return with a generic type parameter.

**`(state as any)[key]` mutation inside `saveToDisk` mutates a parameter:**
- Issue: `saveToDisk` modifies the `state` object passed to it in-place by encrypting values before writing, relying on the comment "state is a copy." If the call-site ever passes a live reference, config will be silently corrupted in memory.
- Files: `src/stores/config/config.main.ts:141`
- Impact: Subtle data-corruption risk that is invisible to the type system.
- Fix approach: Create an explicit copy inside `saveToDisk` before mutation, not relying on the caller.

**Uncommented debug `console.log` left in production cloud path:**
- Issue: `console.log(excludedOptions)` (no prefix, no guard) is committed inside `saveCloud`, leaking internal config key names to stdout on every cloud save.
- Files: `src/windows/settings/cloud/cloud.ts:82`
- Impact: Noise in production logs; minor information disclosure.
- Fix approach: Remove or replace with a prefixed `console.debug` behind a dev guard.

**QuickCSS window implementation described in-code as "crazy hacking":**
- Issue: The QuickCSS editor loads Monaco from a public CDN (`cdn.jsdelivr.net`) via `executeJavaScript`, relies on `BroadcastChannel` same-origin trick with Discord's `/popout` URL, and uses a 1-second hardcoded `setTimeout` as a failure sentinel.
- Files: `src/windows/main/quickCssFix.ts`
- Impact: CDN unavailability breaks QuickCSS entirely; 1-second race condition causes false "Failed to connect" message. Author's own comment: "Can't wait for this to break."
- Fix approach: Bundle Monaco locally; use a proper IPC round-trip with `ipcRenderer`/`ipcMain` instead of BroadcastChannel.

**venbind module entirely type-checked off:**
- Issue: `// @ts-nocheck` at the top of `src/modules/native/venbind.ts` because Bun doesn't install the native module on macOS. Entire file's type safety is disabled.
- Files: `src/modules/native/venbind.ts`
- Impact: Any API change in the `venbind` native module will silently break keybind functionality on Linux.
- Fix approach: Use a conditional type import with `?` optional chaining on import, or platform-gate the module in tsconfig `paths` to a stub type file.

**DOM Optimizer monkeypatches `Element.prototype.removeChild` globally:**
- Issue: `startDomOptimizer` replaces the native `Element.prototype.removeChild` with a version that introduces random `50–100ms` delays on certain element class names. Commented-out `console.log` calls suggest ongoing debug activity.
- Files: `src/windows/main/renderer/preVencord/domOptimizer.ts`
- Impact: May interact unpredictably with Discord/Vencord DOM operations; random delay makes bugs non-deterministic and hard to reproduce.
- Fix approach: Scope to a MutationObserver or use CSS `content-visibility` instead of patching native DOM APIs.

**`isSemverLower` is a hand-rolled semver comparator:**
- Issue: Instead of using a semver library, the update checker has a custom 87-line semver comparison function with no tests.
- Files: `src/modules/updateCheck.ts:37-86`
- Impact: Edge cases in pre-release or build-metadata parsing could cause missed update notifications.
- Fix approach: Use `semver` npm package, or at minimum add unit tests for the custom implementation.

**Migration system uses `@ts-expect-error` to access obsolete config keys:**
- Issue: Migrations for pre-2.0.0 users access `modNames` (a deleted key) using `// @ts-expect-error` suppression, and check `windowState:main` length by casting via `// @ts-expect-error`. These will silently break if the suppressed types are ever corrected.
- Files: `src/migration.ts:16,26`
- Fix approach: Capture the raw JSON as `Record<string, unknown>` before parsing into `Config`, allowing safe property access during migrations.

---

## Known Bugs

**Message encryption requires reloading Discord twice to take effect:**
- Symptoms: Enabling message encryption does not activate Vencord's `ChatInputButtonAPI` and `MessageEventsAPI` plugins in a way that takes effect without two reloads.
- Files: `src/windows/main/renderer/postVencord/messageEncryption.ts:89`
- Trigger: Enable "Message Encryption" in settings for the first time.
- Workaround: Reload Discord twice (noted in code as a TODO).

**`flashTitlebarWithText` IPC handler interpolates unsanitized strings into `executeJavaScript`:**
- Symptoms: The `color` and `text` parameters received from IPC are interpolated verbatim into a JS string passed to `executeJavaScript`. Also present in `cycleThroughPasswords` which interpolates `displayPass` (derived from user-configured password).
- Files: `src/windows/main/main.ts:124,127`, `src/modules/messageEncryption.ts:99`
- Trigger: A maliciously crafted color string (e.g., `#fff"); alert(1);//`) would execute arbitrary JS in the renderer.
- Workaround: None currently. The risk is limited because these IPC channels are internal (registered via `registerHandle`), but a compromised renderer could still pass crafted values.

---

## Security Considerations

**CSP is completely stripped for all main/sub frames:**
- Risk: `unstrictCSP` sets `content-security-policy` to `""` for all `mainFrame` and `subFrame` responses. This provides zero protection against injected scripts in any embedded content Discord loads.
- Files: `src/modules/firewall.ts:51-64`
- Current mitigation: `sandbox: true` on all `BrowserWindow` instances limits Node.js access; Electron's `contextBridge` gating restricts preload API surface.
- Recommendations: Selectively relax CSP only for Discord's own origin rather than blanket-clearing all frames.

**`discordUrl` config value is loaded unsanitized into `mainWindow.loadURL` and `preconnect`:**
- Risk: A user-controlled setting can point the app at an arbitrary URL (including `javascript:` or `file://` URIs in older Electron versions).
- Files: `src/windows/main/main.ts:59`, `src/windows/main/quickCssFix.ts:28`
- Current mitigation: Only the URL is loaded; sandbox is enabled. But a malicious URL could still phish or exfiltrate session data.
- Recommendations: Validate that `discordUrl` starts with `https://` and matches a discord.com pattern before loading.

**Firewall regex built from user-controlled config values without escaping:**
- Risk: `blockedStrings` and `allowedStrings` arrays are joined with `|` and passed directly to `new RegExp(...)`. A malformed entry (e.g., `(` or catastrophic backtracking pattern) can throw a `SyntaxError` that crashes the firewall initialization.
- Files: `src/modules/firewall.ts:31-32`
- Current mitigation: None.
- Recommendations: Wrap `new RegExp(...)` construction in a try/catch; escape each string with `escapeRegExp` before joining.

**`dangerouslySetInnerHTML` used with settings description strings:**
- Risk: Setting descriptions are rendered via `dangerouslySetInnerHTML={{ __html: description }}` in the settings UI. These strings come from localization files and `settingsSchema.ts`, not user input, but any XSS in a translation string would execute in the settings renderer context.
- Files: `src/windows/settings/preload/SettingField.tsx:87`
- Current mitigation: Descriptions are bundled strings, not runtime user input.
- Recommendations: Use a sanitization library (e.g., DOMPurify) or replace with a safe HTML subset renderer.

**Cloud authentication window opens without a preload or sandbox restriction:**
- Risk: `getCallbackUrlViaWindow` creates a `BrowserWindow` with no `webPreferences` at all (no sandbox, no preload), then intercepts `onBeforeRequest` to grab the OAuth callback. The unprotected window can run full Node.js if it navigates to a page that exploits Electron.
- Files: `src/windows/settings/cloud/token.ts:164-196`
- Current mitigation: The window is short-lived and modal.
- Recommendations: Add `webPreferences: { sandbox: true, nodeIntegration: false }` to the auth window.

**`shell.openExternal` called with linkURL from context menu without protocol validation:**
- Risk: `params.linkURL` is passed directly to `shell.openExternal` in the context menu "Open Link in Browser" item. Custom protocol handlers (e.g., `javascript:`, custom app URIs) are not filtered.
- Files: `src/modules/menus/contextMenu.ts:49`
- Current mitigation: Electron's `shell.openExternal` has its own allow-listing in some versions, but this is not relied on explicitly.
- Recommendations: Validate `linkURL` starts with `https://` or `http://` before calling `shell.openExternal`.

---

## Performance Bottlenecks

**Badge/tray icon generation runs `executeJavaScript` on every badge count change:**
- Problem: Both `generateBadgeOverlay` and `loadTrayImage` render badge graphics by executing JavaScript in the main window's renderer process via `executeJavaScript`. While a cache exists, every unique badge count (1–100) triggers a renderer round-trip on first appearance.
- Files: `src/modules/dynamicIcon.ts:73`, `src/modules/dynamicIcon.ts:161`
- Cause: Using the browser canvas API in the renderer process as a workaround for missing native image generation.
- Improvement path: Use Electron's `nativeImage` with node-canvas or sharp to generate badge images in the main process without a renderer round-trip.

**`waitForInternetConnection` busy-polls every 1 second indefinitely:**
- Problem: A `while (!net.isOnline())` loop with a 1-second sleep blocks the `load()` function until the network is available, with no timeout or maximum retry count.
- Files: `src/loader.ts:56-59`
- Cause: No event-based offline/online detection is used.
- Improvement path: Use `net.onlineStatusChanged` event (`app.on('online', ...)`) with a Promise to avoid polling.

**Config file read uses synchronous `fs.readFileSync` inside an async hydrate loop:**
- Problem: `hydrate()` uses `fs.readFileSync` (acknowledged in a comment as intentional over `fs.promises.readFile`) inside a `while (true)` loop that retries on error. While correct for startup, it blocks the main event loop on every config read failure retry.
- Files: `src/stores/config/config.main.ts:122`
- Cause: Comment says `fs.promises.readFile` is "much slower"; may be worth re-evaluating with profiling.
- Improvement path: Profile whether async read is actually slower; if not, switch to async to unblock the event loop.

---

## Fragile Areas

**Vencord patcher uses regex against minified bundle:**
- Files: `src/windows/main/preload/vencordPatcher.ts`
- Why fragile: `patchVencord` locates a specific anchor string (`Symbol("WebpackPatcher.isProxiedFactory")`) in Vencord's minified bundle, then applies a regex to the surrounding 200-character window. Any Vencord minification change, refactor, or rename breaks the hook silently (it logs an error but continues loading Vencord without the GoofCord patch array attached).
- Safe modification: Always test after Vencord updates; keep the anchor string and regex in sync with Vencord source changes.
- Test coverage: None.

**Pre/Post/Vencord asset categorization relies on a 500-byte content scan:**
- Files: `src/modules/assets/assetLoader.ts:13`, `src/modules/assets/assetLoader.ts:55-77`
- Why fragile: Asset type (pre-Vencord, Vencord, post-Vencord, other) is determined by scanning the first 500 bytes of the file for magic marker strings (`prevencordmarker`, `postvencordmarker`, `vencord`). Any asset whose marker falls beyond byte 500 is silently miscategorized as an "other" script.
- Safe modification: Increase `SCAN_LENGTH` or switch to a full-file marker search; document the marker convention.
- Test coverage: None.

**Screenshare global window state (`window.screenshareSettings`) shared across components:**
- Files: `src/windows/screenshare/screenshare.ts:68`, `src/windows/main/renderer/preVencord/patches/screenshare.ts:21`, `src/windows/main/renderer/postVencord/screensharePatch.ts:34`
- Why fragile: Screenshare quality settings are passed from the screenshare picker to the Discord renderer by writing to `window.screenshareSettings` via `frame.executeJavaScript`. Three separate files read from this global; if the screenshare window is opened multiple times or reloaded, stale global state may persist.
- Safe modification: Use the IPC layer to pass screenshare settings rather than relying on a global window property.
- Test coverage: None.

**`stopPatchcord` called from `STREAM_CLOSE` Flux event but also references deleted `GoofCord.stopVenmic`:**
- Files: `src/windows/main/renderer/postVencord/screensharePatch.ts:96-99`
- Why fragile: The renderer falls back to `GoofCord.stopVenmic` (a legacy API) if it exists, guarded by `// @ts-expect-error`. This legacy path is never cleaned up and may interfere if an old version of Vencord still exposes `stopVenmic`.
- Safe modification: Remove the `stopVenmic` fallback after confirming it is no longer used.

**`mainWindow` exported as a mutable `let` variable accessed across modules:**
- Files: `src/windows/main/main.ts:22`
- Why fragile: `export let mainWindow: BrowserWindow` is imported directly by `src/modules/arrpc/arrpc.ts`, `src/modules/assets/assetLoader.ts`, `src/modules/dynamicIcon.ts`, `src/modules/messageEncryption.ts`, `src/modules/tray.ts`, and `src/modules/cacheManager.ts`. Any module that imports it before `createMainWindow()` completes will get `undefined`.
- Safe modification: Expose `mainWindow` through a getter function `getMainWindow(): BrowserWindow | undefined`; add null-checks at all call sites.
- Test coverage: None.

---

## Scaling Limits

**ETag/asset cache stored in settings config file:**
- Current capacity: `assetEtags` and `managedFiles` are stored as config keys in `settings.json`.
- Limit: As the number of external assets grows, the config file grows. There is no eviction or size limit on the ETag cache.
- Scaling path: Move ETag/managed-file state to a separate JSON file outside the main settings file.

---

## Dependencies at Risk

**All critical dependencies sourced from GitHub forks with no version pinning:**
- Risk: `arrpc`, `electron-sync-store`, `stegcloak`, and `patchcord` are all listed as `github:Milkshiift/<repo>` without a commit hash or tag. A force-push to any of these forks would silently change the installed dependency on the next `bun install`.
- Impact: Reproducible builds are not guaranteed; a supply-chain compromise of any fork affects all GoofCord users.
- Migration plan: Pin each GitHub dependency to a specific commit SHA (e.g., `github:Milkshiift/arrpc#<sha>`).

**`electron` version pinned to 41.3.0 (an older release series):**
- Risk: Electron 41.x may have security patches backlogged. Electron's own security advisories should be checked when major versions are released.
- Impact: Known Chromium or Node.js CVEs in Electron 41 may not be patched.
- Migration plan: Track Electron release notes and upgrade to the latest stable series; test platform-specific features (Patchcord, Venbind) after each major upgrade.

**`venbind` optional dependency at `0.1.7` with no semver range:**
- Risk: The native binary is platform-specific; an incompatible Node.js ABI bump (via Electron upgrade) would silently fail to load venbind with no user-visible error beyond a console warning.
- Impact: Global keybinds silently stop working on Linux after Electron ABI change.
- Migration plan: Add ABI version checks or bundle a pre-built binary per-Electron-version in the release workflow.

---

## Test Coverage Gaps

**No test suite exists:**
- What's not tested: The entire codebase has zero test files (no `.test.ts`, `.spec.ts`, or test runner configuration found).
- Files: All of `src/`
- Risk: Regressions in any module (config encryption, asset loading, screenshare IPC, message encryption, version comparison, firewall regex) are caught only by manual testing or user bug reports.
- Priority: High

**Version comparison logic is untested:**
- What's not tested: The hand-rolled `isSemverLower` function has 87 lines of semver comparison logic covering edge cases (pre-release, build metadata, numeric vs. string identifiers).
- Files: `src/modules/updateCheck.ts:37-86`
- Risk: A comparison bug could suppress update notifications for a release, silently keeping users on outdated (potentially insecure) versions.
- Priority: High

**Config encryption/decryption round-trip is untested:**
- What's not tested: `encryptSafeStorage` / `decryptSafeStorage` behavior with unavailable `safeStorage`, corrupted ciphertext, and the `PLAIN:` fallback prefix.
- Files: `src/stores/config/config.main.ts:168-203`
- Risk: A bug in the plaintext fallback silently stores passwords in plaintext without user awareness.
- Priority: High

---

*Concerns audit: 2026-05-28*
