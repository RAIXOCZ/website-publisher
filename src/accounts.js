'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const { one, all, run, transaction, now, inMinutes, inDays, encodeCursor, decodeCursor, likeContains, pageSize } = require('./db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

function normEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null;
}

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/* ---------- audit log ---------- */

function audit(action, { userId = null, siteId = null, siteName = null, ip = null, detail = null } = {}) {
  run(
    'INSERT INTO audit_log (at, user_id, site_id, site_name, action, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
    now(), userId, siteId, siteName, action, ip, detail ? JSON.stringify(detail) : null,
  );
}

function parseAudit(row, { forOwner }) {
  let detail = row.detail ? JSON.parse(row.detail) : null;
  // The owner's own history leaves out e-mail and IP addresses; only the admin sees them.
  if (detail && forOwner) {
    detail = Object.fromEntries(Object.entries(detail).filter(([k]) => !/email|^to$|ip$/i.test(k)));
  }
  const ip = forOwner ? null : row.ip;
  return { id: row.id, at: row.at, action: row.action, site: row.site_name, siteId: row.site_id, ip, detail };
}

// History is read a page at a time, newest first: { events, next }.
function auditPage(where, args, { forOwner, cursor, limit }) {
  const before = decodeCursor(cursor);
  const size = pageSize(limit);
  const rows = all(`SELECT * FROM audit_log WHERE (${where}) ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`, ...args, ...(before ? [before] : []), size + 1);
  const page = rows.slice(0, size);
  return { events: page.map((r) => parseAudit(r, { forOwner })), next: rows.length > size ? encodeCursor(page.at(-1).id) : null };
}

const auditForUser = (userId, { forOwner = true, cursor = null, limit = 50 } = {}) =>
  auditPage('user_id = ? OR site_id IN (SELECT id FROM sites WHERE user_id = ?)', [userId, userId], { forOwner, cursor, limit });

const auditForSite = (siteId, { cursor = null, limit = 50 } = {}) => auditPage('site_id = ?', [siteId], { forOwner: false, cursor, limit });

/* ---------- users ---------- */

const activeUserByEmail = (email) => one('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL', email);
const userById = (id) => one('SELECT * FROM users WHERE id = ?', id);

function createUser({ email, firstName, lastName, ip }) {
  const info = run(
    'INSERT INTO users (email, first_name, last_name, created_at, created_ip) VALUES (?, ?, ?, ?, ?)',
    email, cleanName(firstName), cleanName(lastName), now(), ip,
  );
  const id = Number(info.lastInsertRowid);
  audit('account.created', { userId: id, ip, detail: { email } });
  return userById(id);
}

function publicUser(user) {
  return user && { id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name, createdAt: user.created_at, isAdmin: Boolean(user.is_admin), blocked: Boolean(user.blocked_at) };
}

// The admin can stop an account from adding and editing sites (for
// example when it uses too much storage); deleting stays possible.
function setBlocked(userId, blocked, ip) {
  run('UPDATE users SET blocked_at = ? WHERE id = ? AND is_admin = 0', blocked ? now() : null, userId);
  audit(blocked ? 'account.blocked_by_admin' : 'account.unblocked_by_admin', { userId, ip });
}

const isBlocked = (user) => Boolean(user && user.blocked_at && !user.is_admin);

// The account with ADMIN_EMAIL is the administrator. It is created on start;
// if ADMIN_EMAIL changed and no account uses the new address yet, the
// previous admin account (or the one created for migrated sites under the
// old default address) moves to it, keeping its sites.
const PREVIOUS_DEFAULT_ADMIN = 'martin@balcar.me';
function ensureAdmin() {
  let admin =
    activeUserByEmail(config.ADMIN_EMAIL) ||
    one('SELECT * FROM users WHERE is_admin = 1 AND deleted_at IS NULL') ||
    one('SELECT * FROM users WHERE email = ? AND created_ip IS NULL AND deleted_at IS NULL', PREVIOUS_DEFAULT_ADMIN);
  if (!admin) admin = createUser({ email: config.ADMIN_EMAIL, firstName: config.ADMIN_FIRST_NAME, lastName: config.ADMIN_LAST_NAME, ip: null });
  transaction(() => {
    run('UPDATE users SET is_admin = 0 WHERE is_admin = 1 AND id != ?', admin.id);
    run('UPDATE users SET is_admin = 1, email = ? WHERE id = ?', config.ADMIN_EMAIL, admin.id);
  });
  if (admin.email !== config.ADMIN_EMAIL) console.log(`admin account moved from ${admin.email} to ${config.ADMIN_EMAIL}`);
  return userById(admin.id);
}

// Admin rights come only with a browser session, never with an API token.
function isAdmin(req) {
  const user = currentUser(req);
  return Boolean(user && user.is_admin && req._via === 'session');
}

function updateNames(user, { firstName, lastName }, ip) {
  run('UPDATE users SET first_name = ?, last_name = ? WHERE id = ?', cleanName(firstName), cleanName(lastName), user.id);
  audit('account.updated', { userId: user.id, ip });
}

/* ---------- sessions (cookie fp_user) ---------- */

const SESSION_COOKIE = 'fp_user';

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function startSession(res, userId) {
  const token = randomToken();
  const maxAge = config.USER_SESSION_DAYS * 86400;
  run('INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(token), userId, now(), inDays(config.USER_SESSION_DAYS));
  const cookie = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (config.SECURE_COOKIE) cookie.push('Secure');
  res.append('Set-Cookie', cookie.join('; '));
}

function endSession(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) run('DELETE FROM sessions WHERE hash = ?', sha256(token));
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// The signed-in user from the session cookie or an API token, or null.
function currentUser(req) {
  if (req._user !== undefined) return req._user;
  let user = null;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const row = one('SELECT * FROM api_tokens WHERE hash = ? AND revoked_at IS NULL', sha256(auth.slice(7).trim()));
    if (row) {
      run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), row.id);
      user = one('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', row.user_id);
      req._via = 'token';
    }
  } else {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const row = one('SELECT * FROM sessions WHERE hash = ? AND expires_at > ?', sha256(token), now());
      if (row) user = one('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', row.user_id);
      req._via = 'session';
    }
  }
  req._user = user;
  return user;
}

/* ---------- one-time e-mail links ---------- */

function createEmailToken({ purpose, email, userId = null, payload = null, ip, minutes }) {
  const token = randomToken();
  run(
    'INSERT INTO email_tokens (hash, purpose, email, user_id, payload, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    sha256(token), purpose, email, userId, payload ? JSON.stringify(payload) : null, ip, now(), inMinutes(minutes),
  );
  return token;
}

function readEmailToken(token) {
  const row = one('SELECT * FROM email_tokens WHERE hash = ?', sha256(token || ''));
  if (!row) return null;
  return { ...row, payload: row.payload ? JSON.parse(row.payload) : null, valid: !row.used_at && row.expires_at > now() };
}

// Marks the link as used; returns it only if it was still valid.
function consumeEmailToken(token) {
  const hash = sha256(token || '');
  const info = run('UPDATE email_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?', now(), hash, now());
  if (!info.changes) return null;
  const row = one('SELECT * FROM email_tokens WHERE hash = ?', hash);
  return { ...row, payload: row.payload ? JSON.parse(row.payload) : null };
}

/* ---------- API tokens for curl ---------- */

function createApiToken(user, name, ip) {
  const token = `fp_${randomToken(24)}`;
  const info = run(
    'INSERT INTO api_tokens (user_id, name, hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)',
    user.id, cleanName(name) || 'CLI', sha256(token), token.slice(0, 10), now(),
  );
  audit('token.created', { userId: user.id, ip, detail: { name: cleanName(name) || 'CLI' } });
  return { id: Number(info.lastInsertRowid), token };
}

function listApiTokens(userId) {
  return all(
    'SELECT id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY id DESC',
    userId,
  );
}

function revokeApiToken(user, id, ip) {
  const info = run('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', now(), id, user.id);
  if (info.changes) audit('token.revoked', { userId: user.id, ip });
  return info.changes > 0;
}

/* ---------- IP whitelist (publishing without an account) ---------- */

const normIp = (ip) => String(ip || '').replace(/^::ffff:/, '').trim();

function isWhitelisted(ip) {
  const n = normIp(ip);
  if (!n) return false;
  return Boolean(one('SELECT 1 AS x FROM ip_whitelist WHERE ip = ?', n));
}

function listWhitelist() {
  return all('SELECT ip, note, created_at AS createdAt FROM ip_whitelist ORDER BY created_at DESC');
}

function addWhitelist(ip, note) {
  const n = normIp(ip);
  if (!/^[0-9a-f:.]{3,45}$/i.test(n)) return false;
  run('INSERT OR REPLACE INTO ip_whitelist (ip, note, created_at) VALUES (?, ?, ?)', n, cleanName(note), now());
  return true;
}

function removeWhitelist(ip) {
  return run('DELETE FROM ip_whitelist WHERE ip = ?', normIp(ip)).changes > 0;
}

/* ---------- deleting accounts ---------- */

// Unlinks the account: sites go offline, sign-ins stop, and everything is
// erased after RETENTION_DAYS (or right away with purgeUser).
async function deleteUser(userId, { by, ip }) {
  const user = userById(userId);
  if (!user || user.deleted_at || user.is_admin) return false;
  const sites = require('./sites');
  for (const site of all('SELECT * FROM sites WHERE user_id = ? AND deleted_at IS NULL', userId)) {
    await sites.softDelete(site, { by, ip });
  }
  transaction(() => {
    run('UPDATE users SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ?', now(), by, inDays(config.RETENTION_DAYS), userId);
    run('DELETE FROM sessions WHERE user_id = ?', userId);
    run('UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now(), userId);
  });
  audit(by === 'admin' ? 'account.deleted_by_admin' : 'account.deleted', { userId, ip });
  return true;
}

// Erases an account and everything linked to it for good.
async function purgeUser(userId) {
  const user = userById(userId);
  if (!user || user.is_admin) return false;
  const sites = require('./sites');
  for (const site of all('SELECT * FROM sites WHERE user_id = ?', userId)) await sites.purgeSite(site);
  transaction(() => {
    run('DELETE FROM audit_log WHERE user_id = ?', userId);
    // Entries and links from before the account existed (first upload,
    // e-mails sent to the address), up to the deletion: a newer account
    // with the same e-mail keeps its own.
    const until = user.deleted_at || now();
    run(
      `DELETE FROM audit_log WHERE user_id IS NULL AND at <= ?
       AND (json_extract(detail, '$.email') = ? OR json_extract(detail, '$.to') = ?)`,
      until, user.email, user.email,
    );
    run('DELETE FROM api_tokens WHERE user_id = ?', userId);
    run('DELETE FROM sessions WHERE user_id = ?', userId);
    run('DELETE FROM email_tokens WHERE user_id = ? OR (email = ? AND created_at <= ?)', userId, user.email, until);
    run('DELETE FROM previews WHERE user_id = ?', userId);
    run('DELETE FROM users WHERE id = ?', userId);
  });
  return true;
}

/* ---------- admin listing ---------- */

/**
 * One page of accounts, newest first, searched by e-mail, name or the IP
 * they were created from. `deleted` is 'active' (default), 'deleted' or 'all'.
 */
function listUsersPage({ q = '', deleted = 'active', cursor = null, limit = 50 } = {}) {
  const where = ['1 = 1'];
  const args = [];
  if (deleted === 'active') where.push('u.deleted_at IS NULL');
  else if (deleted === 'deleted') where.push('u.deleted_at IS NOT NULL');
  const term = String(q || '').trim().toLowerCase();
  if (term) {
    const like = likeContains(term);
    where.push("(lower(u.email) LIKE ? ESCAPE '\\' OR lower(u.first_name || ' ' || u.last_name) LIKE ? ESCAPE '\\' OR u.created_ip LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  const filter = where.join(' AND ');
  const total = one(`SELECT COUNT(*) AS n FROM users u WHERE ${filter}`, ...args).n;
  const before = decodeCursor(cursor);
  const size = pageSize(limit);
  const rows = all(`
    SELECT u.id, u.email, u.first_name AS firstName, u.last_name AS lastName, u.created_at AS createdAt,
           u.created_ip AS createdIp, u.is_admin AS isAdmin, u.blocked_at AS blockedAt, u.deleted_at AS deletedAt, u.deleted_by AS deletedBy, u.purge_after AS purgeAfter,
           (SELECT COUNT(*) FROM sites s WHERE s.user_id = u.id AND s.deleted_at IS NULL) AS sites,
           (SELECT COUNT(*) FROM sites s WHERE s.user_id = u.id AND s.deleted_at IS NOT NULL) AS deletedSites
    FROM users u WHERE ${filter} ${before ? 'AND u.id < ?' : ''} ORDER BY u.id DESC LIMIT ?`, ...args, ...(before ? [before] : []), size + 1);
  const page = rows.slice(0, size);
  return { items: page, next: rows.length > size ? encodeCursor(page.at(-1).id) : null, total };
}

const countUsers = () => one('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL').n;

/* ---------- housekeeping ---------- */

async function cleanup() {
  const sites = require('./sites');
  const t = now();
  for (const user of all('SELECT id FROM users WHERE deleted_at IS NOT NULL AND purge_after < ?', t)) {
    await purgeUser(user.id);
    console.log(`purged account ${user.id} after retention period`);
  }
  for (const site of all('SELECT * FROM sites WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND purge_after < ?', t)) {
    await sites.purgeSite(site);
  }
  for (const preview of all('SELECT code FROM previews WHERE expires_at < ?', t)) {
    await fsp.rm(path.join(config.PREVIEWS_DIR, preview.code), { recursive: true, force: true });
    run('DELETE FROM previews WHERE code = ?', preview.code);
  }
  for (const tok of all("SELECT hash, payload FROM email_tokens WHERE purpose = 'publish' AND (expires_at < ? OR used_at IS NOT NULL)", t)) {
    const dir = tok.payload && JSON.parse(tok.payload).dir;
    if (dir) await fsp.rm(path.join(config.PENDING_DIR, path.basename(dir)), { recursive: true, force: true });
  }
  run('DELETE FROM email_tokens WHERE expires_at < ?', inDays(-1));
  run('DELETE FROM sessions WHERE expires_at < ?', t);
  // Entries tied to no account or site (unconfirmed uploads, sent e-mails)
  // are kept for the same retention period.
  run('DELETE FROM audit_log WHERE user_id IS NULL AND site_id IS NULL AND at < ?', inDays(-config.RETENTION_DAYS));
  // No entry is kept longer than AUDIT_DAYS (12 months by default).
  run('DELETE FROM audit_log WHERE at < ?', inDays(-config.AUDIT_DAYS));
}

module.exports = {
  normEmail,
  cleanName,
  sha256,
  audit,
  auditForUser,
  auditForSite,
  activeUserByEmail,
  userById,
  createUser,
  publicUser,
  ensureAdmin,
  isAdmin,
  setBlocked,
  isBlocked,
  updateNames,
  startSession,
  endSession,
  currentUser,
  createEmailToken,
  readEmailToken,
  consumeEmailToken,
  createApiToken,
  listApiTokens,
  revokeApiToken,
  isWhitelisted,
  normIp,
  listWhitelist,
  addWhitelist,
  removeWhitelist,
  deleteUser,
  purgeUser,
  listUsersPage,
  countUsers,
  cleanup,
};
