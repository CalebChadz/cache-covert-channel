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
    lineChart(els.chart, [{
      points: points.map((p) => [p.bytes, p.ns]),
      color: mode === 'linear' ? getComputedStyle(document.documentElement).getPropertyValue('--warn').trim() || '#9a6700' : undefined,
      dots: true,
    }], {
      logX: true,
      height: 280,
      xLabel: 'working set size',
      yLabel: 'ns per access',
      yFormat: (v) => v.toFixed(v < 10 ? 1 : 0),
      xTicks: xTicks.filter((_, i) => i % 2 === 0),
      marks: knees.map((k) => ({ x: k.atBytes, label: k.label })),
    });
  }

  function renderTable(points) {
    if (!points.length) { els.table.innerHTML = ''; return; }
    const rows = points.map((p, i) => {
      const prev = i > 0 ? points[i - 1].ns : null;
      const ratio = prev ? (p.ns / prev) : null;
      return `<tr><td>${fmtBytes(p.bytes)}</td>` +
             `<td class="num">${p.ns.toFixed(2)}</td>` +
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
      ? `The 2020 heuristic (first 1.5× jump, no repetition, no noise floor) would report: ${fmtBytes(orig.reportedBytes)}.`
      : 'The 2020 heuristic would report nothing — it never saw a 1.5× jump.';
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

    const gen = currentMode === 'linear'
      ? sweepLinear({ bytes: new Uint8Array(alloc.buf.buffer), sizes, repeats })
      : sweep({ buf: alloc.buf, sizes, repeats });

    drive(gen, currentMode, (points) => {
      setBusy(false);
      renderSummary(points, currentMode);
      setStatus(`Live run complete on this machine — ${points.length} windows measured.`, 'ok');
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

  // Environment readout — measured, not assumed.
  const env = environmentReport();
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
