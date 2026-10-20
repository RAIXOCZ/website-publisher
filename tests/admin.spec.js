// @ts-check
const { test, expect } = require('@playwright/test');
const { FIXTURES, ADMIN_PASSWORD, HEADERS, unique, pick, createAccount, publishViaApi, answerDialogs } = require('./helpers');

async function login(page) {
  await page.goto('/admin');
  await page.locator('#login input[name=password]').fill(ADMIN_PASSWORD);
  await page.locator('#login button[type=submit]').click();
  await expect(page.locator('#panel')).toBeVisible();
}

// A site owned by a fresh account (created through its own request context).
async function ownedSite(playwright) {
  const ctx = await playwright.request.newContext({ baseURL: 'http://localhost:4317' });
  const account = await createAccount(ctx, { site: unique('owned'), html: '<h1>Owned</h1>' });
  await ctx.dispose();
  return account;
}

const siteRow = (page, name) => page.locator('#site-rows tr').filter({ has: page.locator('.site-name span', { hasText: new RegExp(`^${name}$`) }) });
const userRow = (page, email) => page.locator('#user-rows tr').filter({ hasText: email });

test('admin needs the admin password', async ({ page, request }) => {
  await page.goto('/admin');
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#panel')).toBeHidden();
  for (const url of ['/api/admin/sites', '/api/admin/users', '/api/admin/whitelist']) expect((await request.get(url)).status()).toBe(401);

  await page.locator('#login input[name=password]').fill('not-the-password');
  await page.locator('#login button[type=submit]').click();
  await expect(page.locator('#login .alert')).toHaveText('Nesprávné heslo.');

  await page.locator('#login input[name=password]').fill(ADMIN_PASSWORD);
  await page.locator('#login button[type=submit]').click();
  await expect(page.locator('#panel')).toBeVisible();
  await expect(page.locator('#nav')).toBeVisible();
});

test('"Odhlásit" logs out', async ({ page }) => {
  await login(page);
  await page.locator('#logout').click();
  await expect(page.locator('#login')).toBeVisible();
  await page.reload();
  await expect(page.locator('#login')).toBeVisible();
});

test('sites list shows owners and filters by name or e-mail', async ({ page, playwright }) => {
  const { email, site } = await ownedSite(playwright);
  await login(page);
  const row = siteRow(page, site);
  await expect(row).toBeVisible();
  await expect(row.locator('.site-url')).toHaveText(`http://localhost:4317/${site}/`);
  await expect(row).toContainText('Test User');
  await expect(row).toContainText(email);

  await page.locator('.filter[data-for=sites]').fill('no-such-site-here');
  await expect(row).toBeHidden();
  await page.locator('.filter[data-for=sites]').fill(email);
  await expect(row).toBeVisible();
});

test('site history shows actions with IP addresses and e-mails', async ({ page, playwright }) => {
  const { email, site } = await ownedSite(playwright);
  await login(page);
  await siteRow(page, site).locator('[data-action=audit]').click();
  const dialog = page.locator('#audit-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#audit-title')).toHaveText(`Historie webu ${site}`);
  await expect(dialog.locator('#audit-rows')).toContainText('Web zveřejněn');
  await expect(dialog.locator('#audit-rows')).toContainText(email);
  await expect(dialog.locator('#audit-rows code').first()).toHaveText(/127\.0\.0\.1|::1/);
  await dialog.locator('#audit-close').click();
  await expect(dialog).toBeHidden();
});

test('rename, edit and delete any site; deleted sites stay listed until purged', async ({ page, playwright, request }) => {
  const { site } = await ownedSite(playwright);
  await login(page);
  const renamed = unique('adm');
  answerDialogs(page, [renamed, true, true]);
  await siteRow(page, site).locator('[data-action=rename]').click();
  await expect(siteRow(page, renamed)).toBeVisible();
  expect(await (await request.get(`/${renamed}/`)).text()).toContain('Owned');

  // "Upravit" opens the editor on the main page, where the admin can save any site.
  await siteRow(page, renamed).locator('a', { hasText: 'Upravit' }).click();
  await expect(page.locator('#edit-banner')).toContainText(renamed);
  await page.waitForFunction(() => window.scrollY === 0);
  await pick(page, page.locator('[data-tool=files]'), `${FIXTURES.siteV2}/index.html`);
  await page.locator('#publish').click();
  await expect(page.locator('#result-title')).toHaveText(`Web ${renamed} byl aktualizován`);
  expect(await (await request.get(`/${renamed}/`)).text()).toContain('Version 2');

  await page.goto('/admin');
  await siteRow(page, renamed).locator('[data-action=delete]').click();
  await expect(siteRow(page, renamed)).toBeHidden();
  expect((await request.get(`/${renamed}/`)).status()).toBe(404);

  await page.locator('#show-deleted-sites').check();
  const row = siteRow(page, renamed);
  await expect(row).toContainText('smazáno · správcem');
  await expect(row.locator('[data-action=delete]')).toHaveCount(0);
  await row.locator('[data-action=audit]').click();
  await expect(page.locator('#audit-rows')).toContainText('Web smazán správcem');
  await page.locator('#audit-close').click();

  await row.locator('[data-action=purge]').click();
  await expect(siteRow(page, renamed)).toHaveCount(0);
});

test('users: history with IPs, delete (unlink, keep data) and purge', async ({ page, playwright, request }) => {
  const { email, site } = await ownedSite(playwright);
  await login(page);
  await page.locator('[role=tab][data-tab=users]').click();
  const row = userRow(page, email);
  await expect(row).toContainText('Test User');
  await expect(row.locator('code')).toHaveText(/127\.0\.0\.1|::1/);

  await row.locator('[data-action=audit]').click();
  await expect(page.locator('#audit-rows')).toContainText('Účet vytvořen');
  await expect(page.locator('#audit-rows')).toContainText(email);
  await page.locator('#audit-close').click();

  await row.locator('[data-action=sites]').click();
  await expect(page.locator('[data-panel=sites]')).toBeVisible();
  await expect(siteRow(page, site)).toBeVisible();
  await page.locator('[role=tab][data-tab=users]').click();

  const dialogs = answerDialogs(page, [true, true]);
  await row.locator('[data-action=delete]').click();
  await expect(userRow(page, email)).toBeHidden();
  expect(dialogs[0].message).toContain('90 dní');
  expect((await request.get(`/${site}/`)).status()).toBe(404);

  await page.locator('#show-deleted-users').check();
  await expect(userRow(page, email)).toContainText('smazáno · správcem');
  await userRow(page, email).locator('[data-action=purge]').click();
  await expect(userRow(page, email)).toHaveCount(0);
  const { users } = await (await page.request.get('/api/admin/users')).json();
  expect(users.some((u) => u.email === email)).toBe(false);
});

test('IP whitelist can be edited', async ({ page }) => {
  await login(page);
  await page.locator('[role=tab][data-tab=whitelist]').click();
  await expect(page.locator('#your-ip')).toContainText('Vaše IP adresa:');
  await page.locator('#whitelist-form input[name=ip]').fill('203.0.113.7');
  await page.locator('#whitelist-form input[name=note]').fill('office');
  await page.locator('#whitelist-form button').click();
  const row = page.locator('#whitelist-rows tr', { hasText: '203.0.113.7' });
  await expect(row).toContainText('office');

  page.once('dialog', (d) => d.accept());
  await page.locator('#whitelist-form input[name=ip]').fill('not an ip');
  await page.locator('#whitelist-form button').click();
  await expect(page.locator('#whitelist-rows tr', { hasText: 'not an ip' })).toHaveCount(0);

  await row.locator('[data-action=remove]').click();
  await expect(row).toHaveCount(0);
});

test('password sites can get a new password from the admin', async ({ page, playwright }) => {
  // Password sites are published from whitelisted IPs (the :4319 server).
  const wl = await playwright.request.newContext({ baseURL: 'http://localhost:4319' });
  const name = unique('pw');
  const created = await publishViaApi(wl, name, '<h1>pw</h1>', {}, { token: null });
  expect(created.body.password).toBeTruthy();

  await page.goto('http://localhost:4319/admin');
  await page.locator('#login input[name=password]').fill(ADMIN_PASSWORD);
  await page.locator('#login button[type=submit]').click();
  const row = siteRow(page, name);
  await expect(row).toContainText('bez účtu (heslo)');
  const dialogs = answerDialogs(page, [true, true]);
  await row.locator('[data-action=password]').click();
  await expect.poll(() => dialogs.length).toBe(2);
  const fresh = dialogs[1].value;
  expect(fresh).not.toBe(created.body.password);
  const check = await wl.post('/api/my-sites', { headers: HEADERS, data: { sites: [{ name, password: fresh }, { name, password: created.body.password }] } });
  expect((await check.json()).sites.map((s) => s.status)).toEqual(['ok', 'wrong-password']);
  await wl.dispose();
});

test('"+ Zveřejnit" goes back to the upload page', async ({ page }) => {
  await login(page);
  await page.locator('#nav a[href="/"]').click();
  await expect(page).toHaveURL('/');
});
