'use strict';

const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const sites = require('./sites');
const stats = require('./stats');
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

// The pages freepages.dev shows itself on a site's address (no such site,
// 404 without the site's own 404.html, folder listing), in the look of the
// app. Everything is inline: they load nothing from anywhere.
const LOGO = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
const STYLE = `
:root{color-scheme:light;--page:#f3f5f9;--card:rgba(255,255,255,.82);--line:rgba(15,23,42,.08);--ink:#0b1324;--muted:#586174;--faint:#687083;--accent:#0f766e;--accent-fill:#0d9488;--g1:rgba(45,212,191,.4);--g2:rgba(167,139,250,.38)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--page:#070b14;--card:rgba(17,24,39,.82);--line:rgba(255,255,255,.08);--ink:#e9edf5;--muted:#a0a9ba;--faint:#8b95a8;--accent:#2dd4bf;--g1:rgba(20,184,166,.2);--g2:rgba(124,58,237,.24)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:24px 16px;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:radial-gradient(800px 500px at 10% -10%,var(--g1),transparent 60%),radial-gradient(700px 600px at 100% 10%,var(--g2),transparent 60%),var(--page)}
main{width:100%;max-width:560px;padding:32px;border-radius:22px;background:var(--card);border:1px solid var(--line);box-shadow:0 12px 40px -12px rgba(30,41,59,.18)}
.code{margin:0 0 6px;font-weight:800;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
h1{margin:0 0 10px;font-size:30px;line-height:1.15;letter-spacing:-.02em}
p{margin:0 0 12px;color:var(--muted)}
code{font:.92em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ink);overflow-wrap:anywhere}
a{color:var(--accent);text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}
.btn{display:inline-flex;align-items:center;padding:11px 18px;border-radius:10px;font-weight:600;font-size:15px;text-decoration:none;color:var(--ink);background:var(--card);border:1px solid var(--line)}
.btn:hover{border-color:var(--accent-fill)}
.btn.primary{color:#fff;background:#0f766e;border-color:transparent}
.btn.primary:hover{background:#115e59}
main:has(.files){max-width:680px}
.path{margin:-4px 0 14px}
.path code{display:inline-block;padding:3px 10px;border-radius:8px;background:var(--line);font-size:14px}
.files{margin:18px 0 0;padding:6px;list-style:none;border:1px solid var(--line);border-radius:14px}
.files li a{display:flex;align-items:center;gap:12px;min-height:40px;padding:8px 10px;border-radius:9px;color:var(--ink);text-decoration:none}
.files li a:hover{background:var(--line)}
.files .icon{display:grid;place-items:center;flex:none;color:var(--muted)}
.files .icon.dir{color:var(--accent)}
.files .name{flex:1;min-width:0;font:15px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.files .size{flex:none;font-size:13px;color:var(--faint)}
.files .empty{padding:10px;color:var(--faint)}
.help{margin:18px 0 0;font-size:15px}
.actions + .help, .help:last-child{margin-bottom:0}
footer{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--faint)}
footer a{color:var(--muted);font-weight:600;text-decoration:none}
.mark{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;color:#fff;background:var(--accent-fill)}
@media (max-width:640px){main{padding:24px}h1{font-size:25px}}
`;

/**
 * A page of the service itself. `body` is trusted HTML; `actions` are
 * [label, href, primary] links shown as buttons.
 */
function page(lang, title, body, { code = '', actions = null, help = true } = {}) {
  const app = config.PUBLIC_URL;
  const links = actions ?? [[t(lang, 'errors.publish'), `${app}/`, true]];
  // The guide is a link in a sentence, not another button.
  if (help) body += `<p class="help">${t(lang, 'errors.help', { docs: `${app}/docs` })}</p>`;
  const buttons = links.map(([label, href, primary]) => `<a class="btn${primary ? ' primary' : ''}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`).join('');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>
<main>${code ? `<p class="code">${escapeHtml(code)}</p>` : ''}${body}${buttons ? `<div class="actions">${buttons}</div>` : ''}</main>
<footer><span class="mark">${LOGO}</span><span>${t(lang, 'errors.hostedOn')} <a href="${escapeHtml(app)}/">${escapeHtml(new URL(app).host)}</a></span></footer>
</body></html>`;
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

const ICON_DIR = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_FILE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const ICON_UP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
const formatSize = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

// A folder without a start page: its files, folders first.
async function listing(req, res, dir, urlPath, siteName) {
  const lang = langOf(req);
  const entries = (await fsp.readdir(dir, { withFileTypes: true }))
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  const rows = await Promise.all(
    entries.map(async (e) => {
      const isDir = e.isDirectory();
      const size = isDir ? '' : formatSize((await statOrNull(path.join(dir, e.name)))?.size ?? 0);
      return `<li><a href="${escapeHtml(encodeURIComponent(e.name))}${isDir ? '/' : ''}"><span class="icon${isDir ? ' dir' : ''}">${isDir ? ICON_DIR : ICON_FILE}</span><span class="name">${escapeHtml(e.name)}${isDir ? '/' : ''}</span><span class="size">${size}</span></a></li>`;
    }),
  );
  const up = urlPath !== '/' ? `<li><a href="../"><span class="icon">${ICON_UP}</span><span class="name">${t(lang, 'listingUp')}</span><span class="size"></span></a></li>` : '';
  res.set('Cache-Control', 'no-cache');
  const body = `<h1>${t(lang, 'listingTitle')}</h1>
<p class="path"><code>${escapeHtml(siteName)}${escapeHtml(urlPath)}</code></p>
<p>${t(lang, 'listingText')}</p>
<ul class="files">${up}${rows.join('') || `<li class="empty">${t(lang, 'listingEmpty')}</li>`}</ul>
<p class="help">${t(lang, 'listingHelp', { docs: `${config.PUBLIC_URL}/docs` })}</p>`;
  res.type('html').send(page(lang, `${siteName}${urlPath}`, body, { actions: [], help: false }));
}

async function notFound(req, res, root, sandboxed, siteHome = '/') {
  const custom = path.join(root, '404.html');
  if (await statOrNull(custom)) {
    res.status(404);
    return send(res, custom, sandboxed);
  }
  const lang = langOf(req);
  res.status(404).type('html').send(page(lang, t(lang, 'pageNotFoundTitle'), `<h1>${t(lang, 'pageNotFound')}</h1><p>${t(lang, 'pageNotFoundText')}</p>`, {
    code: '404',
    actions: [[t(lang, 'errors.siteHome'), siteHome, true]],
    help: false,
  }));
}

/**
 * Serves a file from a published site.
 * @param name     site name
 * @param subPath  path inside the site, starting with "/"
 * @param basePath URL prefix the site is mounted at ("" for subdomains)
 */
/**
 * What a folder shows when it is opened. index.html is not required:
 * index.htm, or the only HTML page in the folder, works too, and the root
 * of a site that has no pages of its own leads to the nearest subfolder
 * with an index.html (e.g. dist/). Otherwise the folder is listed.
 */
async function entryPage(dir, isRoot) {
  for (const name of ['index.html', 'index.htm']) {
    if ((await statOrNull(path.join(dir, name)))?.isFile()) return { file: path.join(dir, name) };
  }
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const pages = entries.filter((e) => e.isFile() && /\.html?$/i.test(e.name) && !/^404\.html?$/i.test(e.name));
  if (pages.length === 1) return { file: path.join(dir, pages[0].name) };
  if (!isRoot || pages.length) return null;
  // Breadth-first, so the shallowest index.html wins.
  let level = [''];
  for (let depth = 0; depth < 3 && level.length; depth++) {
    const next = [];
    for (const rel of level) {
      const children = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
      for (const child of children.filter((c) => c.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        const sub = rel ? `${rel}/${child.name}` : child.name;
        if ((await statOrNull(path.join(dir, sub, 'index.html')))?.isFile()) return { redirect: `${sub.split('/').map(encodeURIComponent).join('/')}/` };
        next.push(sub);
      }
    }
    level = next;
  }
  return null;
}

async function serveSite(req, res, name, subPath, basePath, previewRoot = null) {
  const sandboxed = basePath !== '' && config.PATH_SANDBOX;
  const lang = langOf(req);
  const noSuchSite = (text = '') =>
    res.status(404).type('html').send(page(lang, t(lang, 'noSuchSite'), `<h1>${t(lang, 'noSuchSite')}</h1>${text}`, { code: '404' }));
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

  // Pages (not previews, not images or styles) count as visits.
  const view = (file) => {
    if (!previewRoot && /\.html?$/i.test(file)) stats.hit(name, req);
    return send(res, file, sandboxed);
  };

  const st = await statOrNull(full);
  if (st && st.isDirectory()) {
    if (!subPath.endsWith('/')) {
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      return res.redirect(301, `${basePath}${subPath}/${query}`);
    }
    const entry = await entryPage(full, rel === '/');
    if (entry?.file) return view(entry.file);
    if (entry?.redirect) return res.redirect(302, `${basePath}${rel.replace(/\/?$/, '/')}${entry.redirect}`);
    return listing(req, res, full, rel.endsWith('/') ? rel : rel + '/', name);
  }
  if (st && st.isFile()) return view(full);

  // Clean URLs: /about -> /about.html
  if (!rel.endsWith('/') && (await statOrNull(full + '.html'))) return view(full + '.html');

  return notFound(req, res, root, sandboxed, `${basePath}/`);
}

module.exports = { serveSite, page, escapeHtml };
