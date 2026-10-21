'use strict';

// OAuth 2.1 sign-in for MCP clients (the MCP authorization spec). An app
// such as Claude or Cursor registers itself (dynamic client registration),
// opens /oauth/authorize in the user's browser and gets an API key once the
// user allows it: with one click when already signed in, otherwise through
// a link sent by e-mail, which can also create the account. The key is an
// ordinary API key of the account (listed and revocable under API keys).
const crypto = require('crypto');
const config = require('./config');
const accounts = require('./accounts');
const { one, run, now, inMinutes } = require('./db');

const REQUEST_MINUTES = 30; // how long the browser page waits for approval
const CODE_MINUTES = 10; // how long the app has to exchange the code
const SCOPE = 'sites';

const randomId = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function metadata() {
  const u = config.PUBLIC_URL;
  return {
    authorizationServer: {
      issuer: u,
      authorization_endpoint: `${u}/oauth/authorize`,
      token_endpoint: `${u}/oauth/token`,
      registration_endpoint: `${u}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE],
      service_documentation: `${u}/docs.md?lang=en`,
    },
    protectedResource: {
      resource: `${u}/mcp`,
      authorization_servers: [u],
      bearer_methods_supported: ['header'],
      scopes_supported: [SCOPE],
      resource_name: 'freepages.dev',
      resource_documentation: `${u}/docs.md?lang=en`,
    },
  };
}

// https anywhere, http only back to this computer, or an app's own scheme
// (cursor://…); never script-like schemes.
function validRedirect(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(url.protocol);
}

function clientById(id) {
  const row = one('SELECT * FROM oauth_clients WHERE id = ?', String(id || ''));
  return row && { ...row, redirect_uris: JSON.parse(row.redirect_uris) };
}

function register(body) {
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) {
    return { status: 400, body: { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https, http://localhost or an app scheme.' } };
  }
  const name = String(body.client_name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || 'MCP client';
  const id = randomId(16);
  run('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)', id, name, JSON.stringify(uris), now());
  return {
    status: 201,
    body: {
      client_id: id,
      client_name: name,
      redirect_uris: uris,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    },
  };
}

// The browser page starts a request with the authorize parameters.
function startRequest(q, ip) {
  const client = clientById(q.client_id);
  if (!client) return { error: 'unknownClient' };
  if (!client.redirect_uris.includes(q.redirect_uri)) return { error: 'badRedirect' };
  if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !/^[\w-]{43,128}$/.test(q.code_challenge || '')) {
    return { error: 'badRequest' };
  }
  const id = randomId();
  run(
    'INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, state, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, client.id, q.redirect_uri, q.code_challenge, q.state ? String(q.state).slice(0, 500) : null, ip, now(), inMinutes(REQUEST_MINUTES),
  );
  return { id, client: { name: client.name, host: new URL(q.redirect_uri).host || new URL(q.redirect_uri).protocol } };
}

const activeRequest = (id) => one("SELECT * FROM oauth_requests WHERE id = ? AND expires_at > ? AND status IN ('pending', 'approved')", String(id || ''), now());

function redirectWith(request, params) {
  const url = new URL(request.redirect_uri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (request.state) url.searchParams.set('state', request.state);
  url.searchParams.set('iss', config.PUBLIC_URL);
  return url.href;
}

/** The user allowed the request: the app gets a one-time code. */
function approve(id, user, ip) {
  const request = activeRequest(id);
  if (!request || request.status !== 'pending') return null;
  const code = randomId();
  run("UPDATE oauth_requests SET status = 'approved', user_id = ?, code_hash = ?, expires_at = ? WHERE id = ?", user.id, sha256(code), inMinutes(CODE_MINUTES), id);
  const client = clientById(request.client_id);
  accounts.audit('oauth.approved', { userId: user.id, ip, detail: { app: client?.name } });
  return redirectWith(request, { code });
}

function deny(id) {
  const request = activeRequest(id);
  if (!request) return null;
  run("UPDATE oauth_requests SET status = 'denied' WHERE id = ?", id);
  return redirectWith(request, { error: 'access_denied' });
}

// What the waiting browser page sees. The code is only in the redirect,
// and it is useless without the app's PKCE secret.
function requestStatus(id) {
  const request = one('SELECT * FROM oauth_requests WHERE id = ?', String(id || ''));
  if (!request || request.expires_at <= now()) return { status: 'expired' };
  return { status: request.status };
}

// The page that waited gets the redirect with a fresh code once approved
// (the e-mail link may have been opened on another device).
function takeRedirect(id) {
  const request = one("SELECT * FROM oauth_requests WHERE id = ? AND status = 'approved' AND expires_at > ?", String(id || ''), now());
  if (!request) return null;
  const code = randomId();
  run('UPDATE oauth_requests SET code_hash = ? WHERE id = ?', sha256(code), id);
  return redirectWith(request, { code });
}

function token(body, ip) {
  const bad = (error, description) => ({ status: 400, body: { error, error_description: description } });
  if (body.grant_type !== 'authorization_code') return bad('unsupported_grant_type', 'Only authorization_code is supported.');
  const request = one("SELECT * FROM oauth_requests WHERE code_hash = ? AND status = 'approved' AND expires_at > ?", sha256(body.code || ''), now());
  if (!request) return bad('invalid_grant', 'The code is invalid, expired or already used.');
  if (body.client_id && body.client_id !== request.client_id) return bad('invalid_grant', 'The code belongs to another client.');
  if (body.redirect_uri && body.redirect_uri !== request.redirect_uri) return bad('invalid_grant', 'redirect_uri does not match.');
  const challenge = crypto.createHash('sha256').update(String(body.code_verifier || '')).digest('base64url');
  if (challenge !== request.code_challenge) return bad('invalid_grant', 'PKCE verification failed.');
  run("UPDATE oauth_requests SET status = 'used', code_hash = NULL WHERE id = ?", request.id);
  const user = accounts.userById(request.user_id);
  if (!user || user.deleted_at) return bad('invalid_grant', 'The account no longer exists.');
  const client = clientById(request.client_id);
  const { token: accessToken } = accounts.createApiToken(user, `${client?.name || 'MCP client'} (MCP)`, ip);
  return { status: 200, body: { access_token: accessToken, token_type: 'Bearer', scope: SCOPE } };
}

function cleanup() {
  run('DELETE FROM oauth_requests WHERE expires_at < ?', new Date(Date.now() - 86400_000).toISOString());
}

module.exports = { metadata, register, startRequest, activeRequest, approve, deny, requestStatus, takeRedirect, token, clientById, cleanup, REQUEST_MINUTES };
