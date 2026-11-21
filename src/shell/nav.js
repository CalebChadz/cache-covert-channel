// Build-time only: generates the shared <head> meta, site nav + footer stamped
// into every page. Not shipped to the browser as JS.
//
// Relative hrefs (not absolute) so the built dist/ works identically double-
// clicked from file:// and served from a subpath on GitHub Pages.

// Set this to your repo once pushed; it drives the "GitHub" link in the nav.
export const REPO_URL = 'https://github.com/CalebChadz/cache-covert-channel';

export const PAGES = [
  { id: 'index',   href: 'index.html',   nav: 'Overview' },
  { id: 'cache',   href: 'cache.html',   nav: 'Live demo' },
  { id: 'article', href: 'article.html', nav: 'How it works' },
];

// Per-page description for search engines and link previews (LinkedIn, Slack,
// iMessage…). Kept here so every page gets the same set of tags.
const DESCRIPTIONS = {
  index:
    'Two threads exchange a message without the payload touching shared memory, the network or storage — only contention for the CPU cache. A browser demo, with a candid account of what it does and does not show.',
  cache:
    'Measure your CPU cache hierarchy from a coarse browser timer, then send a message through the cache between a page and a Web Worker.',
  article:
    'A from-scratch explainer: the memory-speed gap, pointer chasing vs the prefetcher, how the channel is framed and decoded, and what the evidence does and does not show.',
};

// Inline SVG favicon — keeps every page a single self-contained file.
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="7" fill="#080b12"/>' +
      '<rect x="6" y="6" width="9" height="9" rx="1.5" fill="#22d3ee"/>' +
      '<rect x="17" y="17" width="9" height="9" rx="1.5" fill="#c04cff"/>' +
      '<rect x="17" y="6" width="9" height="9" rx="1.5" fill="none" stroke="#22d3ee" stroke-width="1.5" opacity=".5"/>' +
      '<rect x="6" y="17" width="9" height="9" rx="1.5" fill="none" stroke="#c04cff" stroke-width="1.5" opacity=".5"/>' +
    '</svg>'
  );

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function headHtml(currentId) {
  const desc = esc(DESCRIPTIONS[currentId] || DESCRIPTIONS.index);
  return `<meta name="description" content="${desc}">
<meta name="theme-color" content="#080b12">
<meta name="color-scheme" content="dark">
<meta property="og:type" content="website">
<meta property="og:site_name" content="cache-covert-channel">
<meta property="og:description" content="${desc}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="${FAVICON}">`;
}

const GH_ICON =
  '<svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

export function navHtml(currentId) {
  const links = PAGES.map((p) => {
    const cur = p.id === currentId ? ' class="on" aria-current="page"' : '';
    return `      <a href="${p.href}"${cur}>${p.nav}</a>`;
  }).join('\n');

  const gh = REPO_URL.includes('USER')
    ? ''
    : `\n    <a class="ghlink" href="${REPO_URL}" target="_blank" rel="noopener" aria-label="Source on GitHub">${GH_ICON}<span>GitHub</span></a>`;

  return `<a class="skip" href="#main">Skip to content</a>
<nav class="sitenav" aria-label="Site">
  <div class="sitenav-inner">
    <a class="brand" href="index.html" aria-label="cache-covert-channel home"><span class="logo" aria-hidden="true"></span><span class="brand-text">cache-covert-channel</span></a>
    <div class="navlinks">
${links}
    </div>${gh}
  </div>
</nav>`;
}

export function footerHtml() {
  const year = new Date().getFullYear();
  const gh = REPO_URL.includes('USER') ? '' : ` · <a href="${REPO_URL}" target="_blank" rel="noopener">Source on GitHub</a>`;
  return `<footer class="site">
  <div class="footer-inner">
    <p><strong>cache-covert-channel</strong> — a cooperative cache-timing covert channel: measured, weaponised and defended.</p>
    <p>Educational security research — no victim, no secret, no network. Every page is a single file you can save and run offline.</p>
    <p class="fine">© ${year} Caleb Chadderton${gh}</p>
  </div>
</footer>`;
}
