# Does Electron's Chromium honour `restrictOwnAudio`? — 2026-08-15

**No.** Electron 41.3.0 / Chromium 146.0.7680.188, Windows. The constraint is reported supported,
is never applied, and the capturing document's own audio survives in full.

Harness: `electron-scope/`. Needs no picker and no human — Electron's
`setDisplayMediaRequestHandler` auto-grants with `audio: "loopback"`, which is also what GoofCord's
own handler does, so this measures the real product path.

    440 Hz  <- VLC (out of tree) -> Speakers        control
    997 Hz  <- VLC (out of tree) -> CABLE Input     device scope
   1600 Hz  <- the Electron page itself             self-exclusion  <-- the one under test

## Every run

`getSupportedConstraints().restrictOwnAudio === true`, and `getSettings().restrictOwnAudio ===
**false**` in *every* pass — requested or not, feature switch or not.

| run | pass | 440 (control) | 997 (VAC) | **1600 (own audio)** | noise ref |
|---|---|---|---|---|---|
| no switch | baseline | −25.0 | −101.4 | **−26.0** | −109.8 |
| no switch | restrict | −33.0 | −92.5 | **−39.9** | −103.1 |
| `--enable-features=RestrictOwnAudio` | baseline | −29.6 | −103.4 | **−26.0** | −98.4 |
| `--enable-features=RestrictOwnAudio` | restrict | −29.2 | −95.4 | **−36.9** | −98.9 |
| switch, **reversed order** | **restrict (1st)** | −25.0 | −101.4 | **−26.0** | −109.8 |
| switch, **reversed order** | baseline (2nd) | −26.0 | −98.9 | **−28.5** | −106.0 |

## The trap this nearly fell into

Runs 2 and 4 look like partial suppression: own audio down 10–14 dB in the restrict pass. It is
not. **Reversing the pass order moves the drop with the order, not with the constraint** — when
restrict runs *first* its own audio is −26.0 dB, identical to baseline, and the *baseline* pass is
then the quieter one. Whatever causes it (second-pass AudioContext, ducking) it is positional.

Two other artifacts were removed along the way, both of which produced misleading numbers first:

- The tone files are finite and the two passes ran back-to-back, so pass 2 straddled the end of a
  tone — that is the control dropping 8 dB in run 2. Players now restart per pass.
- The renderer's `process.argv` is **not** the app's argv, so a `--reverse` flag added to the
  Electron command line silently did nothing and the "reversed" run repeated the original order.
  Flags now cross the boundary via `loadFile(..., { query })`.

## Verdict

`restrictOwnAudio` is **inert in Electron**, with and without the Chromium feature switch. It was
equally inert in Brave 151 (constraint at acquisition, `applyConstraints` on a live track, and
`--enable-features=RestrictOwnAudio` all left it `false`), so this is **not** a Brave patch.

Also confirmed here: Electron's loopback is **device-scoped** like every other Chromium path — the
VAC tone sits at −95 to −103 dB against a −96 to −110 dB floor in all six passes.

## What this does and does not prove

It settles the question that mattered: **GoofCord cannot get self-exclusion out of Chromium's
loopback.** Goal (b) — device-scoped *and* self-excluding — remains unreachable, and
`SYNTHESIS.md`'s "IMPOSSIBLE" verdict stands.

It does **not** prove the feature is broken upstream. Electron supplies the audio through its own
`audio: "loopback"` handler, which plausibly bypasses the constraint plumbing entirely; that alone
would explain the Electron result. It does not explain Brave, which uses the ordinary picker path.
Settling *that* needs a real Chrome, which is **not installed on this machine** — and it would be a
curiosity, not a path, since GoofCord is Electron either way.

## Reproducing

    unzip ~/.cache/electron/electron-v41.3.0-win32-x64.zip -d /mnt/c/temp/electron41-win
    electron.exe <repo>\tools\wasapi-echo-test\electron-scope [--enable-rot] [--reverse]
