'use strict';

const path = require('path');
const crypto = require('crypto');
const { expect, request: playwrightRequest } = require('@playwright/test');

const FIXTURES = {
  site: path.join(__dirname, 'fixtures', 'sample-site'),
  siteV2: path.join(__dirname, 'fixtures', 'sample-site-v2'),
  zip: path.join(__dirname, 'fixtures', 'zipped-site.zip'),
};

const ADMIN_EMAIL = 'martin@freepages.dev';
const PASSWORD_RE = /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/;
const HEADERS = { 'X-Requested-With': 'fetch' };

// Unique site name per test so tests can run in parallel against one server.
function unique(prefix) {
  return `${prefix}-${crypto.randomBytes(3).toString('hex')}`;
}

const uniqueEmail = (prefix = 'user') => `${unique(prefix)}@example.com`;

// Clicks something that opens a file picker and answers it with `files`.
async function pick(page, locator, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), locator.click()]);
  await chooser.setFiles(files);
}

// Adds files through a picker, then presses the publish button.
async function pickAndPublish(page, locator, files) {
  await pick(page, locator, files);
  await page.locator('#publish').click();
}

const htmlFile = (html) => ({ name: 'index.html', mimeType: 'text/html', buffer: Buffer.from(html) });

/* ---------- e-mail (the test servers run with MAIL_DEV_OUTBOX=1) ---------- */

// The newest e-mail of `kind` sent to `email`; waits for it to arrive.
async function lastMail(request, email, kind) {
  let message;
  await expect
    .poll(async () => {
      const { messages } = await (await request.get('/api/dev/outbox')).json();
      message = messages.filter((m) => m.to === email && (!kind || m.kind === kind)).at(-1);
      return Boolean(message);
    })
    .toBe(true);
  return message;
}

async function mailToken(request, email, kind) {
  const message = await lastMail(request, email, kind);
  return message.params.link.split('/').pop();
}

/**
 * Creates an account the way a visitor does (upload + e-mail confirmation)
 * and signs `request` in. With page.request the browser page is signed in
 * too, as they share cookies. Returns { email, site }.
 */
async function createAccount(request, { email = uniqueEmail(), site = unique('first'), html = '<h1>First site</h1>' } = {}) {
  const res = await request.post('/api/sites', {
    headers: HEADERS,
    multipart: { name: site, email, firstName: 'Test', lastName: 'User', f: htmlFile(html) },
  });
  expect(res.status(), await res.text()).toBe(200);
  const token = await mailToken(request, email, 'publish');
  const consumed = await request.post('/api/auth/consume', { headers: HEADERS, data: { token } });
  expect(consumed.status()).toBe(200);
  return { email, site: (await consumed.json()).site.name };
}

const signIn = (page, options) => createAccount(page.request, options);

/**
 * Signs `request` in to an existing account with an e-mail link. Several
 * tests may sign in as the admin at once, so a link someone else used up
 * just means asking for a new one.
 */
async function signInByEmail(request, email, origin = '') {
  for (let attempt = 0; attempt < 10; attempt++) {
    const before = (await (await request.get(`${origin}/api/dev/outbox`)).json()).messages.length;
    await request.post(`${origin}/api/auth/login`, { headers: HEADERS, data: { email } });
    let token;
    await expect
      .poll(async () => {
        const { messages } = await (await request.get(`${origin}/api/dev/outbox`)).json();
        const mail = messages.slice(before).find((m) => m.to === email && m.kind === 'login');
        token = mail?.params.link.split('/').pop();
        return Boolean(token);
      })
      .toBe(true);
    const res = await request.post(`${origin}/api/auth/consume`, { headers: HEADERS, data: { token } });
    if (res.ok()) return;
  }
  throw new Error(`could not sign in as ${email}`);
}

const signInAsAdmin = (page, origin) => signInByEmail(page.request, ADMIN_EMAIL, origin);

// An API token of a fresh account on the server at `baseURL` (cached per worker).
const tokens = new Map();
async function apiToken(baseURL = 'http://localhost:4317', extraHTTPHeaders = {}) {
  const key = baseURL + JSON.stringify(extraHTTPHeaders);
  if (!tokens.has(key)) {
    tokens.set(
      key,
      (async () => {
        const ctx = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders });
        await createAccount(ctx);
        const res = await ctx.post('/api/me/tokens', { headers: HEADERS, data: { name: 'tests' } });
        const { token } = await res.json();
        await ctx.dispose();
        return token;
      })(),
    );
  }
  return tokens.get(key);
}

/**
 * Publishes a one-file site straight through the API with an account token
 * (pass `token: null` to publish anonymously). Returns { status, body }.
 */
async function publishViaApi(request, name, html = '<h1>API site</h1>', extra = {}, { token, baseURL, extraHTTPHeaders } = {}) {
  if (token === undefined) token = await apiToken(baseURL, extraHTTPHeaders);
  const headers = token ? { Authorization: `Bearer ${token}` } : HEADERS;
  const res = await request.post('/api/sites', { headers, multipart: { name, ...extra, f: htmlFile(html) } });
  return { status: res.status(), body: await res.json() };
}

// Answers browser dialogs (confirm/prompt) in order; returns what they showed.
function answerDialogs(page, answers) {
  const seen = [];
  page.on('dialog', async (dialog) => {
    seen.push({ type: dialog.type(), message: dialog.message(), value: dialog.defaultValue() });
    const answer = answers.shift();
    if (answer === false) await dialog.dismiss();
    else await dialog.accept(typeof answer === 'string' ? answer : undefined);
  });
  return seen;
}

async function clipboard(page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

module.exports = {
  FIXTURES,
  ADMIN_EMAIL,
  PASSWORD_RE,
  HEADERS,
  unique,
  uniqueEmail,
  pick,
  pickAndPublish,
  htmlFile,
  lastMail,
  mailToken,
  createAccount,
  signIn,
  signInByEmail,
  signInAsAdmin,
  apiToken,
  publishViaApi,
  answerDialogs,
  clipboard,
};
