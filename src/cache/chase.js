// Pointer-chase memory latency measurement.
//
// The naive version walks memory with a linear 64-byte stride (see linear.js),
// whose loads are both predictable (prefetchable) and independent of each other
// (overlappable), so miss latency is hidden and the curve comes out flat.
//
// The fix is a dependent load chain. Lay out the working set as a single random
// cycle through cache-line-sized slots, where the value stored at each slot is
// the index of the next slot. The address of load N+1 is not known until load N
// has returned, so the prefetcher has nothing to run ahead on and every access
// pays the true latency of whichever level of cache currently holds it.
//
// TIMER NOTE: this does not need a high-resolution clock and does not use
// SharedArrayBuffer. Each measurement times a loop of hundreds of thousands of
// dependent loads, so the whole timed region lasts milliseconds. Chrome's
// non-isolated performance.now() is quantised to 100us and Firefox/Safari to
// 1ms; against a multi-millisecond region that is a rounding error. Timer
// coarsening defends against resolving a *single* access, which this technique
// never attempts.

export const LINE_BYTES = 64;
const STRIDE = LINE_BYTES / 4; // Int32Array elements per cache line

// Deterministic PRNG so a given seed lays out the same cycle every time.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x80000000;
  };
}

// Lay out a single Hamiltonian cycle over `windowBytes` worth of cache lines.
export function buildChain(buf, windowBytes, seed = 12345) {
  const n = Math.floor(windowBytes / LINE_BYTES);
  if (n < 2) throw new RangeError('window must span at least two cache lines');

  const perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;

  const rnd = lcg(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }

  // perm[0] -> perm[1] -> ... -> perm[n-1] -> perm[0]
  for (let i = 0; i < n; i++) {
    buf[perm[i] * STRIDE] = perm[(i + 1) % n] * STRIDE;
  }
  return n;
}

// Time `steps` dependent loads around the cycle. Returns nanoseconds per access.
export function measureWindow(buf, windowBytes, steps, seed) {
  buildChain(buf, windowBytes, seed);

  // Warm the chain and let the JIT settle before the timed region. Without
  // this the first few window sizes read several times too high and the low
  // end of the curve is meaningless.
  let p = 0;
  for (let i = 0; i < 50000; i++) p = buf[p];

  const t0 = performance.now();
  for (let i = 0; i < steps; i++) p = buf[p];
  const t1 = performance.now();

  // Consume `p` so the loop cannot be optimised away as dead code. The
  // condition is never true - buf holds only non-negative indices.
  if (p === -1) throw new Error('unreachable');

  return ((t1 - t0) * 1e6) / steps;
}

// How many hops to time for a given window. Big windows are slow per access,
// so fewer steps keeps each measurement inside one animation frame.
export function stepsFor(windowBytes) {
  const MB = 1024 * 1024;
  if (windowBytes >= 32 * MB) return 200_000;
  if (windowBytes >= 8 * MB) return 400_000;
  return 1_000_000;
}

// Powers of two from `minBytes` to `maxBytes` inclusive.
export function windowSizes(minBytes, maxBytes) {
  const out = [];
  for (let s = minBytes; s <= maxBytes; s *= 2) out.push(s);
  return out;
}

// Allocate the largest backing buffer we can, up to `maxBytes`, halving on
// failure. Returns { buf, bytes } or throws if even the floor fails.
export function allocate(maxBytes, floorBytes = 4 * 1024 * 1024) {
  let bytes = maxBytes;
  for (;;) {
    try {
      const buf = new Int32Array(bytes / 4);
      // Touch every page so the allocation is really backed, not just reserved.
      for (let i = 0; i < buf.length; i += 1024) buf[i] = 0;
      return { buf, bytes };
    } catch (e) {
      if (bytes <= floorBytes) throw new Error(`could not allocate ${floorBytes / 1048576} MB`);
      bytes = Math.floor(bytes / 2);
    }
  }
}

// Run the sweep as a generator, yielding after every window so the caller can
// paint between measurements and keep the page responsive.
export function* sweep({ buf, sizes, repeats = 3, seed = 12345, warmup = true }) {
  if (warmup) {
    // Global JIT warmup before any measurement is recorded.
    const w = Math.min(1024 * 1024, sizes[sizes.length - 1]);
    for (let i = 0; i < 4; i++) measureWindow(buf, w, 300_000, seed);
    yield { phase: 'warmup' };
  }

  const results = [];
  for (const bytes of sizes) {
    const runs = [];
    for (let r = 0; r < repeats; r++) {
      runs.push(measureWindow(buf, bytes, stepsFor(bytes), seed + r));
      yield { phase: 'progress', bytes, run: r + 1, of: repeats };
    }
    runs.sort((a, b) => a - b);
    const median = runs[(runs.length - 1) >> 1];
    const point = { bytes, ns: median, min: runs[0], max: runs[runs.length - 1] };
    results.push(point);
    yield { phase: 'window', point, results: results.slice() };
  }
  return results;
}
