// UI for the covert-channel finale section of cache.html.
//
// Two modes:
//   replay  - deterministic simulation calibrated to the measured hardware
//             figures. Always works, identical everywhere. The default, so the
//             page demonstrates the concept end to end no matter what.
//   live    - the real channel.js path, best-effort. Clearly labelled
//             experimental; on failure it says so and points back to replay.
//
// The defence beat is a CAPACITY DIAL, not a kill switch: a timer-coarsening
// toggle and an integration/quality slider that make BER climb and bitrate fall,
// demonstrating that the real mitigations degrade the channel rather than
// closing it - because a physically shared cache cannot be un-shared in
// software, and this channel would survive process/site isolation.

function $(id) { return document.getElementById(id); }

// Render the receiver latency scope: one dot per chip, threshold line, sender
// ground-truth shown faintly so hits and misses are visible.
function drawScope(canvas, samples, truthChips, threshold, revealed) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = 150;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = (n, fb) => (getComputedStyle(document.documentElement).getPropertyValue(n) || '').trim() || fb;
  const line = css('--line', '#d0d7de'), muted = css('--muted', '#59636e');
  const ok = css('--ok', '#1a7f37'), err = css('--err', '#cf222e'), accent = css('--accent', '#0969da');

  const valid = samples.filter((x) => !isNaN(x));
  if (!valid.length) return;
  const maxV = Math.max(...valid) * 1.1, minV = 0;
  const padL = 40, padB = 16, padT = 8;
  const plotH = h - padB - padT, plotW = w - padL - 8;
  const n = samples.length;
  const x = (i) => padL + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v) => padT + plotH - ((v - minV) / (maxV - minV || 1)) * plotH;

  // threshold line
  if (threshold != null) {
    ctx.strokeStyle = accent; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y(threshold)); ctx.lineTo(w - 8, y(threshold)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = accent; ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('decision threshold', padL + 2, y(threshold) - 2);
  }

  // y axis labels
  ctx.fillStyle = muted; ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillText(Math.round(maxV) + ' ns', padL - 4, y(maxV));
  ctx.fillText('0', padL - 4, y(0));

  for (let i = 0; i < n; i++) {
    if (i >= revealed || isNaN(samples[i])) continue;
    const above = threshold != null && samples[i] > threshold;
    const truth = truthChips ? truthChips[i] : null;
    // colour: green if decoded chip matches truth, red if it disagrees
    let colour = accent;
    if (truth != null) colour = (above ? 1 : 0) === truth ? ok : err;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(x(i), y(samples[i]), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// The cache-occupancy strip: lights up while the current chip is a "1".
function drawOccupancy(canvas, chips, revealed) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600, h = 26;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = (n, fb) => (getComputedStyle(document.documentElement).getPropertyValue(n) || '').trim() || fb;
  const accent = css('--accent', '#0969da'), panel = css('--line', '#d0d7de');
  const n = chips.length, cw = w / n;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = (i < revealed && chips[i] === 1) ? accent : panel;
    ctx.globalAlpha = i < revealed ? (chips[i] === 1 ? 0.85 : 0.25) : 0.1;
    ctx.fillRect(i * cw + 0.5, 4, Math.max(1, cw - 1), h - 8);
  }
  ctx.globalAlpha = 1;
}

export function initChannel() {
  // Bail quietly if this page has no channel section (defensive).
  if (!$('chMessage')) return;

  const els = {
    message: $('chMessage'), mode: $('chMode'), fec: $('chFec'),
    coarsen: $('chCoarsen'), quality: $('chQuality'), qualityOut: $('chQualityOut'),
    run: $('chRun'), status: $('chStatus'),
    scope: $('chScope'), occupancy: $('chOccupancy'),
    sent: $('chSent'), decoded: $('chDecoded'), decodedRaw: $('chDecodedRaw'),
    statBitrate: $('chBitrate'), statBer: $('chBer'), statCapacity: $('chCapacity'),
    statChecksum: $('chChecksum'),
    liveNote: $('chLiveNote'),
    source: $('chSource'),
    save: $('chSave'),
  };

  // The provenance badge: tells the viewer, unmissably, whether what they are
  // looking at is a real live transmission on this machine or the simulated
  // model. Live mode can auto-fall-back to simulated, so this always reflects
  // the ACTUAL source of the currently-displayed result, not the dropdown.
  function setBadge(src) {
    if (!els.source) return;
    if (src === 'live') {
      els.source.textContent = '● LIVE — real cache contention on this machine';
      els.source.className = 'srcbadge live';
    } else {
      els.source.textContent = '● SIMULATED — modelled trace (calibrated to measured hardware)';
      els.source.className = 'srcbadge sim';
    }
  }

  const CHIP_MS = 40;
  const rawBitrate = 1000 / (CHIP_MS * 2); // Manchester halves the data rate

  let anim = null;
  let lastFrame = null; // { result, truthChips, revealed } — repainted on resize
  let lastTrace = null; // the most recent result, in the shared trace format
  let liveDiag = null;  // calibration, pre-flights and attempts of the latest live run

  // ---- Save trace --------------------------------------------------------
  // Exports exactly what the page decoded from, in the same JSON shape as
  // native/channel.c --trace ("cache-covert-channel/trace@1"), so a live run
  // can be kept as evidence and checked offline rather than just reported.
  function buildTrace(result, truthChips, ber, pRaw, capacity) {
    const live = result.source === 'live';
    const th = result.calibration ? result.calibration.threshold : null;
    return {
      format: 'cache-covert-channel/trace@1',
      source: live ? 'browser-live' : 'browser-simulated',
      machine: navigator.userAgent,
      logical_cores: navigator.hardwareConcurrency || null,
      captured: new Date().toISOString(),
      params: {
        chip_ms: CHIP_MS,
        fec: els.fec.checked,
        ...(live
          ? { probe_bytes: result.regionBytes, probe_steps: result.probeSteps, sender_buf_mb: result.bufMB, idle_ns: result.idleNs }
          : { model: { ...MODEL }, quality: Number(els.quality.value), coarsen_model: els.coarsen.checked, seed: 12345 }),
      },
      sync: live
        ? 'out-of-band: one start instant passed to both Workers via postMessage'
        : 'n/a (simulation)',
      // Everything the live path measured this run - kept even when it fell
      // back to the simulation, because the failures are evidence too.
      live_diagnostics: liveDiag,
      note: result.note || null,
      decoded: {
        text: result.text || '',
        raw_text_no_fec: result.rawText != null ? result.rawText : null,
        checksum_ok: !!result.checksumOk,
        threshold_ns: th,
        preamble_separation: result.calibration ? result.calibration.separation : null,
      },
      sent: els.message.value,
      payload_bit_errors_rate: result.text ? ber : null,
      raw_bit_error_prob: pRaw,
      capacity_bps_estimate: Math.round(capacity * 1000) / 1000,
      raw_bitrate_bps: rawBitrate,
      truth_chips: truthChips ? Array.from(truthChips) : null,
      chips: th == null ? null : result.samples.map((v) => (v > th ? 1 : 0)),
      samples_ns_per_access: result.samples.map((v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)),
    };
  }

  function saveTrace() {
    if (!lastTrace) return;
    const blob = new Blob([JSON.stringify(lastTrace, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    const stamp = lastTrace.captured.replace(/[:.]/g, '-').slice(0, 19);
    a.href = URL.createObjectURL(blob);
    a.download = `cache-channel-trace-${lastTrace.source}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function setStatus(msg, cls = '') { els.status.textContent = msg; els.status.className = 'status ' + cls; }

  function bitErrorRate(a, b) {
    const bitsOf = (t) => [...t].flatMap((c) => {
      const v = c.charCodeAt(0) & 0xff; const o = [];
      for (let i = 7; i >= 0; i--) o.push((v >> i) & 1); return o;
    });
    const x = bitsOf(a), yb = bitsOf(b);
    const n = Math.max(x.length, yb.length);
    if (!n) return 0;
    let e = 0; for (let i = 0; i < n; i++) if ((x[i] ?? -1) !== (yb[i] ?? -2)) e++;
    return e / n;
  }

  function present(result, truthChips) {
    // animate chips arriving
    if (anim) clearInterval(anim);
    let revealed = 0;
    const total = result.samples.length;
    const cal = result.calibration;

    const paint = () => {
      lastFrame = { result, truthChips, revealed };
      drawScope(els.scope, result.samples, truthChips, cal ? cal.threshold : null, revealed);
      drawOccupancy(els.occupancy, truthChips, revealed);
      // progressive text: decode only the chips revealed so far is complex;
      // simpler and honest - reveal final text char by char in step with chips.
      const frac = revealed / total;
      const shown = Math.floor(result.text.length * frac);
      els.decoded.textContent = result.text.slice(0, shown) || '…';
    };

    paint(); // draw an initial frame immediately so nothing is blank

    const stepMs = 900 / Math.max(1, total);
    anim = setInterval(() => {
      revealed++;
      paint();
      if (revealed >= total) {
        clearInterval(anim); anim = null;
        els.decoded.textContent = result.text || '(nothing)';
        finalReadouts(result, truthChips);
      }
    }, stepMs);
  }

  // Raw (pre-FEC) bit error probability across the WHOLE frame after the
  // preamble: compare the bits the receiver decided (by comparing each chip
  // pair, exactly as the decoder does) against the bits that were sent. This is the crossover probability of the binary
  // symmetric channel, which is what Shannon capacity is defined on. (Using the
  // decoded message's BER instead was wrong: a failed decode reads as 100%
  // "error", and 1 - H(1) = 1 reported FULL capacity for a dead channel.)
  function rawBitErrorProb(result, truthChips) {
    if (!truthChips) return null;
    const pre = PREAMBLE_PAIRS * 2;
    const data = result.samples.slice(pre);
    const want = manchesterDecode(truthChips.slice(pre)).bits;
    // Same decision the decoder makes: compare the two halves of each bit.
    let e = 0, n = 0;
    for (let i = 0; i < want.length; i++) {
      const x = data[2 * i], y = data[2 * i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      n++;
      if ((x > y ? 1 : 0) !== want[i]) e++;
    }
    return n ? e / n : null;
  }

  function finalReadouts(result, truthChips) {
    const truth = els.message.value;
    const ber = bitErrorRate(truth, result.text || '');
    const pRaw = rawBitErrorProb(result, truthChips);
    els.sent.textContent = truth;
    els.decodedRaw.textContent = result.rawText != null ? result.rawText : result.text;
    els.statBitrate.textContent = rawBitrate.toFixed(1) + ' b/s';
    els.statBer.textContent = result.text ? (ber * 100).toFixed(1) + '%' : 'no decode';
    const capacity = pRaw == null ? 0 : channelCapacity(pRaw, rawBitrate);
    els.statCapacity.textContent = capacity.toFixed(1) + ' b/s';
    lastTrace = buildTrace(result, truthChips, ber, pRaw, capacity);
    if (els.save) els.save.disabled = false;
    els.statChecksum.textContent = result.checksumOk ? 'pass' : 'FAIL';
    els.statChecksum.className = result.checksumOk ? 'pass' : 'fail';
    const live = result.source === 'live';
    const sep = result.calibration && result.calibration.separation ? result.calibration.separation : null;
    const pre = result.note ? result.note + ' ' : '';
    if (result.text === truth) {
      setStatus(pre + (live
        ? 'Live decode clean — real cache contention on this machine, no shared memory or network.'
        : 'Simulated transmission decoded cleanly — a model calibrated to the measured hardware, identical on every machine.'), 'ok');
    } else if (result.checksumOk) {
      setStatus(pre + (live
        ? 'Live: checksum passed but the text differs — partial corruption this run.'
        : 'Simulated: checksum passed but the text differs — partial corruption.'), 'warn');
    } else {
      setStatus(pre + (live
        ? `Live: the receiver couldn't cleanly recover the message this run${sep ? ` (${sep.toFixed(1)}× preamble separation)` : ''} — real channels are noisy. Retry, or switch to Replay.`
        : 'Simulated: corrupted at this quality / coarsening setting.'), 'err');
    }
  }

  // Map the "channel quality" slider (0..100) to simulator noise + contrast.
  // High quality = low noise, full contrast. Low quality models a weak sender /
  // short integration time - the attacker's own limit.
  function simParamsFromDial() {
    const q = Number(els.quality.value) / 100;      // 1 = best
    const noise = 0.08 + (1 - q) * 0.55;            // 0.08 .. 0.63
    const dropContrast = (1 - q) * 0.5;             // up to half the gap gone
    // timer coarsening: round samples to a grid. Off, or a ns grid coarse
    // enough to blur the hi/lo clusters at this scale.
    const coarsenNs = els.coarsen.checked ? 25 : 0;
    return { noise, dropContrast, coarsenNs };
  }

  function runReplay(note) {
    if (els.save) els.save.disabled = true;
    const msg = els.message.value.slice(0, 16) || 'cache';
    const fec = els.fec.checked;
    const { chips } = encodeFrame(msg, { fec });
    const { noise, dropContrast, coarsenNs } = simParamsFromDial();
    const samples = renderTrace(chips, { seed: 12345, noise, dropContrast, coarsenNs });
    const dec = decodeSamples(samples, { preambleChips: PREAMBLE_PAIRS * 2, fec });

    // also decode WITHOUT fec assumption to show the raw-vs-corrected contrast
    const rawDec = decodeSamples(samples, { preambleChips: PREAMBLE_PAIRS * 2, fec: false });

    const result = {
      samples,
      text: dec.ok ? dec.text : '',
      rawText: rawDec.ok ? rawDec.text : '',
      checksumOk: !!dec.checksumOk,
      calibration: dec.calibration,
      source: 'sim',
      note: note || null,
    };
    setBadge('sim');
    setStatus((note ? note + ' ' : '') + 'Transmitting over the simulated cache channel…');
    present(result, chips);
  }

  // Live transmission, adapted to the chip it's running on:
  //   1. open a session: sender + receiver Workers (main thread only coordinates)
  //   2. the receiver measures ITS core's cache edges (quick pointer-chase sweep)
  //   3. each edge suggests a probe size; a ~1 s pre-flight tries each on the
  //      same Workers, and the best-separating size is used
  //   4. transmit (up to 2 attempts); differential Manchester decode
  // If no size separates (the OS put the two Workers on cores that don't share
  // a cache), it falls back to the simulation and SAYS SO - and keeps every
  // live measurement in the trace.
  async function runLive() {
    if (!liveSupported()) {
      liveDiag = { error: 'unsupported' };
      runReplay('Live channel unsupported in this browser —');
      return;
    }
    const msg = els.message.value.slice(0, 16) || 'cache';
    const fec = els.fec.checked;
    const { chips } = encodeFrame(msg, { fec });
    els.run.disabled = true;
    if (els.save) els.save.disabled = true;
    setBadge('live');
    const fmt = (b) => (b >= 1048576 ? (b / 1048576).toFixed(b >= 10 * 1048576 ? 0 : 1) + ' MB' : Math.round(b / 1024) + ' KB');
    const diag = (liveDiag = { calibration: null, plan: null, preflights: [], attempts: [], chosen: null });
    let session = null;
    try {
      session = new LiveSession();

      setStatus('Live: measuring this core’s caches (quick sweep)…');
      const points = await session.calibrate();
      const plan = planFromCalibration(points);
      diag.calibration = points.map((p) => ({ bytes: p.bytes, ns: Math.round(p.ns * 100) / 100 }));
      diag.plan = plan;

      const edgeText = plan.fallback ? 'no clear edges' : 'edges near ' + plan.edges.map(fmt).join(', ');
      let best = null;
      for (const region of plan.probes) {
        setStatus(`Live: ${edgeText} — pre-flight with a ${fmt(region)} probe…`);
        const pf = await session.preflight(region, { chipMs: CHIP_MS, bufMB: plan.senderBufMB });
        diag.preflights.push({ probe_bytes: region, separation: Math.round(pf.separation * 100) / 100, high_ns: pf.high, low_ns: pf.low, idle_ns: pf.idleNs, samples: pf.samples });
        if (!best || pf.separation > best.separation) best = { region, separation: pf.separation };
      }
      const tried = diag.preflights.map((x) => `${fmt(x.probe_bytes)} ${x.separation.toFixed(1)}×`).join(', ');

      if (!best || best.separation < MIN_SEPARATION) {
        els.liveNote.style.display = '';
        runReplay(`Live channel too weak right now (pre-flights: ${tried}) — the two Workers likely landed on cores that don't share a cache —`);
        return;
      }
      diag.chosen = { probe_bytes: best.region, separation: best.separation, sender_buf_mb: plan.senderBufMB };

      const MAX_ATTEMPTS = 2;
      let bestRes = null, bestBer = Infinity;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        setStatus(`Live: ${fmt(best.region)} probe (${best.separation.toFixed(1)}× pre-flight) — transmitting, attempt ${attempt} of ${MAX_ATTEMPTS}…`);
        const tx = await session.transmit(chips, { chipMs: CHIP_MS, regionBytes: best.region, bufMB: plan.senderBufMB });
        const dec = decodeSamples(tx.samples, { preambleChips: PREAMBLE_PAIRS * 2, fec });
        const rawDec = decodeSamples(tx.samples, { preambleChips: PREAMBLE_PAIRS * 2, fec: false });
        const text = dec.ok ? dec.text : '';
        const ber = bitErrorRate(msg, text);
        const cand = {
          samples: tx.samples, text,
          rawText: rawDec.ok ? rawDec.text : '',
          checksumOk: !!dec.checksumOk,
          calibration: dec.calibration,
          source: 'live',
          regionBytes: tx.regionBytes, bufMB: tx.bufMB, probeSteps: tx.probeSteps, idleNs: tx.idleNs,
          note: `Live (${fmt(best.region)} probe, chosen from pre-flights: ${tried}).`,
        };
        diag.attempts.push({ text, checksum_ok: cand.checksumOk, separation: dec.calibration ? dec.calibration.separation : null });
        if (ber < bestBer) { bestRes = cand; bestBer = ber; }
        if (cand.checksumOk && text === msg) break; // clean decode - no need to retry
      }

      const sep = bestRes && bestRes.calibration ? (bestRes.calibration.separation || 0) : 0;
      const clean = bestRes && bestRes.checksumOk && bestRes.text === msg;
      if (!clean && sep < MIN_SEPARATION) {
        els.liveNote.style.display = '';
        runReplay(`Live transmission lost the channel (${sep.toFixed(1)}× preamble separation; pre-flights: ${tried}) —`);
      } else {
        if (!clean) els.liveNote.style.display = '';
        setBadge('live');
        present(bestRes, chips);
      }
    } catch (e) {
      diag.error = String(e && e.message || e);
      els.liveNote.style.display = '';
      runReplay('Live channel failed (' + diag.error + ') —');
    } finally {
      if (session) session.close();
      els.run.disabled = false;
    }
  }

  function run() {
    if (els.mode.value === 'live') runLive();
    else { liveDiag = null; runReplay(); }
  }

  els.run.addEventListener('click', run);
  if (els.save) els.save.addEventListener('click', saveTrace);
  els.quality.addEventListener('input', () => { els.qualityOut.textContent = els.quality.value + '%'; });
  els.coarsen.addEventListener('change', () => { if (els.mode.value === 'replay') runReplay(); });
  els.quality.addEventListener('change', () => { if (els.mode.value === 'replay') runReplay(); });
  els.mode.addEventListener('change', () => {
    liveDiag = null;
    els.liveNote.style.display = els.mode.value === 'live' ? '' : 'none';
  });
  // Repaint the last frame at the new width (rotation, window resize) so the
  // canvases never stay stretched or blurry. rAF-throttled.
  let resizeQueued = false;
  window.addEventListener('resize', () => {
    if (resizeQueued || !lastFrame) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      const { result, truthChips, revealed } = lastFrame;
      drawScope(els.scope, result.samples, truthChips, result.calibration ? result.calibration.threshold : null, revealed);
      drawOccupancy(els.occupancy, truthChips, revealed);
    });
  });

  els.qualityOut.textContent = els.quality.value + '%';
  els.liveNote.style.display = 'none';
  runReplay();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initChannel);
  else initChannel();
}
