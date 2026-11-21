// Build-time only: generates the site nav + footer stamped into every page.
// Not shipped to the browser.
//
// Relative hrefs (not absolute) so the built dist/ works identically double-
// clicked from file:// and served from a subpath on GitHub Pages.

// Set this to your repo once pushed; it drives the "GitHub" link in the nav.
export const REPO_URL = 'https://github.com/USER/cache-covert-channel';

export const PAGES = [
  { id: 'index',   href: 'index.html',   nav: 'Overview' },
  { id: 'cache',   href: 'cache.html',   nav: 'Live demo' },
  { id: 'article', href: 'article.html', nav: 'How it works' },
];

export function navHtml(currentId) {
  const links = PAGES.map((p) => {
    const cls = p.id === currentId ? ' class="on"' : '';
    return `    <a href="${p.href}"${cls}>${p.nav}</a>`;
  }).join('\n');

  const gh = REPO_URL.includes('USER')
    ? ''
    : `\n    <a class="ghlink" href="${REPO_URL}" target="_blank" rel="noopener">GitHub ↗</a>`;

  return `<nav class="sitenav">
    <span class="brand"><a href="index.html">cache-covert-channel</a></span>
${links}
    <span class="spacer"></span>${gh}
  </nav>`;
}

export function footerHtml() {
  return `<footer class="site">
    A cooperative cache-timing covert channel &middot; cache side-channel measurement, weaponised and defended.
    Educational security research &mdash; no victim, no secret, no network. Every page is a single file you can save and run offline.
  </footer>`;
}
