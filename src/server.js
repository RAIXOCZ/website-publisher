'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('./config');
const auth = require('./auth');
const sites = require('./sites');
const accounts = require('./accounts');
const mail = require('./mail');
const db = require('./db');
const { serveSite, page } = require('./serve');
const seo = require('./seo');
const stats = require('./stats');
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
    serveSite(req, res, name, req.path, '', sites.previewRoot(name)).catch(next);
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
  return (req, res) => {
    // ?lang=cs|en gives every page a fixed language for search engines;
    // without it the visitor's browser decides.
    const explicit = seo.LANGS.includes(req.query.lang) ? req.query.lang : null;
    const lang = explicit || langOf(req);
    res.set('Cache-Control', 'no-cache');
    if (!explicit) res.vary('Accept-Language');
    if (seo.PRIVATE.has(name)) res.set('X-Robots-Tag', 'noindex');
    res.type('html').send(seo.render(name, pages[name], { lang, explicit: Boolean(explicit) }));
  };
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
app.get(['/ucet', '/account'], securityHeaders, appPage('account.html'));
app.get('/email/:token', securityHeaders, appPage('confirm.html'));
app.get('/robots.txt', (req, res) => res.type('text').send(seo.robots()));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(seo.sitemap()));
app.get('/site.webmanifest', (req, res) => res.type('application/manifest+json').send(JSON.stringify(seo.manifest())));
for (const file of seo.ROOT_FILES) {
  app.get(`/${file}`, (req, res) => res.sendFile(path.join(publicDir, file), { headers: { 'Cache-Control': 'public, max-age=86400' } }));
}
app.get('/apple-touch-icon-precomposed.png', (req, res) => res.sendFile(path.join(publicDir, 'apple-touch-icon.png'), { headers: { 'Cache-Control': 'public, max-age=86400' } }));

const api = express.Router();
api.use(securityHeaders, auth.sameOrigin);

const json = express.json({ limit: '100kb' });
// JSON error in the requester's language.
const fail = (req, res, status, key, params) => res.status(status).json({ error: t(langOf(req), key, params) });
const ipOf = (req) => accounts.normIp(auth.clientIp(req));
const emailLink = (token) => `${config.PUBLIC_URL}/email/${token}`;

// At most EMAILS_PER_HOUR e-mails per IP address and per recipient.
const sentMail = new Map();
function emailAllowed(...keys) {
  const cutoff = Date.now() - 3600_000;
  for (const key of keys) {
    const times = (sentMail.get(key) || []).filter((t) => t > cutoff);
    if (times.length >= config.EMAILS_PER_HOUR) return false;
    sentMail.set(key, times);
  }
  for (const key of keys) sentMail.get(key).push(Date.now());
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [key, times] of sentMail) if (!times.some((t) => t > cutoff)) sentMail.delete(key);
}, 60_000).unref();

async function sendMail(req, { to, kind, params, userId = null }) {
  await mail.send({ to, kind, params, lang: langOf(req) });
  accounts.audit('email.sent', { userId, ip: ipOf(req), detail: { to, kind } });
}

// Whether this request may change `site`: its owner, the admin, or (for
// password sites) whoever knows the password.
function canManage(req, site, password) {
  if (accounts.isAdmin(req)) return true;
  const user = accounts.currentUser(req);
  if (user && site.user_id === user.id) return true;
  return sites.checkSitePassword(site, password);
}

function requireUser(req, res, next) {
  if (accounts.currentUser(req)) return next();
  fail(req, res, 401, 'loginRequired');
}

api.get('/config', (req, res) => {
  const user = accounts.currentUser(req);
  res.json({
    admin: accounts.isAdmin(req),
    user: accounts.publicUser(user),
    whitelisted: accounts.isWhitelisted(ipOf(req)),
    maxUploadMb: config.MAX_UPLOAD_MB,
    siteMaxMb: config.SITE_MAX_MB,
    accountMaxMb: config.ACCOUNT_MAX_MB,
    urlTemplate: sites.siteUrl('{name}'),
    previewMinutes: config.PREVIEW_MINUTES,
    retentionDays: config.RETENTION_DAYS,
    contact: config.ABUSE_EMAIL,
  });
});

/* ---------- user sign-in by e-mail link ---------- */

api.post('/auth/login', json, async (req, res) => {
  const email = accounts.normEmail(req.body?.email);
  if (!email) return fail(req, res, 400, 'emailInvalid');
  if (!emailAllowed(`ip:${ipOf(req)}`, `to:${email}`)) return fail(req, res, 429, 'tooManyEmails');
  const user = accounts.activeUserByEmail(email);
  if (user) {
    const token = accounts.createEmailToken({ purpose: 'login', email, userId: user.id, ip: ipOf(req), minutes: config.LINK_MINUTES });
    await sendMail(req, { to: email, kind: 'login', userId: user.id, params: { link: emailLink(token), minutes: config.LINK_MINUTES } });
  } else {
    await sendMail(req, { to: email, kind: 'loginNoAccount', params: { app: config.PUBLIC_URL } });
  }
  // Same answer either way, so nobody can probe which addresses have accounts.
  res.json({ ok: true });
});

// Creating an account without publishing anything: the account exists
// once the e-mail link is confirmed.
api.post('/auth/register', json, async (req, res) => {
  const email = accounts.normEmail(req.body?.email);
  if (!email) return fail(req, res, 400, 'emailInvalid');
  const firstName = accounts.cleanName(req.body?.firstName);
  const lastName = accounts.cleanName(req.body?.lastName);
  if (!firstName || !lastName) return fail(req, res, 400, 'nameRequired');
  if (!emailAllowed(`ip:${ipOf(req)}`, `to:${email}`)) return fail(req, res, 429, 'tooManyEmails');
  const user = accounts.activeUserByEmail(email);
  if (user) {
    // Already registered: a sign-in link instead (and the same answer).
    const token = accounts.createEmailToken({ purpose: 'login', email, userId: user.id, ip: ipOf(req), minutes: config.LINK_MINUTES });
    await sendMail(req, { to: email, kind: 'login', userId: user.id, params: { link: emailLink(token), minutes: config.LINK_MINUTES } });
  } else {
    const token = accounts.createEmailToken({
      purpose: 'register', email, ip: ipOf(req), minutes: config.PENDING_HOURS * 60, payload: { firstName, lastName },
    });
    await sendMail(req, { to: email, kind: 'register', params: { link: emailLink(token), hours: config.PENDING_HOURS, terms: `${config.PUBLIC_URL}/podminky` } });
  }
  res.json({ ok: true });
});

api.post('/auth/logout', (req, res) => {
  accounts.endSession(req, res);
  res.json({ ok: true });
});

// What an e-mail link does, shown on the confirmation page before it is used.
api.get('/auth/token', (req, res) => {
  const row = accounts.readEmailToken(String(req.query.token || ''));
  if (!row) return res.json({ valid: false });
  res.json({ valid: row.valid, purpose: row.purpose, name: row.payload?.name || null });
});

api.post('/auth/consume', json, async (req, res) => {
  const ip = ipOf(req);
  // A publish link that would exceed a storage limit stays unused, so it
  // still works after the owner frees some space.
  const peek = accounts.readEmailToken(String(req.body?.token || ''));
  if (peek?.valid && peek.purpose === 'publish') {
    const owner = accounts.activeUserByEmail(peek.email);
    if (accounts.isBlocked(owner)) return fail(req, res, 403, 'uploadsBlocked');
    const dir = sites.pendingDir(peek.payload?.dir);
    if (dir) await sites.assertQuota(dir, { ownerId: owner?.id });
  }
  const row = accounts.consumeEmailToken(String(req.body?.token || ''));
  if (!row) return fail(req, res, 410, 'linkExpired');

  if (row.purpose === 'register') {
    let user = accounts.activeUserByEmail(row.email);
    if (!user) user = accounts.createUser({ email: row.email, firstName: row.payload?.firstName, lastName: row.payload?.lastName, ip });
    accounts.audit('email.verified', { userId: user.id, ip, detail: { email: row.email } });
    accounts.startSession(res, user.id);
    return res.json({ redirect: '/ucet?welcome=1' });
  }

  if (row.purpose === 'login') {
    const user = accounts.activeUserByEmail(row.email);
    if (!user) return fail(req, res, 410, 'linkExpired');
    accounts.startSession(res, user.id);
    accounts.audit('account.login', { userId: user.id, ip });
    return res.json({ redirect: '/ucet' });
  }

  if (row.purpose === 'publish') {
    const dir = sites.pendingDir(row.payload?.dir);
    if (!dir) return fail(req, res, 410, 'linkExpired');
    let user = accounts.activeUserByEmail(row.email);
    if (!user) user = accounts.createUser({ email: row.email, firstName: row.payload.firstName, lastName: row.payload.lastName, ip });
    accounts.audit('email.verified', { userId: user.id, ip, detail: { email: row.email, uploadIp: row.ip } });
    const site = await sites.createSite({ requested: row.payload.name, dir, userId: user.id, ip });
    accounts.startSession(res, user.id);
    return res.json({ redirect: `/?published=${encodeURIComponent(site.name)}`, site });
  }

  if (row.purpose === 'delete-account') {
    const user = accounts.userById(row.user_id);
    if (!user || user.deleted_at) return fail(req, res, 410, 'linkExpired');
    await accounts.deleteUser(user.id, { by: 'user', ip });
    accounts.endSession(req, res);
    return res.json({ redirect: '/?accountDeleted=1' });
  }
  fail(req, res, 410, 'linkExpired');
});

/* ---------- the signed-in user's account ---------- */

api.get('/me', requireUser, (req, res) => {
  const user = accounts.currentUser(req);
  res.json({ user: accounts.publicUser(user), sites: sites.sitesOfUser(user.id), tokens: accounts.listApiTokens(user.id), usage: sites.usage(user.id) });
});

api.post('/me', requireUser, json, (req, res) => {
  const user = accounts.currentUser(req);
  const firstName = accounts.cleanName(req.body?.firstName);
  const lastName = accounts.cleanName(req.body?.lastName);
  if (!firstName || !lastName) return fail(req, res, 400, 'nameRequired');
  accounts.updateNames(user, { firstName, lastName }, ipOf(req));
  res.json({ user: accounts.publicUser(accounts.userById(user.id)) });
});

// Visits of the signed-in user's sites: all of them, or one (?site=name).
api.get('/me/stats', requireUser, (req, res) => {
  const mine = sites.sitesOfUser(accounts.currentUser(req).id);
  const chosen = req.query.site ? mine.filter((s) => s.name === req.query.site) : mine;
  res.json(stats.series(chosen.map((s) => s.id), String(req.query.range || '24h')));
});

api.get('/me/audit', requireUser, (req, res) => {
  res.json({ events: accounts.auditForUser(accounts.currentUser(req).id, { hideEmails: true }) });
});

api.post('/me/tokens', requireUser, json, (req, res) => {
  const { id, token } = accounts.createApiToken(accounts.currentUser(req), req.body?.name, ipOf(req));
  res.json({ id, token });
});

api.post('/me/tokens/:id/revoke', requireUser, (req, res) => {
  if (!accounts.revokeApiToken(accounts.currentUser(req), Number(req.params.id), ipOf(req))) return fail(req, res, 404, 'notFound');
  res.json({ ok: true });
});

// Deleting an account needs a click in an e-mail.
api.post('/me/delete', requireUser, async (req, res) => {
  const user = accounts.currentUser(req);
  if (user.is_admin) return fail(req, res, 400, 'adminAccount');
  if (!emailAllowed(`ip:${ipOf(req)}`, `to:${user.email}`)) return fail(req, res, 429, 'tooManyEmails');
  const token = accounts.createEmailToken({ purpose: 'delete-account', email: user.email, userId: user.id, ip: ipOf(req), minutes: config.LINK_MINUTES });
  accounts.audit('account.delete_requested', { userId: user.id, ip: ipOf(req) });
  await sendMail(req, {
    to: user.email,
    kind: 'deleteAccount',
    userId: user.id,
    params: { link: emailLink(token), days: config.RETENTION_DAYS, contact: config.ABUSE_EMAIL },
  });
  res.json({ ok: true });
});

/* ---------- sites ---------- */

api.get('/check-name', (req, res) => {
  const name = sites.slugify(req.query.name);
  const error = sites.validateName(name);
  const site = !error && sites.activeSite(name);
  const user = accounts.currentUser(req);
  res.json({
    name,
    error: error && t(langOf(req), error, { name }),
    exists: Boolean(site),
    mine: Boolean(site && user && site.user_id === user.id),
    url: name ? sites.siteUrl(name) : null,
  });
});

/**
 * Publishing. Who may do what:
 *  - signed in (session or API token): publish right away, replace own sites
 *  - admin: replace any site
 *  - whitelisted IP without an account: publish with a site password
 *  - everyone else: give e-mail + name; the site goes live after the e-mail link
 *  - preview=1: anyone, a temporary preview-xxxxxx site for PREVIEW_MINUTES
 */
api.post('/sites', async (req, res) => {
  const ip = ipOf(req);
  const user = accounts.currentUser(req);
  const isAdmin = accounts.isAdmin(req);
  if (accounts.isBlocked(user)) return fail(req, res, 403, 'uploadsBlocked');
  if (!user && !isAdmin) {
    if (auth.tooManyAttempts(req)) return fail(req, res, 429, 'tooManyAttempts');
    if (!auth.publishAllowed(req)) return fail(req, res, 429, 'tooManyUploads');
  }
  const upload = await sites.parseUpload(req);
  try {
    const f = upload.fields;
    let base = null;
    if (f.base) {
      base = sites.activeSite(f.base);
      if (!base) throw new sites.UserError('siteNotFound', 404);
      if (!canManage(req, base, f.password)) throw new sites.UserError('notYourSite', 403);
    }
    const { dir, requested } = await sites.assemble(upload, { baseDir: base ? sites.siteDir(base.name) : null });

    if (f.preview) {
      return res.json({ preview: await sites.savePreview(dir, { userId: user?.id ?? null, ip, siteName: base?.name ?? null, replace: f.replacePreview }) });
    }

    if (f.overwrite) {
      const site = sites.activeSite(requested);
      if (site) {
        if (!canManage(req, site, f.password)) {
          if (f.password) auth.recordFailure(req);
          throw new sites.UserError(
            site.password_hash ? 'wrongSitePasswordNamed' : 'notYourSite', 403,
            { exists: true, name: site.name, wrongPassword: Boolean(site.password_hash) }, { name: site.name },
          );
        }
        const owner = isAdmin && !(user && site.user_id === user.id) && !sites.checkSitePassword(site, f.password);
        const result = await sites.replaceSite(site, dir, { userId: user?.id ?? null, ip, by: owner ? 'admin' : 'owner' });
        console.log(`updated ${result.name}`);
        return res.json(result);
      }
    }

    const invalid = sites.validateName(requested);
    if (invalid) throw new sites.UserError(invalid, 400, {}, { name: requested });

    if (user) {
      const result = await sites.createSite({ requested, dir, userId: user.id, ip });
      console.log(`published ${result.name} (${result.files} files)`);
      return res.json(result);
    }
    if (isAdmin || accounts.isWhitelisted(ip)) {
      const result = await sites.createSite({ requested, dir, withPassword: true, ip });
      console.log(`published ${result.name} (${result.files} files, password)`);
      return res.json(result);
    }

    // Everyone else confirms their e-mail address first.
    const email = accounts.normEmail(f.email);
    if (!email) throw new sites.UserError('emailRequired');
    const existing = accounts.activeUserByEmail(email);
    if (accounts.isBlocked(existing)) throw new sites.UserError('uploadsBlocked', 403);
    const firstName = accounts.cleanName(f.firstName);
    const lastName = accounts.cleanName(f.lastName);
    if (!existing && (!firstName || !lastName)) throw new sites.UserError('nameRequired');
    if (!emailAllowed(`ip:${ip}`, `to:${email}`)) throw new sites.UserError('tooManyEmails', 429);
    const pendingId = await sites.savePending(dir, { ownerId: existing?.id });
    const token = accounts.createEmailToken({
      purpose: 'publish', email, userId: existing?.id ?? null, ip, minutes: config.PENDING_HOURS * 60,
      payload: { dir: pendingId, name: requested, firstName, lastName },
    });
    accounts.audit('site.pending', { userId: existing?.id ?? null, siteName: requested, ip, detail: { email } });
    await sendMail(req, {
      to: email, kind: 'publish', userId: existing?.id ?? null,
      params: { link: emailLink(token), name: requested, hours: config.PENDING_HOURS, terms: `${config.PUBLIC_URL}/podminky` },
    });
    res.json({ pending: true, email, name: requested, hours: config.PENDING_HOURS });
  } finally {
    upload.cleanup();
  }
});

// The files of a site, for editing it in the file tree.
api.post('/sites/:name/files', json, async (req, res) => {
  if (accounts.isBlocked(accounts.currentUser(req))) return fail(req, res, 403, 'uploadsBlocked');
  const site = sites.activeSite(req.params.name);
  if (!site) return fail(req, res, 404, 'siteNotFound');
  if (!canManage(req, site, req.body?.password)) return fail(req, res, 403, 'notYourSite');
  res.json({ site: sites.publicSite(site), files: await sites.listFiles(site) });
});

api.post('/sites/:name/delete', json, async (req, res) => {
  const site = sites.activeSite(req.params.name);
  if (!site) return fail(req, res, 404, 'siteNotFound');
  if (!canManage(req, site, req.body?.password)) {
    if (req.body?.password) auth.recordFailure(req);
    return fail(req, res, 403, site.password_hash ? 'wrongSitePassword' : 'notYourSite');
  }
  const user = accounts.currentUser(req);
  const byAdmin = accounts.isAdmin(req) && !(user && site.user_id === user.id) && !sites.checkSitePassword(site, req.body?.password);
  await sites.softDelete(site, { by: byAdmin ? 'admin' : 'owner', ip: ipOf(req) });
  console.log(`deleted ${site.name}`);
  res.json({ ok: true, retentionDays: config.RETENTION_DAYS });
});

api.post('/sites/:name/rename', json, async (req, res) => {
  if (accounts.isBlocked(accounts.currentUser(req))) return fail(req, res, 403, 'uploadsBlocked');
  const site = sites.activeSite(req.params.name);
  if (!site) return fail(req, res, 404, 'siteNotFound');
  const user = accounts.currentUser(req);
  const isOwner = user && site.user_id === user.id;
  if (!isOwner && !accounts.isAdmin(req)) return fail(req, res, 403, 'notYourSite');
  res.json(await sites.rename(site, req.body?.name, { ip: ipOf(req), by: isOwner ? 'owner' : 'admin' }));
});

// Password sites (whitelisted uploads): which saved passwords still work.
api.post('/my-sites', json, (req, res) => {
  if (auth.tooManyAttempts(req)) return fail(req, res, 429, 'tooManyAttempts');
  const entries = Array.isArray(req.body?.sites) ? req.body.sites.slice(0, 500) : [];
  const out = entries.map((entry) => {
    const name = String(entry?.name || '');
    const site = sites.activeSite(name);
    if (!site) return { name, status: 'missing' };
    if (sites.checkSitePassword(site, entry.password)) return { ...sites.publicSite(site), status: 'ok' };
    auth.recordFailure(req);
    return { name, status: 'wrong-password' };
  });
  res.json({ sites: out });
});

/* ---------- admin ---------- */

const admin = express.Router();
admin.use((req, res, next) => {
  if (accounts.isAdmin(req)) return next();
  fail(req, res, accounts.currentUser(req) ? 403 : 401, 'adminRequired');
}, json);
const adminSite = (req, res) => {
  const site = sites.siteById(Number(req.params.id));
  if (!site) fail(req, res, 404, 'siteNotFound');
  return site;
};
const adminUser = (req, res) => {
  const user = accounts.userById(Number(req.params.id));
  if (!user) fail(req, res, 404, 'notFound');
  return user;
};

admin.get('/sites', (req, res) =>
  res.json({ sites: sites.listAll(), storage: { used: sites.storageUsed(), limit: config.TOTAL_MAX_GB * 1024 ** 3 } }),
);
admin.get('/sites/:id/audit', (req, res) => {
  const site = adminSite(req, res);
  if (site) res.json({ site: sites.publicSite(site), events: accounts.auditForSite(site.id) });
});
// Tells the owner about a measure taken by the admin, with the reasons the
// admin wrote (only when there are some).
async function notifyMeasure(req, user, measure, params = {}) {
  const reason = String(req.body?.reason || '').trim().slice(0, 4000);
  if (!reason || !user || user.deleted_at && measure !== 'accountDeleted') return;
  await sendMail(req, {
    to: user.email, kind: 'measure', userId: user.id,
    params: { measure: mail.measureText(langOf(req), measure, params), reason, contact: config.ABUSE_EMAIL, terms: `${config.PUBLIC_URL}/podminky` },
  });
}

admin.post('/sites/:id/delete', async (req, res) => {
  const site = adminSite(req, res);
  if (!site) return;
  if (!site.deleted_at) {
    await sites.softDelete(site, { by: 'admin', ip: ipOf(req) });
    await notifyMeasure(req, site.user_id && accounts.userById(site.user_id), 'siteDeleted', { name: site.name });
  }
  res.json({ ok: true });
});
admin.post('/sites/:id/purge', async (req, res) => {
  const site = adminSite(req, res);
  if (!site) return;
  await sites.purgeSite(site);
  console.log(`purged site ${site.id} (${site.name})`);
  res.json({ ok: true });
});
admin.post('/sites/:id/rename', async (req, res) => {
  const site = adminSite(req, res);
  if (site) res.json(await sites.rename(site, req.body?.name, { ip: ipOf(req), by: 'admin' }));
});
admin.post('/sites/:id/reset-password', (req, res) => {
  const site = adminSite(req, res);
  if (!site) return;
  if (site.user_id) return fail(req, res, 400, 'accountSite');
  res.json({ name: site.name, password: sites.resetPassword(site) });
});

admin.get('/stats', (req, res) => {
  const active = sites.listAll().filter((s) => !s.deletedAt);
  const chosen = req.query.site ? active.filter((s) => s.name === req.query.site) : active;
  res.json(stats.series(chosen.map((s) => s.id), String(req.query.range || '24h')));
});
admin.get('/users', (req, res) => res.json({ users: accounts.listUsers() }));
admin.get('/users/:id/audit', (req, res) => {
  const user = adminUser(req, res);
  if (user) res.json({ user: accounts.publicUser(user), events: accounts.auditForUser(user.id, { hideEmails: false }) });
});
admin.post('/users/:id/delete', async (req, res) => {
  const user = adminUser(req, res);
  if (!user) return;
  if (user.is_admin) return fail(req, res, 400, 'adminAccount');
  await notifyMeasure(req, user, 'accountDeleted');
  await accounts.deleteUser(user.id, { by: 'admin', ip: ipOf(req) });
  res.json({ ok: true });
});
admin.post('/users/:id/block', async (req, res) => {
  const user = adminUser(req, res);
  if (!user) return;
  if (user.is_admin) return fail(req, res, 400, 'adminAccount');
  accounts.setBlocked(user.id, Boolean(req.body?.blocked), ipOf(req));
  if (req.body?.blocked) await notifyMeasure(req, user, 'accountBlocked');
  res.json({ ok: true, blocked: Boolean(req.body?.blocked) });
});
admin.post('/users/:id/purge', async (req, res) => {
  const user = adminUser(req, res);
  if (!user) return;
  if (user.is_admin) return fail(req, res, 400, 'adminAccount');
  await accounts.purgeUser(user.id);
  console.log(`purged account ${user.id} on request`);
  res.json({ ok: true });
});

admin.get('/whitelist', (req, res) => res.json({ ips: accounts.listWhitelist(), yourIp: ipOf(req) }));
admin.post('/whitelist', (req, res) => {
  if (!accounts.addWhitelist(req.body?.ip, req.body?.note)) return fail(req, res, 400, 'ipInvalid');
  res.json({ ips: accounts.listWhitelist() });
});
admin.post('/whitelist/remove', (req, res) => {
  accounts.removeWhitelist(req.body?.ip);
  res.json({ ips: accounts.listWhitelist() });
});

api.use('/admin', admin);

if (config.MAIL_DEV_OUTBOX) {
  // Tests read sent e-mails here. Never enabled in production.
  api.get('/dev/outbox', (req, res) => res.json({ messages: mail.outbox }));
}

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
  serveSite(req, res, name, rest, `/${name}`, sites.previewRoot(name)).catch(next);
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

db.open();
sites.init().then(() => {
  const housekeeping = () =>
    accounts
      .cleanup()
      .then(() => stats.cleanup())
      .catch((err) => console.error('cleanup failed:', err));
  housekeeping();
  setInterval(housekeeping, 60_000).unref();
  app.listen(config.PORT, () => {
    console.log(`Website publisher listening on :${config.PORT}`);
    console.log(`  app:   ${config.PUBLIC_URL}`);
    console.log(`  sites: ${sites.siteUrl('<name>')}`);
    console.log(`  data:  ${config.DATA_DIR}`);
  });
});
