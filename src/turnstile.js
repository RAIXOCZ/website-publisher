'use strict';

// Cloudflare Turnstile: the browser gets a one-time token from the widget and
// sends it in the X-Turnstile-Token header; the server checks it here before
// sending an e-mail to an address typed in by an anonymous visitor.
const config = require('./config');

const enabled = () => Boolean(config.TURNSTILE_SITE_KEY && config.TURNSTILE_SECRET_KEY);

/** Whether the request carries a valid token (always true when Turnstile is off). */
async function verify(req, ip) {
  if (!enabled()) return true;
  const token = String(req.headers['x-turnstile-token'] || '');
  if (!token || token.length > 2048) return false;
  try {
    const res = await fetch(config.TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: config.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    // Cloudflare unreachable: refuse rather than let the form be abused.
    console.error('turnstile verification failed:', err.message);
    return false;
  }
}

module.exports = { enabled, verify };
