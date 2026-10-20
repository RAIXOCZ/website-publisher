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
    publicUpload: config.PUBLIC_UPLOAD,
    maxUploadMb: config.MAX_UPLOAD_MB,
    urlTemplate: sites.siteUrl('{name}'),
  });
});

api.post('/login', express.json({ limit: '10kb' }), (req, res) => {
  if (auth.tooManyAttempts(req)) return res.status(429).json({ error: 'Příliš mnoho pokusů. Zkuste to znovu za 15 minut.' });
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

api.get('/sites', auth.requireAuth, async (req, res) => {
  res.json({ sites: await sites.list() });
});

api.post('/sites', async (req, res) => {
  const authed = auth.isAuthed(req);
  if (!authed && !config.PUBLIC_UPLOAD) return res.status(401).json({ error: 'Nejprve se přihlaste.' });
  // Only the admin can replace an existing site.
  const result = await sites.handleUpload(req, { canOverwrite: authed });
  console.log(`published ${result.name} (${result.files} files, ${result.bytes} bytes)${result.replaced ? ' [replaced]' : ''}`);
  res.json(result);
});

api.delete('/sites/:name', auth.requireAuth, async (req, res) => {
  await sites.remove(req.params.name);
  console.log(`deleted ${req.params.name}`);
  res.json({ ok: true });
});

api.post('/sites/:name/rename', auth.requireAuth, express.json({ limit: '10kb' }), async (req, res) => {
  const result = await sites.rename(req.params.name, req.body?.name);
  console.log(`renamed ${req.params.name} -> ${result.name}`);
  res.json(result);
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
    console.log(`  public uploads: ${config.PUBLIC_UPLOAD ? 'on' : 'off (admin only)'}`);
  });
});
