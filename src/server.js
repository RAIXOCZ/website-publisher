'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const auth = require('./auth');
const sites = require('./sites');
const { serveSite, page } = require('./serve');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

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
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).send('Metoda není povolena');
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
app.use('/_app', securityHeaders, express.static(publicDir, { index: false, maxAge: '1h' }));
app.get('/', securityHeaders, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get(['/admin', '/admin/'], securityHeaders, (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));
app.get(['/docs', '/docs/'], securityHeaders, (req, res) => res.sendFile(path.join(publicDir, 'docs.html')));
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
const TOO_MANY = { error: 'Příliš mnoho pokusů. Zkuste to znovu za 15 minut.' };

api.post('/login', json, (req, res) => {
  if (auth.tooManyAttempts(req)) return res.status(429).json(TOO_MANY);
  if (!auth.checkPassword(req.body?.password)) {
    auth.recordFailure(req);
    return res.status(401).json({ error: 'Nesprávné heslo.' });
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
  res.json({ name, error, exists: !error && (await sites.exists(name)), url: name ? sites.siteUrl(name) : null });
});

// Anyone may publish a new site; replacing one needs its password (or the admin).
api.post('/sites', async (req, res) => {
  const isAdmin = auth.isAuthed(req);
  if (!isAdmin) {
    if (auth.tooManyAttempts(req)) return res.status(429).json(TOO_MANY);
    if (!auth.publishAllowed(req)) {
      return res.status(429).json({ error: 'Příliš mnoho nahrávání z vaší adresy. Zkuste to znovu později.' });
    }
  }
  const result = await sites.handleUpload(req, { isAdmin, onWrongPassword: () => auth.recordFailure(req) });
  console.log(`published ${result.name} (${result.files} files, ${result.bytes} bytes)${result.replaced ? ' [replaced]' : ''}${isAdmin ? ' [admin]' : ''}`);
  res.json(result);
});

// The browser's own list of sites: checks which saved passwords are still valid.
api.post('/my-sites', json, async (req, res) => {
  if (auth.tooManyAttempts(req)) return res.status(429).json(TOO_MANY);
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
  if (auth.tooManyAttempts(req)) return res.status(429).json(TOO_MANY);
  if (await sites.checkSitePassword(req.params.name, req.body?.password)) return next();
  auth.recordFailure(req);
  res.status(403).json({ error: 'Nesprávné heslo k webu.' });
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

api.use((req, res) => res.status(404).json({ error: 'Nenalezeno' }));
app.use('/api', api);

// 3. <PUBLIC_URL>/<name>/... → site (or redirect to its subdomain).
app.use((req, res, next) => {
  const match = /^\/([^/]+)(\/.*)?$/.exec(req.path);
  if (!match) return next();
  const [, name, rest = ''] = match;
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).send('Metoda není povolena');
  if (config.SITE_DOMAIN && sites.NAME_RE.test(name)) {
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    return res.redirect(301, sites.siteUrl(name) + (rest || '/').slice(1) + query);
  }
  serveSite(req, res, name, rest, `/${name}`).catch(next);
});

app.use((req, res) => res.status(404).type('html').send(page('Nenalezeno', '<h1>404 – Stránka nenalezena</h1>')));

// Errors: user-facing messages for expected problems, a generic one otherwise.
app.use((err, req, res, _next) => {
  if (res.headersSent) return res.end();
  if (err instanceof sites.UserError) {
    return res.status(err.status).json({ error: err.message, ...err.extra });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Neplatný JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Na serveru se něco pokazilo.' });
});

sites.init().then(() => {
  app.listen(config.PORT, () => {
    console.log(`Website publisher listening on :${config.PORT}`);
    console.log(`  app:   ${config.PUBLIC_URL}`);
    console.log(`  sites: ${sites.siteUrl('<name>')}`);
    console.log(`  data:  ${config.DATA_DIR}`);
  });
});
