// @ts-check
const { test, expect } = require('./test');
const { HEADERS, unique, uniqueEmail, FIXTURES, pick } = require('./helpers');

// The server on :4321 has Turnstile on; tests/start-server.js stands in for
// Cloudflare and accepts only the token "pass-token".
const BASE = 'http://localhost:4321';
test.use({ baseURL: BASE });

const htmlFile = { name: 'index.html', mimeType: 'text/html', buffer: Buffer.from('<h1>t</h1>') };

// A stand-in for Cloudflare's widget script: hands out "pass-token" at once.
const fakeWidget = `window.turnstile = {
  render(el, opts) { this.opts = opts; window.__turnstileRenders = (window.__turnstileRenders || 0) + 1; return 1; },
  execute() { setTimeout(() => this.opts.callback('pass-token')); },
  reset() {},
};`;

test('e-mail forms need a valid Turnstile token', async ({ request }) => {
  const login = (token) =>
    request.post('/api/auth/login', { headers: { ...HEADERS, ...(token ? { 'X-Turnstile-Token': token } : {}) }, data: { email: uniqueEmail('ts') } });
  expect((await login(null)).status()).toBe(403);
  const wrong = await login('wrong');
  expect(wrong.status()).toBe(403);
  expect((await wrong.json()).error).toContain('robot');
  expect((await login('pass-token')).status()).toBe(200);

  const register = (token) =>
    request.post('/api/auth/register', {
      headers: { ...HEADERS, ...(token ? { 'X-Turnstile-Token': token } : {}) },
      data: { email: uniqueEmail('ts'), firstName: 'Tea', lastName: 'Test' },
    });
  expect((await register(null)).status()).toBe(403);
  expect((await register('pass-token')).status()).toBe(200);

  const publish = (token) =>
    request.post('/api/sites', {
      headers: { ...HEADERS, ...(token ? { 'X-Turnstile-Token': token } : {}) },
      multipart: { name: unique('ts'), email: uniqueEmail('ts'), firstName: 'Tea', lastName: 'Test', f: htmlFile },
    });
  expect((await publish(null)).status()).toBe(403);
  const ok = await publish('pass-token');
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toMatchObject({ pending: true });
});

test('pages carry the site key and the CSP lets the widget load', async ({ request }) => {
  for (const p of ['/', '/ucet']) {
    const res = await request.get(p);
    expect(await res.text(), p).toContain('<meta name="turnstile-site-key" content="test-site-key">');
    const csp = res.headers()['content-security-policy'];
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
  }
});

test('the sign-in and publish forms get a token from the widget', async ({ page }) => {
  await page.route('https://challenges.cloudflare.com/**', (route) => route.fulfill({ contentType: 'text/javascript', body: fakeWidget }));

  await page.goto('/ucet');
  await page.locator('#signin-form [name=email]').fill(uniqueEmail('tsui'));
  await page.locator('#signin-form button[type=submit]').click();
  await expect(page.locator('#signin-sent')).toBeVisible();

  await page.goto('/');
  await pick(page, page.locator('#pick-folder'), FIXTURES.site);
  await page.locator('#name').fill(unique('tsui'));
  await page.locator('#id-first').fill('Tea');
  await page.locator('#id-last').fill('Test');
  await page.locator('#id-email').fill(uniqueEmail('tsui'));
  await page.locator('#publish').click();
  await expect(page.locator('#pending')).toBeVisible();
  expect(await page.evaluate(() => window.__turnstileRenders)).toBe(1);
});
