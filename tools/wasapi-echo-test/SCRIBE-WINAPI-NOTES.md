# WASAPI subtraction: Windows API notes

**D** = documented; **I** = inference; **U** = unspecified/unverified. Research-only; no build.

## Evidence boundary

The question supplies 77 dB/480 frames/0.98937 and 36→48 dB/334+0.10 frames. The local `subtract-run.json` is **different**: process ≈48→52 dB at −51→−51.05; endpoint gain/null zero with an enormous invalid lag; process DevicePositions zero; endpoint discontinuity. Treat the supplied results separately. The script's single-tone correlation/gain fit proves neither broadband equivalence nor unique delay; fractional interpolation also changes amplitude.

## 1. Endpoint tap and volume

**D:** [Loopback Recording][1] specifies shared-mode `IMMDevice` render loopback: engine-output copying, or a hardware loopback pin when available. `AUDCLNT_STREAMFLAGS_LOOPBACK`, `AUTOCONVERTPCM`, and `SRC_DEFAULT_QUALITY` are defined in `AudioSessionTypes.h`, used through `audioclient.h`.

**I:** the ordinary software endpoint tap is downstream of session gains and stream mixing, including LFX/SFX processing; “pre-volume” does **not** mean pre-`ISimpleAudioVolume`. **D:** [APO architecture][4] places SFX before mixing, MFX after mode mixing, EFX after all-mode mixing (legacy LFX/GFX roughly per-stream/global). **U:** this does not specify one universal loopback position relative to every GFX/EFX, hardware DSP, or engine limiter. Endpoint capture can contain enhancements; never assume it bypasses them or is invariably post-everything.

**D:** [`AUDCLNT_STREAMOPTIONS_POST_VOLUME_LOOPBACK`][2] (`0x08`, `audioclient.h`) requests **post-endpoint-volume/mute** instead of default pre-volume/mute. Set `AudioClientProperties.Options` through `IAudioClient2::SetClientProperties` before `Initialize`; not an `Initialize` flag. Introduction: **Windows 11 24H2, release build 26100** ([driver contract][3]; SDK IDL guard `NTDDI_VERSION > NTDDI_WIN11_ZN`). The enum page's Windows 8.1 minimum is not this flag's minimum. Check HRESULT support.

**D:** `IAudioEndpointVolume::QueryHardwareSupport` (`endpointvolume.h`) reports `ENDPOINT_HARDWARE_SUPPORT_VOLUME/MUTE`; hardware controls otherwise become software controls. It does not locate the loopback pin. [3] specifies hardware tap capabilities using `KSPROPSETID_AudioLoopback`, `KSPROPERTY_AUDIOLOOPBACK_TAPPOINT_CAPS`, `AUDIOLOOPBACK_TAPPOINT_CAPS_PREVOLUMEMUTE/POSTVOLUMEMUTE`, and `KSATTRIBUTE_AUDIOLOOPBACK_TAPPOINT` (`ksmedia.h`); do not retroactively assume compliant behavior on older drivers.

### What is 0.98937?

**I:** best conservative identity: an effective path-gain ratio (≈−0.093 dB), not an identified volume setting. Near-unity engine/APO attenuation, possibly limiter action, is plausible; a nonunity session gain is plausible if the reference bypasses it. The tone cannot rank these reliably. A limiter is signal/history-dependent, not necessarily a fixed multiplier; no public WASAPI getter exposes its instantaneous gain.

**D:** [session gain][5] combines `IAudioStreamVolume`, `ISimpleAudioVolume::GetMasterVolume`, `IChannelAudioVolume::GetAllVolumes`, and policy attenuation. Enumerate target render sessions via `IAudioSessionManager2`/`IAudioSessionControl2::GetProcessId` (`audiopolicy.h`); query each session and mute, not just one Electron PID/session. Foreign per-stream/policy gains are not fully queryable this way.

For a verified pre-session reference, apply only gains between taps. **Do not multiply endpoint `GetMasterVolumeLevelScalar`: it is audio-tapered, not linear amplitude** [6]. If endpoint gain actually lies between taps, query `GetMasterVolumeLevel`/per-channel dB and use `10^(dB/20)`, respecting mute/balance. For two pre-endpoint-volume taps, omit endpoint gain entirely. Shared gains cancel; multiplying them again is wrong.

## 2. Process tap

**D:** [ApplicationLoopback][7] documents build 20348+, device-independent process-tree INCLUDE/EXCLUDE. `audioclientactivationparams.h` defines `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK` = `L"VAD\\Process_Loopback"`, `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, and `PROCESS_LOOPBACK_MODE_*_TARGET_PROCESS_TREE`.

**U:** neither sample nor inspected SDK comments specify pre-session-volume placement or LFX/GFX/EFX/limiter order; no authoritative MS Q&A guarantee was located. **I:** a per-stream branch before the endpoint's aggregate processing/master volume is plausible; pre-session-volume remains an unverified hypothesis. Device independence alone does not prove bypassing stream effects/gains. Validate session/master mute and volume separately; do not transplant the endpoint POST_VOLUME contract onto this pseudo-device.

## 3. Fractional disagreement

**I:** “same engine” is unproven: process capture spans endpoints. Query both real endpoints' `IAudioClient::GetMixFormat` (rate, channels, mask), not just requested 48-kHz output. VB-Cable's actual rate was not recorded. A differing rate, independent per-client `AUTOCONVERTPCM` SRC state/phase, aggregation clocks, or timestamp origins could explain fractional delay; Speakers' native 48 kHz could avoid one conversion.

Requesting the source endpoint's mix rate/format is a useful isolation test, **not an exactness guarantee**: process capture has no single endpoint-native format. Addon comments report pseudo-device format queries returning `E_NOTIMPL`; the sample's contrary `GetMixFormat` suggestion is not proof. No documented cross-client SRC phase/reset/clock-lock control exists; identical formats, start calls, or `SRC_DEFAULT_QUALITY` do not provide one. Fan out one capture for identical copies. Test broadband, repeated starts, and long-run drift.

## 4. Product failure checklist

| Failure | Runtime detection and limit |
|---|---|
| Default changes/unplug | `IMMNotificationClient::OnDefaultDeviceChanged`, `OnDeviceStateChanged` (`mmdeviceapi.h`); match `eRender` and chosen role (`eConsole` here). Reopen by ID; existing capture does not automatically follow. |
| Format/channel changes | `OnPropertyValueChanged`, `PKEY_AudioEngine_DeviceFormat`; re-query mix format; `AUDCLNT_E_DEVICE_INVALIDATED`; session `OnSessionDisconnected(DisconnectReasonFormatChanged)`. Reinitialize alignment. |
| Enhancements/limiter | `IAudioEffectsManager::GetAudioEffects` and change callback where supported [9], on relevant render streams. Partial visibility only: no complete foreign-path coefficients, nonlinear state, or limiter-gain query. |
| Mid-share app/master volume | `IAudioSessionEvents::OnSimpleVolumeChanged/OnChannelVolumeChanged`; `IAudioEndpointVolumeCallback::OnNotify`; track newly created sessions. Notifications are not sample-accurate gain envelopes; policy ducking adds uncertainty. |
| Exclusive/offload/protected content | `AUDCLNT_E_DEVICE_IN_USE`, resource/device invalidation, `DisconnectReasonExclusiveModeOverride` are clues. Shared loopback cannot guarantee coverage of bypassed/protected paths; silence alone cannot identify cause. |
| Spatial audio | `ISpatialAudioClient` (`spatialaudioclient.h`) exposes capabilities/current-engine stream availability, not which foreign stream contributes post-spatial samples. Partial detection; stereo format does not prove spatial processing absent. |
| Variable lag/period/drift/drop | Query `GetDevicePeriod`, `IAudioClient3::GetCurrentSharedModeEnginePeriod`; periods are instantaneous, not inter-tap latency. Monitor `DATA_DISCONTINUITY`, `TIMESTAMP_ERROR`, packet counts and QPC slopes; revalidate, never hardcode 480. |
| Electron renders elsewhere | Enumerate sessions/PIDs across endpoints. Global INCLUDE also contains off-device audio: subtraction can **inject inverted audio absent from C**. Session mapping is not packet-level routing metadata. |

**D:** [`GetBuffer`][8] returns first-frame DevicePosition and QPC in **100-ns units**, not shared array indices. Preserve atomic per-packet timestamps plus local frame indices through rechunking. Current polled addon stats permit torn pairs and lack packet/sample association; process positions are zero in the artifact. QPC establishes a timebase, **not equal DSP phase/delay**. Runtime APIs cannot certify exact subtraction; gate it on residual validation and disable unsafe cancellation.

[1]: https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording
[2]: https://learn.microsoft.com/en-us/windows/win32/api/audioclient/ne-audioclient-audclnt_streamoptions
[3]: https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/ksproperty-audioloopback
[4]: https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/audio-processing-object-architecture
[5]: https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nn-audioclient-isimpleaudiovolume
[6]: https://learn.microsoft.com/en-us/windows/win32/api/endpointvolume/nn-endpointvolume-iaudioendpointvolume
[7]: https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback
[8]: https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudiocaptureclient-getbuffer
[9]: https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nn-audioclient-iaudioeffectsmanager
