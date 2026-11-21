// The 2020 algorithm, ported faithfully - including the reason it does not work.
//
// From SideChannelAttack.java:
//
//     modu = testCacheSize - 1;
//     startTime = System.nanoTime();
//     for (i = 0; i < steps; i++) { arr[(i * 64) & modu] &= 1; }
//     endTime = System.nanoTime();
//
// This page ships it as a selectable mode so the flat line it produces can be
// shown next to the pointer-chase curve. That contrast is the point: the
// original was not defeated by any security control, it was defeated by a
// performance optimisation.
//
// Three defects, all preserved here and all listed in BUGS.md:
//
//  #1  A 64-byte linear stride is the most predictable access pattern that
//      exists. The hardware prefetcher streams the next lines in before they
//      are asked for, so miss latency never appears in the measurement. The
//      result is roughly constant from 16 KB to 32 MB - it measures sequential
//      bandwidth, not cache capacity.
//
//  #2  `modu = testCacheSize - 1` is only a valid bitmask when testCacheSize is
//      a power of two. The original steps 1 MB, 2 MB, 3 MB, 4 MB... so at 3 MB
//      the mask is 0x2FFFFF, which selects a 2 MB working set, not 3 MB. Most
//      of the windows it tested were not the size it thought.
//
//  #3  `i * 64` overflows a Java int once i exceeds ~33.5 million. With the
//      README's recommended steps=512 (536,870,912 iterations) it overflows for
//      94% of the loop. JavaScript numbers are doubles and do not overflow
//      here, so this port is deliberately NOT bug-compatible on that point -
//      it cannot be, and the difference is noted rather than emulated.

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
