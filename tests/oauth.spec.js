// @ts-check
const crypto = require('crypto');
const { test, expect } = require('./test');
const { HEADERS, uniqueEmail, lastMail, signIn } = require('./helpers');

const BASE = 'http://localhost:4317';
const REDIRECT = 'http://127.0.0.1:33418/callback';

// What an MCP client does before it opens the browser.
async function startClient(request) {
  const meta = await (await request.get('/.well-known/oauth-protected-resource')).json();
  expect(meta.resource).toBe(`${BASE}/mcp`);
  const as = await (await request.get('/.well-known/oauth-authorization-server')).json();
  expect(as.code_challenge_methods_supported).toContain('S256');
  const reg = await request.post(as.registration_endpoint.replace(BASE, ''), { data: { client_name: 'Test Agent', redirect_uris: [REDIRECT] } });
  expect(reg.status()).toBe(201);
  const { client_id } = await reg.json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(8).toString('hex');
  const url = `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state, resource: `${BASE}/mcp`, scope: 'sites' })}`;
  return { client_id, verifier, state, url };
}

// The browser lands on the app's redirect URI; we catch it instead of loading it.
async function catchRedirect(page) {
  let target;
  await page.route(`${REDIRECT}**`, (route) => {
    target = new URL(route.request().url());
    route.fulfill({ body: 'ok' });
  });
  return () => target;
}

async function exchange(request, client, code) {
  return request.post('/oauth/token', {
    form: { grant_type: 'authorization_code', code, code_verifier: client.verifier, client_id: client.client_id, redirect_uri: REDIRECT },
  });
}

test('an MCP client without a key is told where to sign in', async ({ request }) => {
  const res = await request.post('/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  expect(res.status()).toBe(401);
  expect(res.headers()['www-authenticate']).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
});

test('signed in: one click allows the app, and its key works with MCP', async ({ page, request }) => {
  await signIn(page);
  const client = await startClient(request);
  const target = await catchRedirect(page);
  await page.goto(client.url);
  await expect(page.locator('#oauth-title')).toHaveText('Připojit Test Agent');
  await expect(page.locator('#oauth-signed-as')).toContainText('Přihlašujete se jako');
  await expect(page.locator('#oauth-other')).toHaveText('můžete se přihlásit do jiného účtu');
  await page.locator('#oauth-allow').click();
  await expect.poll(() => Boolean(target())).toBe(true);
  expect(target().searchParams.get('state')).toBe(client.state);

  const res = await exchange(request, client, target().searchParams.get('code'));
  expect(res.status()).toBe(200);
  const { access_token, token_type } = await res.json();
  expect(token_type).toBe('Bearer');
  const tools = await request.post('/mcp', { headers: { Authorization: `Bearer ${access_token}` }, data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  expect(tools.status()).toBe(200);

  // The code works once, and the key shows up among the account's API keys.
  expect((await exchange(request, client, target().searchParams.get('code'))).status()).toBe(400);
  const me = await (await page.request.get('/api/me', { headers: HEADERS })).json();
  expect(me.tokens.map((tok) => tok.name)).toContain('Test Agent (MCP)');
});

test('not signed in: a new account is created by the e-mail link and the page returns to the app', async ({ browser, request }) => {
  const client = await startClient(request);
  const appPage = await browser.newPage();
  const target = await catchRedirect(appPage);
  await appPage.goto(`${BASE}${client.url}`);
  const email = uniqueEmail('agent');
  await appPage.locator('#oauth-form input[name=email]').fill(email);
  await appPage.locator('#oauth-form button[type=submit]').click();
  await expect(appPage.locator('#oauth-form .alert')).toContainText('Doplňte jméno');
  await appPage.locator('#oauth-form input[name=firstName]').fill('Agent');
  await appPage.locator('#oauth-form input[name=lastName]').fill('Smith');
  await appPage.locator('#oauth-form button[type=submit]').click();
  await expect(appPage.locator('#oauth-wait-text')).toContainText(email);

  // The e-mail is opened somewhere else, e.g. on a phone.
  const mail = await lastMail(request, email, 'oauthRegister');
  expect(mail.subject).toBe('Vytvořit účet a povolit přístup pro Test Agent');
  const phone = await browser.newPage();
  await phone.goto(new URL(mail.params.link).href.replace(/^https?:\/\/[^/]+/, BASE));
  await expect(phone.locator('#confirm-title')).toHaveText('Povolit přístup pro Test Agent');
  await phone.locator('#confirm-button').click();
  await expect(phone.locator('#confirm-title')).toHaveText('Přístup povolen');

  await expect.poll(() => Boolean(target()), { timeout: 10000 }).toBe(true);
  const res = await exchange(request, client, target().searchParams.get('code'));
  expect(res.status()).toBe(200);
  await phone.close();
  await appPage.close();
});

test('denying, bad redirects and wrong PKCE are refused', async ({ page, request }) => {
  const client = await startClient(request);
  const target = await catchRedirect(page);
  await page.goto(client.url);
  await page.locator('#oauth-deny-2').click();
  await expect.poll(() => target()?.searchParams.get('error')).toBe('access_denied');

  await page.goto(client.url.replace(encodeURIComponent(REDIRECT), encodeURIComponent('https://evil.example/cb')));
  await expect(page.locator('#oauth-title')).toHaveText('Aplikaci nelze připojit');

  expect((await request.post('/oauth/register', { data: { redirect_uris: ['javascript:alert(1)'] } })).status()).toBe(400);
  expect((await request.post('/oauth/token', { form: { grant_type: 'authorization_code', code: 'nope', code_verifier: 'x' } })).status()).toBe(400);
});
