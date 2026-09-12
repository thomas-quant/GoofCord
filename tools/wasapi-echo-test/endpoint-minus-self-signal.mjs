// Deterministic, dependency-free broadband stereo signal generator.
//
// This module is the SINGLE source of truth for "own" and "other" test content. Its functions
// are plain ES2017 (no imports, no closures over Node/DOM globals), so `fn.toString()` produces
// a self-contained source string that is byte-identical whether it runs here in the Node
// orchestrator (to recompute a reference for scoring) or injected into an Electron renderer via
// executeJavaScript (to actually generate the WebAudio buffer that gets played). Keeping it to
// one implementation is what lets the harness compare "what we asked the page to play" against
// "what came back" without a second, driftable copy of the algorithm.
//
// A seeded PRNG feeds a short leaky integrator so the signal is broadband (correlated across
// neighbouring samples) rather than per-sample white noise, then it is scaled to a bounded moderate
// peak. Independent seeds for L and R make cross-channel leakage/swap detectable in the scorer.

export function mulberry32(seed) {
	let a = seed >>> 0;
	return function next() {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), a | 1);
		t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function generateBroadbandChannel(seed, frameCount, peakAmplitude) {
	const rand = mulberry32(seed);
	const out = new Float32Array(frameCount);
	const leak = 0.86;
	let state = 0;
	let peak = 0;
	for (let i = 0; i < frameCount; i++) {
		const white = rand() * 2 - 1;
		state = state * leak + white * (1 - leak);
		out[i] = state;
		const a = state < 0 ? -state : state;
		if (a > peak) peak = a;
	}
	const scale = peak > 0 ? peakAmplitude / peak : 0;
	for (let i = 0; i < frameCount; i++) out[i] *= scale;
	return out;
}

export function generateBroadbandStereo(seedL, seedR, frameCount, peakAmplitude) {
	return {
		left: generateBroadbandChannel(seedL, frameCount, peakAmplitude),
		right: generateBroadbandChannel(seedR, frameCount, peakAmplitude),
	};
}

// The literal source injected into a renderer via executeJavaScript. Kept as one string so both
// runtimes execute the exact same function bodies (see the module comment above). Each of these
// is a plain named function declaration, so `.toString()` already reproduces valid, standalone
// source with no captured closure state.
export const SIGNAL_SOURCE = [mulberry32, generateBroadbandChannel, generateBroadbandStereo].map((fn) => fn.toString()).join("\n\n");
