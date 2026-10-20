// @ts-check
const { test, expect } = require('@playwright/test');
const { FIXTURES, ADMIN_PASSWORD, PASSWORD_RE, unique, pick, publishViaApi, answerDialogs, clipboard } = require('./helpers');

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

async function login(page) {
  await page.goto('/admin');
  await page.locator('#login input[name=password]').fill(ADMIN_PASSWORD);
  await page.locator('#login button[type=submit]').click();
  await expect(page.locator('#panel')).toBeVisible();
}

async function siteStatus(request, name, password) {
  const res = await request.post('/api/my-sites', {
    headers: { 'X-Requested-With': 'fetch' },
    data: { sites: [{ name, password }] },
  });
  return (await res.json()).sites[0].status;
}

test('admin needs the admin password', async ({ page, request }) => {
  await page.goto('/admin');
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#panel')).toBeHidden();
  expect((await request.get('/api/sites')).status()).toBe(401);

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

test('admin lists, filters and copies links of all sites', async ({ page, request }) => {
  const name = unique('listed');
  await publishViaApi(request, name);
  await login(page);

  const row = page.locator(`#rows tr[data-name="${name}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('.site-url')).toHaveText(`http://localhost:4317/${name}/`);
  await expect(page.locator('#stats')).toContainText('·');

  await page.locator('#filter').fill('no-such-site-here');
  await expect(row).toBeHidden();
  await page.locator('#filter').fill(name);
  await expect(row).toBeVisible();

  await row.locator('[data-action=copy]').click();
  expect(await clipboard(page)).toBe(`http://localhost:4317/${name}/`);
});

test('"Nahradit" replaces any site without its password', async ({ page, request }) => {
  const name = unique('replace');
  await publishViaApi(request, name);
  await login(page);
  const row = page.locator(`#rows tr[data-name="${name}"]`);
  await pick(page, row.locator('[data-action=replace]'), FIXTURES.siteV2);
  await expect(page.locator('.toast')).toHaveText(`Web ${name} byl nahrazen`);
  expect(await (await request.get(`/${name}/`)).text()).toContain('Version 2');
  await expect(row.locator('[data-action=replace]')).toHaveText('Nahradit');
});

test('"Nové heslo" generates a new password and invalidates the old one', async ({ page, request }) => {
  const name = unique('reset');
  const { body } = await publishViaApi(request, name);
  await login(page);

  const dialogs = answerDialogs(page, [true, true]);
  await page.locator(`#rows tr[data-name="${name}"] [data-action=password]`).click();
  await expect.poll(() => dialogs.length).toBe(2);
  expect(dialogs[0].type).toBe('confirm');
  expect(dialogs[1].type).toBe('prompt');
  const newPassword = dialogs[1].value;
  expect(newPassword).toMatch(PASSWORD_RE);
  expect(newPassword).not.toBe(body.password);

  expect(await siteStatus(request, name, body.password)).toBe('wrong-password');
  expect(await siteStatus(request, name, newPassword)).toBe('ok');
});

test('"Nové heslo" can be cancelled', async ({ page, request }) => {
  const name = unique('keep');
  const { body } = await publishViaApi(request, name);
  await login(page);
  const dialogs = answerDialogs(page, [false]);
  await page.locator(`#rows tr[data-name="${name}"] [data-action=password]`).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(await siteStatus(request, name, body.password)).toBe('ok');
});

test('"Přejmenovat" moves the site to a new address', async ({ page, request }) => {
  const name = unique('old');
  const renamed = unique('new');
  await publishViaApi(request, name);
  await login(page);

  answerDialogs(page, [renamed]);
  await page.locator(`#rows tr[data-name="${name}"] [data-action=rename]`).click();
  await expect(page.locator(`#rows tr[data-name="${renamed}"]`)).toBeVisible();
  await expect(page.locator(`#rows tr[data-name="${name}"]`)).toHaveCount(0);
  expect((await request.get(`/${name}/`)).status()).toBe(404);
  expect(await (await request.get(`/${renamed}/`)).text()).toContain('API site');
});

test('"Smazat" deletes any site after confirmation', async ({ page, request }) => {
  const name = unique('remove');
  await publishViaApi(request, name);
  await login(page);
  const row = page.locator(`#rows tr[data-name="${name}"]`);

  answerDialogs(page, [false, true]);
  await row.locator('[data-action=delete]').click();
  await expect(row).toBeVisible();
  await row.locator('[data-action=delete]').click();
  await expect(row).toHaveCount(0);
  expect((await request.get(`/${name}/`)).status()).toBe(404);
});

test('"+ Zveřejnit" goes back to the upload page', async ({ page }) => {
  await login(page);
  await page.locator('#nav a[href="/"]').click();
  await expect(page).toHaveURL('/');
  await expect(page.locator('#pick-folder')).toBeVisible();
});
