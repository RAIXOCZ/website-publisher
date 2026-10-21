// @ts-check
// The :4320 test server runs with SITE_MAX_MB=1 and ACCOUNT_MAX_MB=2.
const { test, expect } = require('./test');
const { HEADERS, FIXTURES, unique, createAccount, signIn, signInAsAdmin } = require('./helpers');

const BASE = 'http://localhost:4320';
test.use({ baseURL: BASE });

const KB = 1024;
const cs = { 'Accept-Language': 'cs' };
// A site of roughly `kb` kilobytes (random bytes, so nothing compresses them away).
const siteOf = (kb) => ({ name: 'index.html', mimeType: 'text/html', buffer: Buffer.concat([Buffer.from('<h1>big</h1><!--'), require('crypto').randomBytes(kb * KB)]) });

async function tokenFor(playwright) {
  const ctx = await playwright.request.newContext({ baseURL: BASE });
  await createAccount(ctx);
  const { token } = await (await ctx.post('/api/me/tokens', { headers: HEADERS, data: { name: 'limits' } })).json();
  await ctx.dispose();
  return { Authorization: `Bearer ${token}`, ...cs };
}

test('one site can have at most SITE_MAX_MB', async ({ request, playwright }) => {
  const auth = await tokenFor(playwright);
  const res = await request.post('/api/sites', { headers: auth, multipart: { name: unique('big'), f: siteOf(1100) } });
  expect(res.status()).toBe(413);
  expect((await res.json()).error).toMatch(/^Web má 1\.\d MB, jeden web může mít nejvýše 1 MB\.$/);
  // Previews and uploads waiting for an e-mail confirmation are limited too.
  const preview = await request.post('/api/sites', { headers: { ...HEADERS, ...cs }, multipart: { preview: '1', f: siteOf(1100) } });
  expect(preview.status()).toBe(413);
  const pending = await request.post('/api/sites', {
    headers: { ...HEADERS, ...cs },
    multipart: { name: unique('p'), email: `${unique('v')}@example.com`, firstName: 'A', lastName: 'B', f: siteOf(1100) },
  });
  expect(pending.status()).toBe(413);
});

test('all sites of an account together can have at most ACCOUNT_MAX_MB; deleted sites do not count', async ({ request, playwright }) => {
  const auth = await tokenFor(playwright); // the account already has a tiny first site
  const names = [unique('a'), unique('b'), unique('c')];
  for (const name of names.slice(0, 2)) {
    expect((await request.post('/api/sites', { headers: auth, multipart: { name, f: siteOf(900) } })).status()).toBe(200);
  }
  const full = await request.post('/api/sites', { headers: auth, multipart: { name: names[2], f: siteOf(900) } });
  expect(full.status()).toBe(413);
  expect((await full.json()).error).toMatch(/^Na účtu už máte 1\.\d MB z 2 MB\./);

  // Replacing a site only counts the difference.
  const replaced = await request.post('/api/sites', { headers: auth, multipart: { name: names[0], overwrite: '1', f: siteOf(950) } });
  expect(replaced.status()).toBe(200);

  await request.post(`/api/sites/${names[1]}/delete`, { headers: auth, data: {} });
  expect((await request.post('/api/sites', { headers: auth, multipart: { name: names[2], f: siteOf(900) } })).status()).toBe(200);
});

test('the account page shows how much of the limit the sites use', async ({ page, request }) => {
  await signIn(page);
  const { token } = await (await page.request.post('/api/me/tokens', { headers: HEADERS, data: { name: 'fill' } })).json();
  const own = { Authorization: `Bearer ${token}` };
  for (const name of [unique('f1'), unique('f2')]) {
    expect((await request.post('/api/sites', { headers: own, multipart: { name, f: siteOf(900) } })).status()).toBe(200);
  }
  await page.goto('/ucet');
  await expect(page.locator('#usage-text')).toHaveText(/^1\.\d MB z 2\.0 MB$/);
  await expect(page.locator('#usage-limit')).toHaveText('Jeden web může mít nejvýše 1.0 MB.');
  const width = await page.locator('#usage-bar').evaluate((el) => parseFloat(el.style.width));
  expect(width).toBeGreaterThan(80);
  await expect(page.locator('#usage-bar')).toHaveClass(/full/);
});

test('the admin account has no account limit and sees the total storage', async ({ page }) => {
  await signInAsAdmin(page, BASE);
  await page.goto('/ucet');
  await expect(page.locator('#usage-text')).toContainText('bez limitu');
  await expect(page.locator('.usage .meter')).toBeHidden();
  await page.goto('/admin');
  await expect(page.locator('#stats')).toContainText(/úložiště .* z 20 GB/);
});

test('a new preview deletes the previous one right away', async ({ page, request, playwright }) => {
  // Signed-in: one preview per account.
  const auth = await tokenFor(playwright);
  const first = await (await request.post('/api/sites', { headers: auth, multipart: { preview: '1', f: siteOf(1) } })).json();
  expect((await request.get(first.preview.url)).status()).toBe(200);
  const second = await (await request.post('/api/sites', { headers: auth, multipart: { preview: '1', f: siteOf(1) } })).json();
  expect((await request.get(first.preview.url)).status()).toBe(404);
  expect((await request.get(second.preview.url)).status()).toBe(200);

  // In the browser without an account, the page replaces its own previous preview.
  await page.goto('http://localhost:4317/');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#pick-folder').click()]);
  await chooser.setFiles(FIXTURES.site);
  await page.locator('#preview').click();
  await expect(page.locator('#preview-open')).toHaveAttribute('href', /preview-/);
  const old = await page.locator('#preview-open').getAttribute('href');
  await page.locator('#preview').click();
  await expect(page.locator('#preview-open')).not.toHaveAttribute('href', old || '');
  const fresh = await page.locator('#preview-open').getAttribute('href');
  expect((await request.get(old || '')).status()).toBe(404);
  expect((await request.get(fresh || '')).status()).toBe(200);
});

test('preview-… names are reserved for previews: not for publishing nor renaming', async ({ request, playwright }) => {
  const auth = await tokenFor(playwright);
  for (const name of ['preview-abc123', 'preview-x', 'preview']) {
    const res = await request.post('/api/sites', { headers: auth, multipart: { name, f: siteOf(1) } });
    expect(res.status(), name).toBe(400);
    expect((await res.json()).error, name).toContain('rezervovaný');
  }
  const name = unique('ren');
  await request.post('/api/sites', { headers: auth, multipart: { name, f: siteOf(1) } });
  const rename = await request.post(`/api/sites/${name}/rename`, { headers: auth, data: { name: 'preview-abc123' } });
  expect(rename.status()).toBe(400);
});
