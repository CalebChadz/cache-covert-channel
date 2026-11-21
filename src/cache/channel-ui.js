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
    ctx.fillStyle = accent; ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('decision threshold', padL + 2, y(threshold) - 2);
  }

  // y axis labels
  ctx.fillStyle = muted; ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
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
        finalReadouts(result);
      }
    }, stepMs);
  }

  function finalReadouts(result) {
    const truth = els.message.value;
    const ber = bitErrorRate(truth, result.text || '');
    els.sent.textContent = truth;
    els.decodedRaw.textContent = result.rawText != null ? result.rawText : result.text;
    els.statBitrate.textContent = rawBitrate.toFixed(1) + ' b/s';
    els.statBer.textContent = (ber * 100).toFixed(1) + '%';
    els.statCapacity.textContent = channelCapacity(ber, rawBitrate).toFixed(1) + ' b/s';
    els.statChecksum.textContent = result.checksumOk ? 'pass' : 'FAIL';
    els.statChecksum.className = 'stat';
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

  // Live transmission, made more consistent in two ways:
  //   1. the sender warms up and the receiver re-rolls core placement on each
  //      attempt, so a flat first run gets a second chance automatically;
  //   2. if the preamble shows no usable contention (a dead channel this run),
  //      it falls back to the simulated model and SAYS SO, rather than showing
  //      undecodable noise as if it were a result.
  async function runLive() {
    if (!liveSupported()) {
      runReplay('Live channel unsupported in this browser —');
      return;
    }
    const msg = els.message.value.slice(0, 16) || 'cache';
    const fec = els.fec.checked;
    const { chips } = encodeFrame(msg, { fec });
    els.run.disabled = true;
    setBadge('live');

    const MAX_ATTEMPTS = 2;
    let best = null, bestBer = Infinity;
    try {
      // Pre-flight: a ~1s preamble-only probe to see if there's a usable channel
      // right now, so a dead channel falls back fast instead of after a full
      // multi-second frame.
      setStatus('Live: checking the channel — short pre-flight probe…');
      const pre = await probeChannel({ chipMs: CHIP_MS });
      if (pre.separation < 2.0) {
        els.liveNote.style.display = '';
        runReplay(`Live channel too weak right now (${pre.separation.toFixed(1)}× pre-flight separation — usually core scheduling) —`);
        return;
      }
      setStatus(`Live: channel looks good (${pre.separation.toFixed(1)}× separation) — transmitting…`);

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        setStatus(`Live: attempt ${attempt} of ${MAX_ATTEMPTS} — transmitting through real cache contention on this machine…`);
        const { samples } = await transmitLive(chips, { chipMs: CHIP_MS });
        const dec = decodeSamples(samples, { preambleChips: PREAMBLE_PAIRS * 2, fec });
        const rawDec = decodeSamples(samples, { preambleChips: PREAMBLE_PAIRS * 2, fec: false });
        const text = dec.ok ? dec.text : '';
        const ber = bitErrorRate(msg, text);
        const cand = {
          samples, text,
          rawText: rawDec.ok ? rawDec.text : '',
          checksumOk: !!dec.checksumOk,
          calibration: dec.calibration,
          source: 'live',
        };
        if (ber < bestBer) { best = cand; bestBer = ber; }
        if (cand.checksumOk && text === msg) break; // clean decode — no need to retry
      }

      const sep = best && best.calibration ? (best.calibration.separation || 0) : 0;
      const clean = best && best.checksumOk && best.text === msg;

      if (!clean && sep < 2.0) {
        // No usable contention this run (flat scope, ~coin-flip): the OS likely
        // kept both ends on one core. Fall back to the model, clearly labelled.
        els.liveNote.style.display = '';
        runReplay(`Live channel too weak right now (${sep.toFixed(1)}× preamble separation — usually core scheduling) —`);
      } else {
        if (!clean) els.liveNote.style.display = '';
        setBadge('live');
        present(best, chips);
      }
    } catch (e) {
      els.liveNote.style.display = '';
      runReplay('Live channel failed (' + e.message + ') —');
    } finally {
      els.run.disabled = false;
    }
  }

  function run() {
    if (els.mode.value === 'live') runLive();
    else runReplay();
  }

  els.run.addEventListener('click', run);
  els.quality.addEventListener('input', () => { els.qualityOut.textContent = els.quality.value + '%'; });
  els.coarsen.addEventListener('change', () => { if (els.mode.value === 'replay') runReplay(); });
  els.quality.addEventListener('change', () => { if (els.mode.value === 'replay') runReplay(); });
  els.mode.addEventListener('change', () => {
    els.liveNote.style.display = els.mode.value === 'live' ? '' : 'none';
  });
  window.addEventListener('resize', () => {
    // cheap redraw of last state is skipped; a re-run is one click away.
  });

  els.qualityOut.textContent = els.quality.value + '%';
  els.liveNote.style.display = 'none';
  runReplay();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initChannel);
  else initChannel();
}
