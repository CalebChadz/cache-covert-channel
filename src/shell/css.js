// Shared visual shell — dark "neon terminal" theme.
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
// The extra --accent2 / --glow are theme-only and not read by canvases.

export const SHELL_CSS = `
:root {
  color-scheme: dark;
  --bg: #080b12; --panel: #0e141f; --panel-2: #121b29; --line: #243247;
  --text: #cdd9e5; --muted: #6c819b; --accent: #22d3ee; --accent2: #c04cff;
  --ok: #37f39a; --err: #ff3b6b; --warn: #ffb020;
  --glow: 0 0 0.5px currentColor, 0 0 8px rgba(34,211,238,0.35);
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, "Cascadia Code", Consolas, monospace;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.55 var(--mono);
  background-image:
    radial-gradient(1200px 600px at 80% -10%, rgba(34,211,238,0.06), transparent 60%),
    radial-gradient(900px 500px at -10% 110%, rgba(192,76,255,0.05), transparent 60%);
  background-attachment: fixed;
}
/* faint scanlines over the whole page */
body::before {
  content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 9999;
  background: repeating-linear-gradient(to bottom, rgba(255,255,255,0.016) 0 1px, transparent 1px 3px);
  mix-blend-mode: overlay;
}
::selection { background: rgba(34,211,238,0.3); color: #fff; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-shadow: var(--glow); }

/* ---- site chrome ---- */
.sitenav {
  display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
  padding: 11px 24px; border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(18,27,41,0.9), rgba(8,11,18,0.7));
  backdrop-filter: blur(6px); position: sticky; top: 0; z-index: 50;
}
.sitenav .brand { font-weight: 700; letter-spacing: 0.02em; margin-right: 4px; }
.sitenav .brand a { color: var(--text); }
.sitenav .brand a::before { content: "▚ "; color: var(--accent); text-shadow: var(--glow); }
.sitenav a { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
.sitenav a:hover { color: var(--accent); }
.sitenav a.on { color: var(--text); }
.sitenav a.on::before { content: "› "; color: var(--accent); }
.sitenav .spacer { flex: 1; }
.sitenav .ghlink { border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; color: var(--muted); }
.sitenav .ghlink:hover { border-color: var(--accent); color: var(--accent); }

header.page { padding: 22px 24px 14px; border-bottom: 1px solid var(--line); position: relative; }
header.page h1 {
  margin: 0; font-size: 19px; font-weight: 700; letter-spacing: 0.01em; color: var(--text);
}
header.page h1::before { content: "$ "; color: var(--accent); text-shadow: var(--glow); }
header.page p { margin: 5px 0 0; color: var(--muted); font-size: 13px; }

/* ---- two-column demo layout ---- */
.wrap { display: grid; grid-template-columns: 300px 1fr; gap: 0; min-height: calc(100vh - 120px); }
.panel { padding: 20px 24px; border-right: 1px solid var(--line); background: rgba(14,20,31,0.4); }
.stage { padding: 20px 24px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }

fieldset { border: 0; padding: 0; margin: 0 0 20px; }
legend {
  padding: 0; margin-bottom: 9px; font-size: 10px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.14em; color: var(--accent);
}
legend::before { content: "// "; opacity: 0.6; }
label { display: block; margin-bottom: 11px; font-size: 12px; color: var(--muted); }
label span { display: block; margin-bottom: 4px; letter-spacing: 0.02em; }
label.inline { display: flex; align-items: center; gap: 8px; }
label.inline input { width: auto; accent-color: var(--accent); }
input, select, button, textarea {
  width: 100%; padding: 8px 10px; background: var(--panel); color: var(--text);
  border: 1px solid var(--line); border-radius: 6px; font: inherit; font-size: 13px;
}
input[type="range"] { padding: 0; accent-color: var(--accent); }
input:focus, select:focus, textarea:focus {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent), 0 0 10px rgba(34,211,238,0.25);
}
button { cursor: pointer; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; font-size: 12px; transition: box-shadow .15s, border-color .15s, color .15s; }
button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 10px rgba(34,211,238,0.2); }
button:disabled { opacity: 0.4; cursor: not-allowed; }
button.primary {
  background: linear-gradient(180deg, rgba(34,211,238,0.18), rgba(34,211,238,0.06));
  border-color: var(--accent); color: var(--accent); text-shadow: var(--glow);
}
button.primary:hover:not(:disabled) { box-shadow: 0 0 16px rgba(34,211,238,0.45); color: #c8fbff; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

/* ---- stats strip ---- */
.stats { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 10px; }
.stat {
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px;
  position: relative; overflow: hidden;
}
.stat::after { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--accent); opacity: 0.6; }
.stat b { display: block; font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text); }
.stat span { font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); }

/* ---- canvas surfaces ---- */
.canvasBox {
  flex: 1; min-height: 300px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 8px; padding: 8px;
}
.canvasBox.fixed { flex: none; }
.canvasBox canvas { width: 100%; height: 100%; display: block; }
.chartBox { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
.chartBox b { font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); font-weight: 700; }
.chartBox canvas { width: 100%; display: block; }

/* live vs simulated provenance badge */
.srcbadge {
  display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
  text-transform: uppercase; padding: 5px 12px; border-radius: 20px;
  border: 1px solid var(--line); background: var(--panel); margin-bottom: 2px;
}
.srcbadge.live { color: var(--ok); border-color: var(--ok); box-shadow: 0 0 12px rgba(55,243,154,0.3); }
.srcbadge.sim { color: var(--warn); border-color: var(--warn); }

.status { font-size: 13px; color: var(--muted); min-height: 20px; }
.status::before { content: "> "; color: var(--accent); }
.status.ok { color: var(--ok); } .status.ok::before { color: var(--ok); }
.status.err { color: var(--err); } .status.err::before { color: var(--err); }
.status.warn { color: var(--warn); } .status.warn::before { color: var(--warn); }

.legendkey { display: flex; gap: 14px; font-size: 12px; color: var(--muted); align-items: center; flex-wrap: wrap; }
.sw { display: inline-block; width: 11px; height: 11px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; box-shadow: 0 0 6px currentColor; }
.note { font-size: 12px; color: var(--muted); margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
.note code, code { font-family: var(--mono); font-size: 0.92em; background: var(--panel-2); color: var(--accent); padding: 1px 5px; border-radius: 4px; border: 1px solid var(--line); }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }

/* ---- prose (landing + explainers) ---- */
.prose { max-width: 760px; padding: 30px 24px 64px; }
.prose h2 { font-size: 15px; margin: 34px 0 9px; letter-spacing: 0.01em; color: var(--text); }
.prose h2::before { content: "## "; color: var(--accent); opacity: 0.7; }
.prose h3 { font-size: 12px; margin: 24px 0 7px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.1em; }
.prose p { margin: 0 0 13px; color: var(--text); }
.prose ul { margin: 0 0 13px; padding-left: 20px; }
.prose li { margin-bottom: 6px; }
.prose li::marker { color: var(--accent); }
.prose em { color: #e7eef6; font-style: normal; border-bottom: 1px dotted var(--muted); }
.prose strong { color: #fff; }
.prose table { border-collapse: collapse; font-size: 13px; margin: 6px 0 18px; width: 100%; }
.prose th, .prose td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; }
.prose th { background: var(--panel); font-weight: 600; color: var(--muted); text-transform: uppercase; font-size: 11px; letter-spacing: 0.06em; }
.prose td.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); color: var(--accent); }

/* ---- landing cards ---- */
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; margin: 20px 0 8px; }
.card {
  border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px;
  background: linear-gradient(180deg, var(--panel), rgba(8,11,18,0.6)); color: inherit; display: block;
  position: relative; transition: border-color .15s, box-shadow .15s, transform .15s;
}
.card:hover { border-color: var(--accent); box-shadow: 0 0 22px rgba(34,211,238,0.18); transform: translateY(-2px); }
.card h3 { margin: 0 0 6px; font-size: 14px; font-weight: 700; color: var(--text); text-transform: none; letter-spacing: 0; }
.card h3::before { content: "▶ "; color: var(--accent); font-size: 11px; }
.card p { margin: 0 0 12px; font-size: 13px; color: var(--muted); }
.card .tags { display: flex; gap: 6px; flex-wrap: wrap; }
.card .tag {
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em;
  border: 1px solid var(--line); border-radius: 20px; padding: 3px 9px; color: var(--muted); background: var(--bg);
}

.callout {
  border-left: 3px solid var(--accent); background: linear-gradient(90deg, rgba(34,211,238,0.07), transparent);
  padding: 13px 16px; margin: 18px 0; font-size: 13px; border-radius: 0 6px 6px 0;
}
.callout.warn { border-left-color: var(--warn); background: linear-gradient(90deg, rgba(255,176,32,0.08), transparent); }
.callout.danger { border-left-color: var(--err); background: linear-gradient(90deg, rgba(255,59,107,0.08), transparent); }
.callout p:last-child { margin-bottom: 0; }
.callout strong { color: #fff; }

/* chips for the honest-framing banner */
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 2px; }
.chip {
  font-size: 11px; letter-spacing: 0.04em; color: var(--muted);
  border: 1px solid var(--line); border-radius: 20px; padding: 4px 11px; background: var(--panel);
}
.chip b { color: var(--ok); font-weight: 700; }

.lede { font-size: 15px; line-height: 1.65; color: #dce6f1; }

footer.site {
  border-top: 1px solid var(--line); padding: 18px 24px; color: var(--muted); font-size: 12px;
}
footer.site code { background: var(--panel-2); }

@media (max-width: 820px) {
  .wrap { grid-template-columns: 1fr; }
  .panel { border-right: 0; border-bottom: 1px solid var(--line); }
  .stats { grid-auto-flow: row; grid-template-columns: repeat(2, 1fr); }
}
`;
