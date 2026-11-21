import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildChain, measureWindow, windowSizes, allocate, LINE_BYTES, stepsFor, stepsForTarget, resolutionNs } from '../src/cache/chase.js';
import { isPowerOfTwo, effectiveWindow } from '../src/cache/linear.js';
import {
  stepRatios, dynamicRange, detectKnees, originalHeuristic, describe, formatBytes,
} from '../src/cache/detect.js';

const MB = 1024 * 1024;
const fixtures = JSON.parse(fs.readFileSync(new URL('../data/cache/fixtures.json', import.meta.url)));

// ------------------------------------------------------------- chain --------

test('buildChain lays out a single cycle covering every slot exactly once', () => {
  const windowBytes = 64 * LINE_BYTES;
  const buf = new Int32Array((windowBytes / 4) * 2);
  const n = buildChain(buf, windowBytes, 42);
  assert.equal(n, 64);

  const seen = new Set();
  let p = 0;
  for (let i = 0; i < n; i++) {
    assert.ok(!seen.has(p), 'cycle closed early - not a single Hamiltonian cycle');
    seen.add(p);
    p = buf[p];
  }
  assert.equal(seen.size, n, 'cycle did not visit every slot');
  assert.equal(p, 0, 'cycle did not return to its start');
});

test('buildChain is deterministic for a seed and varies across seeds', () => {
  const windowBytes = 32 * LINE_BYTES;
  const a = new Int32Array(windowBytes / 4);
  const b = new Int32Array(windowBytes / 4);
  const c = new Int32Array(windowBytes / 4);
  buildChain(a, windowBytes, 7);
  buildChain(b, windowBytes, 7);
  buildChain(c, windowBytes, 8);
  assert.deepEqual([...a], [...b]);
  assert.notDeepEqual([...a], [...c]);
});

test('buildChain rejects a window smaller than two cache lines', () => {
  const buf = new Int32Array(64);
  assert.throws(() => buildChain(buf, LINE_BYTES, 1), RangeError);
});

test('every chain hop lands on a cache-line boundary', () => {
  const windowBytes = 128 * LINE_BYTES;
  const buf = new Int32Array(windowBytes / 4);
  buildChain(buf, windowBytes, 3);
  let p = 0;
  for (let i = 0; i < 128; i++) {
    assert.equal(p % (LINE_BYTES / 4), 0, `hop ${i} was not line-aligned`);
    p = buf[p];
  }
});

test('windowSizes yields powers of two inclusive of both ends', () => {
  assert.deepEqual(windowSizes(1024, 8192), [1024, 2048, 4096, 8192]);
});

test('stepsFor backs off for large windows', () => {
  assert.ok(stepsFor(64 * MB) < stepsFor(1 * MB));
});

test('allocate returns a usable buffer and reports its size', () => {
  const { buf, bytes } = allocate(8 * MB);
  assert.ok(bytes <= 8 * MB);
  assert.equal(buf.length, bytes / 4);
});

// -------------------------------------------------- the original's masking --

test('isPowerOfTwo', () => {
  assert.equal(isPowerOfTwo(1 * MB), true);
  assert.equal(isPowerOfTwo(3 * MB), false);
});

test('a `size - 1` mask silently tests a smaller working set for non-power-of-two windows', () => {
  // Why the sweeps only use power-of-two windows: `size - 1` is only a valid
  // bitmask for powers of two.
  assert.equal(effectiveWindow(1 * MB), 1 * MB);
  assert.equal(effectiveWindow(2 * MB), 2 * MB);
  assert.equal(effectiveWindow(4 * MB), 4 * MB);

  // 3 MB - 1 == 0x2FFFFF, which can only produce 2 MB of distinct addresses.
  assert.equal(effectiveWindow(3 * MB), 2 * MB);
  // 5 MB, 6 MB, 7 MB are all wrong too.
  assert.equal(effectiveWindow(6 * MB), 4 * MB);
  assert.ok(effectiveWindow(7 * MB) < 7 * MB);
});

// ---------------------------------------------------------- detection -------

test('stepRatios compares each point with its predecessor', () => {
  const pts = [{ bytes: 1, ns: 1 }, { bytes: 2, ns: 2 }, { bytes: 4, ns: 8 }];
  assert.deepEqual(stepRatios(pts).map((s) => s.ratio), [2, 4]);
});

test('dynamicRange spans fastest to slowest', () => {
  assert.equal(dynamicRange([{ ns: 1 }, { ns: 4 }, { ns: 2 }]), 4);
});

test('detectKnees finds the boundaries in the captured pointer-chase run', () => {
  const { knees, range, confident } = detectKnees(fixtures.chase.points);
  assert.equal(confident, true);
  assert.ok(range > 50, `expected a wide range, got ${range}`);
  // The captured machine steps out of its first level around 128 KB and out of
  // the last level around 16 MB.
  const labels = knees.map((k) => k.label);
  assert.ok(labels.includes('~128 KB'), `expected a 128 KB boundary, got ${labels}`);
  assert.ok(labels.some((l) => l === '~16 MB' || l === '~32 MB'), `got ${labels}`);
});

test('detectKnees merges a gradual rolloff instead of reporting two boundaries', () => {
  // Reproduces the A18 Pro artefact: a latency curve with a real L1d edge at
  // 128 KB, then a gradual rolloff where the 8 MB step barely clears threshold
  // (1.47x) as a shoulder of the L2 rolloff + TLB exhaustion, followed by the
  // real L2 (16 MB) and SLC/DRAM (32 MB) edges. A per-step detector reports a
  // false 8 MB boundary; the merge must drop it while keeping 16 MB and 32 MB.
  const points = [
    { bytes: 32768, ns: 1.1 }, { bytes: 65536, ns: 1.05 }, { bytes: 131072, ns: 1.05 },
    { bytes: 262144, ns: 5.3 }, { bytes: 524288, ns: 5.45 }, { bytes: 1048576, ns: 5.15 },
    { bytes: 2097152, ns: 5.4 }, { bytes: 4194304, ns: 6.85 }, { bytes: 8388608, ns: 7.8 },
    { bytes: 16777216, ns: 11.5 }, { bytes: 33554432, ns: 28.3 }, { bytes: 67108864, ns: 82.7 },
  ];

  const { knees, rawKnees, merged } = detectKnees(points);
  const labels = knees.map((k) => k.label);
  const rawLabels = rawKnees.map((k) => k.label);

  // Corrected default: exactly the three real levels, no 8 MB.
  assert.deepEqual(labels, ['~128 KB', '~16 MB', '~32 MB'],
    `merged knees should be L1d/L2/SLC edges, got ${labels}`);
  assert.ok(!labels.includes('~8 MB'), 'the 8 MB false positive must not survive the merge');

  // Teaching point preserved: the raw list still shows what a naive detector saw.
  assert.deepEqual(rawLabels, ['~128 KB', '~8 MB', '~16 MB', '~32 MB'],
    `raw knees should still expose the false positive, got ${rawLabels}`);

  // And the merge is recorded as absorbing the 8 MB shoulder into the 16 MB edge.
  assert.equal(merged.length, 1);
  assert.equal(merged[0].absorbed, '~8 MB');
  assert.equal(merged[0].kept, '~16 MB');
});

test('describe() surfaces the merged false positive as a teaching note', () => {
  const points = [
    { bytes: 32768, ns: 1.1 }, { bytes: 65536, ns: 1.05 }, { bytes: 131072, ns: 1.05 },
    { bytes: 262144, ns: 5.3 }, { bytes: 524288, ns: 5.45 }, { bytes: 1048576, ns: 5.15 },
    { bytes: 2097152, ns: 5.4 }, { bytes: 4194304, ns: 6.85 }, { bytes: 8388608, ns: 7.8 },
    { bytes: 16777216, ns: 11.5 }, { bytes: 33554432, ns: 28.3 }, { bytes: 67108864, ns: 82.7 },
  ];
  const d = describe(points, 'chase');
  assert.match(d.headline, /128 KB.*16 MB.*32 MB/);
  assert.match(d.detail, /8 MB/); // the absorbed artefact is still mentioned
});

test('detectKnees refuses to invent a boundary in the flat linear run', () => {
  const { knees, confident, range } = detectKnees(fixtures.linear.points);
  assert.equal(confident, false, 'should not claim a boundary on a flat curve');
  assert.deepEqual(knees, []);
  assert.ok(range < 3, `flat curve should have a small range, got ${range}`);
});

test('the naive first-jump heuristic has no notion of a flat curve; detectKnees does', () => {
  // detectKnees refuses to answer on a flat curve. The naive heuristic has no
  // such guard - whether it fires depends only on noise in a given capture.
  const orig = originalHeuristic(fixtures.linear.points, 1.5);
  const better = detectKnees(fixtures.linear.points);
  assert.equal(better.confident, false);
  // Depending on the noise in a given capture it may or may not fire; what
  // matters is that it has no way of knowing the curve is flat.
  if (orig !== null) {
    assert.ok(orig.reportedBytes > 0);
  }
});

test('describe() calls the linear sweep out as undetectable', () => {
  const d = describe(fixtures.linear.points, 'linear');
  assert.equal(d.tone, 'err');
  assert.match(d.headline, /No cache boundary/i);
  assert.match(d.detail, /prefetcher/i);
});

test('describe() reports boundaries for the chase sweep', () => {
  const d = describe(fixtures.chase.points, 'chase');
  assert.equal(d.tone, 'ok');
  assert.match(d.headline, /boundar/i);
});

test('formatBytes renders KB and MB', () => {
  assert.equal(formatBytes(65536), '64 KB');
  assert.equal(formatBytes(4 * MB), '4 MB');
});

// --------------------------------------------------------- fixture shape ----

test('both fixtures are well formed and monotonic in window size', () => {
  for (const key of ['chase', 'linear']) {
    const f = fixtures[key];
    assert.ok(f.points.length >= 8, `${key}: too few points`);
    assert.ok(f.machine && f.captured, `${key}: missing provenance`);
    for (let i = 1; i < f.points.length; i++) {
      assert.ok(f.points[i].bytes === f.points[i - 1].bytes * 2, `${key}: windows must double`);
      assert.ok(f.points[i].ns > 0);
      assert.ok(f.points[i].min <= f.points[i].ns && f.points[i].ns <= f.points[i].max,
        `${key}: median outside [min,max] at ${f.points[i].bytes}`);
    }
  }
});

test('the captured chase run really does show a hierarchy and the linear one does not', () => {
  assert.ok(dynamicRange(fixtures.chase.points) > 50);
  assert.ok(dynamicRange(fixtures.linear.points) < 2);
});

// ------------------------------------------------- live measurement (node) --

// Node has an uncoarsened performance.now(), but the technique does not depend
// on that - it is the same code the browser runs. This asserts the measurement
// produces a real hierarchy rather than noise.
test('a live pointer-chase sweep resolves a cache hierarchy', { timeout: 60000 }, () => {
  const { buf } = allocate(64 * MB);
  const sizes = [32 * 1024, 256 * 1024, 4 * MB, 32 * MB];
  const points = sizes.map((bytes) => ({
    bytes,
    ns: measureWindow(buf, bytes, bytes >= 16 * MB ? 200_000 : 500_000, 1),
  }));

  const range = dynamicRange(points);
  assert.ok(range > 3, `expected a hierarchy, got only ${range.toFixed(2)}x spread`);
  assert.ok(
    points[points.length - 1].ns > points[0].ns,
    'the largest window should be slower than the smallest'
  );
});

// ---- clock-tick awareness (from a real Safari/Firefox-style run: 1 ms clock,
// fixed 4M steps, so every reading was a multiple of 0.25 ns) ----

const TICKY = [
  [16, .5], [32, .5], [64, .25], [128, .5], [256, .75], [512, .75], [1024, .75],
  [2048, .75], [4096, .75], [8192, .75], [16384, 1], [32768, 1.5], [65536, 2.5],
].map(([kb, ns]) => ({ bytes: kb * 1024, ns, resolutionNs: 0.25 }));

test('detector ignores jumps that are only a clock tick or two', () => {
  const labels = detectKnees(TICKY).knees.map((k) => k.label);
  assert.ok(!labels.includes('~64 KB'), `invented a 64 KB edge: ${labels}`);
  // without resolution info the old behaviour is unchanged
  const bare = TICKY.map(({ bytes, ns }) => ({ bytes, ns }));
  assert.ok(detectKnees(bare).knees.map((k) => k.label).includes('~64 KB'));
});

test('stepsForTarget grows a run until it spans the target on a coarse clock', () => {
  const trueNs = 0.6, quantumMs = 1;
  // simulated 1 ms clock: elapsed time is floored to whole ticks
  const measure = (steps) => (Math.floor((trueNs * steps) / 1e6 / quantumMs) * quantumMs * 1e6) / steps;
  const steps = stepsForTarget(measure, { startSteps: 100_000, targetMs: 50 });
  assert.ok((trueNs * steps) / 1e6 >= 50, `only ${(trueNs * steps) / 1e6} ms`);
  assert.ok(resolutionNs(quantumMs, steps) <= trueNs * 0.03);
});

test('a resolved Safari straight walk is described as bandwidth steps', () => {
  const KB = 1024, MiB = 1024 * 1024;
  const safari = [
    [32 * KB, .26], [64 * KB, .27], [128 * KB, .27], [256 * KB, .62], [512 * KB, .61], [MiB, .61],
    [2 * MiB, .61], [4 * MiB, .61], [8 * MiB, .62], [16 * MiB, .63], [32 * MiB, .90], [64 * MiB, 2.20],
  ].map(([bytes, ns]) => ({ bytes, ns, resolutionNs: 0.005 }));
  const d = describe(safari, 'linear');
  assert.match(d.headline, /bandwidth/i);
  assert.match(d.headline, /~128 KB/);
});

test('a step inside the run-to-run scatter is not a boundary', () => {
  // from a noisy efficiency-core Chrome run: 32→64 KB read 2.14→3.32 ns but
  // the repeats overlapped, and two reruns showed no step there
  const pts = [
    { bytes: 32 * 1024, ns: 2.14, min: 1.9, max: 3.5 },
    { bytes: 64 * 1024, ns: 3.32, min: 2.7, max: 3.6 },
    { bytes: 128 * 1024, ns: 3.36, min: 3.0, max: 3.7 },
    { bytes: 256 * 1024, ns: 9.0, min: 8.6, max: 9.4 },
    { bytes: 512 * 1024, ns: 9.1, min: 8.8, max: 9.5 },
  ];
  const labels = detectKnees(pts).knees.map((k) => k.label);
  assert.ok(!labels.includes('~32 KB'), labels.join());
  assert.ok(labels.includes('~128 KB'), labels.join());
});
