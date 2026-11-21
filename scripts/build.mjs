// Bundles each page into ONE self-contained HTML file in dist/.
//
// Why bundle: browsers refuse ES module imports and fetch() over file://, so a
// multi-file page would only work behind a web server. Inlining everything
// means every page in dist/ can be double-clicked, emailed, or published as-is.
// src/ stays modular so the node test suite can import it directly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { SHELL_CSS } from '../src/shell/css.js';
import { navHtml, footerHtml, headHtml } from '../src/shell/nav.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const readRoot = (...p) => read(root, ...p);

// Shared browser modules concatenated ahead of every page's own modules.
// Dependency order matters — these are concatenated, not resolved.
const SHELL_MODULES = ['src/shell/chart.js'];

const PAGES = [
  { id: 'index',   out: 'index.html',   template: 'web/index.html',   modules: [], data: null },
  {
    id: 'cache',
    out: 'cache.html',
    template: 'web/cache.html',
    modules: [
      'src/cache/chase.js',
      'src/cache/linear.js',
      'src/cache/detect.js',
      'src/cache/ui.js',
      // covert-channel finale
      'src/cache/manchester.js',
      'src/cache/channel-sim.js',
      'src/cache/channel.js',
      'src/cache/channel-ui.js',
    ],
    data: () =>
      `const BUILD = ${JSON.stringify(buildInfo())};\n` +
      `const FIXTURES = ${readRoot('data/cache/fixtures.json').trim()};\n` +
      `const CHANNEL_FIXTURE = ${readRoot('data/cache/channel-fixture.json').trim()};`,
  },
  { id: 'article', out: 'article.html', template: 'web/article.html', modules: [], data: null },
];

// Which source a page was built from, stamped into it so saved traces say
// exactly which version produced them (a stale deploy once made traces
// silently lack a field). `--dirty` marks uncommitted local changes.
function buildInfo() {
  let commit = 'unknown';
  try { commit = execSync('git describe --always --dirty', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  return { commit };
}

const stripModuleSyntax = (src) =>
  src
    .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+(?=(async\s+function|function|class|const|let|var)\b)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '');

const banner = (label) =>
  `// ---- ${label} ${'-'.repeat(Math.max(0, 62 - label.length))}`;

function bundleModules(paths) {
  return paths
    .map((m) => `${banner(m)}\n${stripModuleSyntax(read(root, m))}`)
    .join('\n');
}

function stamp(html, { id, code, data }) {
  return html
    .replace('<!--__HEAD__-->', () => headHtml(id))
    .replace('/*__SHELL_CSS__*/', () => SHELL_CSS)
    .replace('<!--__NAV__-->', () => navHtml(id))
    .replace('<!--__FOOTER__-->', () => footerHtml())
    .replace('/*__DATA__*/', () => data || '')
    .replace('/*__CODE__*/', () => code || '');
}

const distDir = path.join(root, 'dist');
fs.mkdirSync(distDir, { recursive: true });

const written = [];
for (const page of PAGES) {
  const modules = page.modules.length
    ? bundleModules([...SHELL_MODULES, ...page.modules])
    : '';
  const data = typeof page.data === 'function' ? page.data() : page.data;
  const html = stamp(readRoot(page.template), { id: page.id, code: modules, data });
  fs.writeFileSync(path.join(distDir, page.out), html);
  written.push([page.out, html]);
}

for (const [name, html] of written) {
  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`dist/${name.padEnd(14)} ${kb.padStart(7)} kB`);
}
console.log(`\n${written.length} pages written to dist/`);
