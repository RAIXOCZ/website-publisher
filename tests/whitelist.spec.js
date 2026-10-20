// @ts-check
// The :4319 server has this machine on its IP whitelist: publishing works
// without an account, and every site gets a password (the original mode).
const { test, expect } = require('@playwright/test');
const { FIXTURES, HEADERS, PASSWORD_RE, unique, pick, pickAndPublish, publishViaApi, answerDialogs, clipboard } = require('./helpers');

const BASE = 'http://localhost:4319';
test.use({ baseURL: BASE, permissions: ['clipboard-read', 'clipboard-write'] });

async function publishViaUi(page, name, dir = FIXTURES.site) {
  await page.locator('#name').fill(name);
  await pickAndPublish(page, page.locator('#pick-folder'), dir);
  await page.locator('#result').waitFor();
  return (await page.locator('#result-password-value').textContent() || '').trim();
}

test('publishes without e-mail and shows the site password', async ({ page }) => {
  const name = unique('wl');
  await page.goto('/');
  await pick(page, page.locator('#pick-folder'), FIXTURES.site);
  await expect(page.locator('#identity')).toBeHidden();
  await expect(page.locator('#publish')).toHaveText('Zveřejnit web');
  await page.locator('#name').fill(name);
  await page.locator('#publish').click();
  await expect(page.locator('#result-title')).toHaveText(`Web ${name} je online`);
  const password = (await page.locator('#result-password-value').textContent()) || '';
  expect(password).toMatch(PASSWORD_RE);
  await page.locator('#copy-password').click();
  await expect(page.locator('.toast')).toHaveText('Heslo zkopírováno');
  expect(await clipboard(page)).toBe(password);

  const card = page.locator(`.site-card[data-name="${name}"]`);
  await card.locator('[data-action=password]').click();
  await expect(card.locator('.site-pw code')).toHaveText(password);
});

test('re-publishing your own site fills in the saved password and replaces it', async ({ page, request }) => {
  const name = unique('mine');
  await page.goto('/');
  const password = await publishViaUi(page, name);
  await page.locator('#again').click();
  await page.locator('#name').fill(name);
  await pickAndPublish(page, page.locator('#pick-folder'), FIXTURES.siteV2);
  await expect(page.locator('#error-text')).toContainText('je mezi vašimi weby');
  await expect(page.locator('#conflict-password')).toHaveValue(password);
  await page.locator('#conflict button[type=submit]').click();
  await expect(page.locator('#result')).toBeVisible();
    await expect(page.locator('#result-title')).toHaveText(`Web ${name} byl aktualizován`);
  expect(await (await request.get(`/${name}/`)).text()).toContain('Version 2');
});

test('"Upravit" edits a password site in the file tree', async ({ page, request }) => {
  const name = unique('wledit');
  await page.goto('/');
  await publishViaUi(page, name);
  await page.locator(`.site-card[data-name="${name}"] [data-action=edit]`).click();
  await expect(page.locator('#edit-banner')).toContainText(name);
  await page.waitForFunction(() => window.scrollY === 0);
  await page.locator('.tree-row[data-path="about.html"] [data-act=remove]').click({ force: true });
  await page.locator('#publish').click();
  await expect(page.locator('#result')).toBeVisible();
    await expect(page.locator('#result-title')).toHaveText(`Web ${name} byl aktualizován`);
  expect((await request.get(`/${name}/about`)).status()).toBe(404);
  expect((await request.get(`/${name}/`)).status()).toBe(200);
});

test('"Smazat" deletes the site and removes it from the list', async ({ page, request }) => {
  const name = unique('wldel');
  await page.goto('/');
  await publishViaUi(page, name);
  answerDialogs(page, [true]);
  await page.locator(`.site-card[data-name="${name}"] [data-action=delete]`).click();
  await expect(page.locator(`.site-card[data-name="${name}"]`)).toHaveCount(0);
  expect((await request.get(`/${name}/`)).status()).toBe(404);
});

test('"Přidat web s heslem" checks the password and adds the site', async ({ page, browser }) => {
  const name = unique('import');
  await page.goto('/');
  const password = await publishViaUi(page, name);

  const other = await (await browser.newContext({ locale: 'cs-CZ', baseURL: BASE })).newPage();
  await other.goto('/');
  await other.locator('#add-toggle').click();
  const form = other.locator('#add-form');
  await form.locator('[name=site]').fill(name);
  await form.locator('[name=password]').fill('bad-pass-word');
  await form.locator('button[type=submit]').click();
  await expect(form.locator('.alert')).toHaveText('Nesprávné heslo k webu.');
  await form.locator('[name=password]').fill(password);
  await form.locator('button[type=submit]').click();
  await expect(form).toBeHidden();
  await expect(other.locator(`.site-card[data-name="${name}"]`)).toBeVisible();
  await other.context().close();
});

test('a site deleted elsewhere can be removed from the list', async ({ page, request }) => {
  const name = unique('gone');
  await page.goto('/');
  const password = await publishViaUi(page, name);
  await request.post(`/api/sites/${name}/delete`, { headers: HEADERS, data: { password } });
  await page.reload();
  const card = page.locator(`.site-card[data-name="${name}"]`);
  await expect(card.locator('.site-status')).toHaveText('Web už neexistuje (byl smazán nebo přejmenován).');
  await expect(card.locator('[data-action=edit]')).toBeHidden();
  await card.locator('[data-action=forget]').click();
  await expect(card).toHaveCount(0);
});

test('the API refuses to replace or delete a site without the right password', async ({ request }) => {
  const name = unique('api');
  const created = await publishViaApi(request, name, '<h1>API site</h1>', {}, { token: null });
  expect(created.status).toBe(200);
  expect(created.body.password).toMatch(PASSWORD_RE);

  const second = await publishViaApi(request, name, '<h1>x</h1>', {}, { token: null });
  expect(second.body.name).toMatch(new RegExp(`^${name}-[a-z0-9]{3}$`));

  const wrong = await publishViaApi(request, name, '<h1>evil</h1>', { overwrite: '1', password: 'nope' }, { token: null });
  expect(wrong.status).toBe(403);
  const del = await request.post(`/api/sites/${name}/delete`, { headers: HEADERS, data: { password: 'nope' } });
  expect(del.status()).toBe(403);
  expect(await (await request.get(`/${name}/`)).text()).toContain('API site');

  const right = await publishViaApi(request, name, '<h1>new</h1>', { overwrite: '1', password: created.body.password }, { token: null });
  expect(right.body.replaced).toBe(true);
});

test('the server reports the whitelist to the page', async ({ request }) => {
  expect((await (await request.get('/api/config')).json()).whitelisted).toBe(true);
  expect((await (await request.get('http://localhost:4317/api/config')).json()).whitelisted).toBe(false);
});
