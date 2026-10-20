'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('./config');
const auth = require('./auth');
const sites = require('./sites');
const { serveSite, page } = require('./serve');
const { langOf, t } = require('./i18n');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
  res.set('Report-Abuse', config.ABUSE_EMAIL);
  next();
});

const hostOf = (req) => (req.headers.host || '').toLowerCase().replace(/:\d+$/, '');

// 1. <name>.<SITE_DOMAIN> → that site, and nothing else on that host.
if (config.SITE_DOMAIN) {
  const suffix = `.${config.SITE_DOMAIN}`;
  app.use((req, res, next) => {
    const host = hostOf(req);
    if (host === config.APP_HOSTNAME) return next();
    // The bare site domain (and www) has no site of its own: send visitors to the publisher.
    if (host === config.SITE_DOMAIN || host === `www${suffix}`) {
      return res.redirect(302, config.PUBLIC_URL + '/');
    }
    if (!host.endsWith(suffix)) return next();
    const name = host.slice(0, -suffix.length);
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).send(t(langOf(req), 'methodNotAllowed'));
    serveSite(req, res, name, req.path, '').catch(next);
  });
}

// 2. The publisher app itself.
const securityHeaders = (req, res, next) => {
  res.set({
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  });
  next();
};

const publicDir = path.join(__dirname, '..', 'public');

// Asset URLs in the pages carry a hash of the public files (?v=…), so a new
// deploy never mixes fresh HTML with CSS/JS cached by browsers or Cloudflare.
const assetVersion = (() => {
  const hash = crypto.createHash('sha256');
  for (const entry of fs.readdirSync(publicDir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    hash.update(path.relative(publicDir, file)).update(fs.readFileSync(file));
  }
  return hash.digest('hex').slice(0, 12);
})();

const pages = {};
function appPage(name) {
  pages[name] ??= fs
    .readFileSync(path.join(publicDir, name), 'utf8')
    .replace(/((?:src|href)=")\/_app\/([^"?]+)"/g, `$1/_app/$2?v=${assetVersion}"`);
  return (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(pages[name]);
}

app.use(
  '/_app',
  securityHeaders,
  express.static(publicDir, {
    index: false,
    setHeaders: (res) => {
      const versioned = res.req.query.v === assetVersion;
      res.set('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }),
);
app.get('/', securityHeaders, appPage('index.html'));
app.get(['/admin', '/admin/'], securityHeaders, appPage('admin.html'));
app.get(['/docs', '/docs/'], securityHeaders, appPage('docs.html'));
app.get(['/podminky', '/terms'], securityHeaders, appPage('terms.html'));
app.get(['/soukromi', '/privacy'], securityHeaders, appPage('privacy.html'));
app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /admin\n'));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(publicDir, 'favicon.svg'), { headers: { 'Content-Type': 'image/svg+xml' } }));

const api = express.Router();
api.use(securityHeaders, auth.sameOrigin);

api.get('/config', (req, res) => {
  res.json({
    authed: auth.isAuthed(req),
    maxUploadMb: config.MAX_UPLOAD_MB,
    urlTemplate: sites.siteUrl('{name}'),
  });
});

const json = express.json({ limit: '100kb' });
// JSON error in the requester's language.
const fail = (req, res, status, key, params) => res.status(status).json({ error: t(langOf(req), key, params) });

api.post('/login', json, (req, res) => {
  if (auth.tooManyAttempts(req)) return fail(req, res, 429, 'tooManyAttempts');
  if (!auth.checkPassword(req.body?.password)) {
    auth.recordFailure(req);
    return fail(req, res, 401, 'wrongPassword');
  }
  auth.setSession(res);
  res.json({ ok: true });
});

api.post('/logout', (req, res) => {
  auth.clearSession(res);
  res.json({ ok: true });
});

api.get('/check-name', async (req, res) => {
  const name = sites.slugify(req.query.name);
  const error = sites.validateName(name);
  res.json({
    name,
    error: error && t(langOf(req), error, { name }),
    exists: !error && (await sites.exists(name)),
    url: name ? sites.siteUrl(name) : null,
  });
});

// Anyone may publish a new site; replacing one needs its password (or the admin).
api.post('/sites', async (req, res) => {
  const isAdmin = auth.isAuthed(req);
  if (!isAdmin) {
    if (auth.tooManyAttempts(req)) return fail(req, res, 429, 'tooManyAttempts');
    if (!auth.publishAllowed(req)) return fail(req, res, 429, 'tooManyUploads');
  }
  const result = await sites.handleUpload(req, { isAdmin, onWrongPassword: () => auth.recordFailure(req) });
  console.log(`published ${result.name} (${result.files} files, ${result.bytes} bytes)${result.replaced ? ' [replaced]' : ''}${isAdmin ? ' [admin]' : ''}`);
  res.json(result);
});

// The browser's own list of sites: checks which saved passwords are still valid.
api.post('/my-sites', json, async (req, res) => {
  if (auth.tooManyAttempts(req)) return fail(req, res, 429, 'tooManyAttempts');
  const entries = Array.isArray(req.body?.sites) ? req.body.sites.slice(0, 500) : [];
  const out = [];
  for (const entry of entries) {
    const name = String(entry?.name || '');
    const site = await sites.info(name);
    if (!site) {
      out.push({ name, status: 'missing' });
    } else if (await sites.checkSitePassword(name, entry.password)) {
      out.push({ ...site, status: 'ok' });
    } else {
      auth.recordFailure(req);
      out.push({ name, status: 'wrong-password' });
    }
  }
  res.json({ sites: out });
});

// Owner (with the site's password) or admin.
async function authorizeSite(req, res, next) {
  if (auth.isAuthed(req)) return next();
  if (auth.tooManyAttempts(req)) return fail(req, res, 429, 'tooManyAttempts');
  if (await sites.checkSitePassword(req.params.name, req.body?.password)) return next();
  auth.recordFailure(req);
  fail(req, res, 403, 'wrongSitePassword');
}

api.post('/sites/:name/delete', json, authorizeSite, async (req, res) => {
  await sites.remove(req.params.name);
  console.log(`deleted ${req.params.name}`);
  res.json({ ok: true });
});

// Admin only.
api.get('/sites', auth.requireAuth, async (req, res) => {
  res.json({ sites: await sites.list() });
});

api.post('/sites/:name/rename', auth.requireAuth, json, async (req, res) => {
  const result = await sites.rename(req.params.name, req.body?.name);
  console.log(`renamed ${req.params.name} -> ${result.name}`);
  res.json(result);
});

api.post('/sites/:name/reset-password', auth.requireAuth, async (req, res) => {
  const password = await sites.resetPassword(req.params.name);
  console.log(`password reset for ${req.params.name}`);
  res.json({ name: req.params.name, password });
});

api.use((req, res) => fail(req, res, 404, 'notFound'));
app.use('/api', api);

// 3. <PUBLIC_URL>/<name>/... → site (or redirect to its subdomain).
app.use((req, res, next) => {
  const match = /^\/([^/]+)(\/.*)?$/.exec(req.path);
  if (!match) return next();
  const [, name, rest = ''] = match;
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).send(t(langOf(req), 'methodNotAllowed'));
  if (config.SITE_DOMAIN && sites.NAME_RE.test(name)) {
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    return res.redirect(301, sites.siteUrl(name) + (rest || '/').slice(1) + query);
  }
  serveSite(req, res, name, rest, `/${name}`).catch(next);
});

app.use((req, res) => {
  const lang = langOf(req);
  res.status(404).type('html').send(page(lang, t(lang, 'pageNotFoundTitle'), `<h1>${t(lang, 'pageNotFound')}</h1>`));
});

// Errors: user-facing messages for expected problems, a generic one otherwise.
app.use((err, req, res, _next) => {
  if (res.headersSent) return res.end();
  if (err instanceof sites.UserError) {
    return res.status(err.status).json({ error: t(langOf(req), err.key, err.params), ...err.extra });
  }
  if (err.type === 'entity.parse.failed') return fail(req, res, 400, 'invalidJson');
  console.error(err);
  fail(req, res, 500, 'serverError');
});

sites.init().then(() => {
  app.listen(config.PORT, () => {
    console.log(`Website publisher listening on :${config.PORT}`);
    console.log(`  app:   ${config.PUBLIC_URL}`);
    console.log(`  sites: ${sites.siteUrl('<name>')}`);
    console.log(`  data:  ${config.DATA_DIR}`);
  });
});
