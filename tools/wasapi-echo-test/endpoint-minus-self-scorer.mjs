// Pure, offline DSP scoring for the endpoint-minus-self integration harness. No Electron, no
// addon, no I/O — everything here takes plain Float32Arrays and returns a verdict object, so it
// is unit-testable in isolation (see endpoint-minus-self-scorer.test.mjs) and reusable by the
// harness to score real captures.
//
// IMPORTANT SCOPE NOTE: any alignment/gain done in here (crossCorrelateLag, the scalar fit inside
// scorePreservation) is offline, diagnostic, and read-only. It exists to report what happened; it
// never rewrites, shifts, or re-subtracts the captured samples before the pass/fail gates below
// are evaluated. Native subtraction is scored as it came out of the addon, not as this file wishes
// it had come out.

const EPSILON = 1e-12;

export function rms(buf) {
	if (buf.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
	return Math.sqrt(sum / buf.length);
}

export function dbfs(value, reference = 1) {
	const ratio = Math.abs(value) / Math.max(Math.abs(reference), EPSILON);
	return 20 * Math.log10(Math.max(ratio, EPSILON));
}

/**
 * Normalized cross-correlation between `a` and `b`, searched over integer lags in
 * [-maxLagFrames, +maxLagFrames]. A positive lag means `b` is delayed relative to `a` (b[i] lines
 * up with a[i - lag]). Returns the best lag and its normalized correlation coefficient in [-1, 1].
 * This is the one offline alignment primitive in the module; every caller uses its result only to
 * report or gate a score, never to resynthesize a "corrected" signal.
 */
export function crossCorrelateLag(a, b, maxLagFrames) {
	let best = { lagFrames: 0, normCorr: 0 };
	for (let lag = -maxLagFrames; lag <= maxLagFrames; lag++) {
		// b[i] is compared against a[i - lag]: a positive lag means b lines up with an EARLIER
		// sample of a, i.e. b is delayed relative to a by `lag` frames.
		const start = Math.max(0, lag);
		const end = Math.min(a.length + lag, b.length);
		if (end - start < 2) continue;
		let dot = 0;
		let na = 0;
		let nb = 0;
		for (let i = start; i < end; i++) {
			const av = a[i - lag];
			const bv = b[i];
			dot += av * bv;
			na += av * av;
			nb += bv * bv;
		}
		const denom = Math.sqrt(na * nb);
		const normCorr = denom > EPSILON ? dot / denom : 0;
		if (Math.abs(normCorr) > Math.abs(best.normCorr)) best = { lagFrames: lag, normCorr };
	}
	return best;
}

/**
 * "Exact cancellation": when the own reference is the ONLY signal expected in `captured` (no
 * other-app content sharing the window), the residual energy relative to the reference's own RMS
 * must sit below a fixed dB gate. This is a deterministic energy check, not a statistical test —
 * there is one number and one gate.
 */
export function scoreExactCancellation({ captured, ownReference, maxResidualDb = -45 }) {
	const refRms = rms(ownReference);
	const capRms = rms(captured);
	const residualDb = refRms > EPSILON ? dbfs(capRms, refRms) : dbfs(capRms, 1);
	return {
		pass: residualDb <= maxResidualDb,
		residualDb,
		maxResidualDb,
		capturedRms: capRms,
		referenceRms: refRms,
	};
}

/**
 * "No leakage": during the mixed (self + other) hold-out window, the captured output must not
 * correlate with the disjoint own-audio reference that was never used for any native alignment.
 * Correlation (not raw energy) is the right statistic here because other real content can dominate
 * the energy budget while a linear leak of the own signal would still show up as a correlation
 * peak against it.
 */
export function scoreLeakage({ capturedHoldout, ownHoldoutReference, maxLagFrames = 64, maxAbsNormCorr = 0.08 }) {
	const { lagFrames, normCorr } = crossCorrelateLag(ownHoldoutReference, capturedHoldout, maxLagFrames);
	return {
		pass: Math.abs(normCorr) <= maxAbsNormCorr,
		lagFrames,
		normCorr,
		maxAbsNormCorr,
	};
}

/**
 * Guards against the trivial "cancel everything, including other apps" false pass: across the
 * full claimed-active window, captured output must exceed a floor RMS. A session that is silent
 * throughout is reported as a failure here, never as a clean cancellation.
 */
export function scoreMissingOutput({ captured, minRmsDbfs = -70 }) {
	const capRms = rms(captured);
	const levelDb = dbfs(capRms, 1);
	return {
		pass: levelDb > minRmsDbfs,
		levelDb,
		minRmsDbfs,
		capturedRms: capRms,
	};
}

/**
 * "Other audio preserved": the known, independently generated other-process signal must survive
 * subtraction with recognizable correlation and a plausible linear gain. The gain reported here is
 * a read-only diagnostic of how faithfully the render/capture path carried the other signal
 * through — it is never fed back to alter what the addon produced, and the pass gate is on
 * correlation/gain bounds, not on fitting a gain that makes the numbers agree.
 */
export function scorePreservation({ captured, otherReference, maxLagFrames = 64, minNormCorr = 0.5, minGain = 0.4, maxGain = 2.5 }) {
	const { lagFrames, normCorr } = crossCorrelateLag(otherReference, captured, maxLagFrames);
	const start = Math.max(0, lagFrames);
	// Same captured-index overlap as crossCorrelateLag: reference[i - lag] vs captured[i].
	const end = Math.min(otherReference.length + lagFrames, captured.length);
	let dot = 0;
	let refEnergy = 0;
	for (let i = start; i < end; i++) {
		const r = otherReference[i - lagFrames];
		dot += r * captured[i];
		refEnergy += r * r;
	}
	const gain = refEnergy > EPSILON ? dot / refEnergy : 0;
	const corrOk = Math.abs(normCorr) >= minNormCorr;
	const gainOk = gain >= minGain && gain <= maxGain;
	return {
		pass: corrOk && gainOk,
		lagFrames,
		normCorr,
		gain,
		minNormCorr,
		minGain,
		maxGain,
	};
}

/**
 * Channel-swap detector: computes correlation of each own-reference channel against BOTH captured
 * channels. A correct (non-swapped) leakage-free result has all four terms near zero; a swapped
 * wiring bug shows up as a cross term (e.g. refL vs capturedR) exceeding the same leakage gate
 * used elsewhere, even when the direct term looks fine.
 */
export function scoreCrossWiring({ capturedL, capturedR, refL, refR, maxLagFrames = 64, maxAbsNormCorr = 0.08 }) {
	const terms = {
		refL_capL: crossCorrelateLag(refL, capturedL, maxLagFrames).normCorr,
		refL_capR: crossCorrelateLag(refL, capturedR, maxLagFrames).normCorr,
		refR_capL: crossCorrelateLag(refR, capturedL, maxLagFrames).normCorr,
		refR_capR: crossCorrelateLag(refR, capturedR, maxLagFrames).normCorr,
	};
	const worst = Object.entries(terms).reduce((acc, [name, value]) => (Math.abs(value) > Math.abs(acc.value) ? { name, value } : acc), { name: "", value: 0 });
	return {
		pass: Math.abs(worst.value) <= maxAbsNormCorr,
		terms,
		worst,
		maxAbsNormCorr,
	};
}

/**
 * The addon's self-reported offsetFrames should hold roughly steady while it stays in one
 * "running" generation — large unexplained jumps mean the alignment is not actually holding, which
 * is exactly the drift concern this harness exists to catch. This checks only within-generation
 * jitter; a generation change is expected to reset the offset and is excluded by the caller
 * filtering samples to one generation before calling this.
 */
export function scoreOffsetStability({ offsetFramesSamples, maxJitterFrames = 8 }) {
	if (offsetFramesSamples.length === 0) {
		return { pass: false, reason: "no offset samples collected", maxJitterFrames };
	}
	const min = Math.min(...offsetFramesSamples);
	const max = Math.max(...offsetFramesSamples);
	const jitter = max - min;
	return {
		pass: jitter <= maxJitterFrames,
		jitter,
		min,
		max,
		maxJitterFrames,
		sampleCount: offsetFramesSamples.length,
	};
}
