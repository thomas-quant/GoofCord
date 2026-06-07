# Phase 06 — Encryption Hardening Investigation (INV-01)

## Verdict: NO-GO (for a hardening build milestone) — with one optional DEFER-level micro-PR

**BLUF:** GoofCord's secret handling is already in good shape and there is **no plaintext-at-rest hole** for the message-encryption password on the platforms that matter. Verified against the *real* on-disk config on this Windows box (`%APPDATA%/goofcord/GoofCord/settings.json`): `encryptionPasswords` is stored as `ENC:djEw…` and `cloudEncryptionKey` as `ENC:djEw…` — i.e. Electron `safeStorage` ciphertext (DPAPI-backed; the base64 decodes to the Chromium OSCrypt `v10` versioned prefix), **not** plaintext. The "StegCloak is steganography not crypto" worry is also largely defused: GoofCord pins `Milkshiift/stegcloak-rs`, a WASM rewrite that does **Argon2 key derivation + a ChaCha/Salsa AEAD** under the hood (confirmed from the compiled `.wasm` strings: `Argon2 hashing failed`, `KeyDerivationError`, `expand 32-byte k`, `IntegrityError`). The cloud-sync path uses textbook-correct `scrypt (N=2^15) + AES-256-GCM` with NIST/OWASP-cited parameters. The only genuinely-plaintext value is `cloudToken` (a bearer token to the user's *own* already-E2E-encrypted cloud blob), and on this machine it's empty. The single residual hardening observation — `decryptSettings()` pushes the *decrypted* passwords into the renderer-synced config store — is low severity (context isolation keeps the untrusted Discord/Vencord main-world from reading them) and would be moderate-divergence to fix. None of this rises to a security-justified build, and proposing a large "encryption hardening" milestone to an AI-averse maintainer whose crypto is already correct would be a poor use of fork capital.

---

## 1. Current State (codebase today)

### 1a. The message-encryption password — protected, not plaintext

- **Schema:** `encryptionPasswords` is declared `encrypted: true` (`src/settingsSchema.ts:266-270`). The schema comment at `src/settingsSchema.ts:30` documents the contract: *"Encrypted settings can't be read before appReady."* `isEncrypted(key)` (`src/settingsSchema.ts:526`) is the single source of truth, backed by a cached `Set` of all keys carrying `encrypted: true`.
- **At rest:** every write goes through `saveToDisk()` (the `onPersist` middleware), which loops the state and, for each `isEncrypted(key)`, replaces the value with `encryptSafeStorage(value)` before writing JSON (`src/stores/config/config.main.ts:138-144`). `encryptSafeStorage` calls `safeStorage.encryptString(json)` and stores it as `ENC:<base64>` (`config.main.ts:168-183`).
- **Confirmed on disk** (real file, `%APPDATA%/goofcord/GoofCord/settings.json`):
  - `"encryptionPasswords": "ENC:djEwB6D8wNdev7heGcVH7JBh1lXIsQ9kOiHRyVKbgIc4"`
  - `"cloudEncryptionKey": "ENC:djEwEYVjWzVxQY/RRcJUbAuHK2IBcjCMG+Pv+02N0k/r"`
  - `base64("djEw…")` → bytes `v10…`, the Chromium OSCrypt versioned-ciphertext marker → safeStorage encryption genuinely engaged (DPAPI on Windows).
- **In memory:** at startup `loader.ts:40-41` runs `initConfigEncryption()` then `decryptSettings()` — *after* `app.whenReady()` (line 33) and *before* any window is created (line 43). `decryptSettings()` (`config.main.ts:151-166`) decrypts each encrypted key in place and writes it back with `configHost.set(config, { persist: false })`, so the decrypted form lives only in RAM and is **never** re-persisted in cleartext. Decrypt failures are swallowed and silently reset the key to its default (`config.main.ts:160-162`).
- **Use:** `messageEncryption.ts` runs entirely in the **main** process. `ensureInitialized()` reads `getConfig("encryptionPasswords")[0]` into `chosenPassword` (`src/modules/messageEncryption.ts:18-20`); `encryptMessage`/`decryptMessage` call `stegcloak.hide/reveal(message, password, salt, …)` (`messageEncryption.ts:45,61`). The renderer reaches these only via `sendSync` IPC (`bridge.ts:39-40`); the salt is the **channelId** (`assets/postVencord.js:152,178`), a deterministic per-conversation salt — required so a peer holding the shared password can re-derive the same key.

### 1b. safeStorage application & availability gating

- `initConfigEncryption()` (`config.main.ts:19-42`) awaits `app.whenReady()`, caches `safeStorage.isEncryptionAvailable()`, and — on first launch only, if unavailable — shows a warning dialog naming the backend (`getSelectedStorageBackend()`) and telling Linux users to install gnome-keyring/kwallet. This is a correctly-handled failure mode, not an oversight.
- Fallback is explicit and labelled: when encryption is unavailable, secrets are written as `PLAIN:<json>` (`config.main.ts:171-172,181`); `encryptSafeStorage` also self-heals to `PLAIN:` if `encryptString` throws (`config.main.ts:178-182`). So "plaintext at rest" can only occur when the OS itself offers no secret store (primarily Linux without a keyring → `basic_text` backend) — and the user is warned when it happens.

### 1c. Defense-in-depth: the password is kept out of the renderer API…

`bridge.ts:32-37` — the contextBridge `goofcord.getConfig(key)` deliberately returns `getDefaults()[key]` (i.e. empty) for any `isEncrypted(key)`, so the password is **never** handed to the Discord/Vencord main-world. Encryption/decryption is done server-side (main process) over IPC. Good design.

### 1d. …but the decrypted secret is broadcast into renderer-process memory (the one real residual)

`decryptSettings()` writes the plaintext back via `configHost.set(...)`. In `electron-sync-store`, `StoreHost.set()` → `broadcast()` does `webContents.send("store:config:changed", this.state)` to **every** window, and the `GET` IPC handler returns the full state on client hydration (`node_modules/electron-sync-store/src/main.ts:48-66,80-86`; `preload.ts` `StoreClient` stores it in `this.state`). So the decrypted `encryptionPasswords` / `cloudEncryptionKey` transit IPC into each **preload's isolated world**. This is *not* plaintext-at-rest and *not* reachable from the untrusted main-world (context isolation + `sandbox:true`), but it is unnecessary exposure: only the main process consumes these values. Severity: **low**.

### 1e. Cloud sync — already strong crypto

`src/windows/settings/cloud/encryption.ts` derives a key with `scrypt(password, salt, 32, {N:32768, r:8, p:3})` and encrypts with `aes-256-gcm` (random 32-byte salt, 12-byte IV per NIST SP 800-38D, 16-byte tag), brotli-compressed, base64-packed (`encryption.ts:9-52`). Parameters are explicitly OWASP/NIST-cited in comments. `cloud.ts:70-80` excludes `cloudEncryptionKey/cloudHost/cloudToken/modEtagCache` from upload, and — if no cloud key is set — additionally strips every `isEncrypted` key so message passwords are never sent unencrypted. This is correct, defensible crypto.

### 1f. The one actually-plaintext secret: `cloudToken`

`cloudToken` is `hidden("")` (`settingsSchema.ts:441`) — **not** marked `encrypted`, so it is written to `settings.json` in cleartext (`token.ts:18` `setConfig("cloudToken", …)`). On this machine it is empty (cloud unused). Impact is limited: it is a bearer token to the user's *own* cloud-settings blob, which is itself E2E-encrypted with `cloudEncryptionKey`. Severity: **low-moderate** (a local attacker with the token could fetch/delete the encrypted blob but not read settings without the separate key). This is the most defensible single-line hardening, if any is wanted: add `encrypted: true` to `cloudToken`.

---

## 2. Options Survey

| Approach | What it buys | Maintenance / status | License |
|---|---|---|---|
| **Status quo: Electron `safeStorage`** (in use) | OS-bound encryption at rest: DPAPI (Win), Keychain (macOS), kwallet/gnome-libsecret (Linux); `basic_text` plaintext fallback when no keyring. | First-party Electron API, stable in Electron 41; zero extra deps. | MIT (Electron) |
| **`stegcloak-rs` (Argon2 + ChaCha/Salsa AEAD)** (in use, for messages) | Memory-hard KDF + authenticated encryption, layered under zero-width steganography. Already pinned `github:Milkshiift/stegcloak-rs#847c39e`. | Maintainer's own fork; WASM, no native build. Single-maintainer risk. | (fork; upstream StegCloak MIT) |
| **Node `crypto` scrypt + AES-256-GCM** (in use, for cloud) | Standard authenticated encryption with a tunable memory-hard KDF; no third-party dep (built into Node/Electron). | First-party Node API; permanently maintained. | — (Node core) |
| `keytar` | Per-secret OS keychain entries | **Archived/unmaintained** (Atom-era); native module per platform. Electron docs now steer users to `safeStorage` instead. | Apache-2.0 |
| `libsodium` / `libsodium-wrappers` | XChaCha20-Poly1305, Argon2id, audited primitives | Actively maintained; WASM build avoids native compile. Would duplicate crypto GoofCord already gets from Node core + stegcloak-rs. | ISC |
| Web Crypto `SubtleCrypto` (AES-GCM/PBKDF2) | Standard, no dep | Available in renderer; PBKDF2 only (no memory-hard KDF without extra work). Weaker KDF than the existing scrypt path. | — |

**Peer clients:** Vesktop/Vencord and legcord do **not** ship a GoofCord-style "message encryption password" feature, so there is no directly comparable pattern to copy; the closest analogue is their generic use of Electron `safeStorage` for sensitive blobs — exactly what GoofCord already does. (Sources below.)

---

## 3. Tech-Debt Cost

- **Do nothing (recommended):** zero cost. Current design is correct on Windows/macOS and degrades loudly (warning dialog) on keyring-less Linux.
- **Encrypt `cloudToken` (1-line):** add `encrypted: true` in schema + nothing else (the encrypt/decrypt/cloud-exclude plumbing already keys off `isEncrypted`). Risk: one-time migration of an existing plaintext token (it self-heals — an unparseable/!`ENC:` value just falls through; worst case the user re-auths). New deps: none. Cross-platform: inherits safeStorage's existing behavior. **Effort: S.**
- **Stop broadcasting decrypted secrets to renderers:** keep encrypted keys out of the synced store and decrypt into a main-process-only map that `messageEncryption.ts` reads. Touches the config store's decrypt path and possibly `electron-sync-store` (which has no per-key filtering). Moderate fork-divergence; meaningful test surface (settings UI reads, cloud save, message encrypt/decrypt). New deps: none. **Effort: M.** Payoff is low (context isolation already blocks the realistic attacker), so cost/benefit is poor.
- **Swap in libsodium/keytar:** net-negative — duplicates crypto already present, adds a dependency + supply-chain/native-build surface, and `keytar` is unmaintained. Not worth it.

---

## 4. Upstream-ability

- The hardened paths here **are** the upstream code (this fork tracks `Milkshiift/GoofCord`; `safeStorage`, the `ENC:`/`PLAIN:` scheme, `stegcloak-rs`, and the scrypt+GCM cloud crypto are all upstream's own work). There is no fork-local security debt to fix.
- The only cleanly upstream-able change is the **`cloudToken` one-liner** (`encrypted: true`): surgical, idiomatic (reuses the existing `isEncrypted` machinery), and easy to justify in one sentence ("the cloud bearer token is the only sensitive value still written in cleartext"). This is the kind of minimal, mechanism-grounded diff that clears the maintainer's bar — *if* the user wants to spend a PR on it.
- The renderer-broadcast change is **not** a good upstream candidate: it would need design-level changes to `electron-sync-store` (also the maintainer's project) and reads as speculative hardening rather than a concrete bug — exactly the profile the maintainer rejects.

---

## 5. Recommendation & Next Step

**NO-GO** on an "encryption hardening" build milestone. The investigation's two driving worries are both already handled:

1. *Is the message-encryption password plaintext at rest?* — **No.** It's `safeStorage`/DPAPI ciphertext on disk (confirmed on the real config), decrypted only in main-process RAM.
2. *Is StegCloak weak crypto with no KDF?* — **No.** The pinned `stegcloak-rs` uses **Argon2 + a ChaCha/Salsa AEAD**; the cloud path independently uses scrypt+AES-256-GCM with OWASP params.

**Threat model (precise):** safeStorage protects secrets against (a) another OS user reading `settings.json`, and (b) offline inspection of a copied disk/file — DPAPI binds the key to the Windows user account. It does **not** (and is not meant to) protect against malware running *as the same user*, which can call DPAPI-unprotect or scrape process memory; that's the universal limit of local secret stores and is acceptable for a single-user desktop client. The remaining genuine plaintext value (`cloudToken`) guards only the user's own already-E2E-encrypted cloud blob.

**Recommended next step (optional, DEFER):** if the user wants *something* shippable out of this, open one surgical upstream PR adding `encrypted: true` to `cloudToken` in `src/settingsSchema.ts` (the only cleartext secret), framed around that single concrete fact. **Effort: S (~1 line + a sentence of justification).** Do **not** pursue the renderer-broadcast change or any library swap.

If a build milestone were ever forced, its entire defensible contents would be: (1) `cloudToken` → `encrypted:true`; (2) optionally, decrypt secrets into a main-only map instead of the synced store. That's a half-day, not a milestone — which is itself the argument for NO-GO.

---

### Evidence index (file:line)
- `src/settingsSchema.ts:30` (encrypted contract), `:266-270` (`encryptionPasswords` encrypted), `:441` (`cloudToken` plaintext), `:442-447` (`cloudEncryptionKey` encrypted), `:506-529` (`isEncrypted`)
- `src/stores/config/config.main.ts:19-42` (`initConfigEncryption`), `:132-149` (`saveToDisk` re-encrypts), `:151-166` (`decryptSettings`, persist:false), `:168-203` (`encryptSafeStorage`/`decryptSafeStorage`, `ENC:`/`PLAIN:`)
- `src/loader.ts:40-43` (order: init → decrypt → window)
- `src/modules/messageEncryption.ts:11-20,45,61` (main-process password use; channelId salt)
- `src/windows/main/preload/bridge.ts:32-37` (encrypted keys hidden from renderer API)
- `src/windows/settings/cloud/encryption.ts:9-52` (scrypt N=2^15 + AES-256-GCM), `cloud.ts:70-85` (exclusions), `token.ts:18` (plaintext token write)
- `node_modules/electron-sync-store/src/main.ts:48-66` (`broadcast` sends full state to all windows)
- `node_modules/stegcloak/pkg/stegcloak_rs_bg.wasm` strings: `Argon2 hashing failed`, `KeyDerivationError`, `expand 32-byte k`, `IntegrityError`, `Salt is required`
- Real on-disk config: `%APPDATA%/goofcord/GoofCord/settings.json` → `encryptionPasswords`/`cloudEncryptionKey` both `ENC:djEw…` (OSCrypt `v10`)

### Sources (library/platform claims)
- [Electron `safeStorage` API docs](https://www.electronjs.org/docs/latest/api/safe-storage) — per-platform backends (DPAPI / Keychain / kwallet+gnome-libsecret), `getSelectedStorageBackend()`, `basic_text` plaintext fallback "encrypted via hardcoded plaintext password."
- [electron/electron #33640](https://github.com/electron/electron/issues/33640), [#34614](https://github.com/electron/electron/issues/34614), [#32206](https://github.com/electron/electron/issues/32206) — `isEncryptionAvailable()` requires `app` ready / first BrowserWindow; platform quirks.
- [Vesktop security overview](https://github.com/Vencord/Vesktop/security) / [vesktop.org](https://vesktop.org/is-vesktop-a-safe-discord-client-to-use/) — peer Vencord client relies on token auth + Electron `safeStorage`; no equivalent message-password feature to compare against.
