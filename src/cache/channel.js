// The LIVE physical channel: a real cache/memory-bandwidth covert channel
// between the main thread (receiver) and a Web Worker (sender), on this machine,
// right now. No shared memory, no postMessage payload - only contention.
//
// This is the best-effort path. The feasibility study
// (COVERT-CHANNEL-SCOPING.md 1) established that the contention SIGNAL is huge
// and trivially detectable (~10x), but that turning it into reliably-decoded
// bits is genuine engineering bounded by two things measured there:
//
//   - the timer-quantum floor: a probe must do >~100us of work to rise above
//     the coarse clock, so each reliable sample costs ~1ms+,
//   - synchronisation drift: a probe whose duration depends on the bit will
//     overrun its slot and desync, so the probe MUST be constant-work.
//
// The design below addresses both: a fixed step-count probe (constant work
// regardless of contention) sampled several times per chip and medianed, on
// absolute Date.now() chip boundaries so error does not accumulate. Whether it
// decodes cleanly depends on the machine and its background load; the page
// treats a live failure as part of the honest story and falls back to replay.
//
// If SharedArrayBuffer + cross-origin isolation were available this could use a
// nanosecond counting timer and go much faster - deliberately NOT required, so
// the page stays a double-clickable file.

// Worker source, as a string so the build can inline it (a blob Worker is
// same-origin and works from file://; an external worker file would not).
export const SENDER_WORKER_SRC = `
  const MB = 1048576;
  let buf = null;
  function ensureBuf(mb){ if(!buf || buf.length < mb*MB){ buf = new Uint8Array(mb*MB);
    for(let i=0;i<buf.length;i+=4096) buf[i]=1; } }
  // Tight, non-yielding thrash for ~ms milliseconds. A '1' chip. Must saturate
  // the memory subsystem continuously - a bursty sender produces no signal.
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
    while (Date.now() < startAt) {}   // align to the shared start instant
    let acc = 0;
    for (let k=0;k<chips.length;k++){
      const end = startAt + (k+1)*chipMs;
      if (chips[k] === 1) acc ^= thrash(chipMs - 3);
      while (Date.now() < end) {}      // idle the rest / the whole '0' chip
    }
    self.postMessage({ done:true, acc });
  };
`;

// Build the receiver's probe buffer: a single random cycle through cache-line-
// sized slots, so probing is a dependent load chain the prefetcher cannot beat
// (the same trick as chase.js). Returned as a closure over its own buffer.
export function makeProbe(regionBytes = 8 * 1024 * 1024, seed = 7) {
  const STRIDE = 16; // 64B line / 4B element
  const buf = new Int32Array(regionBytes / 4);
  const n = buf.length / STRIDE;
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x80000000; };
  for (let i = n - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  for (let i = 0; i < n; i++) buf[perm[i] * STRIDE] = perm[(i + 1) % n] * STRIDE;

  // Constant-work probe: fixed step count so its DURATION does not depend on
  // whether the region is currently evicted (that dependence is what wrecked
  // synchronisation in the feasibility study).
  return function probeNs(steps) {
    let p = 0;
    const t0 = performance.now();
    for (let i = 0; i < steps; i++) p = buf[p];
    const t1 = performance.now();
    if (p < 0) throw new Error('probe DCE guard');
    return ((t1 - t0) * 1e6) / steps;
  };
}

// Check the environment can host the live path at all.
export function liveSupported() {
  return typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL?.createObjectURL === 'function';
}

// Transmit an already-encoded chip sequence live and return the per-chip latency
// samples the receiver observed. Async; resolves when the frame completes.
//
// params: { chipMs, probeSteps, regionBytes, bufMB, onChip }
export async function transmitLive(chips, params = {}) {
  const {
    chipMs = 40,
    probeSteps = 60000,
    regionBytes = 8 * 1024 * 1024,
    bufMB = 24,
    onChip = null,
  } = params;

  if (!liveSupported()) throw new Error('live channel unsupported in this context');

  const probeNs = makeProbe(regionBytes);
  for (let i = 0; i < 6; i++) probeNs(probeSteps); // JIT + cache warmup

  const url = URL.createObjectURL(new Blob([SENDER_WORKER_SRC], { type: 'application/javascript' }));
  const worker = new Worker(url);

  try {
    const startAt = Date.now() + 200; // lead time for both ends to be ready
    worker.postMessage({ chips, chipMs, startAt, bufMB });

    while (Date.now() < startAt) { /* spin to the shared start */ }

    const samples = new Array(chips.length);
    for (let k = 0; k < chips.length; k++) {
      const winStart = startAt + k * chipMs + chipMs * 0.25;
      const winEnd = startAt + (k + 1) * chipMs - chipMs * 0.1;
      const reads = [];
      while (Date.now() < winEnd) {
        if (Date.now() >= winStart) reads.push(probeNs(probeSteps));
      }
      reads.sort((a, b) => a - b);
      const median = reads.length ? reads[reads.length >> 1] : NaN;
      samples[k] = median;
      if (onChip) onChip(k, median, reads.length);
      // yield to the event loop occasionally so the UI can paint
      if (k % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }

    return { samples, chipMs, rawBitrate: 1000 / (chipMs * 2) };
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}
