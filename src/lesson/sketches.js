// Animated p5.js sketches for the lesson page (instance mode, so nothing
// leaks into the global scope of the bundled page).
//
// These are ILLUSTRATIONS with round numbers, not measurements: the real data
// lives in the interactive tools and the lab notes. Each sketch:
//   - pauses whenever it's scrolled off-screen (several canvases, one page)
//   - starts paused under prefers-reduced-motion, with a Play button
//   - sits on top of a static SVG fallback that shows if p5 can't run.
//
// Only the pure model below is exported (for tests); the bundler strips the
// `export` keyword and everything else stays inside one IIFE.

// Illustrative cache levels, loosely based on my laptop (Apple A18 Pro).
export const LESSON_LEVELS = [
  { name: 'L1', bytes: 128 * 1024, ns: 1 },
  { name: 'L2', bytes: 16 * 1024 * 1024, ns: 5 },
  { name: 'SLC', bytes: 24 * 1024 * 1024, ns: 20 },
  { name: 'DRAM', bytes: Infinity, ns: 80 },
];

// For a random walk over `workingSet` bytes, roughly what share of reads each
// level serves: a level holding C bytes can keep min(1, C / W) of the set.
export function lessonServed(workingSet, levels = LESSON_LEVELS) {
  const out = [];
  let prev = 0;
  for (const lv of levels) {
    const cum = Math.min(1, lv.bytes / workingSet);
    out.push(Math.max(0, cum - prev));
    prev = Math.max(prev, cum);
  }
  return out;
}

export function lessonExpectedNs(workingSet, levels = LESSON_LEVELS) {
  return lessonServed(workingSet, levels).reduce((s, f, i) => s + f * levels[i].ns, 0);
}

(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function theme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => (cs.getPropertyValue(n).trim() || d);
    return {
      bg: v('--bg', '#070a10'), panel: v('--panel', '#0d131d'), line: v('--line', '#1f2b3d'),
      line2: v('--line-2', '#2c3d55'), text: v('--text', '#d5e0ec'), hi: v('--text-hi', '#f1f6fb'),
      muted: v('--muted', '#7d91aa'), accent: v('--accent', '#22d3ee'), accent2: v('--accent2', '#c04cff'),
      ok: v('--ok', '#37f39a'), err: v('--err', '#ff3b6b'), warn: v('--warn', '#ffb020'),
      // p5 quotes a comma-separated stack (breaking it), so use bare generics.
      mono: 'monospace',
      sans: 'sans-serif',
    };
  }

  const fmtBytes = (b) =>
    b >= 1024 * 1024 * 1024 ? (b / 1024 ** 3).toFixed(0) + ' GB'
      : b >= 1024 * 1024 ? (b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0).replace(/\.0$/, '') + ' MB'
        : (b / 1024).toFixed(0) + ' KB';

  // Mount a sketch into <figure class="sketch" id=…>, wire Play/Pause, and
  // only run the draw loop while the figure is on screen.
  function mount(id, factory) {
    const host = document.getElementById(id);
    if (!host || typeof p5 === 'undefined') return null;
    const box = host.querySelector('.sk-canvas');
    host.classList.add('has-sketch');
    let inst;
    try {
      inst = new p5((p) => factory(p, box, host), box);
    } catch (e) {
      host.classList.remove('has-sketch');
      return null;
    }
    const btn = host.querySelector('[data-sk="play"]');
    let playing = !REDUCED;
    let visible = false;
    const sync = () => {
      if (playing && visible) inst.loop(); else inst.noLoop();
      if (btn) {
        btn.textContent = playing ? '❚❚ Pause' : '▶ Play';
        btn.setAttribute('aria-pressed', String(!playing));
      }
    };
    if (btn) btn.addEventListener('click', () => { playing = !playing; sync(); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((es) => { visible = es[0].isIntersecting; sync(); }, { rootMargin: '80px' }).observe(host);
    } else { visible = true; }
    sync();
    // Keep the canvas the width of its column (rotation, window resize).
    if ('ResizeObserver' in window) {
      let last = box.clientWidth;
      new ResizeObserver(() => {
        const w = box.clientWidth;
        if (Math.abs(w - last) < 2) return;
        last = w;
        if (inst._resize) inst._resize(w);
        inst.redraw();
      }).observe(box);
    }
    return inst;
  }

  // Seconds since the last frame, capped so a paused or backgrounded sketch
  // doesn't jump when it resumes.
  const dt = (p) => Math.min(0.05, (p.deltaTime || 16) / 1000);

  // ===================================================================
  // 1. The memory hierarchy, in 3D. Drag sideways to turn it. A read drops
  //    from the core until some level has the data, then climbs back.
  // ===================================================================
  function hierarchy(p, box, host) {
    const LV = [
      { name: 'registers', size: '~1 KB', lat: '<1 ns', t: 0.25 },
      { name: 'L1 cache', size: 'tens of KB', lat: '~1 ns', t: 0.35 },
      { name: 'L2 cache', size: 'a few MB', lat: '~5 ns', t: 0.6 },
      { name: 'L3 / system-level cache', size: 'tens of MB', lat: '~10–30 ns', t: 1.0 },
      { name: 'main memory (DRAM)', size: 'many GB', lat: '~80+ ns', t: 1.9 },
    ];
    const H = 400;
    let T, W, yaw = -0.6, spin = 0.25, dragX = null, tex = [];
    let req = { level: 2, phase: 0, k: 0 }; // phase 0 = down, 1 = hold, 2 = up
    const status = host.querySelector('.sk-status');

    function makeLabel(lv, hot) {
      const g = p.createGraphics(640, 92);
      g.pixelDensity(2);
      g.clear();
      g.textFont(T.sans);
      g.noStroke();
      g.fill(hot ? T.hi : T.text);
      g.textStyle(p.BOLD);
      g.textSize(30);
      g.textAlign(p.LEFT, p.TOP);
      g.text(lv.name, 8, 6);
      g.textStyle(p.NORMAL);
      g.textFont(T.mono);
      g.textSize(24);
      g.fill(hot ? T.accent : T.muted);
      g.text(lv.size + '  ·  ' + lv.lat, 8, 52);
      return g;
    }

    function pick() {
      // Mostly near hits, now and then a long trip — like real programs.
      const r = Math.random();
      return r < 0.35 ? 1 : r < 0.65 ? 2 : r < 0.85 ? 3 : 4;
    }

    p._resize = (w) => { W = w; p.resizeCanvas(W, H); };

    p.setup = () => {
      T = theme();
      W = box.clientWidth || 640;
      const c = p.createCanvas(W, H, p.WEBGL);
      p.pixelDensity(Math.min(2, window.devicePixelRatio || 1));
      tex = LV.map((lv) => [makeLabel(lv, false), makeLabel(lv, true)]);
      // Drag sideways to rotate; vertical swipes still scroll the page.
      const el = c.elt;
      el.style.touchAction = 'pan-y';
      el.addEventListener('pointerdown', (e) => { dragX = e.clientX; el.setPointerCapture(e.pointerId); spin = 0; });
      el.addEventListener('pointermove', (e) => {
        if (dragX === null) return;
        yaw += (e.clientX - dragX) * 0.01; dragX = e.clientX;
        if (!p.isLooping()) p.redraw();
      });
      const end = () => { dragX = null; spin = 0.25; };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    };

    p.draw = () => {
      const s = dt(p);
      p.clear();
      p.background(T.panel);
      p.ortho(-W / 2, W / 2, -H / 2, H / 2, -3000, 3000);
      // Stack on the left, labels on the right, at every width.
      const scale = Math.min(1, (W * 0.5) / 340);
      const stackX = -W / 2 + Math.max(W * 0.27, 170 * scale + 12);
      const pitch = -0.5;
      const gap = 62 * Math.max(0.8, scale);
      const y0 = -gap * 2;
      yaw += spin * s * 0.6;
      yaw = ((yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;

      // advance the read
      req.k += s / LV[Math.min(req.level, 4)].t / (req.phase === 1 ? 0.6 : 1);
      if (req.k >= 1) {
        req.k = 0;
        req.phase = (req.phase + 1) % 3;
        if (req.phase === 0) req.level = pick();
      }
      let ry;
      const target = y0 + req.level * gap;
      if (req.phase === 0) ry = p.lerp(y0 - gap * 0.9, target, easeInOut(req.k));
      else if (req.phase === 1) ry = target;
      else ry = p.lerp(target, y0 - gap * 0.9, easeInOut(req.k));
      const active = req.phase === 1 ? req.level : -1;
      if (status) {
        status.textContent = active >= 0
          ? `found in ${LV[active].name} · ${LV[active].lat}`
          : req.phase === 0 ? 'looking for the data…' : 'back to the core';
      }

      p.push();
      p.translate(stackX, 0, 0);
      p.rotateX(pitch);
      p.rotateY(yaw);
      p.ambientLight(140);
      p.directionalLight(255, 255, 255, 0.3, 0.6, -1);

      // the read, drawn first so the translucent slabs blend over it
      p.push();
      p.translate(0, ry, 0);
      p.noStroke();
      p.emissiveMaterial(T.warn);
      p.sphere(7 * Math.max(0.8, scale), 14, 10);
      p.pop();

      const c1 = p.color(T.accent), c2 = p.color(T.accent2);
      for (let i = 0; i < LV.length; i++) {
        const w = (54 + i * 66) * scale;
        const d = w * 0.62;
        const isDram = i === LV.length - 1;
        const col = isDram ? p.color(T.line2) : p.lerpColor(c1, c2, i / 3);
        col.setAlpha(i === active ? 235 : isDram ? 150 : 120);
        p.push();
        p.translate(0, y0 + i * gap, 0);
        p.fill(col);
        p.stroke(i === active ? T.hi : T.accent);
        p.strokeWeight(i === active ? 2 : 1);
        p.box(w, 30 * Math.max(0.8, scale), d);
        p.pop();
      }
      p.pop();

      // labels: screen-aligned, always readable
      const gl = p.drawingContext;
      gl.disable(gl.DEPTH_TEST);
      p.noLights();
      p.noStroke();
      for (let i = 0; i < LV.length; i++) {
        const y = (y0 + i * gap) * Math.cos(pitch);
        const lx0 = stackX + (54 + 4 * 66) * scale / 2 + 14;
        const lw = Math.min(280, W / 2 - lx0 - 8);
        const lh = lw * 92 / 640;
        p.push();
        p.translate(lx0 + lw / 2, y, 1);
        p.texture(tex[i][i === active ? 1 : 0]);
        p.plane(lw, lh);
        p.pop();
      }
      gl.enable(gl.DEPTH_TEST);
    };
  }

  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  // ===================================================================
  // 2. Stopwatch: grow the working set with the slider and watch where the
  //    reads have to go. One read at a time, like the pointer chase.
  // ===================================================================
  function stopwatch(p, box, host) {
    const H = 330;
    const slider = host.querySelector('input[type="range"]');
    const sizeOut = host.querySelector('.sk-size');
    let T, W;
    let read = null;
    let tally = [0, 0, 0, 0];
    const MIN = Math.log2(16 * 1024), MAX = Math.log2(256 * 1024 * 1024);
    const ws = () => Math.pow(2, MIN + (MAX - MIN) * (Number(slider ? slider.value : 40) / 100));

    p._resize = (w) => { W = w; p.resizeCanvas(W, H); };

    function stationX(i) {
      const xs = [0.27, 0.45, 0.64, 0.9];
      return 64 + (W - 100) * xs[i] * (W < 520 ? 0.98 : 1);
    }

    function newRead() {
      const served = lessonServed(ws());
      let r = Math.random(), i = 0;
      while (i < 3 && r > served[i]) { r -= served[i]; i++; }
      // Real trips differ ~80×; squash that so short trips are still visible.
      return { level: i, k: 0, dur: 0.18 + 0.03 * LESSON_LEVELS[i].ns };
    }

    p.setup = () => {
      T = theme();
      W = box.clientWidth || 640;
      p.createCanvas(W, H);
      p.pixelDensity(Math.min(2, window.devicePixelRatio || 1));
      p.textFont(T.mono);
      if (slider) slider.addEventListener('input', () => {
        tally = [0, 0, 0, 0];
        if (sizeOut) sizeOut.textContent = fmtBytes(ws());
        if (!p.isLooping()) p.redraw();
      });
      if (sizeOut) sizeOut.textContent = fmtBytes(ws());
      read = newRead();
    };

    p.draw = () => {
      const s = dt(p);
      p.background(T.panel);
      const W0 = ws();
      const served = lessonServed(W0);
      const exp = lessonExpectedNs(W0);
      const lane = 92;

      // core
      p.noStroke();
      p.fill(T.accent);
      p.rectMode(p.CENTER);
      p.rect(36, lane, 44, 44, 8);
      p.fill('#001018');
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(11);
      p.textStyle(p.BOLD);
      p.text('CPU', 36, lane);
      p.textStyle(p.NORMAL);

      // the road
      p.stroke(T.line2);
      p.strokeWeight(2);
      p.line(60, lane, stationX(3), lane);

      // stations, with a bar for the share of reads each one serves
      for (let i = 0; i < 4; i++) {
        const x = stationX(i);
        const lit = read && read.level === i;
        p.stroke(lit ? T.hi : T.line2);
        p.strokeWeight(lit ? 2 : 1);
        p.fill(i === 3 ? T.line : T.bg);
        p.rect(x, lane, 50, 40, 6);
        p.noStroke();
        p.fill(lit ? T.hi : T.text);
        p.textSize(12);
        p.text(LESSON_LEVELS[i].name, x, lane);
        p.fill(T.muted);
        p.textSize(10);
        p.text('~' + LESSON_LEVELS[i].ns + ' ns', x, lane + 34);
        const bh = 44 * served[i];
        p.fill(i === 3 ? T.err : T.accent);
        p.rectMode(p.CORNER);
        p.rect(x - 9, lane - 30 - bh, 18, bh, 3);
        p.rectMode(p.CENTER);
        p.fill(T.muted);
        if (served[i] > 0.005) p.text(Math.round(served[i] * 100) + '%', x, lane - 40 - bh);
      }

      // the read in flight
      if (read) {
        read.k += s / read.dur;
        if (read.k >= 1) { tally[read.level]++; read = newRead(); }
        const x1 = stationX(read.level);
        const k = read.k;
        const x = k < 0.5 ? p.lerp(60, x1 - 26, k * 2) : p.lerp(x1 - 26, 60, (k - 0.5) * 2);
        p.noStroke();
        p.fill(T.warn);
        p.circle(x, lane, 11);
        p.fill(p.color(255, 176, 32, 50));
        p.circle(x, lane, 22);
      }

      // the staircase this produces, with "you are here"
      const top = 188, bot = H - 30, left = 56, right = W - 20;
      p.stroke(T.line);
      p.strokeWeight(1);
      p.line(left, bot, right, bot);
      p.line(left, top, left, bot);
      const xOf = (b) => p.map(Math.log2(b), MIN, MAX, left, right);
      const yOf = (ns) => p.map(Math.log10(ns), 0, Math.log10(90), bot, top);
      p.noFill();
      p.stroke(T.accent);
      p.strokeWeight(2);
      p.beginShape();
      for (let i = 0; i <= 80; i++) {
        const b = Math.pow(2, MIN + (MAX - MIN) * i / 80);
        p.vertex(xOf(b), yOf(lessonExpectedNs(b)));
      }
      p.endShape();
      p.noStroke();
      p.fill(T.warn);
      p.circle(xOf(W0), yOf(exp), 10);
      p.fill(T.muted);
      p.textSize(10);
      p.textAlign(p.LEFT, p.BOTTOM);
      p.text('average time per read', left + 4, top - 4);
      p.textAlign(p.CENTER, p.TOP);
      for (const b of [16 * 1024, 1024 * 1024, 64 * 1024 * 1024]) p.text(fmtBytes(b), xOf(b), bot + 6);
      p.textAlign(p.RIGHT, p.TOP);
      p.text('working-set size →', right, bot + 18);
      p.textAlign(p.LEFT, p.CENTER);
      p.fill(T.hi);
      p.textSize(12);
      const lx = Math.min(xOf(W0) + 12, right - 92);
      p.text('≈ ' + exp.toFixed(exp < 10 ? 1 : 0) + ' ns', lx, yOf(exp) - 12);
    };
  }

  // ===================================================================
  // 3. Straight walk vs pointer chase, side by side, on one shared clock.
  // ===================================================================
  function walker(p, box, host) {
    const COLS = 12, ROWS = 6, N = COLS * ROWS;
    const SIM_NS_PER_S = 100;         // 1 real second = 100 simulated ns
    const STRAIGHT_NS = 2;            // prefetched + overlapped: cheap
    const CHASE_NS = 80;              // every hop pays a trip to memory
    let T, W, H;
    let simNs, A, B;

    function reset() {
      simNs = 0;
      A = { i: 0, done: 0, heat: new Float32Array(N), acc: 0 };
      const order = [...Array(N).keys()];
      for (let i = N - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [order[i], order[j]] = [order[j], order[i]]; }
      B = { order, pos: 0, done: 0, k: 0, heat: new Float32Array(N), trail: [order[0]] };
    }
    const rst = host.querySelector('[data-sk="reset"]');
    if (rst) rst.addEventListener('click', () => { reset(); if (!p.isLooping()) p.redraw(); });

    const layout = () => {
      const stacked = W < 600;
      H = stacked ? 560 : 300;
      return stacked;
    };
    p._resize = (w) => { W = w; layout(); p.resizeCanvas(W, H); };

    p.setup = () => {
      T = theme();
      W = box.clientWidth || 640;
      layout();
      p.createCanvas(W, H);
      p.pixelDensity(Math.min(2, window.devicePixelRatio || 1));
      p.textFont(T.mono);
      reset();
    };

    function grid(ox, oy, gw, heat, color, current, ahead) {
      const cw = gw / COLS, ch = Math.min(cw, 26);
      for (let n = 0; n < N; n++) {
        const cx = ox + (n % COLS) * cw, cy = oy + Math.floor(n / COLS) * ch;
        const h = heat[n];
        const c = p.color(color);
        c.setAlpha(30 + 200 * h);
        p.noStroke();
        p.fill(h > 0.02 ? c : T.bg);
        p.rect(cx + 1.5, cy + 1.5, cw - 3, ch - 3, 3);
        if (ahead && ahead.includes(n)) {
          p.noFill();
          p.stroke(T.warn);
          p.strokeWeight(1.5);
          p.rect(cx + 2, cy + 2, cw - 4, ch - 4, 3);
        }
        if (n === current) {
          p.noFill();
          p.stroke(T.hi);
          p.strokeWeight(2);
          p.rect(cx + 1, cy + 1, cw - 2, ch - 2, 4);
        }
      }
      return { cw, ch };
    }
    const center = (ox, oy, g, n) => [ox + (n % COLS + 0.5) * g.cw, oy + (Math.floor(n / COLS) + 0.5) * g.ch];

    p.draw = () => {
      const s = dt(p);
      const stacked = layout();
      p.background(T.panel);
      const step = s * SIM_NS_PER_S;
      simNs += step;

      // straight walk: a new read finishes every STRAIGHT_NS
      A.acc += step;
      while (A.acc >= STRAIGHT_NS) { A.acc -= STRAIGHT_NS; A.i = (A.i + 1) % N; A.done++; A.heat[A.i] = 1; }
      // pointer chase: one hop at a time, each a full trip
      B.k += step / CHASE_NS;
      while (B.k >= 1) {
        B.k -= 1; B.done++;
        B.pos = (B.pos + 1) % N;
        const n = B.order[B.pos];
        B.heat[n] = 1;
        B.trail.push(n); if (B.trail.length > 7) B.trail.shift();
      }
      for (let n = 0; n < N; n++) { A.heat[n] *= Math.pow(0.25, s); B.heat[n] *= Math.pow(0.6, s); }

      const pad = 18;
      const gw = stacked ? W - pad * 2 : (W - pad * 3) / 2;
      const panels = stacked
        ? [[pad, 40], [pad, 40 + H / 2]]
        : [[pad, 40], [pad * 2 + gw, 40]];

      // headings
      p.noStroke();
      p.textAlign(p.LEFT, p.BASELINE);
      p.textSize(12);
      p.fill(T.hi);
      p.text('Straight walk', panels[0][0], panels[0][1] - 14);
      p.text('Pointer chase', panels[1][0], panels[1][1] - 14);
      p.fill(T.muted);
      p.textSize(10);
      p.text('prefetched + overlapped', panels[0][0] + 108, panels[0][1] - 14);
      p.text('one read at a time', panels[1][0] + 108, panels[1][1] - 14);

      const ahead = [1, 2, 3, 4, 5, 6].map((d) => (A.i + d) % N);
      const gA = grid(panels[0][0], panels[0][1], gw, A.heat, T.err, A.i, ahead);
      const cur = B.order[B.pos];
      const gB = grid(panels[1][0], panels[1][1], gw, B.heat, T.accent, cur, null);

      // chase: the hops it took, and a ring filling while it waits on memory
      p.noFill();
      for (let t = 1; t < B.trail.length; t++) {
        const [x0, y0] = center(panels[1][0], panels[1][1], gB, B.trail[t - 1]);
        const [x1, y1] = center(panels[1][0], panels[1][1], gB, B.trail[t]);
        const c = p.color(T.accent); c.setAlpha(40 + 200 * t / B.trail.length);
        p.stroke(c); p.strokeWeight(1.5);
        p.line(x0, y0, x1, y1);
      }
      const [cx, cy] = center(panels[1][0], panels[1][1], gB, cur);
      p.stroke(T.warn); p.strokeWeight(3);
      p.arc(cx, cy, gB.ch * 1.3, gB.ch * 1.3, -p.HALF_PI, -p.HALF_PI + p.TWO_PI * B.k);

      // counters
      const rows = ROWS * Math.min(gw / COLS, 26);
      p.noStroke();
      p.textSize(12);
      const stat = (x, y, done, per, col) => {
        p.fill(col); p.text(String(done).padStart(4, ' ') + ' reads', x, y);
        p.fill(T.muted); p.text('~' + per + ' ns each', x + 104, y);
      };
      stat(panels[0][0], panels[0][1] + rows + 24, A.done, STRAIGHT_NS, T.err);
      stat(panels[1][0], panels[1][1] + rows + 24, B.done, CHASE_NS, T.accent);
      p.fill(T.muted);
      p.textSize(10);
      p.text('amber = already fetched before it was asked for', panels[0][0], panels[0][1] + rows + 42);
      p.text('ring = waiting for memory before the next hop', panels[1][0], panels[1][1] + rows + 42);
    };
  }

  // ===================================================================
  // 4. The covert channel: the sender floods the shared cache to send a 1,
  //    the receiver notices its own lines got evicted and its reads slowed.
  // ===================================================================
  function channel(p, box, host) {
    const MSG = 'hi';
    const bits = [];
    for (const ch of MSG) for (let b = 7; b >= 0; b--) bits.push((ch.charCodeAt(0) >> b) & 1);
    const chips = [];
    for (const b of bits) chips.push(...(b ? [1, 0] : [0, 1]));
    const GAP = 4;                    // idle chips between repeats
    const CHIP_S = 0.75;
    const COLS = 16, ROWS = 6, N = COLS * ROWS;
    const H = 380;
    let T, W, t, owner, mine, parts, trace, chipMeans, decoded;

    function reset() {
      t = 0;
      owner = new Uint8Array(N);       // 0 = other, 1 = receiver, 2 = sender
      mine = [];
      const idx = [...Array(N).keys()].sort(() => Math.random() - 0.5);
      for (let i = 0; i < 36; i++) { owner[idx[i]] = 1; mine.push(idx[i]); }
      parts = []; trace = []; chipMeans = []; decoded = [];
    }
    p._resize = (w) => { W = w; p.resizeCanvas(W, H); };

    p.setup = () => {
      T = theme();
      W = box.clientWidth || 640;
      p.createCanvas(W, H);
      p.pixelDensity(Math.min(2, window.devicePixelRatio || 1));
      p.textFont(T.mono);
      reset();
    };

    p.draw = () => {
      const s = dt(p);
      t += s;
      const total = chips.length + GAP;
      const ci = Math.floor(t / CHIP_S);
      if (ci >= total) { reset(); return; }
      const inMsg = ci < chips.length;
      const busy = inMsg && chips[ci] === 1;
      const narrow = W < 700;

      const gx0 = narrow ? 16 : W * 0.24, gx1 = narrow ? W - 16 : W * 0.76;
      const gy0 = narrow ? 92 : 70;
      const cw = (gx1 - gx0) / COLS, chh = Math.min(cw, 18);
      const cellXY = (n) => [gx0 + (n % COLS + 0.5) * cw, gy0 + (Math.floor(n / COLS) + 0.5) * chh];
      const sender = narrow ? [W * 0.25, 52] : [W * 0.11, gy0 + ROWS * chh / 2];
      const recv = narrow ? [W * 0.75, 52] : [W * 0.89, gy0 + ROWS * chh / 2];

      // sender: while sending a 1, fire lines into random cache slots
      if (busy) {
        const rate = 240 * s;
        for (let k = 0; k < rate + (Math.random() < rate % 1 ? 1 : 0); k++) {
          const n = (Math.random() * N) | 0;
          parts.push({ x: sender[0], y: sender[1], n, vx: (Math.random() - 0.5) * 60, vy: (Math.random() - 0.5) * 60, who: 2 });
        }
      } else {
        // receiver: its probe pulls its evicted lines back in
        let need = Math.max(1, Math.round(110 * s));
        for (const n of mine) {
          if (need <= 0) break;
          if (owner[n] !== 1 && !parts.some((q) => q.n === n && q.who === 1)) {
            parts.push({ x: recv[0], y: recv[1], n, vx: 0, vy: 0, who: 1 }); need--;
          }
        }
      }
      // particles steer towards their slot (a little Nature of Code)
      for (const q of parts) {
        const [tx, ty] = cellXY(q.n);
        const dx = tx - q.x, dy = ty - q.y;
        const d = Math.hypot(dx, dy) || 1;
        const sp = q.who === 2 ? 900 : 800;
        q.vx += ((dx / d) * sp - q.vx) * Math.min(1, 10 * s);
        q.vy += ((dy / d) * sp - q.vy) * Math.min(1, 10 * s);
        q.x += q.vx * s; q.y += q.vy * s;
        if (d < 10) { owner[q.n] = q.who; q.dead = true; }
      }
      parts = parts.filter((q) => !q.dead).slice(-400);

      // the receiver's view: the more of its lines are gone, the slower it reads
      let gone = 0;
      for (const n of mine) if (owner[n] !== 1) gone++;
      const lat = 9 + 81 * (gone / mine.length) + (Math.random() - 0.5) * 4;
      trace.push({ ci, lat });
      if (trace.length > 600) trace.shift();
      // decide each finished chip from its later part
      if (inMsg && chipMeans.length < ci) {
        const c = chipMeans.length;
        const xs = trace.filter((e) => e.ci === c).map((e) => e.lat);
        const tail = xs.slice(Math.floor(xs.length * 0.4));
        chipMeans.push(tail.reduce((a, b) => a + b, 0) / Math.max(1, tail.length));
        if (chipMeans.length % 2 === 0) {
          const a = chipMeans[chipMeans.length - 2], b = chipMeans[chipMeans.length - 1];
          decoded.push(a > b ? 1 : 0);
        }
      }

      p.background(T.panel);

      // boxes
      p.rectMode(p.CENTER);
      p.textAlign(p.CENTER, p.CENTER);
      const boxW = narrow ? Math.min(150, W * 0.42) : W * 0.17;
      p.strokeWeight(busy ? 2 : 1);
      p.stroke(busy ? T.accent2 : T.line2);
      p.fill(T.bg);
      p.rect(sender[0], sender[1], boxW, 46, 8);
      p.stroke(T.line2); p.strokeWeight(1);
      p.rect(recv[0], recv[1], boxW, 46, 8);
      p.noStroke();
      p.textSize(11);
      p.fill(T.accent2); p.text('SENDER', sender[0], sender[1] - 9);
      p.fill(T.accent); p.text('RECEIVER', recv[0], recv[1] - 9);
      p.textSize(10);
      p.fill(T.muted);
      p.text(busy ? 'flooding the cache → 1' : 'resting → 0', sender[0], sender[1] + 9);
      p.text('reads: ' + lat.toFixed(0) + ' ns', recv[0], recv[1] + 9);

      // shared cache
      p.rectMode(p.CORNER);
      p.noStroke();
      p.fill(T.muted);
      p.textSize(10);
      p.textAlign(p.LEFT, p.BOTTOM);
      p.text('SHARED CACHE', gx0, gy0 - 6);
      p.textAlign(p.RIGHT, p.BOTTOM);
      p.text(`receiver's lines still cached: ${mine.length - gone}/${mine.length}`, gx1, gy0 - 6);
      for (let n = 0; n < N; n++) {
        const [x, y] = cellXY(n);
        p.fill(owner[n] === 1 ? T.accent : owner[n] === 2 ? T.accent2 : T.line);
        if (owner[n] === 2) { const c = p.color(T.accent2); c.setAlpha(150); p.fill(c); }
        p.rect(x - cw / 2 + 1.5, y - chh / 2 + 1.5, cw - 3, chh - 3, 2);
      }
      for (const q of parts) {
        p.fill(q.who === 2 ? T.accent2 : T.accent);
        p.circle(q.x, q.y, 4);
      }

      // chip tape + decoded bits
      const ty = gy0 + ROWS * chh + 30;
      const tw = Math.min((W - 32) / chips.length, 16);
      const tx0 = (W - tw * chips.length) / 2;
      p.textAlign(p.LEFT, p.BOTTOM);
      p.fill(T.muted);
      p.text('each bit = two slots: busy-then-quiet is 1, quiet-then-busy is 0', tx0, ty - 4);
      for (let i = 0; i < chips.length; i++) {
        p.fill(chips[i] ? T.accent2 : T.line);
        if (i > ci) { const c = p.color(chips[i] ? T.accent2 : T.line); c.setAlpha(60); p.fill(c); }
        p.rect(tx0 + i * tw + 1, ty, tw - 2, 8, 2);
        if (i === ci) { p.noFill(); p.stroke(T.hi); p.rect(tx0 + i * tw, ty - 2, tw, 12, 2); p.noStroke(); }
      }
      p.textAlign(p.CENTER, p.TOP);
      p.textSize(Math.min(11, tw * 1.2));
      for (let b = 0; b < decoded.length; b++) {
        p.fill(decoded[b] === bits[b] ? T.ok : T.err);
        p.text(String(decoded[b]), tx0 + (b * 2 + 1) * tw, ty + 12);
      }

      // latency trace
      const py0 = ty + 40, py1 = H - 34;
      p.stroke(T.line); p.strokeWeight(1);
      p.line(16, py1, W - 16, py1);
      const yOf = (v) => p.map(v, 0, 100, py1, py0);
      p.drawingContext.setLineDash([4, 4]);
      p.line(16, yOf(50), W - 16, yOf(50));
      p.drawingContext.setLineDash([]);
      p.noFill(); p.stroke(T.accent); p.strokeWeight(1.5);
      p.beginShape();
      const n = trace.length;
      for (let i = 0; i < n; i++) p.vertex(p.map(i, 0, 599, 16, W - 16), yOf(trace[i].lat));
      p.endShape();
      p.noStroke(); p.fill(T.muted); p.textSize(10);
      p.textAlign(p.LEFT, p.BOTTOM);
      p.text("receiver's read time (slow = sender busy)", 16, py0 - 2);

      // the message so far
      let text = '';
      for (let i = 0; i + 8 <= decoded.length; i += 8) {
        let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | decoded[i + k];
        text += String.fromCharCode(v);
      }
      p.textAlign(p.RIGHT, p.BOTTOM);
      p.textSize(13);
      p.fill(T.hi);
      p.text(`sent "${MSG}" · received "${text}${decoded.length % 8 ? '…' : ''}"`, W - 16, H - 10);
    };
  }

  function init() {
    mount('sk-hier', hierarchy);
    mount('sk-stopwatch', stopwatch);
    mount('sk-walker', walker);
    mount('sk-channel', channel);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
