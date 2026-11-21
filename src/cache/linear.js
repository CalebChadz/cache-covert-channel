// The naive measurement: a linear 64-byte stride - the obvious first attempt,
// and the one this project started from. Kept as a selectable mode so its flat
// line can be shown next to the pointer-chase curve.
//
//     mask = windowBytes - 1;
//     for (i = 0; i < steps; i++) bytes[(i * 64) & mask] &= 1;
//
// Why it fails to show the hierarchy: a fixed-stride walk is the easiest
// pattern there is for the hardware prefetcher, AND every iteration is
// independent of the last, so an out-of-order core can keep many misses in
// flight at once (memory-level parallelism). Both hide miss latency. This
// experiment does not separate the two effects - see the article.
//
// Also note `windowBytes - 1` is only a valid mask for power-of-two windows
// (3 MB - 1 = 0x2FFFFF selects only 2 MB of addresses). effectiveWindow() makes
// that measurable; the page only ever sweeps powers of two.

export function isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

// The number of distinct addresses `x & mask` can actually produce. For a
// power-of-two window this equals the window; otherwise it is smaller, which
// is defect #2 made measurable.
export function effectiveWindow(windowBytes) {
  const mask = windowBytes - 1;
  let bits = 0;
  for (let b = 0; b < 32; b++) if (mask & (1 << b)) bits++;
  return 2 ** bits;
}

// Faithful linear-stride pass. Returns nanoseconds per access.
export function measureLinear(bytes, windowBytes, steps) {
  const modu = windowBytes - 1;

  // Warm, matching the chase path so the comparison is fair.
  for (let i = 0; i < 100000; i++) bytes[(i * 64) & modu] &= 1;

  const t0 = performance.now();
  for (let i = 0; i < steps; i++) {
    bytes[(i * 64) & modu] &= 1;
  }
  const t1 = performance.now();

  return ((t1 - t0) * 1e6) / steps;
}

export function* sweepLinear({ bytes, sizes, repeats = 3, steps = 4_000_000 }) {
  const results = [];
  for (const windowBytes of sizes) {
    const runs = [];
    for (let r = 0; r < repeats; r++) {
      runs.push(measureLinear(bytes, windowBytes, steps));
      yield { phase: 'progress', bytes: windowBytes, run: r + 1, of: repeats };
    }
    runs.sort((a, b) => a - b);
    const point = {
      bytes: windowBytes,
      ns: runs[(runs.length - 1) >> 1],
      min: runs[0],
      max: runs[runs.length - 1],
      effective: effectiveWindow(windowBytes),
    };
    results.push(point);
    yield { phase: 'window', point, results: results.slice() };
  }
  return results;
}
