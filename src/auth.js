'use strict';

const config = require('./config');
const { langOf, t } = require('./i18n');

// Simple in-memory brute-force protection (site passwords): MAX_FAILED_ATTEMPTS per IP per 15 minutes.
const failures = new Map();
const WINDOW = 15 * 60 * 1000;

function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip || 'unknown';
}

function tooManyAttempts(req) {
  const entry = failures.get(clientIp(req));
  if (!entry || entry.until < Date.now()) return false;
  return entry.count >= config.MAX_FAILED_ATTEMPTS;
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

// Forget IP addresses as soon as their limits have expired (the privacy
// notice promises they are kept for at most an hour).
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failures) if (entry.until < now) failures.delete(ip);
  for (const [ip, times] of publishes) if (!times.some((t) => t > now - 3600 * 1000)) publishes.delete(ip);
}, 60 * 1000).unref();

// Requests that change state must come from our own page: a custom header
// cannot be sent cross-origin without a CORS preflight (which we never
// answer), and a present Origin must match the host being talked to.
function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  // API tokens (curl) carry no cookies, so cross-site forgery does not apply.
  if (/^Bearer /.test(req.headers.authorization || '')) return next();
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

module.exports = {
  tooManyAttempts,
  recordFailure,
  publishAllowed,
  clientIp,
  sameOrigin,
};
