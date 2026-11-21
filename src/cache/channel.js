// The LIVE physical channel: a real cache covert channel between two Web
// Workers on this machine, right now. No shared memory, no postMessage payload
// to the receiver - only contention for a shared cache.
//
// Design, and why (see the article, Parts 7-8):
//
//   * BOTH ends run in Workers. On Apple silicon the two core clusters have
//     separate L2 caches, and the channel only works when sender and receiver
//     share one. With the receiver on the page's main thread, macOS was seen to
//     move it to the efficiency cores once the sender got busy, splitting the
//     ends across clusters (no channel). Two Workers have equal priority and
//     tend to be placed together; the main thread just coordinates.
//
//   * The probe size ADAPTS to the chip. The receiver first runs a quick
//     pointer-chase sweep on whatever core it landed on, the knee detector finds
//     that core's cache edges, and each edge suggests a probe region that fits
//     comfortably inside that level. A short pre-flight tries each candidate on
//     the SAME pair of Workers (keeping their placement) and the best one is
//     used. The sender's buffer is scaled to overflow the largest level found.
//     So a 4 MB efficiency-core L2, a 16 MB performance-core L2 or a 32 MB
//     desktop L3 each get a probe that fits, instead of one hard-coded 8 MB.
//
//   * Sync is still out-of-band: both Workers are given one start instant and
//     schedule every chip from it on the wall clock (Date.now()). The payload
//     never travels that way and the decoder sees only latency samples, but a
//     channel between genuinely isolated parties would need in-band frame
//     recovery (native/channel.c does that).
//
// The coarse browser clock (100 us in Chrome without cross-origin isolation)
// means every probe must run for many clock ticks; the probe's step count is
// set from the measured idle latency so an idle probe lasts ~0.8 ms.

import { detectKnees } from './detect.js';

const MiB = 1024 * 1024;

// ---- sender ---------------------------------------------------------------
// '1' chip: stream a large buffer as hard as possible. '0' chip: idle.
export const SENDER_WORKER_SRC = `
  const MB = 1048576;
  let buf = null;
  function ensureBuf(mb){ if(!buf || buf.length < mb*MB){ buf = new Uint8Array(mb*MB);
    for(let i=0;i<buf.length;i+=4096) buf[i]=1; } }
  // Tight, non-yielding thrash for ~ms milliseconds. Must saturate continuously
  // - a bursty sender produces no signal.
  function thrash(ms){
    const step = 64; let acc = 0; const t0 = performance.now();
    while (performance.now() - t0 < ms){
      for (let i=0;i<buf.length;i+=step) acc ^= buf[i];
    }
    return acc;
  }
  self.onmessage = (e) => {
    const { chips, chipMs, startAt, bufMB } = e.data;
    ensureBuf(bufMB || 24);
    // Short warm-up so caches/clocks settle before the aligned frame. (It does
    // NOT control which cores the OS uses - that is out of a page's hands.)
    { const t0 = performance.now(); let a = 0;
      while (performance.now() - t0 < 25) { for (let i = 0; i < buf.length; i += 64) a ^= buf[i]; }
      if (a === 0.5) self.postMessage({ warm: a }); }
    while (Date.now() < startAt) {}   // align to the shared start instant
    let acc = 0;
    for (let k=0;k<chips.length;k++){
      const end = startAt + (k+1)*chipMs;
      if (chips[k] === 1) acc ^= thrash(chipMs - 3);
      while (Date.now() < end) {}      // idle the rest / the whole '0' chip
    }
    self.postMessage({ type: 'done', acc });
  };
`;

// ---- receiver -------------------------------------------------------------
// Owns one probe buffer laid out as a single random cycle of cache lines (a
// dependent-load chain the prefetcher can't predict, as in chase.js).
//   calibrate: quick sweep -> [{bytes, ns}] on whichever core this Worker is on
//   prepare:   lay out the probe region, measure its idle latency, pick steps
//   receive:   sample each chip (median of probes in a guard window)
export const RECEIVER_WORKER_SRC = `
  const STRIDE = 16; // 64-byte line / 4-byte Int32 element
  let rs = 7;
  const rnd = () => { rs = (Math.imul(rs, 1103515245) + 12345) & 0x7fffffff; return rs / 0x80000000; };
  let pool = null, p = 0;
  function chain(bytes) {
    const len = bytes / 4;
    if (!pool || pool.length < len) pool = new Int32Array(len);
    const n = len / STRIDE, perm = new Int32Array(n);
    for (let i = 0; i < n; i++) perm[i] = i;
    for (let i = n - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
    for (let i = 0; i < n; i++) pool[perm[i] * STRIDE] = perm[(i + 1) % n] * STRIDE;
    p = 0;
    return n;
  }
  function walk(steps) {
    const t0 = performance.now();
    for (let i = 0; i < steps; i++) p = pool[p];
    return ((performance.now() - t0) * 1e6) / steps;
  }
  // ns/access over a region timed for ~targetMs. The browser clock ticks in
  // ~100 us steps, so a short pilot can read 0 (no tick) or one stray tick;
  // the old version scaled from that pilot and could time too few steps,
  // recording 0 ns and inventing cache edges. Grow the step count until a run
  // spans at least half the target (many ticks), then time the full target.
  function timed(targetMs) {
    let steps = 20000;
    for (;;) {
      const ns = walk(steps);
      if ((ns * steps) / 1e6 >= targetMs * 0.5 || steps >= 4e7) {
        const full = Math.min(4e7, Math.max(steps, Math.round((targetMs * 1e6) / Math.max(ns, 0.05))));
        return walk(full);
      }
      steps *= 4;
    }
  }
  self.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'calibrate') {
      const points = [];
      for (let k = 0; ; k++) {
        const bytes = Math.round(m.minBytes * Math.pow(2, k / m.perOctave) / 65536) * 65536;
        if (bytes > m.maxBytes) break;
        if (points.length && points[points.length - 1].bytes === bytes) continue;
        const n = chain(bytes);
        walk(Math.min(n * 2, 2e6));                              // warm
        const a = timed(m.targetMs), b = timed(m.targetMs);
        points.push({ bytes, ns: Math.min(a, b) });              // min: least-interrupted run
      }
      self.postMessage({ type: 'calibrated', points });
    } else if (m.type === 'prepare') {
      const n = chain(m.regionBytes);
      walk(Math.min(n * 3, 3e6));
      const idleNs = timed(4);
      const probeSteps = Math.max(5000, Math.min(400000, Math.round((m.targetProbeMs * 1e6) / idleNs)));
      self.postMessage({ type: 'prepared', idleNs, probeSteps });
    } else if (m.type === 'receive') {
      const { nChips, chipMs, startAt, probeSteps } = m;
      while (Date.now() < startAt) {}
      const samples = new Array(nChips), reads = new Array(nChips);
      for (let k = 0; k < nChips; k++) {
        const a = startAt + k * chipMs + chipMs * 0.25, b = startAt + (k + 1) * chipMs - chipMs * 0.1;
        const r = [];
        while (Date.now() < b) { if (Date.now() >= a) r.push(walk(probeSteps)); }
        r.sort((x, y) => x - y);
        samples[k] = r.length ? r[r.length >> 1] : NaN;
        reads[k] = r.length;
      }
      if (p < 0) throw new Error('unreachable');
      self.postMessage({ type: 'samples', samples, reads });
    }
  };
`;

export function liveSupported() {
  return typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL?.createObjectURL === 'function';
}

// ---- adaptive plan (pure; unit-tested) ------------------------------------
// From a calibration sweep, propose probe sizes and a sender buffer size.
// L1-sized edges are skipped: L1 is private to a core, never the shared level.
export function planFromCalibration(points, opts = {}) {
  const { minProbe = 512 * 1024, maxProbe = 48 * MiB, fill = 0.85, innerFill = 0.6, maxCandidates = 4 } = opts;
  // Safety net: drop unusable readings (0 ns = the clock never ticked) so a
  // bad sample can't masquerade as a cache edge.
  points = points.filter((p) => Number.isFinite(p.ns) && p.ns > 0);
  const det = detectKnees(points);
  const caps = [...new Set([...det.rawKnees, ...det.knees].map((k) => k.capacityBytes))]
    .filter((c) => c >= minProbe)
    .sort((a, b) => a - b);

  const round64k = (b) => Math.max(65536, Math.round(b / 65536) * 65536);
  const clamp = (b) => Math.min(maxProbe, Math.max(minProbe, round64k(b)));
  // A probe that nearly fills a shared level (85%) is evicted by almost any
  // sender traffic - measured best on Apple's 4 MB efficiency-core L2 (3.4 MB
  // beat 2.4 MB). One roomier probe (60%) of the smallest level is kept too,
  // in case the level is shared with other activity.
  let probes = caps.map((c) => clamp(c * fill));
  if (caps.length) probes.unshift(clamp(caps[0] * innerFill));
  probes = [...new Set(probes)].sort((a, b) => a - b);
  if (probes.length > maxCandidates) probes = [probes[0], ...probes.slice(-(maxCandidates - 1))];
  // Nothing detected (flat or noisy sweep): fall back to sizes that fit common
  // shared levels - a 4 MB cluster L2 and a 16 MB L2 / desktop L3.
  const fallback = probes.length === 0;
  if (fallback) probes = [3 * MiB, 8 * MiB];

  const largest = caps.length ? caps[caps.length - 1] : 16 * MiB;
  const senderBufMB = Math.min(96, Math.max(24, Math.ceil((3 * largest) / MiB)));
  return { edges: caps, probes, senderBufMB, fallback, range: det.range };
}

// Minimum pre-flight separation to attempt a live transmission. Differential
// Manchester decoding tolerates less than the old 2x bar; the checksum still
// rejects a bad decode.
export const MIN_SEPARATION = 1.6;

// Separation of a raw alternating 1,0,1,0 pre-flight: mean(high) / mean(low).
export function preflightSeparation(samples) {
  const hi = [], lo = [];
  samples.forEach((v, i) => { if (Number.isFinite(v)) (i % 2 === 0 ? hi : lo).push(v); });
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const h = mean(hi), l = mean(lo);
  return { separation: l > 0 ? h / l : 0, high: h, low: l };
}

// ---- the session ----------------------------------------------------------
// One sender + one receiver Worker, kept for the whole run so that the
// calibration, pre-flights and transmission all happen on the same placement.
export class LiveSession {
  constructor() {
    if (!liveSupported()) throw new Error('live channel unsupported in this context');
    const mk = (src) => {
      const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      return { url, w: new Worker(url) };
    };
    this.s = mk(SENDER_WORKER_SRC);
    this.r = mk(RECEIVER_WORKER_SRC);
  }

  _ask(worker, msg, type) {
    return new Promise((resolve, reject) => {
      const onMsg = (e) => {
        if (e.data && e.data.type === type) { worker.removeEventListener('message', onMsg); resolve(e.data); }
      };
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', (e) => reject(new Error(e.message || 'worker error')), { once: true });
      worker.postMessage(msg);
    });
  }

  calibrate({ minBytes = 256 * 1024, maxBytes = 64 * MiB, perOctave = 2, targetMs = 4 } = {}) {
    return this._ask(this.r.w, { type: 'calibrate', minBytes, maxBytes, perOctave, targetMs }, 'calibrated')
      .then((d) => d.points);
  }

  // Transmit a chip sequence; returns the receiver's per-chip samples.
  async transmit(chips, { chipMs = 40, regionBytes = 8 * MiB, bufMB = 24, probeMs = 0.8, leadMs = 350 } = {}) {
    const prep = await this._ask(this.r.w, { type: 'prepare', regionBytes, targetProbeMs: probeMs }, 'prepared');
    const startAt = Date.now() + leadMs;
    const got = this._ask(this.r.w, { type: 'receive', nChips: chips.length, chipMs, startAt, probeSteps: prep.probeSteps }, 'samples');
    const sent = this._ask(this.s.w, { chips, chipMs, startAt, bufMB }, 'done');
    const [res] = await Promise.all([got, sent]);
    return { samples: res.samples, reads: res.reads, idleNs: prep.idleNs, probeSteps: prep.probeSteps, regionBytes, bufMB, chipMs };
  }

  // ~1 s raw alternating pattern for one probe size.
  async preflight(regionBytes, { chipMs = 40, bufMB = 24, pairs = 10 } = {}) {
    const chips = [];
    for (let i = 0; i < pairs; i++) chips.push(1, 0);
    const r = await this.transmit(chips, { chipMs, regionBytes, bufMB });
    return { ...r, ...preflightSeparation(r.samples) };
  }

  close() {
    for (const x of [this.s, this.r]) { x.w.terminate(); URL.revokeObjectURL(x.url); }
  }
}
