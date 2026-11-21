// Shared visual shell — dark "neon terminal" theme, modernised.
//
// Exported as a JS string (not a .css file) so the build can inline it into each
// page: the pages must run from file://, where a <link> to a sibling file is
// fine but fetch() is not, and keeping the palette in one module means one place
// to change it.
//
// IMPORTANT: the canvas code (shell/chart.js, cache/ui.js, cache/channel-ui.js)
// reads these CSS custom properties at runtime via getComputedStyle — so the
// variable NAMES are an API. Change their values freely; keep the names.
//   --bg --panel --line --text --muted --accent --ok --err --warn --mono
// Everything else (--accent2, --glow, --sans, --maxw, --radius…) is theme-only.
//
// Type system: a system sans for reading (prose, controls), monospace for the
// "terminal" voice (nav, labels, numbers, code). No web fonts — every page must
// stay a single offline file.

export const SHELL_CSS = `
:root {
  color-scheme: dark;
  --bg: #070a10; --panel: #0d131d; --panel-2: #121a27; --line: #1f2b3d; --line-2: #2c3d55;
  --text: #d5e0ec; --text-hi: #f1f6fb; --muted: #7d91aa; --accent: #22d3ee; --accent2: #c04cff;
  --ok: #37f39a; --err: #ff3b6b; --warn: #ffb020;
  --glow: 0 0 0.5px currentColor, 0 0 8px rgba(34,211,238,0.35);
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, "Cascadia Code", "JetBrains Mono", Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
  --maxw: 1240px;
  --gutter: clamp(16px, 4vw, 32px);
  --radius: 12px;
  --nav-h: 56px;
  --ease: cubic-bezier(.2,.7,.2,1);
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; scroll-behavior: smooth; scroll-padding-top: calc(var(--nav-h) + 12px); }
body {
  margin: 0; min-height: 100vh; background: var(--bg); color: var(--text);
  font: 400 16px/1.65 var(--sans);
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  overflow-x: hidden;
}
/* ambient glow — a fixed layer instead of background-attachment:fixed (janky on iOS) */
body::after {
  content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background:
    radial-gradient(1100px 600px at 85% -10%, rgba(34,211,238,0.08), transparent 60%),
    radial-gradient(900px 520px at -10% 105%, rgba(192,76,255,0.07), transparent 60%);
}
/* faint scanlines — desktop only (full-screen blend layers cost scroll perf on phones) */
@media (min-width: 900px) and (prefers-reduced-motion: no-preference) {
  body::before {
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 9999;
    background: repeating-linear-gradient(to bottom, rgba(255,255,255,0.014) 0 1px, transparent 1px 3px);
  }
}
::selection { background: rgba(34,211,238,0.3); color: #fff; }
img, svg, canvas { max-width: 100%; }
a { color: var(--accent); text-decoration: none; text-underline-offset: 3px; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

.skip {
  position: absolute; left: 12px; top: -60px; z-index: 100; padding: 8px 14px;
  background: var(--accent); color: #001014; font-weight: 700; border-radius: 8px;
}
.skip:focus { top: 10px; text-decoration: none; }

/* ---- site chrome ---- */
.sitenav {
  position: sticky; top: 0; z-index: 50;
  background: rgba(7,10,16,0.72);
  -webkit-backdrop-filter: saturate(160%) blur(14px); backdrop-filter: saturate(160%) blur(14px);
  border-bottom: 1px solid var(--line);
}
.sitenav-inner {
  max-width: var(--maxw); margin: 0 auto; height: var(--nav-h);
  display: flex; align-items: center; gap: 20px; padding: 0 var(--gutter);
}
.sitenav a { text-decoration: none; }
.brand { display: inline-flex; align-items: center; gap: 10px; color: var(--text-hi); font: 700 14px/1 var(--mono); letter-spacing: -0.01em; flex: none; }
.brand .logo {
  width: 20px; height: 20px; border-radius: 5px; flex: none;
  background:
    linear-gradient(var(--accent),var(--accent)) 0 0 / 9px 9px no-repeat,
    linear-gradient(var(--accent2),var(--accent2)) 100% 100% / 9px 9px no-repeat;
  filter: drop-shadow(0 0 6px rgba(34,211,238,0.45));
}
.navlinks { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.navlinks::-webkit-scrollbar { display: none; }
.navlinks a {
  color: var(--muted); font: 500 13px/1 var(--sans); white-space: nowrap;
  padding: 9px 12px; border-radius: 8px; transition: color .15s, background .15s;
}
.navlinks a:hover { color: var(--text-hi); background: rgba(255,255,255,0.04); }
.navlinks a.on { color: var(--text-hi); background: rgba(34,211,238,0.1); box-shadow: inset 0 0 0 1px rgba(34,211,238,0.25); }
.ghlink {
  display: inline-flex; align-items: center; gap: 8px; flex: none;
  border: 1px solid var(--line-2); border-radius: 999px; padding: 7px 14px;
  color: var(--text); font: 500 13px/1 var(--sans); transition: border-color .15s, color .15s, background .15s;
}
.ghlink:hover { border-color: var(--accent); color: var(--accent); background: rgba(34,211,238,0.06); }

header.page {
  max-width: var(--maxw); margin: 0 auto;
  padding: clamp(28px, 5vw, 48px) var(--gutter) clamp(18px, 3vw, 28px);
}
header.page h1 {
  margin: 0; font: 700 clamp(26px, 4.2vw, 40px)/1.15 var(--sans); letter-spacing: -0.025em; color: var(--text-hi);
  text-wrap: balance;
}
header.page h1::before { content: "$ "; font-family: var(--mono); color: var(--accent); text-shadow: var(--glow); font-weight: 600; }
header.page p { margin: 10px 0 0; color: var(--muted); font-size: clamp(15px, 1.6vw, 17px); max-width: 760px; text-wrap: pretty; }
.eyebrow {
  display: inline-block; margin-bottom: 12px; font: 600 11px/1 var(--mono); letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--accent);
}

/* ---- two-column demo layout ---- */
.wrap {
  max-width: var(--maxw); margin: 0 auto; padding: 0 var(--gutter) 8px;
  display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 20px; align-items: start;
}
.panel {
  padding: 20px; border: 1px solid var(--line); border-radius: var(--radius);
  background: linear-gradient(180deg, rgba(18,26,39,0.75), rgba(13,19,29,0.55));
}
/* keep the controls in view while the results scroll — only where the whole panel fits */
@media (min-width: 961px) and (min-height: 860px) {
  .panel { position: sticky; top: calc(var(--nav-h) + 16px); }
}
.stage { display: flex; flex-direction: column; gap: 14px; min-width: 0; }

fieldset { border: 0; padding: 0; margin: 0 0 20px; min-width: 0; }
legend {
  padding: 0; margin-bottom: 12px; font: 700 11px/1 var(--mono);
  text-transform: uppercase; letter-spacing: 0.14em; color: var(--accent);
}
legend::before { content: "// "; opacity: 0.6; }
label { display: block; margin-bottom: 12px; font-size: 13px; color: var(--muted); }
label span { display: block; margin-bottom: 6px; }
label.inline { display: flex; align-items: center; gap: 10px; cursor: pointer; color: var(--text); }
label.inline span { margin: 0; }
label.inline input { width: 18px; height: 18px; min-height: 0; flex: none; accent-color: var(--accent); margin: 0; }
input, select, button, textarea {
  width: 100%; min-height: 42px; padding: 9px 12px; background: var(--bg); color: var(--text-hi);
  border: 1px solid var(--line-2); border-radius: 10px; font: inherit; font-size: 14px;
  transition: border-color .15s, box-shadow .15s, background .15s, color .15s;
}
select {
  appearance: none; -webkit-appearance: none; padding-right: 34px; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5l5 5 5-5' fill='none' stroke='%237d91aa' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 12px center;
}
input[type="range"] { padding: 0; min-height: 28px; border: 0; background: transparent; accent-color: var(--accent); }
input:hover:not(:disabled), select:hover:not(:disabled) { border-color: #3b506d; }
input:focus, select:focus, textarea:focus {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(34,211,238,0.18);
}
input:disabled, select:disabled { opacity: 0.5; cursor: not-allowed; }
button {
  cursor: pointer; font: 600 13px/1 var(--sans); letter-spacing: 0.02em;
  background: var(--panel-2); color: var(--text);
}
button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
button:active:not(:disabled) { transform: translateY(1px); }
button:disabled { opacity: 0.4; cursor: not-allowed; }
button.primary {
  background: linear-gradient(135deg, #22d3ee, #3aa8ff 60%, #8b5cf6);
  border-color: transparent; color: #001018; font-weight: 700;
  box-shadow: 0 6px 20px -6px rgba(34,211,238,0.55), inset 0 1px 0 rgba(255,255,255,0.25);
}
button.primary:hover:not(:disabled) { color: #001018; filter: brightness(1.08); box-shadow: 0 8px 26px -6px rgba(34,211,238,0.7), inset 0 1px 0 rgba(255,255,255,0.3); }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

/* ---- link-styled buttons (hero CTAs) ---- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 46px;
  padding: 12px 22px; border-radius: 999px; font: 600 15px/1 var(--sans); text-decoration: none;
  border: 1px solid var(--line-2); color: var(--text-hi); background: rgba(255,255,255,0.03);
  transition: transform .2s var(--ease), box-shadow .2s, border-color .2s, background .2s;
}
.btn:hover { text-decoration: none; border-color: var(--accent); background: rgba(34,211,238,0.07); transform: translateY(-1px); }
.btn.primary {
  border-color: transparent; color: #001018;
  background: linear-gradient(135deg, #22d3ee, #3aa8ff 60%, #8b5cf6);
  box-shadow: 0 10px 30px -10px rgba(34,211,238,0.7), inset 0 1px 0 rgba(255,255,255,0.25);
}
.btn.primary:hover { filter: brightness(1.08); }
.btn .arr { transition: transform .2s var(--ease); }
.btn:hover .arr { transform: translateX(3px); }

/* ---- stats strip ---- */
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.stat {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px;
  position: relative; overflow: hidden; min-width: 0;
}
.stat::before {
  content: ""; position: absolute; inset: 0 0 auto 0; height: 2px;
  background: linear-gradient(90deg, var(--accent), transparent); opacity: 0.7;
}
.stat b {
  display: block; font: 700 clamp(18px, 2vw, 22px)/1.25 var(--mono); font-variant-numeric: tabular-nums;
  color: var(--text-hi); overflow-wrap: anywhere;
}
.stat span { display: block; margin-top: 4px; font: 600 10px/1.3 var(--mono); text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); }

/* ---- canvas surfaces ---- */
.canvasBox {
  flex: 1; min-height: 300px; background: var(--panel);
  border: 1px solid var(--line); border-radius: var(--radius); padding: 10px;
}
.canvasBox.fixed { flex: none; }
.canvasBox canvas { width: 100%; height: 100%; display: block; }
.chartBox { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; min-width: 0; }
.chartBox b { display: block; margin-bottom: 6px; font: 600 10px/1.3 var(--mono); text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); }
.chartBox canvas { width: 100%; display: block; }

/* live vs simulated provenance badge */
.srcbadge {
  display: inline-flex; align-self: flex-start; align-items: center; max-width: 100%;
  font: 700 11px/1.35 var(--mono); letter-spacing: 0.05em;
  text-transform: uppercase; padding: 7px 14px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--panel);
}
.srcbadge.live { color: var(--ok); border-color: rgba(55,243,154,0.6); background: rgba(55,243,154,0.07); box-shadow: 0 0 14px rgba(55,243,154,0.22); }
.srcbadge.sim { color: var(--warn); border-color: rgba(255,176,32,0.55); background: rgba(255,176,32,0.06); }

.status { font: 13px/1.6 var(--mono); color: var(--muted); min-height: 20px; overflow-wrap: anywhere; }
.status::before { content: "> "; color: var(--accent); }
.status:empty::before { content: none; }
.status.ok { color: var(--ok); } .status.ok::before { color: var(--ok); }
.status.err { color: var(--err); } .status.err::before { color: var(--err); }
.status.warn { color: var(--warn); } .status.warn::before { color: var(--warn); }

.legendkey { display: flex; gap: 8px 18px; font-size: 13px; color: var(--muted); align-items: center; flex-wrap: wrap; }
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: 0; box-shadow: 0 0 6px currentColor; }
.note { font-size: 13px; color: var(--muted); margin: 16px 0 0; padding-top: 16px; border-top: 1px solid var(--line); }
code {
  font-family: var(--mono); font-size: 0.86em; background: var(--panel-2); color: var(--accent);
  padding: 0.12em 0.42em; border-radius: 6px; border: 1px solid var(--line); overflow-wrap: anywhere;
}
footer.site code { background: var(--panel-2); }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }

/* ---- prose (landing + explainers) ---- */
.prose { max-width: 760px; margin: 0 auto; padding: clamp(28px, 5vw, 48px) var(--gutter) 72px; }
.prose > :first-child { margin-top: 0; }
.prose h2 {
  font: 700 clamp(21px, 2.6vw, 26px)/1.25 var(--sans); letter-spacing: -0.02em;
  margin: 2.2em 0 0.6em; color: var(--text-hi); text-wrap: balance;
}
.prose h2::before { content: "## "; font-family: var(--mono); font-size: 0.8em; color: var(--accent); opacity: 0.75; }
.prose h3 { font: 700 12px/1.4 var(--mono); margin: 2.2em 0 0.8em; color: var(--accent); text-transform: uppercase; letter-spacing: 0.12em; }
.prose p { margin: 0 0 1.05em; color: var(--text); text-wrap: pretty; }
.prose ul, .prose ol { margin: 0 0 1.1em; padding-left: 1.3em; }
.prose li { margin-bottom: 0.55em; }
.prose li::marker { color: var(--accent); }
.prose em { color: var(--text-hi); font-style: italic; }
.prose strong { color: var(--text-hi); font-weight: 650; }
.prose a { text-decoration: underline; text-decoration-color: rgba(34,211,238,0.4); }
.prose a:hover { text-decoration-color: var(--accent); }
.prose table {
  border-collapse: separate; border-spacing: 0; font-size: 14px; margin: 8px 0 22px; width: 100%;
  border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden;
}
.prose th, .prose td { border-bottom: 1px solid var(--line); padding: 10px 14px; text-align: left; vertical-align: top; }
.prose tr:last-child > * { border-bottom: 0; }
.prose th + td, .prose td + td, .prose th + th { border-left: 1px solid var(--line); }
.prose th { background: var(--panel); font: 600 11px/1.4 var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
.prose td.num { font-variant-numeric: tabular-nums; font-family: var(--mono); font-size: 13px; color: var(--accent); }
.tablewrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 8px 0 22px; }
.tablewrap table { margin: 0; }

/* ---- landing cards ---- */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 16px; margin: 28px 0 8px; }
.card {
  border: 1px solid var(--line); border-radius: 16px; padding: 22px 22px 20px;
  background: linear-gradient(180deg, rgba(18,26,39,0.9), rgba(10,15,23,0.7)); color: inherit; display: flex; flex-direction: column;
  position: relative; overflow: hidden; text-decoration: none !important;
  transition: border-color .2s, box-shadow .25s var(--ease), transform .25s var(--ease);
}
.card::after {
  content: ""; position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity .25s;
  background: radial-gradient(400px 160px at 20% 0%, rgba(34,211,238,0.12), transparent 70%);
}
.card:hover { border-color: rgba(34,211,238,0.6); box-shadow: 0 18px 40px -20px rgba(34,211,238,0.45); transform: translateY(-3px); }
.card:hover::after { opacity: 1; }
.card h3 { margin: 0 0 8px; font: 700 18px/1.3 var(--sans); letter-spacing: -0.01em; color: var(--text-hi); text-transform: none; }
.card h3 .arr { color: var(--accent); margin-left: 4px; display: inline-block; transition: transform .2s var(--ease); }
.card:hover h3 .arr { transform: translateX(4px); }
.card p { margin: 0 0 16px; font-size: 15px; color: var(--muted); flex: 1; }
.card .tags { display: flex; gap: 6px; flex-wrap: wrap; }
.card .tag {
  font: 600 10px/1 var(--mono); text-transform: uppercase; letter-spacing: 0.08em;
  border: 1px solid var(--line-2); border-radius: 999px; padding: 6px 10px; color: var(--muted); background: rgba(7,10,16,0.6);
}

.callout {
  border: 1px solid rgba(34,211,238,0.22); border-left: 3px solid var(--accent);
  background: linear-gradient(90deg, rgba(34,211,238,0.07), rgba(34,211,238,0.015));
  padding: 16px 18px; margin: 24px 0; font-size: 15px; border-radius: 10px;
}
.callout.warn { border-color: rgba(255,176,32,0.25); border-left-color: var(--warn); background: linear-gradient(90deg, rgba(255,176,32,0.08), rgba(255,176,32,0.015)); }
.callout.danger { border-color: rgba(255,59,107,0.25); border-left-color: var(--err); background: linear-gradient(90deg, rgba(255,59,107,0.08), rgba(255,59,107,0.015)); }
.callout p:last-child { margin-bottom: 0; }
.callout strong { color: #fff; }

/* chips for the honest-framing banner */
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 22px 0 0; }
.chip {
  font-size: 13px; color: var(--muted); line-height: 1.35;
  border: 1px solid var(--line); border-radius: 999px; padding: 7px 13px; background: rgba(13,19,29,0.75);
}
.chip b { color: var(--ok); font: 700 12px/1 var(--mono); }

.lede { font-size: clamp(17px, 1.9vw, 19px); line-height: 1.65; color: #dfe8f2; }

footer.site { border-top: 1px solid var(--line); margin-top: 24px; background: rgba(7,10,16,0.6); }
.footer-inner { max-width: var(--maxw); margin: 0 auto; padding: 28px var(--gutter) 36px; color: var(--muted); font-size: 14px; }
.footer-inner p { margin: 0 0 6px; max-width: 760px; }
.footer-inner strong { color: var(--text); font-family: var(--mono); font-weight: 600; }
.footer-inner .fine { margin-top: 14px; font-size: 13px; }

/* ---- responsive ---- */
@media (max-width: 960px) {
  .wrap { grid-template-columns: minmax(0, 1fr); }
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
}
@media (max-width: 640px) {
  :root { --nav-h: 52px; }
  .brand-text { display: none; }
  .sitenav-inner { gap: 10px; }
  .navlinks a { padding: 9px 10px; }
  .ghlink { padding: 8px; }
  .ghlink span { display: none; }
  /* 16px stops iOS Safari zooming the page when a field is focused */
  input, select, textarea { font-size: 16px; }
  button, input, select { min-height: 44px; }
  .prose table { font-size: 13px; }
  .prose th, .prose td { padding: 9px 10px; }
  .stat { padding: 12px 13px; }
}
@media (hover: none) {
  .card:hover, .btn:hover { transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
}
`;
