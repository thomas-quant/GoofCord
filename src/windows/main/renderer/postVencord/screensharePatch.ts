export function patchScreenshare() {
	const original = navigator.mediaDevices.getDisplayMedia;

	async function getVirtmic() {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			let audioDevice;
			// @ts-expect-error
			if (GoofCord.stopVenmic) {
				audioDevice = devices.find(({ label }) => label === "vencord-screen-share");
			} else {
				audioDevice = devices.find(({ label, kind }) => {
					return kind === "audioinput" && label.includes("GoofCord-Virtual-Mic");
				});
			}
			return audioDevice?.deviceId;
		} catch (error) {
			return null;
		}
	}

	navigator.mediaDevices.getDisplayMedia = async function (opts) {
		let stream: MediaStream;
		try {
			stream = await original.call(this, opts);
		} catch {
			// Backing out of GoofCord's source picker makes Electron reject getDisplayMedia with a
			// generic error that Discord doesn't recognize as a cancellation, surfacing it as an
			// uncaught error. Re-throw "NotAllowedError" — the standard name the web client treats as a
			// user-cancelled capture — so the error is swallowed and the go-live control re-arms for a retry.
			throw new DOMException("Permission denied by system", "NotAllowedError");
		}
		console.log("Setting stream's content hint and audio device");

		// THROWAWAY — Phase 4 transport spike (GOOFCORD_TRANSPORT_SPIKE); strip before upstream PR.
		// The audio swap seam runs FIRST — BEFORE the `if (!settings) return stream;` early-return
		// below. The reconstructed transport track is independent of window.screenshareSettings
		// (those are VIDEO constraints), so a missing/late settings object must not strand us on the
		// raw loopback track (that was the echo: the wrapper returned at the settings guard before it
		// ever reached the swap). Gated on the feeder-installed flag, so with the spike OFF this whole
		// block is inert and the page stays byte-identical to upstream.
		const transportSpikeActive = !!(globalThis as Record<string, unknown>).__goofcordWasapiTransportInstalled;
		const wasapiFeeder = (globalThis as { __goofcordWasapiFeeder?: { track: MediaStreamTrack } }).__goofcordWasapiFeeder;
		if (transportSpikeActive) {
			void GoofCord.appendScreenshareDebug(`getDisplayMedia wrapper entered: settings=${window.screenshareSettings ? "present" : "MISSING"} wasapiFeeder=${wasapiFeeder?.track ? "track-present" : "absent"} audioTracks=${stream.getAudioTracks().length}`);
			if (wasapiFeeder?.track) {
				for (const t of stream.getAudioTracks()) {
					t.stop();
					stream.removeTrack(t);
				}
				stream.addTrack(wasapiFeeder.track);
				void GoofCord.appendScreenshareDebug("wasapi swap-seam injected reconstructed audio track");
			} else {
				void GoofCord.appendScreenshareDebug("wasapi swap-seam SKIPPED — feeder track absent (would fall through to loopback → echo)");
			}
		}

		const settings = window.screenshareSettings;
		if (!settings) return stream;
		settings.width = Math.round(settings.resolution * (screen.width / screen.height));

		const videoTrack = stream.getVideoTracks()[0];
		videoTrack.contentHint = settings.contentHint || "motion";

		const constraints = {
			...videoTrack.getConstraints(),
			frameRate: { min: settings.framerate, ideal: settings.framerate },
			width: { min: 640, ideal: settings.width, max: settings.width },
			height: { min: 480, ideal: settings.resolution, max: settings.resolution },
			advanced: [{ width: settings.width, height: settings.resolution }],
			resizeMode: "none",
		};

		videoTrack
			.applyConstraints(constraints)
			.then(() => {
				console.log("Applied constraints successfully. New constraints: ", videoTrack.getConstraints());
			})
			.catch((e) => console.error("Failed to apply constraints.", e));

		// Default audio sharing
		const audioTrack = stream.getAudioTracks()[0];
		if (audioTrack) audioTrack.contentHint = "music";

		// Patchcord — skipped when the transport spike already swapped in its reconstructed track.
		if (!(transportSpikeActive && wasapiFeeder?.track)) {
			const id = await getVirtmic();
			if (id) {
				const audio = await navigator.mediaDevices.getUserMedia({
					audio: {
						deviceId: {
							exact: id,
						},
						autoGainControl: false,
						echoCancellation: false,
						noiseSuppression: false,
						channelCount: 2,
						sampleRate: 48000,
						sampleSize: 16,
					},
				});

				for (const t of stream.getAudioTracks()) {
					t.stop();
					stream.removeTrack(t);
				}

				stream.addTrack(audio.getAudioTracks()[0]);
			}
		}

		return stream;
	};

	Common.FluxDispatcher.subscribe("STREAM_CLOSE", ({ streamKey }: { streamKey: string }) => {
		const owner = streamKey.split(":").at(-1);

		if (owner !== Common.UserStore.getCurrentUser().id) {
			return;
		}

		// THROWAWAY — Phase 4 transport spike (GOOFCORD_TRANSPORT_SPIKE); strip before upstream PR.
		// Tear down the main-world transport feeder (clear drain loop, release writer, close port,
		// call GoofCord.stopWasapiLoopback) on stream close.
		const wasapiFeeder = (globalThis as { __goofcordWasapiFeeder?: { teardown: () => void } }).__goofcordWasapiFeeder;
		if (wasapiFeeder) {
			wasapiFeeder.teardown();
			(globalThis as { __goofcordWasapiFeeder?: unknown }).__goofcordWasapiFeeder = undefined;
		}

		// @ts-expect-error
		if (GoofCord.stopVenmic) {
			// @ts-expect-error
			void GoofCord.stopVenmic();
		} else {
			void GoofCord.stopPatchcord();
		}
	});
}
