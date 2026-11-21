// The covert-channel codec. Pure, deterministic, and the part that is actually
// testable - none of it touches hardware or timing. The physical channel
// (channel.js) only produces a stream of latency samples; everything about
// turning a message into chips and back lives here.
//
// Layers, outermost first:
//
//   text  <->  bytes  <->  bits  <->  [optional repetition-3 FEC]  <->  chips
//
// A "chip" is one half-bit-slot decision: 1 = the sender occupied its cache
// region during that half-slot, 0 = it stayed idle. Manchester coding maps each
// data bit to two chips with a guaranteed transition, so the receiver can
// recover the clock from the signal itself rather than needing a shared one -
// which is the whole reason it is used here (see COVERT-CHANNEL-SCOPING.md 2:
// naive fixed slots drifted to BER 0.5).
//
// Frame on the wire (all chips):
//
//   [ raw preamble ][ SFD ][ Manchester( length | payload | checksum ) ]
//
//   preamble : PREAMBLE_PAIRS x [1,0]  - raw alternating chips, NOT Manchester.
//              Used to (a) find chip phase and (b) calibrate the 0/1 threshold
//              from real hi/lo samples.
//   SFD      : start-of-frame delimiter, a fixed byte, Manchester-encoded, that
//              the decoder locates to find where the framed data begins.
//   length   : 1 byte, number of payload bytes.
//   payload  : the message bytes.
//   checksum : 1 byte, sum of payload bytes mod 256, for error DETECTION.

// G. E. Thomas convention: data 1 -> chips [1,0], data 0 -> chips [0,1].
export const CHIPS_FOR_1 = [1, 0];
export const CHIPS_FOR_0 = [0, 1];

export const PREAMBLE_PAIRS = 16; // 32 raw chips of 1,0,1,0,...
export const SFD_BYTE = 0b10101100; // 0xAC - distinctive once Manchester-encoded

// ---- bytes <-> bits (MSB first) --------------------------------------------

export function bytesToBits(bytes) {
  const bits = [];
  for (const b of bytes) {
    for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  }
  return bits;
}

export function bitsToBytes(bits) {
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] & 1);
    bytes.push(b);
  }
  return bytes;
}

export function textToBytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // Keep it honest: this is a byte channel. Restrict to 8-bit.
    out.push(c & 0xff);
  }
  return out;
}

export function bytesToText(bytes) {
  return bytes.map((b) => String.fromCharCode(b)).join('');
}

// ---- repetition-3 FEC (optional) -------------------------------------------
//
// Each bit sent three times; decoded by majority vote. Cheap, corrects any
// single flip in a triple, and - importantly for the demo - lets the page show
// "raw" vs "corrected" side by side so the errors are visible, not hidden.

export function fecEncode(bits) {
  const out = [];
  for (const b of bits) { out.push(b, b, b); }
  return out;
}

export function fecDecode(bits) {
  const out = [];
  let corrected = 0;
  for (let i = 0; i + 3 <= bits.length; i += 3) {
    const s = bits[i] + bits[i + 1] + bits[i + 2];
    const vote = s >= 2 ? 1 : 0;
    if (bits[i] !== vote || bits[i + 1] !== vote || bits[i + 2] !== vote) corrected++;
    out.push(vote);
  }
  return { bits: out, corrected };
}

// ---- Manchester chip layer -------------------------------------------------

export function manchesterEncode(bits) {
  const chips = [];
  for (const b of bits) chips.push(...(b ? CHIPS_FOR_1 : CHIPS_FOR_0));
  return chips;
}

// Decode chip pairs back to bits. A pair of equal chips [0,0] or [1,1] is a
// Manchester violation (never produced by a valid bit) and is flagged; we still
// emit a best-guess bit so downstream framing stays aligned.
export function manchesterDecode(chips) {
  const bits = [];
  const violations = [];
  for (let i = 0; i + 2 <= chips.length; i += 2) {
    const a = chips[i], b = chips[i + 1];
    if (a === 1 && b === 0) bits.push(1);
    else if (a === 0 && b === 1) bits.push(0);
    else {
      // violation: guess from which chip is "louder" is impossible at this
      // layer (chips are already thresholded), so guess 1 for [1,1], 0 for [0,0].
      violations.push(bits.length);
      bits.push(a === 1 ? 1 : 0);
    }
  }
  return { bits, violations };
}

// ---- checksum --------------------------------------------------------------

export function checksum(bytes) {
  let s = 0;
  for (const b of bytes) s = (s + b) & 0xff;
  return s;
}

// ---- framing ---------------------------------------------------------------

// Build the full chip sequence for a message.
export function encodeFrame(text, { fec = false } = {}) {
  const payload = textToBytes(text);
  if (payload.length > 255) throw new RangeError('message too long (max 255 bytes)');

  const framed = [SFD_BYTE, payload.length, ...payload, checksum(payload)];
  let dataBits = bytesToBits(framed);
  if (fec) dataBits = fecEncode(dataBits);

  const preamble = [];
  for (let i = 0; i < PREAMBLE_PAIRS; i++) preamble.push(1, 0);

  const chips = [...preamble, ...manchesterEncode(dataBits)];
  return {
    chips,
    preambleChips: preamble.length,
    payloadBytes: payload.length,
    fec,
    text,
  };
}

// ---- threshold calibration -------------------------------------------------

// The preamble is raw 1,0,1,0,... so the odd-indexed samples are "1" (occupied,
// high latency) and even-indexed are "0" (idle, low). Average each group and put
// the threshold at the midpoint. Returns nulls if the preamble shows no
// separation (channel too noisy / sender absent).
export function calibrate(preambleSamples) {
  const highs = [], lows = [];
  for (let i = 0; i < preambleSamples.length; i++) {
    (i % 2 === 0 ? highs : lows).push(preambleSamples[i]); // chip[0]=1 -> high
  }
  if (!highs.length || !lows.length) return { threshold: null, high: null, low: null, separation: 0 };
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const high = mean(highs), low = mean(lows);
  const threshold = (high + low) / 2;
  const separation = low > 0 ? high / low : 0;
  return { threshold, high, low, separation };
}

// ---- full decode from a latency sample stream ------------------------------
//
// samples: one latency reading per chip, in order. Length should match the
// encoded chip count when the clock is aligned (the live path guarantees this
// by sampling on the shared cadence; the simulator produces it directly).
export function decodeSamples(samples, opts = {}) {
  const preambleChips = opts.preambleChips ?? PREAMBLE_PAIRS * 2;
  const fec = opts.fec ?? false;

  if (samples.length <= preambleChips) {
    return { ok: false, reason: 'too few samples', text: '', chips: [] };
  }

  const cal = calibrate(samples.slice(0, preambleChips));
  if (cal.threshold === null) {
    return { ok: false, reason: 'no preamble separation', text: '', chips: [], calibration: cal };
  }
  // A caller can require a minimum hi/lo separation before trusting a decode;
  // below it the "bits" are just thresholded noise.
  if (opts.minSeparation && cal.separation < opts.minSeparation) {
    return { ok: false, reason: 'separation below threshold', text: '', chips: [], calibration: cal };
  }

  const chips = samples.map((s) => (s > cal.threshold ? 1 : 0));
  const dataChips = chips.slice(preambleChips);

  let { bits, violations } = manchesterDecode(dataChips);

  let corrected = 0;
  if (fec) {
    const dec = fecDecode(bits);
    bits = dec.bits;
    corrected = dec.corrected;
  }

  const bytes = bitsToBytes(bits);
  if (bytes.length < 2) {
    return { ok: false, reason: 'truncated frame', text: '', chips, calibration: cal, violations };
  }

  const sfd = bytes[0];
  const length = bytes[1];
  const payload = bytes.slice(2, 2 + length);
  const gotChecksum = bytes[2 + length];
  const wantChecksum = checksum(payload);
  const checksumOk = payload.length === length && gotChecksum === wantChecksum;

  return {
    ok: true,
    sfdOk: sfd === SFD_BYTE,
    text: bytesToText(payload),
    payload,
    length,
    checksumOk,
    violations,
    fecCorrected: corrected,
    calibration: cal,
    chips,
  };
}

// Per-bit error rate between a known-truth message and a decode, at the payload
// bit level. Used by tests and by the demo's self-test mode.
export function bitErrorRate(truthText, gotText) {
  const a = bytesToBits(textToBytes(truthText));
  const b = bytesToBits(textToBytes(gotText));
  const n = Math.max(a.length, b.length);
  if (n === 0) return 0;
  let err = 0;
  for (let i = 0; i < n; i++) if ((a[i] ?? -1) !== (b[i] ?? -2)) err++;
  return err / n;
}
