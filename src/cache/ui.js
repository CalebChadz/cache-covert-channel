// Browser UI for the cache side-channel page.

import { MB } from './detect.js';

function $(id) { return document.getElementById(id); }

// Measure this browser's actual performance.now() quantum by sampling the
// smallest non-zero delta between two back-to-back calls.
function timerQuantumMs(samples = 150000) {
  let smallest = Infinity;
  for (let i = 0; i < samples; i++) {
    const a = performance.now();
    const b = performance.now();
    if (b > a && b - a < smallest) smallest = b - a;
  }
  return smallest === Infinity ? null : smallest;
}

function environmentReport() {
  const q = timerQuantumMs();
  return {
    crossOriginIsolated: self.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    timerQuantumMs: q,
    timerQuantumUs: q === null ? null : q * 1000,
    cores: navigator.hardwareConcurrency ?? null,
    protocol: location.protocol,
  };
}

// One clock tick expressed in ns/access, shown beside each live reading.
function fmtRes(r) { return r >= 0.1 ? r.toFixed(2) : r >= 0.01 ? r.toFixed(3) : '<0.01'; }

function fmtBytes(b) {
  if (b >= MB) return `${b / MB} MB`;
  if (b >= 1024) return `${b / 1024} KB`;
  return `${b} B`;
}

export function initCache() {
  const els = {
    mode: $('mode'), minSize: $('minSize'), maxSize: $('maxSize'), repeats: $('repeats'),
    run: $('run'), stop: $('stop'),
    chart: $('chart'), status: $('status'), verdict: $('verdict'),
    statRange: $('statRange'), statMin: $('statMin'), statMax: $('statMax'), statKnee: $('statKnee'),
    env: $('env'), table: $('table'), originalSays: $('originalSays'),
  };

  const env = environmentReport();
  let running = false;
  let cancelled = false;
  let current = [];
  let currentMode = 'chase';

  function setStatus(msg, cls = '') {
    els.status.textContent = msg;
    els.status.className = 'status ' + cls;
  }

  function renderChart(points, mode) {
    if (!points.length) return;
    const xTicks = points.map((p) => ({ x: p.bytes, label: fmtBytes(p.bytes).replace(' ', '') }));
    const { knees } = detectKnees(points);
    // Thin the x labels on narrow (phone) screens so they never collide.
    const narrow = (els.chart.clientWidth || 600) < 560;
    lineChart(els.chart, [{
      points: points.map((p) => [p.bytes, p.ns]),
      color: mode === 'linear' ? getComputedStyle(document.documentElement).getPropertyValue('--warn').trim() || '#9a6700' : undefined,
      dots: true,
    }], {
      logX: true,
      height: narrow ? 240 : 300,
      padL: narrow ? 44 : 52,
      xLabel: 'working set size',
      yLabel: 'ns per access',
      yFormat: (v) => v.toFixed(v < 10 ? 1 : 0),
      xTicks: xTicks.filter((_, i) => i % (narrow ? 4 : 2) === 0),
      marks: knees.map((k) => ({ x: k.atBytes, label: k.label })),
    });
  }

  function renderTable(points) {
    if (!points.length) { els.table.innerHTML = ''; return; }
    const rows = points.map((p, i) => {
      const prev = i > 0 ? points[i - 1].ns : null;
      const ratio = prev ? (p.ns / prev) : null;
      return `<tr><td>${fmtBytes(p.bytes)}</td>` +
             `<td class="num">${p.ns.toFixed(2)}${p.resolutionNs ? ` <span class="res">±${fmtRes(p.resolutionNs)}</span>` : ''}</td>` +
             `<td class="num">${ratio ? ratio.toFixed(2) + '×' : '—'}</td></tr>`;
    }).join('');
    els.table.innerHTML =
      '<table><tr><th>Window</th><th>ns/access</th><th>vs previous</th></tr>' + rows + '</table>';
  }

  function renderSummary(points, mode) {
    if (!points.length) return;
    const ns = points.map((p) => p.ns);
    const range = Math.max(...ns) / Math.min(...ns);
    els.statRange.textContent = range.toFixed(1) + '×';
    els.statMin.textContent = Math.min(...ns).toFixed(2);
    els.statMax.textContent = Math.max(...ns).toFixed(1);

    const { knees } = detectKnees(points);
    els.statKnee.textContent = knees.length ? knees.map((k) => k.label).join(', ') : 'none';

    const d = describe(points, mode);
    els.verdict.innerHTML = `<strong>${d.headline}</strong><br>${d.detail}`;
    els.verdict.className = 'status ' + d.tone;

    const orig = originalHeuristic(points);
    els.originalSays.textContent = orig
      ? `A naive first-jump detector (first 1.5× rise, no repeats, no noise floor) would report: ${fmtBytes(orig.reportedBytes)} — the window after the jump, not the capacity.`
      : 'A naive first-jump detector would report nothing here — it never saw a 1.5× rise.';
  }

  function setBusy(b) {
    running = b;
    els.run.disabled = b;
    els.stop.disabled = !b;
    els.mode.disabled = b;
  }

  // Drive a generator, yielding to the event loop between windows so the page
  // stays responsive and the chart animates. Workers are deliberately not used:
  // they are unreliable from file:// origins, and each measurement here is
  // short enough to fit in a frame.
  function drive(gen, mode, done) {
    const tick = () => {
      if (cancelled) { setBusy(false); setStatus('Stopped.', 'warn'); return; }
      let step;
      try {
        step = gen.next();
      } catch (e) {
        setBusy(false);
        setStatus('Measurement failed: ' + e.message, 'err');
        return;
      }
      if (step.done) { done(current); return; }

      const v = step.value;
      if (v.phase === 'warmup') {
        setStatus('Warming up the JIT…');
      } else if (v.phase === 'progress') {
        setStatus(`Measuring ${fmtBytes(v.bytes)} — run ${v.run} of ${v.of}…`);
      } else if (v.phase === 'window') {
        current = v.results;
        renderChart(current, mode);
        renderTable(current);
      }
      setTimeout(tick, 0);
    };
    tick();
  }

  function loadFixture() {
    const key = els.mode.value === 'linear-replay' ? 'linear' : 'chase';
    const f = FIXTURES[key];
    current = f.points.slice();
    currentMode = key;
    renderChart(current, key);
    renderTable(current);
    renderSummary(current, key);
    setStatus(`Replayed capture — ${f.machine}, ${f.captured}.`, 'ok');
    setBusy(false);
  }

  function runLive() {
    const mode = els.mode.value;
    currentMode = mode === 'linear-live' ? 'linear' : 'chase';
    const minSize = parseInt(els.minSize.value, 10);
    const maxSize = parseInt(els.maxSize.value, 10);
    const repeats = parseInt(els.repeats.value, 10);

    if (!(minSize < maxSize)) {
      setStatus('Smallest window must be below the largest.', 'err');
      return;
    }

    cancelled = false;
    setBusy(true);
    current = [];
    setStatus('Allocating…');

    let alloc;
    try {
      alloc = allocate(maxSize * 2);
    } catch (e) {
      setStatus(`Could not allocate memory for a live run (${e.message}). Falling back to the captured data.`, 'warn');
      els.mode.value = currentMode === 'linear' ? 'linear-replay' : 'chase-replay';
      loadFixture();
      return;
    }

    const sizes = windowSizes(minSize, Math.min(maxSize, alloc.bytes / 2));

    // Make every timed run last ~50 clock ticks (and at least 10 ms), so the
    // clock's rounding is ~2% whatever this browser's timer resolution is.
    const quantumMs = env.timerQuantumMs || 1;
    const targetMs = Math.max(10, 50 * quantumMs);
    const opts = { sizes, repeats, targetMs, quantumMs };
    const gen = currentMode === 'linear'
      ? sweepLinear({ bytes: new Uint8Array(alloc.buf.buffer), ...opts, warmupMs: 400 })
      : sweep({ buf: alloc.buf, ...opts });

    drive(gen, currentMode, (points) => {
      setBusy(false);
      renderSummary(points, currentMode);
      const worst = Math.max(...points.map((p) => (p.resolutionNs || 0) / p.ns));
      setStatus(`Live run complete on this machine — ${points.length} windows measured; ` +
        `each run lasted ≥ ${targetMs.toFixed(0)} ms, so clock rounding is under ${Math.max(1, Math.ceil(worst * 100))}% of a reading.`, 'ok');
    });
  }

  function run() {
    if (els.mode.value.endsWith('-replay')) { loadFixture(); return; }
    runLive();
  }

  els.run.addEventListener('click', run);
  els.stop.addEventListener('click', () => { cancelled = true; });
  els.mode.addEventListener('change', () => {
    const live = !els.mode.value.endsWith('-replay');
    els.minSize.disabled = !live;
    els.maxSize.disabled = !live;
    els.repeats.disabled = !live;
  });
  window.addEventListener('resize', () => {
    if (current.length) renderChart(current, currentMode);
  });

  // Environment readout — measured, not assumed. (env is hoisted above.)
  els.env.innerHTML =
    '<table>' +
    `<tr><th>Page origin</th><td class="num">${env.protocol}</td></tr>` +
    `<tr><th>Cross-origin isolated</th><td class="num">${env.crossOriginIsolated}</td></tr>` +
    `<tr><th>SharedArrayBuffer</th><td class="num">${env.sharedArrayBuffer ? 'available' : 'unavailable'}</td></tr>` +
    `<tr><th>performance.now() quantum</th><td class="num">${env.timerQuantumUs === null ? 'unmeasurable' : env.timerQuantumUs.toFixed(1) + ' µs'}</td></tr>` +
    `<tr><th>Logical cores</th><td class="num">${env.cores ?? 'unknown'}</td></tr>` +
    '</table>';

  els.mode.dispatchEvent(new Event('change'));
  loadFixture();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCache);
  } else {
    initCache();
  }
}
