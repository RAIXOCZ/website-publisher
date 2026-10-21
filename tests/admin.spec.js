// @ts-check
const { test, expect } = require('./test');
const { FIXTURES, ADMIN_EMAIL, HEADERS, unique, pick, signIn, signInAsAdmin, createAccount, publishViaApi, answerModal, lastMail } = require('./helpers');

async function login(page) {
  await signInAsAdmin(page);
  await page.goto('/admin');
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

test('the admin area is only for the admin account, signed in by e-mail link', async ({ page, browser, request }) => {
  await page.goto('/admin');
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#login input[type=password]')).toHaveCount(0);
  await expect(page.locator('#panel')).toBeHidden();
  for (const url of ['/api/admin/sites', '/api/admin/users', '/api/admin/whitelist']) expect((await request.get(url)).status()).toBe(401);

  // An ordinary account is turned away.
  const other = await (await browser.newContext({ locale: 'cs-CZ' })).newPage();
  const { email } = await signIn(other);
  await other.goto('/admin');
  await expect(other.locator('#forbidden')).toBeVisible();
  await expect(other.locator('#forbidden-text')).toContainText(email);
  expect((await other.request.get('/api/admin/users')).status()).toBe(403);
  await other.context().close();

  // The admin signs in with an e-mail link from the admin page.
  // Other tests sign in as the admin at the same time and may use up this
  // link first; then ask for another one.
  for (let attempt = 0; attempt < 10 && !page.url().endsWith('/ucet'); attempt++) {
    if (attempt) await page.goto('/admin');
    const before = (await (await request.get('/api/dev/outbox')).json()).messages.length;
    await page.locator('#login-form input[name=email]').fill(ADMIN_EMAIL);
    await page.locator('#login-form button').click();
    await expect(page.locator('#login .sent')).toContainText(ADMIN_EMAIL);
    let mail;
    await expect
      .poll(async () => {
        const { messages } = await (await request.get('/api/dev/outbox')).json();
        mail = messages.slice(before).find((m) => m.to === ADMIN_EMAIL && m.kind === 'login');
        return Boolean(mail);
      })
      .toBe(true);
    await page.goto(new URL(mail.params.link).pathname);
    const button = page.locator('#confirm-button');
    await expect(page.locator('#confirm-title')).not.toHaveText('Načítám…');
    if (!(await button.isVisible())) continue;
    await button.click();
    await page.waitForURL(/\/ucet$/, { timeout: 3000 }).catch(() => {});
  }
  await expect(page).toHaveURL('/ucet');
  await expect(page.locator('#account-name')).toHaveText('Martin Balcar');
  await expect(page.locator('#admin-link')).toBeVisible();
  await expect(page.locator('#delete-account')).toBeHidden();
  await expect(page.locator('#delete-admin')).toBeVisible();
  await page.locator('#admin-link').click();
  await expect(page.locator('#panel')).toBeVisible();
  await expect(page.locator('#logout')).toBeVisible();
  await expect(page.locator('.nav a[href="/admin"]')).toHaveAttribute('aria-current', 'page');
});

test('admin rights never come with an API token, and the admin account cannot be deleted', async ({ page, playwright }) => {
  await login(page);
  const { token } = await (await page.request.post('/api/me/tokens', { headers: HEADERS, data: { name: 'admin-cli' } })).json();
  const curl = await playwright.request.newContext({ baseURL: 'http://localhost:4317' });
  const res = await curl.get('/api/admin/users', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status()).toBe(403);
  await curl.dispose();

  const { users } = await (await page.request.get('/api/admin/users')).json();
  const admin = users.find((u) => u.email === ADMIN_EMAIL);
  expect(admin.isAdmin).toBe(1);
  expect(admin.firstName).toBe('Martin');
  expect(admin.lastName).toBe('Balcar');
  for (const action of ['delete', 'purge']) {
    expect((await page.request.post(`/api/admin/users/${admin.id}/${action}`, { headers: HEADERS })).status()).toBe(400);
  }
  expect((await page.request.post('/api/me/delete', { headers: HEADERS })).status()).toBe(400);

  await page.locator('[role=tab][data-tab=users]').click();
  const row = page.locator('#user-rows tr').filter({ hasText: ADMIN_EMAIL });
  await expect(row).toContainText('správce');
  await expect(row.locator('[data-action=delete], [data-action=purge]')).toHaveCount(0);
});

test('"Odhlásit" signs out', async ({ page }) => {
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
  await siteRow(page, site).locator('[data-action=rename]').click();
  await answerModal(page, renamed);
  await expect(siteRow(page, renamed)).toBeVisible();
  expect(await (await request.get(`/${renamed}/`)).text()).toContain('Owned');

  // "Upravit" opens the editor on the main page, where the admin can save any site.
  await siteRow(page, renamed).locator('a', { hasText: 'Upravit' }).click();
  await expect(page.locator('#edit-banner')).toContainText(renamed);
  await page.waitForFunction(() => window.scrollY === 0);
  await pick(page, page.locator('[data-tool=files]'), `${FIXTURES.siteV2}/index.html`);
  await page.locator('#overwrite-yes').click(); // the site already has an index.html
  await page.locator('#publish').click();
  await expect(page.locator('#result-title')).toHaveText(`Web ${renamed} byl aktualizován`);
  expect(await (await request.get(`/${renamed}/`)).text()).toContain('Version 2');

  await page.goto('/admin');
  await siteRow(page, renamed).locator('[data-action=delete]').click();
  await answerModal(page, true);
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
  await answerModal(page, true);
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

  await row.locator('[data-action=delete]').click();
  expect((await answerModal(page, true)).text).toContain('90 dní');
  await expect(userRow(page, email)).toBeHidden();
  expect((await request.get(`/${site}/`)).status()).toBe(404);

  await page.locator('#show-deleted-users').check();
  await expect(userRow(page, email)).toContainText('smazáno · správcem');
  await userRow(page, email).locator('[data-action=purge]').click();
  expect((await answerModal(page, true)).title).toMatch(/^Smazat .+ trvale\?$/);
  await expect(userRow(page, email)).toHaveCount(0);
  const { users } = await (await page.request.get('/api/admin/users')).json();
  expect(users.some((u) => u.email === email)).toBe(false);
});

test('the admin can stop an account from adding and editing sites, and allow it again', async ({ page, browser, request }) => {
  const userPage = await (await browser.newContext({ locale: 'cs-CZ' })).newPage();
  const { email, site } = await signIn(userPage);
  const { token } = await (await userPage.request.post('/api/me/tokens', { headers: HEADERS, data: { name: 'cli' } })).json();

  await login(page);
  await page.locator('[role=tab][data-tab=users]').click();
  const row = userRow(page, email);
  await row.locator('[data-action=block]').click();
  const shown = await answerModal(page, true);
  expect(shown.title).toBe('Zakázat přidávání a úpravy?');
  await expect(row).toContainText('úpravy zakázány');
  await expect(page.locator('.toast')).toHaveText(`Úpravy zakázány: ${email}`);

  // Neither the browser, nor the API token, nor a visitor upload for the e-mail gets through.
  const cs = { 'Accept-Language': 'cs' };
  const html = { name: 'index.html', mimeType: 'text/html', buffer: Buffer.from('<h1>x</h1>') };
  const viaToken = await request.post('/api/sites', { headers: { Authorization: `Bearer ${token}`, ...cs }, multipart: { name: unique('b'), f: html } });
  expect(viaToken.status()).toBe(403);
  expect((await viaToken.json()).error).toContain('zakázané');
  const visitor = await request.post('/api/sites', { headers: { ...HEADERS, ...cs }, multipart: { name: unique('b'), email, f: html } });
  expect(visitor.status()).toBe(403);
  expect((await userPage.request.post(`/api/sites/${site}/rename`, { headers: HEADERS, data: { name: unique('r') } })).status()).toBe(403);
  await userPage.goto('/');
  await expect(userPage.locator('#notice')).toContainText('zakázané');
  await userPage.goto('/ucet');
  await expect(userPage.locator('#blocked-notice')).toBeVisible();
  await expect(userPage.locator('#audit')).toContainText('Úpravy webů zakázány správcem');
  // Deleting still works.
  await userPage.locator(`#sites .site-card[data-name="${site}"] [data-action=delete]`).click();
  await answerModal(userPage, true);
  await expect(userPage.locator('#sites-empty')).toBeVisible();

  await row.locator('[data-action=unblock]').click();
  await expect(row).not.toContainText('úpravy zakázány');
  const again = await request.post('/api/sites', { headers: { Authorization: `Bearer ${token}` }, multipart: { name: unique('ok'), f: html } });
  expect(again.status()).toBe(200);
  await userPage.context().close();
});

test('a message written when deleting a site is e-mailed to its owner', async ({ page, playwright, request }) => {
  const { email, site } = await ownedSite(playwright);
  await login(page);
  await siteRow(page, site).locator('[data-action=delete]').click();
  await expect(page.locator('#ui-dialog .ui-area')).toBeVisible();
  await page.locator('#ui-dialog .ui-area').fill('Web posílá přes 1 TB dat denně.');
  await page.locator('#ui-dialog [data-ui=ok]').click();
  const mail = await lastMail(request, email, 'measure');
  expect(mail.text).toContain(`web ${site} byl smazán`);
  expect(mail.text).toContain('Web posílá přes 1 TB dat denně.');
  expect(mail.text).toContain('ohradit');
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

  await page.locator('#whitelist-form input[name=ip]').fill('not an ip');
  await page.locator('#whitelist-form button').click();
  expect((await answerModal(page, true)).text).toBe('Neplatná IP adresa.');
  await expect(page.locator('#whitelist-rows tr', { hasText: 'not an ip' })).toHaveCount(0);

  await row.locator('[data-action=remove]').click();
  await expect(row).toHaveCount(0);
});

test('"Přidat moji IP" whitelists the address the admin is using', async ({ page }) => {
  // The whitelist is shared by tests running in parallel, so the list and the
  // add request are intercepted here; adding and removing for real is tested above.
  let entries = [{ ip: '203.0.113.9', note: 'office', createdAt: new Date().toISOString() }];
  let posted = null;
  await page.route('**/api/admin/whitelist', async (route) => {
    if (route.request().method() === 'POST') {
      posted = route.request().postDataJSON();
      entries = [{ ...posted, createdAt: new Date().toISOString() }, ...entries];
      return route.fulfill({ json: { ips: entries } });
    }
    return route.fulfill({ json: { ips: entries, yourIp: '198.51.100.23' } });
  });
  await login(page);
  await page.locator('[role=tab][data-tab=whitelist]').click();
  await expect(page.locator('#your-ip')).toHaveText('Vaše IP adresa: 198.51.100.23');
  await expect(page.locator('#add-my-ip')).toHaveText('Přidat moji IP (198.51.100.23)');

  await page.locator('#whitelist-form input[name=note]').fill('notebook');
  await page.locator('#add-my-ip').click();
  await expect(page.locator('#whitelist-rows tr', { hasText: '198.51.100.23' })).toContainText('notebook');
  expect(posted).toEqual({ ip: '198.51.100.23', note: 'notebook' });
  await expect(page.locator('#add-my-ip')).toBeHidden();
  await expect(page.locator('#your-ip')).toHaveText('Vaše IP adresa 198.51.100.23 je na whitelistu.');
});

test('password sites can get a new password from the admin', async ({ page, playwright }) => {
  // Password sites are published from whitelisted IPs (the :4319 server).
  const wl = await playwright.request.newContext({ baseURL: 'http://localhost:4319' });
  const name = unique('pw');
  const created = await publishViaApi(wl, name, '<h1>pw</h1>', {}, { token: null });
  expect(created.body.password).toBeTruthy();

  await signInAsAdmin(page, 'http://localhost:4319');
  await page.goto('http://localhost:4319/admin');
  const row = siteRow(page, name);
  await expect(row).toContainText('bez účtu (heslo)');
  await row.locator('[data-action=password]').click();
  await answerModal(page, true);
  const fresh = (await answerModal(page, true)).value;
  expect(fresh).not.toBe(created.body.password);
  const check = await wl.post('/api/my-sites', { headers: HEADERS, data: { sites: [{ name, password: fresh }, { name, password: created.body.password }] } });
  expect((await check.json()).sites.map((s) => s.status)).toEqual(['ok', 'wrong-password']);
  await wl.dispose();
});

test('"Zveřejnit" goes back to the upload page', async ({ page }) => {
  await login(page);
  await page.locator('.nav a[href="/"]').click();
  await expect(page).toHaveURL('/');
});
