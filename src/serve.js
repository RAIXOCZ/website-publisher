'use strict';

const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const sites = require('./sites');
const { langOf, t } = require('./i18n');

// Sites served from the admin's own origin (PUBLIC_URL/<name>/) run in a
// sandbox with an opaque origin, so their scripts cannot talk to the admin
// API with your session. Subdomain sites are isolated by origin instead.
const SANDBOX =
  'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox ' +
  'allow-modals allow-downloads allow-pointer-lock allow-presentation allow-orientation-lock';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function page(lang, title, body) {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:10vh auto;padding:0 16px;color:#1f2328;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}a{color:#58a6ff}}
h1{font-size:1.4rem}ul{padding-left:1.2rem}li{margin:.2rem 0}code{font-size:.95em}
</style></head><body>${body}</body></html>`;
}

async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

function send(res, file, sandboxed) {
  const headers = {
    // Always revalidate so a re-published site shows up immediately.
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  if (sandboxed) {
    headers['Content-Security-Policy'] = SANDBOX;
    // Sandboxed pages have an opaque origin; let them still fetch their own files.
    headers['Access-Control-Allow-Origin'] = '*';
  }
  return new Promise((resolve, reject) => {
    res.sendFile(file, { headers, dotfiles: 'allow', lastModified: true, etag: true }, (err) => {
      if (err && !res.headersSent) reject(err);
      else resolve();
    });
  });
}

async function listing(req, res, dir, urlPath, siteName) {
  const lang = langOf(req);
  const entries = (await fsp.readdir(dir, { withFileTypes: true }))
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  const items = entries
    .map((e) => {
      const name = e.name + (e.isDirectory() ? '/' : '');
      return `<li><a href="${escapeHtml(encodeURIComponent(e.name))}${e.isDirectory() ? '/' : ''}">${escapeHtml(name)}</a></li>`;
    })
    .join('');
  const up = urlPath !== '/' ? '<li><a href="../">../</a></li>' : '';
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(page(lang, `${siteName}${urlPath}`, `<h1>${escapeHtml(siteName)}<code>${escapeHtml(urlPath)}</code></h1>
<p>${t(lang, 'listingText')}</p><ul>${up}${items}</ul>`));
}

async function notFound(req, res, root, sandboxed) {
  const custom = path.join(root, '404.html');
  if (await statOrNull(custom)) {
    res.status(404);
    return send(res, custom, sandboxed);
  }
  const lang = langOf(req);
  res.status(404).type('html').send(page(lang, t(lang, 'pageNotFoundTitle'), `<h1>${t(lang, 'pageNotFound')}</h1>`));
}

/**
 * Serves a file from a published site.
 * @param name     site name
 * @param subPath  path inside the site, starting with "/"
 * @param basePath URL prefix the site is mounted at ("" for subdomains)
 */
async function serveSite(req, res, name, subPath, basePath, previewRoot = null) {
  const sandboxed = basePath !== '' && config.PATH_SANDBOX;
  const lang = langOf(req);
  const noSuchSite = (text = '') =>
    res.status(404).type('html').send(page(lang, t(lang, 'pageNotFoundTitle'), `<h1>${t(lang, 'noSuchSite')}</h1>${text}`));
  if (!sites.NAME_RE.test(name)) {
    return noSuchSite();
  }
  if (name.startsWith(sites.PREVIEW_PREFIX) && !previewRoot) {
    return noSuchSite(`<p>${t(lang, 'previewExpired')}</p>`);
  }
  const root = previewRoot || sites.siteDir(name);
  // Previews are temporary: keep them out of search engines.
  if (previewRoot) res.set('X-Robots-Tag', 'noindex, nofollow');
  if (!(await statOrNull(root))) {
    return noSuchSite(`<p>${t(lang, 'noSuchSiteText', { name: escapeHtml(name) })}</p>`);
  }

  let decoded;
  try {
    decoded = decodeURIComponent(subPath);
  } catch {
    return res.status(400).send(t(lang, 'badRequest'));
  }
  if (decoded.includes('\0')) return res.status(400).send(t(lang, 'badRequest'));
  const rel = path.posix.normalize('/' + decoded);
  const full = path.join(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return res.status(400).send(t(lang, 'badRequest'));

  const st = await statOrNull(full);
  if (st && st.isDirectory()) {
    if (!subPath.endsWith('/')) {
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      return res.redirect(301, `${basePath}${subPath}/${query}`);
    }
    const index = path.join(full, 'index.html');
    if (await statOrNull(index)) return send(res, index, sandboxed);
    return listing(req, res, full, rel.endsWith('/') ? rel : rel + '/', name);
  }
  if (st && st.isFile()) return send(res, full, sandboxed);

  // Clean URLs: /about -> /about.html
  if (!rel.endsWith('/') && (await statOrNull(full + '.html'))) return send(res, full + '.html', sandboxed);

  return notFound(req, res, root, sandboxed);
}

module.exports = { serveSite, page, escapeHtml };
