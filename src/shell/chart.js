// Small canvas helpers shared by every demo page. No dependencies.
//
// Everything here is presentation only - no page's algorithm logic lives in
// this file, the same separation binpack-vns keeps between src/vns.js and
// src/ui.js.

// Size a canvas to its CSS box at device pixel ratio, returning a context
// already scaled so all drawing can use CSS pixel coordinates.
export function fitCanvas(canvas, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const h = cssHeight || canvas.clientHeight || 200;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return (v && v.trim()) || fallback;
}

// A line chart with optional log-scaled x axis, point markers and annotations.
//
// series: [{ points: [[x,y],...], color, width, dashed }]
// opts:   { logX, xLabel, yLabel, yMin, yMax, marks: [{x, label, color}],
//           xTicks: [{x, label}], yFormat: fn }
export function lineChart(canvas, series, opts = {}) {
  const height = opts.height || 240;
  const { ctx, w, h } = fitCanvas(canvas, height);
  const padL = opts.padL ?? 52, padR = 14, padT = 12, padB = 34;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = Math.max(1, h - padT - padB);

  const all = series.flatMap((s) => s.points);
  if (!all.length) return;

  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  let xMin = opts.xMin ?? Math.min(...xs);
  let xMax = opts.xMax ?? Math.max(...xs);
  let yMin = opts.yMin ?? 0;
  let yMax = opts.yMax ?? Math.max(...ys) * 1.08;
  if (yMax === yMin) yMax = yMin + 1;

  const tx = (x) => {
    if (opts.logX) {
      const a = Math.log2(xMin), b = Math.log2(xMax);
      return padL + ((Math.log2(x) - a) / (b - a || 1)) * plotW;
    }
    return padL + ((x - xMin) / (xMax - xMin || 1)) * plotW;
  };
  const ty = (y) => padT + plotH - ((y - yMin) / (yMax - yMin || 1)) * plotH;

  const line = cssVar('--line', '#d0d7de');
  const muted = cssVar('--muted', '#59636e');

  // horizontal gridlines + y labels
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  const yTickCount = 4;
  for (let i = 0; i <= yTickCount; i++) {
    const v = yMin + ((yMax - yMin) * i) / yTickCount;
    const y = ty(v);
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, Math.round(y) + 0.5);
    ctx.lineTo(w - padR, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(opts.yFormat ? opts.yFormat(v) : v.toFixed(1), padL - 6, y);
  }

  // x ticks
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of opts.xTicks || []) {
    if (t.x < xMin || t.x > xMax) continue;
    const x = tx(t.x);
    ctx.strokeStyle = line;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, padT);
    ctx.lineTo(Math.round(x) + 0.5, padT + plotH);
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(t.label, x, padT + plotH + 6);
  }

  // annotations (vertical marks)
  for (const m of opts.marks || []) {
    if (m.x < xMin || m.x > xMax) continue;
    const x = tx(m.x);
    ctx.save();
    ctx.strokeStyle = m.color || cssVar('--err', '#cf222e');
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.restore();
    if (m.label) {
      ctx.fillStyle = m.color || cssVar('--err', '#cf222e');
      ctx.textAlign = x > padL + plotW * 0.7 ? 'right' : 'left';
      ctx.textBaseline = 'top';
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(m.label, x + (x > padL + plotW * 0.7 ? -4 : 4), padT + 2);
    }
  }

  // series
  for (const s of series) {
    if (!s.points.length) continue;
    ctx.save();
    ctx.strokeStyle = s.color || cssVar('--accent', '#0969da');
    ctx.lineWidth = s.width || 2;
    if (s.dashed) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const x = tx(p[0]), y = ty(p[1]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();

    if (s.dots) {
      ctx.fillStyle = s.color || cssVar('--accent', '#0969da');
      for (const p of s.points) {
        ctx.beginPath();
        ctx.arc(tx(p[0]), ty(p[1]), s.dotRadius || 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // axis labels
  ctx.fillStyle = muted;
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  if (opts.xLabel) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(opts.xLabel, padL + plotW / 2, h - 1);
  }
  if (opts.yLabel) {
    ctx.save();
    ctx.translate(11, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(opts.yLabel, 0, 0);
    ctx.restore();
  }
}

// Tiny inline sparkline, used for "best so far over time" strips.
export function sparkline(canvas, values, opts = {}) {
  const { ctx, w, h } = fitCanvas(canvas, opts.height || 44);
  if (values.length < 2) return;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  ctx.strokeStyle = opts.color || cssVar('--accent', '#0969da');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * (w - 2) + 1;
    const y = h - 3 - ((v - min) / span) * (h - 8);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}
