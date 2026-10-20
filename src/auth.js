'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { langOf, t } = require('./i18n');

const COOKIE = 'pub_session';

// Secret used to sign session cookies. Persisted in the data volume so
// sessions survive restarts; mixed with the password so changing
// ADMIN_PASSWORD logs everyone out.
function loadSecret() {
  if (config.SESSION_SECRET) return config.SESSION_SECRET;
  const file = path.join(config.DATA_DIR, '.session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

let key;
function signingKey() {
  if (!key) {
    key = crypto.createHmac('sha256', loadSecret()).update(config.ADMIN_PASSWORD).digest();
  }
  return key;
}

function sign(value) {
  return crypto.createHmac('sha256', signingKey()).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !safeEqual(sig, sign(exp))) return false;
  return Number(exp) > Date.now();
}

function setSession(res) {
  const maxAge = config.SESSION_DAYS * 86400;
  const exp = String(Date.now() + maxAge * 1000);
  const cookie = [
    `${COOKIE}=${exp}.${sign(exp)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (config.SECURE_COOKIE) cookie.push('Secure');
  res.setHeader('Set-Cookie', cookie.join('; '));
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

// Simple in-memory brute-force protection: 10 failures per IP per 15 minutes.
const failures = new Map();
const WINDOW = 15 * 60 * 1000;

function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip || 'unknown';
}

function tooManyAttempts(req) {
  const entry = failures.get(clientIp(req));
  if (!entry || entry.until < Date.now()) return false;
  return entry.count >= 10;
}

function recordFailure(req) {
  const ip = clientIp(req);
  const entry = failures.get(ip);
  if (!entry || entry.until < Date.now()) {
    failures.set(ip, { count: 1, until: Date.now() + WINDOW });
  } else {
    entry.count++;
  }
}

// Caps how many uploads one IP address can make per hour.
const publishes = new Map();

function publishAllowed(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (publishes.get(ip) || []).filter((t) => t > now - 3600 * 1000);
  if (recent.length >= config.PUBLISH_PER_HOUR) return false;
  recent.push(now);
  publishes.set(ip, recent);
  return true;
}

function checkPassword(password) {
  return safeEqual(password || '', config.ADMIN_PASSWORD);
}

// Requests that change state must come from our own page: a custom header
// cannot be sent cross-origin without a CORS preflight (which we never
// answer), and a present Origin must match the host being talked to.
function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.headers['x-requested-with'] !== 'fetch') {
    return res.status(403).json({ error: t(langOf(req), 'missingHeader') });
  }
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      host = '';
    }
    if (host !== req.headers.host) return res.status(403).json({ error: t(langOf(req), 'crossOrigin') });
  }
  next();
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: t(langOf(req), 'loginRequired') });
}

module.exports = {
  isAuthed,
  setSession,
  clearSession,
  checkPassword,
  tooManyAttempts,
  recordFailure,
  publishAllowed,
  sameOrigin,
  requireAuth,
};
