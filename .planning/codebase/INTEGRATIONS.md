# External Integrations

**Analysis Date:** 2026-05-28

## APIs & External Services

**Discord:**
- Discord Web App - Primary content loaded via `discordUrl` config (default `https://discord.com/app`); GoofCord wraps it in an Electron BrowserWindow
  - No SDK; interaction happens via JavaScript injection into Discord's renderer (`mainWindow.webContents.executeJavaScript`)
  - Vencord mod API (`window.Vencord`) is accessed for OAuth modal in cloud auth (`src/windows/settings/cloud/token.ts`)

**GitHub Releases API:**
- Used for update checks: `https://api.github.com/repos/Milkshiift/GoofCord/releases/latest`
- Implementation: `src/modules/updateCheck.ts`
- Auth: None (unauthenticated, subject to rate limits)
- On new version: shows an Electron `Notification`; click opens releases page via `shell.openExternal`

**GoofCord Cloud Server:**
- Self-hosted or default: `https://goofcordcloud.wuemeli.com`
- Purpose: Cloud sync of GoofCord settings
- Endpoints consumed (all under `/v1/`):
  - `GET /v1/clientid` - Fetch OAuth client ID for Discord auth flow
  - `GET /v1/login` - Auth page loaded in embedded BrowserWindow
  - `GET /v1/callback?code=...` - OAuth callback intercepted via `webRequest.onBeforeRequest`
  - `GET /v1/load` - Load settings from cloud
  - `POST /v1/save` - Save settings to cloud (body: `{ settings: encryptedBase64 }`)
  - `GET /v1/delete` - Delete cloud settings
- Auth: Bearer token stored in config (`cloudToken`); token obtained via Discord OAuth2 flow
- Implementation: `src/windows/settings/cloud/cloud.ts`, `src/windows/settings/cloud/token.ts`
- Encryption: AES-256-GCM with scrypt KDF applied client-side before sending (`src/windows/settings/cloud/encryption.ts`)

**Invidious (YouTube proxy):**
- API: `https://api.invidious.io/instances.json` - Fetches list of public Invidious instances sorted by users
- Default instance: `https://invidious.nerdvpn.de` (user-configurable)
- Purpose: Replace YouTube embeds in Discord with privacy-respecting Invidious embeds
- Auto-switching: Latency-tests instances every 24 hours, selects fastest
- Implementation: `src/windows/main/renderer/postVencord/invidiousEmbeds.ts`

**External Asset Sources (user-configurable):**
- GoofCord raw assets: `https://raw.githubusercontent.com/Milkshiift/GoofCord/refs/heads/main/assets/`
  - `preVencord.js`, `postVencord.js` - GoofCord renderer scripts
- Vencord: `https://github.com/Vendicated/Vencord/releases/download/devbuild/browser.js` and `browser.css`
- Equicord (optional): `https://github.com/Equicord/Equicord/releases/download/latest/browser.js`
- Shelter (optional): `https://raw.githubusercontent.com/uwu/shelter-builds/main/shelter.js`
- Assets are fetched with ETag caching and stored locally; implementation: `src/modules/assets/assetDownloader.ts`

## Data Storage

**Databases:**
- None. No database used.

**File Storage (local):**
- Settings: `~/.config/goofcord/settings.json` (JSON, written by `src/stores/config/config.main.ts`)
- Downloaded assets: `~/.config/goofcord/assets/` (JS/CSS files managed by `src/modules/assets/`)
- arRPC detectable apps list: `~/.config/goofcord/detectable.json`
- Window state, ETag cache, managed files list: all stored inside `settings.json`
- Electron compile cache: enabled via `module.enableCompileCache()` in `src/main.ts`

**Caching:**
- ETag-based HTTP cache for downloaded assets stored in config key `assetEtags` (Record<string, string>)
- No in-memory or Redis caching

## Authentication & Identity

**Electron safeStorage (OS keychain):**
- Used to encrypt sensitive config fields (`encrypted: true` in `src/settingsSchema.ts`) before writing to `settings.json`
- Linux backends: gnome-keyring or kwallet
- Implementation: `src/stores/config/config.main.ts` — `encryptSafeStorage` / `decryptSafeStorage`
- Fallback: plaintext with `PLAIN:` prefix when keychain unavailable

**Discord OAuth2 (for cloud sync):**
- Flow: Discord OAuth2 authorization code flow
- Client ID obtained from cloud server; redirect URI is `{cloudHost}/v1/callback`
- Two methods: via Vencord's `OAuth2AuthorizeModal` (in-app) or via embedded BrowserWindow fallback
- Result: opaque token stored in config key `cloudToken`
- Implementation: `src/windows/settings/cloud/token.ts`

## Monitoring & Observability

**Error Tracking:**
- None. GoofCord's firewall actively blocks sentry.io and analytics by default (`blockedStrings` default includes `"sentry"`)

**Logs:**
- `console.log` / `console.error` / `console.warn` throughout, with `picocolors` for colored prefixes
- No structured logging or log file output

## CI/CD & Deployment

**Hosting:**
- GitHub Releases (artifacts uploaded automatically via `--publish=always`)

**CI Pipeline:**
- GitHub Actions
- Release workflow: `.github/workflows/main.yml` — manually triggered (`workflow_dispatch`); builds Linux (AppImage, deb, rpm, tar.xz), Windows (NSIS zip), macOS (DMG) in parallel
- Test build workflow: `.github/workflows/testBuild.yml` — Windows x64 zip only, uploads artifacts without publishing
- Security scan: `.github/workflows/codeql.yml` (CodeQL)
- Build toolchain in CI: Bun (`oven-sh/setup-bun@v2`), Node.js 24.x, electron-builder

## Webhooks & Callbacks

**Incoming:**
- None. GoofCord is a desktop client app with no server component.

**Outgoing:**
- None in the traditional sense. Discord OAuth2 callback is intercepted locally via `webRequest.onBeforeRequest` and never hits a GoofCord-controlled server.

## Rich Presence (arRPC)

**arRPC (OpenAsar):**
- Package: `arrpc` (github:Milkshiift/arrpc)
- Purpose: Implements Discord's Rich Presence IPC socket locally so other apps can set Discord game activity status
- Runs in a Node.js `worker_threads` Worker: `src/modules/arrpc/arrpcWorker.ts`
- IPC between worker and main window: `arrpc:activity`, `arrpc:invite` events via `mainWindow.webContents.send`
- Implementation: `src/modules/arrpc/arrpc.ts`

## Native System Integrations

**PipeWire/PulseAudio (patchcord — Linux only):**
- Package: `patchcord` (github:Milkshiift/patchcord, optional)
- Native binary: `assets/native/patchcord-linux-{arch}`
- Purpose: Routes application audio to a virtual sink for screen share audio capture
- Implementation: `src/modules/native/patchcord.ts`

**Global Keybinds (venbind — Windows/Linux):**
- Package: `venbind` 0.1.7 (optional)
- Native `.node` addon: `assets/native/venbind-{platform}-{arch}.node`
- Purpose: System-wide keybind registration (works even when window is not focused)
- Implementation: `src/modules/native/venbind.ts`

---

*Integration audit: 2026-05-28*
