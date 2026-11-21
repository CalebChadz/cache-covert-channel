import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bytesToBits, bitsToBytes, textToBytes, bytesToText,
  manchesterEncode, manchesterDecode,
  fecEncode, fecDecode, checksum,
  encodeFrame, decodeSamples, calibrate, bitErrorRate,
  CHIPS_FOR_1, CHIPS_FOR_0, SFD_BYTE, PREAMBLE_PAIRS,
} from '../src/cache/manchester.js';
import { renderTrace, channelCapacity, binaryEntropy, MODEL } from '../src/cache/channel-sim.js';

// ------------------------------------------------------- bit/byte plumbing --

test('bytes <-> bits round-trips MSB first', () => {
  const bytes = [0b10110001, 0x00, 0xff, 0x61];
  assert.deepEqual(bitsToBytes(bytesToBits(bytes)), bytes);
  assert.deepEqual(bytesToBits([0x80]), [1, 0, 0, 0, 0, 0, 0, 0]);
});

test('text <-> bytes round-trips ASCII', () => {
  assert.equal(bytesToText(textToBytes('cache')), 'cache');
  assert.deepEqual(textToBytes('A'), [65]);
});

// ------------------------------------------------------------- Manchester ---

test('Manchester encodes each bit as a transition pair', () => {
  assert.deepEqual(manchesterEncode([1]), CHIPS_FOR_1);
  assert.deepEqual(manchesterEncode([0]), CHIPS_FOR_0);
  assert.deepEqual(manchesterEncode([1, 0]), [1, 0, 0, 1]);
});

test('Manchester decode inverts encode', () => {
  const bits = [1, 0, 1, 1, 0, 0, 1, 0];
  const { bits: out, violations } = manchesterDecode(manchesterEncode(bits));
  assert.deepEqual(out, bits);
  assert.equal(violations.length, 0);
});

test('Manchester decode flags violations', () => {
  // [1,1] and [0,0] are illegal pairs.
  const { violations } = manchesterDecode([1, 0, 1, 1, 0, 1]);
  assert.deepEqual(violations, [1]); // second pair [1,1] is the violation
});

// -------------------------------------------------------------------- FEC ---

test('repetition-3 FEC round-trips and corrects a single flip', () => {
  const bits = [1, 0, 1, 1, 0];
  const enc = fecEncode(bits);
  assert.equal(enc.length, bits.length * 3);
  // flip one chip in the first triple
  enc[1] ^= 1;
  const { bits: dec, corrected } = fecDecode(enc);
  assert.deepEqual(dec, bits);
  assert.ok(corrected >= 1);
});

test('FEC cannot fix two flips in one triple (documented limit)', () => {
  const enc = fecEncode([1]); // [1,1,1]
  enc[0] ^= 1; enc[1] ^= 1;   // [0,0,1] -> majority 0
  const { bits } = fecDecode(enc);
  assert.deepEqual(bits, [0]); // wrong, as expected
});

// -------------------------------------------------------------- checksum ---

test('checksum is sum mod 256', () => {
  assert.equal(checksum([1, 2, 3]), 6);
  assert.equal(checksum([200, 100]), 44); // 300 & 0xff
});

// ------------------------------------------------------------- calibration --

test('calibrate finds the midpoint of an alternating preamble', () => {
  // preamble chips are 1,0,1,0,... so even indices are "high", odd are "low"
  const pre = [90, 9, 88, 10, 92, 8];
  const cal = calibrate(pre);
  assert.ok(cal.high > 80 && cal.high < 95);
  assert.ok(cal.low > 5 && cal.low < 15);
  assert.ok(cal.threshold > cal.low && cal.threshold < cal.high);
  assert.ok(cal.separation > 5);
});

test('calibrate reports no separation on a flat preamble', () => {
  const cal = calibrate([10, 10, 10, 10]);
  assert.ok(cal.separation < 1.2);
});

// -------------------------------------------------- end-to-end, clean -------

test('a clean trace round-trips the message exactly', () => {
  const msg = 'ca';
  const { chips } = encodeFrame(msg);
  const samples = renderTrace(chips, { seed: 1, noise: 0.08 });
  const dec = decodeSamples(samples, { preambleChips: PREAMBLE_PAIRS * 2 });
  assert.equal(dec.ok, true);
  assert.equal(dec.sfdOk, true);
  assert.equal(dec.text, msg);
  assert.equal(dec.checksumOk, true);
});

test('the replay message decodes cleanly across many seeds', () => {
  const msg = 'covert';
  const { chips } = encodeFrame(msg);
  for (let seed = 1; seed <= 40; seed++) {
    const samples = renderTrace(chips, { seed, noise: 0.1 });
    const dec = decodeSamples(samples, { preambleChips: PREAMBLE_PAIRS * 2 });
    assert.equal(dec.text, msg, `seed ${seed} decoded "${dec.text}"`);
    assert.equal(dec.checksumOk, true, `seed ${seed} checksum`);
  }
});

test('SFD is recovered, proving frame alignment', () => {
  const { chips } = encodeFrame('hi');
  const dec = decodeSamples(renderTrace(chips, { seed: 3, noise: 0.08 }));
  assert.equal(dec.sfdOk, true);
  assert.notEqual(SFD_BYTE, undefined);
});

// -------------------------------------------------- degradation behaviour ---

test('rising noise degrades the channel monotonically-ish', () => {
  const msg = 'test';
  const { chips } = encodeFrame(msg);
  // average BER over seeds at each noise level
  const berAt = (noise) => {
    let tot = 0; const N = 30;
    for (let seed = 1; seed <= N; seed++) {
      const dec = decodeSamples(renderTrace(chips, { seed, noise }));
      tot += bitErrorRate(msg, dec.text || '');
    }
    return tot / N;
  };
  const low = berAt(0.1);
  const high = berAt(0.6);
  assert.ok(low < 0.05, `clean channel should be near-zero BER, got ${low}`);
  assert.ok(high > low, `more noise should not decode better (${high} vs ${low})`);
});

test('dropping contrast to zero destroys the channel', () => {
  const { chips } = encodeFrame('data');
  const dec = decodeSamples(renderTrace(chips, { seed: 1, noise: 0.1, dropContrast: 1 }));
  // With no hi/lo gap the preamble shows no separation -> honest failure.
  assert.ok(!dec.ok || dec.text !== 'data');
});

test('a dead channel has ~zero capacity when estimated from raw bit errors', () => {
  // Regression: capacity used to be computed from the DECODED message's BER, so
  // a failed decode (100% "error") reported full capacity, since 1 - H(1) = 1.
  // The page now uses the raw pre-FEC bit error probability over the frame.
  const { chips } = encodeFrame('cache');
  const samples = renderTrace(chips, { seed: 3, noise: 0.3, dropContrast: 1 });
  const pre = PREAMBLE_PAIRS * 2;
  const th = calibrate(samples.slice(0, pre)).threshold;
  const got = manchesterDecode(samples.slice(pre).map((v) => (v > th ? 1 : 0))).bits;
  const want = manchesterDecode(chips.slice(pre)).bits;
  let e = 0;
  for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) e++;
  const p = e / want.length;
  assert.ok(p > 0.3 && p < 0.7, `no-signal channel should be near a coin flip, got ${p}`);
  assert.ok(channelCapacity(p, 12.5) < 1.5, 'capacity of a no-signal channel must be near zero');
});

test('FEC recovers a message that raw decoding gets wrong', () => {
  const msg = 'Hi';
  // A noise level where raw fails often but FEC (3x redundancy) holds.
  const noise = 0.34;
  let rawWins = 0, fecWins = 0;
  const N = 40;
  for (let seed = 1; seed <= N; seed++) {
    const raw = decodeSamples(renderTrace(encodeFrame(msg, { fec: false }).chips, { seed, noise }));
    const fec = decodeSamples(renderTrace(encodeFrame(msg, { fec: true }).chips, { seed, noise }), { fec: true });
    if (raw.text === msg) rawWins++;
    if (fec.text === msg) fecWins++;
  }
  assert.ok(fecWins >= rawWins, `FEC (${fecWins}) should do at least as well as raw (${rawWins})`);
});

// ----------------------------------------------------- capacity readouts ----

test('binary entropy is 0 at the ends and 1 at p=0.5', () => {
  assert.equal(binaryEntropy(0), 0);
  assert.equal(binaryEntropy(1), 0);
  assert.ok(Math.abs(binaryEntropy(0.5) - 1) < 1e-9);
});

test('channel capacity is the rate when perfect and zero at BER 0.5', () => {
  assert.ok(Math.abs(channelCapacity(0, 50) - 50) < 1e-3);
  assert.ok(channelCapacity(0.5, 50) < 1e-6);
  assert.ok(channelCapacity(0.1, 50) < 50 && channelCapacity(0.1, 50) > 20);
});

test('the model matches the measured hardware figures', () => {
  // Guards against someone "tidying" the model away from what was measured.
  assert.equal(MODEL.idleNs, 9);
  assert.equal(MODEL.busyNs, 90);
});

test('message length is capped at one byte of length field', () => {
  const long = 'x'.repeat(256);
  assert.throws(() => encodeFrame(long), RangeError);
});

// ------------------------------------------------- adaptive live channel --

import { planFromCalibration, preflightSeparation } from '../src/cache/channel.js';
import { readFileSync } from 'node:fs';

test('differential decisions survive a level drift that breaks a fixed threshold', () => {
  // Calibrate on a clean preamble, then let both levels climb 6x mid-frame
  // (e.g. the OS moved the thread to slower cores): "idle" chips end up above
  // the preamble threshold. Comparing each chip pair still decodes.
  const msg = 'drift';
  const { chips, preambleChips } = encodeFrame(msg);
  const samples = chips.map((c, i) => {
    const scale = i < preambleChips + 40 ? 1 : 6; // idle 54 ns > threshold 49.5
    return (c ? 90 : 9) * scale;
  });
  const fixed = decodeSamples(samples, { preambleChips, differential: false });
  const diff = decodeSamples(samples, { preambleChips });
  assert.notEqual(fixed.ok && fixed.text, msg, 'fixed threshold should fail under drift');
  assert.equal(diff.text, msg);
  assert.equal(diff.checksumOk, true);
});

const MB_ = 1024 * 1024;
const shipped = JSON.parse(readFileSync(new URL('../data/cache/fixtures.json', import.meta.url)));

test('plan: performance-core sweep proposes probes inside the outer cache levels', () => {
  const plan = planFromCalibration(shipped.chase.points);
  assert.equal(plan.fallback, false);
  assert.ok(plan.probes.length >= 1 && plan.probes.length <= 4);
  for (const p of plan.probes) assert.ok(p >= 512 * 1024 && p <= 48 * MB_);
  // The L1 edge (~128 KB) is never a candidate: L1 is private, not shared.
  assert.ok(plan.edges.every((c) => c >= 512 * 1024));
  assert.ok(plan.senderBufMB >= 24 && plan.senderBufMB <= 96);
});

test('plan: an efficiency-core-like curve (4 MB L2) yields a probe that fits in 4 MB', () => {
  const pts = [];
  for (let k = 0; k <= 16; k++) {
    const bytes = 256 * 1024 * Math.pow(2, k / 2);
    const ns = bytes <= 3.5 * MB_ ? 15 : bytes <= 64 * MB_ ? 150 : 200;
    pts.push({ bytes: Math.round(bytes), ns });
  }
  const plan = planFromCalibration(pts);
  assert.ok(plan.probes.some((p) => p <= 4 * MB_ && p >= 1 * MB_), `got ${plan.probes}`);
});

test('plan: a flat sweep falls back to common shared-level sizes', () => {
  const pts = [256, 512, 1024, 2048, 4096, 8192].map((k) => ({ bytes: k * 1024, ns: 5 }));
  const plan = planFromCalibration(pts);
  assert.equal(plan.fallback, true);
  assert.deepEqual(plan.probes, [3 * MB_, 8 * MB_]);
});

test('preflight separation is high/low and ignores missing samples', () => {
  assert.equal(preflightSeparation([90, 9, 90, 9]).separation, 10);
  assert.equal(preflightSeparation([90, 9, NaN, 9]).separation, 10);
  assert.ok(preflightSeparation([20, 20, 20, 20]).separation === 1);
});

test('plan: zero-ns readings (clock never ticked) are ignored, not treated as cache edges', () => {
  // From a real browser trace: a flat ~6 ns performance-core curve with stray
  // 0 ns points at 2, 4 and 8 MB produced fake edges and a wasted 1.2 MB probe.
  const mb = [0.25, 0.375, 0.5, 0.6875, 1, 1.4375, 2, 2.8125, 4, 5.6875, 8, 11.3125, 16, 22.625, 32, 45.25, 64];
  const ns = [6, 6, 6, 5, 6, 6, 0, 6, 0, 8, 0, 9, 12, 12, 50, 100, 112];
  const withZeros = mb.map((m, i) => ({ bytes: Math.round(m * MB_), ns: ns[i] }));
  const clean = withZeros.filter((p) => p.ns > 0);
  const a = planFromCalibration(withZeros), b = planFromCalibration(clean);
  assert.deepEqual(a.probes, b.probes);
  assert.ok(a.probes.every((p) => p > 2 * MB_), `no tiny probe from a fake edge: ${a.probes}`);
});
