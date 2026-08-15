# Capture scope vs. the virtual cable — measured 2026-08-15

Harness: `device-scope-test.mjs`. Two tones, two devices, both played by VLC launched
**out of our process tree** via WMI `Win32_Process.Create` (parent `WmiPrvSE.exe`; anything we
spawn ourselves lands inside the tree we exclude and would be filtered for the wrong reason).
Measured with a Goertzel filter at each tone frequency plus a 1500 Hz noise reference.

    997 Hz -> CABLE Input (VB-Audio Virtual Cable)     the VAC
    440 Hz -> Speakers (Realtek)                        the default endpoint

| capture scope | 997 (VAC) | 440 (default) | 1500 ref |
|---|---|---|---|
| **process loopback, EXCLUDE-self** — what #211 ships | **−17.4 dB** | −20.3 dB | −94.1 dB |
| endpoint: Speakers (default) | **−12.1 dB** | −15.1 dB | −103.6 dB |
| endpoint: CABLE Input (the VAC) | −12.3 dB | **−89.5 dB** | −92.5 dB |
| endpoint: PL2470H (idle) | *no packets* | *no packets* | — |
| endpoint: Realtek Digital Output (idle) | *no packets* | *no packets* | — |

## 1. Our capture is device-agnostic — confirmed

Process loopback picks up the 997 Hz tone at −17.4 dB even though that tone was never sent to
the default endpoint. This is not a bug, it is the API's contract: process loopback attaches to a
*process tree* and takes its render streams wherever they are routed. `#211` therefore captures
VAC-routed audio by construction.

## 2. Endpoint-scoping looked dead too — but only while the Listen bridge was on

> **Superseded by §RESOLVED.** Everything in this section was measured with
> Listen-to-this-device *enabled*. With it off, the endpoint capture sees nothing from the VAC.
> Kept because the controls in it are what proved the endpoint scoping is real.

The obvious follow-up — "capture only the physical output device" — is **dead here**, and for a
reason unrelated to the 2026-07-13 process-filter falsification.

Capturing the Speakers endpoint still yields the 997 Hz VAC tone at −12.1 dB. The VAC is bridged
back into the physical speakers on this machine, so its content is genuinely *in* the speaker mix.
An endpoint-scoped capture of the physical output contains the VAC audio because the VAC audio
really does come out of the speakers.

This is not the endpoint selection failing. Two controls prove the scoping works:

- **Negative:** capturing an idle endpoint (PL2470H, Realtek Digital Output) returns **zero
  chunks**. An inert/global path would have delivered both tones.
- **Positive:** capturing CABLE Input returns the 997 Hz tone at −12.3 dB and rejects the
  speakers' 440 Hz tone at −89.5 dB — **77 dB of isolation**, against a −92.5 dB noise floor.

So endpoint capture is correctly device-isolated; the devices themselves are just not isolated.

## 2b. The bridge is Windows' own "Listen to this device"

Confirmed in the registry, not inferred. Under
`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture\*\Properties`,
exactly one capture endpoint has `{24dbb0fc-9311-4b3d-9cf0-18ff155639d4},1 = 1`:

    LISTEN ON : VB-Audio Virtual Cable
      target  : {0.0.0.00000000}.{5a31bb14-b764-4610-bd44-e44fdae8b935}
              = Speakers (Realtek(R) Audio), the default render endpoint

No user-space bridge process is involved (no VoiceMeeter, no audiorepeater — checked). The Windows
audio engine renders the CABLE Output capture stream into the Speakers mix itself.

Verified with a single tone to remove any possibility that one of two simultaneous players ignored
its device argument: playing **only** 997 Hz to CABLE Input, the Speakers endpoint capture returns
997 at −12.1 dB and 440 at −88.4 dB.

This is almost certainly the user's echo chain: voice → app → CABLE Input → *Listen* → Speakers →
present in the mix that any loopback capture, of either scope, will take.

## 3. What this ruled out about Discord web (partly superseded)

> **Superseded by §RESOLVED and §4.** The reasoning below was sound given a live Listen bridge;
> the premise was wrong. The tab/window-INCLUDE conclusion it reaches is **not** what happened.

The user observed on Discord **web**: friend heard the screenshare audio and other app audio, but
heard neither their own voice nor audio played through the VAC.

Row 2 says a default-endpoint loopback on this box **contains** the VAC tone. So whatever the web
client was capturing, **it was not endpoint loopback on the default device** — that scope
demonstrably includes the VAC content here, and the friend would have heard it.

It was also not plain EXCLUDE-self process loopback: row 1 shows that scope contains the VAC tone
too.

Both of the scopes GoofCord has ever used are excluded by the observation. What remains consistent
with all three of the friend's reports is a **tab/window-scoped (INCLUDE-style) capture** — only
the shared surface's own audio, which is why the call was absent, the VAC was absent, and the
shared content was present. That is the same scope as Discord desktop's window-share
(`soundsharePid` = real PID → INCLUDE) and the same scope as `f021c69`'s per-app INCLUDE.

### RESOLVED — the Listen bridge was off during the web test

The user confirmed Listen-to-this-device was **off** when they demoed to their friend, and turned
it off again so the A/B below could run. Both results reconcile completely.

Registry check, parsed properly this time: the property is a **VT_BOOL** PROPVARIANT
(`vt=0x000B`) whose value lives at **byte offset 8**, and it moved `0xFFFF` (VARIANT_TRUE) → `0`
(VARIANT_FALSE). An earlier check in this session tested `-eq 1` against the whole byte array,
which PowerShell evaluates elementwise and which matched a *reserved* byte — that check was wrong
even though its conclusion happened to be right, because the measurement backed it independently.

**A/B with Listen OFF, playing only 997 Hz into CABLE Input:**

| capture scope | 997 (VAC) | 440 (default) | 1500 ref |
|---|---|---|---|
| endpoint on Speakers | *zero chunks* | — | — |
| process loopback, EXCLUDE-self | **−12.1 dB** | −91.1 dB | −92.3 dB |

Endpoint capture of the default device sees **nothing at all** — the tone never reaches Speakers
once the bridge is gone. Process loopback still takes it at full strength, **79 dB above its own
noise floor**, because it is bound to VLC's process rather than to any device.

## 4. The actual mechanism — scope width, not INCLUDE vs EXCLUDE

Everything the user observed now follows from one difference:

| | scope | sees VLC → CABLE Input? |
|---|---|---|
| Discord **web** (Chromium "entire screen + system audio") | endpoint loopback, default render device | **no** — nothing renders it to Speakers |
| GoofCord **#211** | process loopback, EXCLUDE own tree | **yes** — device-agnostic by contract |

Chromium's capture is *device-scoped*; ours is *device-agnostic*. Ours is strictly the wider scope:
it takes anything any process renders to any endpoint, including a virtual cable nobody is
listening to. Spotify → Speakers was heard by the friend because it lands on the captured device;
VLC → CABLE Input was not, because it never does.

The earlier framing of this milestone — INCLUDE (allowlist) vs EXCLUDE (denylist) — is not what
separates GoofCord from Discord web. **Scope width is.**

## 5. What still is not explained

If Chromium is doing plain endpoint loopback of the default device, the Discord call audio playing
out of those same Speakers should have been captured, and the friend should have heard themselves.
They did not.

So Chromium is somehow *device-scoped* **and** *self-excluding* at the same time — the exact
combination falsified for a single WASAPI `Activate` call on 2026-07-13. Whatever it does, it is
not one call with the EXCLUDE blob on an endpoint.

This is now the only open question, and it matters: if that combination is achievable at all, it is
a better fix than per-app INCLUDE, because it needs no app picker. Settling it requires measuring
Chromium's own `getDisplayMedia({audio:true})` output directly — a local page, MediaRecorder, and
the same Goertzel analysis.

