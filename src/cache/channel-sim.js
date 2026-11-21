// Deterministic simulator of the physical channel.
//
// This is what makes the demo reliable regardless of hardware. It takes an
// encoded chip sequence and renders the latency samples a receiver *would* see,
// using a model calibrated from live measurements on my machine
// (idle ~9 ns, occupied ~90 ns per access - see data/cache/channel-fixture.json).
// Noise, drift and timer coarsening are parameters, so the same code powers:
//
//   - the replay fallback (fixed seed, low noise -> always decodes cleanly),
//   - the defence "capacity dial" (crank noise/coarsening -> watch BER climb),
//   - the test suite (known message + known noise -> assert round-trip and BER).
//
// It is NOT a substitute for the live channel - it is the honest scaffold that
// guarantees the page demonstrates the concept end to end even if live decode
// never lands on a given machine.

// Latency model, in ns per access, from the measured hardware.
export const MODEL = {
  idleNs: 9,       // receiver probe when sender is idle (region resident)
  busyNs: 90,      // receiver probe when sender saturates the cache/bus
};

// Small deterministic PRNG (mulberry32) so every seeded run is identical.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller normal from a uniform generator.
function gaussian(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Render a chip sequence to per-chip latency samples.
//
// params:
//   seed          deterministic noise seed
//   noise         std-dev of per-sample Gaussian noise, as a fraction of the
//                 hi-lo gap (0 = perfect, ~0.5 = badly degraded)
//   coarsenNs     quantise each sample to this grid (models timer coarsening;
//                 0 = off, 100000 ns would be Chrome's non-isolated 100us... but
//                 note samples here are ns/access, so realistic values are small)
//   dropContrast  0..1, shrinks the hi-lo gap (models a weak/bursty sender or a
//                 too-short integration time). 0 = full gap, 1 = no signal.
export function renderTrace(chips, params = {}) {
  const { seed = 1, noise = 0.12, coarsenNs = 0, dropContrast = 0 } = params;
  const rnd = mulberry32(seed);

  const gap = (MODEL.busyNs - MODEL.idleNs) * (1 - dropContrast);
  const lo = MODEL.idleNs;
  const hi = MODEL.idleNs + gap;
  const sigma = noise * (MODEL.busyNs - MODEL.idleNs);

  return chips.map((c) => {
    const base = c === 1 ? hi : lo;
    let v = base + gaussian(rnd) * sigma;
    if (v < 0.5) v = 0.5;
    if (coarsenNs > 0) v = Math.round(v / coarsenNs) * coarsenNs;
    return v;
  });
}

// Effective channel capacity estimate (Shannon, binary symmetric channel) for a
// given bit-error rate and slot time. Used for the "channel capacity" readout.
//   C = R * (1 - H(p))   bits/sec, where H is binary entropy.
export function channelCapacity(ber, bitsPerSecond) {
  const p = Math.min(Math.max(ber, 1e-9), 1 - 1e-9);
  const H = -p * Math.log2(p) - (1 - p) * Math.log2(1 - p);
  return Math.max(0, bitsPerSecond * (1 - H));
}

// Binary entropy, exposed for the UI.
export function binaryEntropy(p) {
  if (p <= 0 || p >= 1) return 0;
  return -p * Math.log2(p) - (1 - p) * Math.log2(1 - p);
}
