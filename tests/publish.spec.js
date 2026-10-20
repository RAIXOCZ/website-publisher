// @ts-check
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { FIXTURES, PASSWORD_RE, unique, pick, publishViaUi, publishViaApi, answerDialogs, clipboard } = require('./helpers');

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('home page works without logging in and does not link to admin', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Web online jedním přetažením.');
  await expect(page.locator('#pick-folder')).toBeVisible();
  await expect(page.locator('#login')).toHaveCount(0);
  await expect(page.locator('a[href="/admin"]')).toHaveCount(0);
});

test('the name is typed into an address bar and slugified', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#url-prefix')).toHaveText('http://localhost:4317/');
  await expect(page.locator('#url-suffix')).toHaveText('/');
  await page.locator('#url-prefix').click();
  await expect(page.locator('#name')).toBeFocused();
  await page.locator('#name').fill('Můj Web');
  await page.locator('#name').blur();
  await expect(page.locator('#name')).toHaveValue('muj-web');
});

test('"Vybrat složku" publishes a folder and shows link and password', async ({ page, context }) => {
  const name = unique('folder');
  await page.goto('/');
  const password = await publishViaUi(page, name);

  expect(password).toMatch(PASSWORD_RE);
  const url = `http://localhost:4317/${name}/`;
  await expect(page.locator('#result-title')).toHaveText(`Web ${name} je online`);
  await expect(page.locator('#result-link')).toHaveAttribute('href', url);
  await expect(page.locator('#result-note')).toContainText('5 souborů');

  await page.locator('#copy').click();
  await expect(page.locator('.toast')).toHaveText('Odkaz zkopírován');
  expect(await clipboard(page)).toBe(url);

  await page.locator('#copy-password').click();
  await expect(page.locator('.toast')).toHaveText('Heslo zkopírováno');
  expect(await clipboard(page)).toBe(password);

  const [tab] = await Promise.all([context.waitForEvent('page'), page.locator('#open').click()]);
  await expect(tab.locator('h1')).toHaveText('Sample site');

  const card = page.locator(`.site-card[data-name="${name}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('.chip')).toHaveText(['5 souborů', /B$/, 'aktualizováno právě teď']);
  await expect(card).toHaveAttribute('data-initial', 'f');
  await expect(page.locator('#my-count')).toHaveText('1');
});

test('clicking the drop zone opens the folder picker', async ({ page }) => {
  const name = unique('dropzone');
  await page.goto('/');
  await page.locator('#name').fill(name);
  await pick(page, page.locator('#dropzone .title'), FIXTURES.site);
  await expect(page.locator('#result-title')).toHaveText(`Web ${name} je online`);
});

test('"Nahrát .zip" publishes the contents of a zip file', async ({ page, request }) => {
  const name = unique('zip');
  await page.goto('/');
  await page.locator('#name').fill(name);
  await pick(page, page.locator('#pick-zip'), FIXTURES.zip);
  await expect(page.locator('#result-title')).toHaveText(`Web ${name} je online`);
  const res = await request.get(`/${name}/`);
  expect(await res.text()).toContain('Zipped site');
});

test('dropping a .zip file onto the drop zone publishes it', async ({ page, request }) => {
  const name = unique('drop');
  await page.goto('/');
  await page.locator('#name').fill(name);
  const zip = fs.readFileSync(FIXTURES.zip).toString('base64');
  const dataTransfer = await page.evaluateHandle((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dropped.zip', { type: 'application/zip' }));
    return dt;
  }, zip);
  await page.dispatchEvent('#dropzone', 'drop', { dataTransfer });
  await expect(page.locator('#result-title')).toHaveText(`Web ${name} je online`);
  expect(await (await request.get(`/${name}/`)).text()).toContain('Zipped site');
});

test('"Zveřejnit další" resets the form', async ({ page }) => {
  await page.goto('/');
  await publishViaUi(page, unique('again'));
  await page.locator('#again').click();
  await expect(page.locator('#dropzone')).toBeVisible();
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#name')).toHaveValue('');
});

test('reserved names are rejected', async ({ page }) => {
  await page.goto('/');
  await page.locator('#name').fill('admin');
  await pick(page, page.locator('#pick-folder'), FIXTURES.site);
  await expect(page.locator('#error-text')).toContainText('rezervovaný');
});

test('re-publishing your own site fills in the saved password and replaces it', async ({ page, request }) => {
  const name = unique('mine');
  await page.goto('/');
  const password = await publishViaUi(page, name);
  await page.locator('#again').click();

  await page.locator('#name').fill(name);
  await pick(page, page.locator('#pick-folder'), FIXTURES.siteV2);
  await expect(page.locator('#error-text')).toContainText('je mezi vašimi weby');
  await expect(page.locator('#conflict-password')).toHaveValue(password);
  await page.locator('#conflict button[type=submit]').click();

  await expect(page.locator('#result-title')).toHaveText(`Web ${name} byl aktualizován`);
  await expect(page.locator('#result-password')).toBeHidden();
  expect(await (await request.get(`/${name}/`)).text()).toContain('Version 2');
});

test('"Zrušit" dismisses the replace prompt', async ({ page }) => {
  const name = unique('cancel');
  await page.goto('/');
  await publishViaUi(page, name);
  await page.locator('#again').click();
  await page.locator('#name').fill(name);
  await pick(page, page.locator('#pick-folder'), FIXTURES.site);
  await expect(page.locator('#conflict')).toBeVisible();
  await page.locator('#cancel').click();
  await expect(page.locator('#error')).toBeHidden();
});

test('someone else using a taken name gets the name with a random suffix', async ({ page, browser, request }) => {
  const name = unique('taken');
  await page.goto('/');
  await publishViaUi(page, name);

  const stranger = await (await browser.newContext({ locale: 'cs-CZ' })).newPage();
  await stranger.goto('/');
  await stranger.locator('#name').fill(name);
  await pick(stranger, stranger.locator('#pick-folder'), FIXTURES.siteV2);
  await expect(stranger.locator('#result')).toBeVisible();
  await expect(stranger.locator('#conflict')).toBeHidden();

  const link = await stranger.locator('#result-link').getAttribute('href');
  const newName = new URL(link).pathname.split('/')[1];
  expect(newName).toMatch(new RegExp(`^${name}-[a-z0-9]{3}$`));
  await expect(stranger.locator('#result-note')).toContainText(`Název „${name}“ už byl obsazený, proto web dostal adresu ${newName}.`);
  await expect(stranger.locator('#name')).toHaveValue(newName);
  await expect(stranger.locator(`.site-card[data-name="${newName}"]`)).toBeVisible();

  expect(await (await request.get(`/${name}/`)).text()).toContain('Sample site');
  expect(await (await request.get(`/${newName}/`)).text()).toContain('Version 2');
  await stranger.context().close();
});

test('"Zveřejnit jako nový web" publishes your own taken name with a suffix', async ({ page, request }) => {
  const name = unique('copy');
  await page.goto('/');
  await publishViaUi(page, name);
  await page.locator('#again').click();
  await page.locator('#name').fill(name);
  await pick(page, page.locator('#pick-folder'), FIXTURES.siteV2);
  await expect(page.locator('#conflict')).toBeVisible();
  await page.locator('#as-new').click();
  await expect(page.locator('#result-title')).toHaveText(new RegExp(`^Web ${name}-[a-z0-9]{3} je online$`));
  expect(await (await request.get(`/${name}/`)).text()).toContain('Sample site');
  await expect(page.locator('.site-card')).toHaveCount(2);
});

test('the API refuses to replace or delete a site without the right password', async ({ request }) => {
  const name = unique('api');
  const created = await publishViaApi(request, name);
  expect(created.status).toBe(200);
  expect(created.body.password).toMatch(PASSWORD_RE);

  const second = await publishViaApi(request, name);
  expect(second.status).toBe(200);
  expect(second.body.name).toMatch(new RegExp(`^${name}-[a-z0-9]{3}$`));
  expect(second.body.requestedName).toBe(name);

  const wrong = await publishViaApi(request, name, '<h1>evil</h1>', { overwrite: '1', password: 'nope' });
  expect(wrong.status).toBe(403);

  const del = await request.post(`/api/sites/${name}/delete`, {
    headers: { 'X-Requested-With': 'fetch' },
    data: { password: 'nope' },
  });
  expect(del.status()).toBe(403);
  expect(await (await request.get(`/${name}/`)).text()).toContain('API site');
});

test.describe('Moje weby', () => {
  test('"Heslo" shows the saved password and "Kopírovat odkaz" copies the URL', async ({ page }) => {
    const name = unique('card');
    await page.goto('/');
    const password = await publishViaUi(page, name);
    const card = page.locator(`.site-card[data-name="${name}"]`);

    await card.locator('[data-action=password]').click();
    await expect(card.locator('.site-pw code')).toHaveText(password);
    await card.locator('[data-action=password]').click();
    await expect(card.locator('.site-pw')).toBeHidden();

    await card.locator('[data-action=copy]').click();
    expect(await clipboard(page)).toBe(`http://localhost:4317/${name}/`);
  });

  test('"Aktualizovat" uploads a new version', async ({ page, request }) => {
    const name = unique('update');
    await page.goto('/');
    await publishViaUi(page, name);
    await page.locator('#again').click();
    await pick(page, page.locator(`.site-card[data-name="${name}"] [data-action=update]`), FIXTURES.siteV2);
    await expect(page.locator('#result-title')).toHaveText(`Web ${name} byl aktualizován`);
    expect(await (await request.get(`/${name}/`)).text()).toContain('Version 2');
  });

  test('"Smazat" deletes the site after confirmation', async ({ page, request }) => {
    const name = unique('delete');
    await page.goto('/');
    await publishViaUi(page, name);
    const card = page.locator(`.site-card[data-name="${name}"]`);

    const dialogs = answerDialogs(page, [false, true]);
    await card.locator('[data-action=delete]').click();
    await expect(card).toBeVisible();
    expect((await request.get(`/${name}/`)).status()).toBe(200);

    await card.locator('[data-action=delete]').click();
    await expect(card).toHaveCount(0);
    await expect(page.locator('.toast')).toHaveText(`Web ${name} byl smazán`);
    expect(dialogs[0].message).toContain(name);
    expect((await request.get(`/${name}/`)).status()).toBe(404);
  });

  test('"Přidat existující web" checks the password and adds the site', async ({ page, browser }) => {
    const name = unique('import');
    await page.goto('/');
    const password = await publishViaUi(page, name);

    const other = await (await browser.newContext({ locale: 'cs-CZ' })).newPage();
    await other.goto('/');
    await expect(other.locator('#my-empty')).toBeVisible();
    await other.locator('#add-toggle').click();
    const form = other.locator('#add-form');
    await form.locator('[name=site]').fill(name);
    await form.locator('[name=password]').fill('bad-pass-word');
    await form.locator('button[type=submit]').click();
    await expect(form.locator('.alert')).toHaveText('Nesprávné heslo k webu.');

    await form.locator('[name=site]').fill('does-not-exist-xyz');
    await form.locator('[name=password]').fill(password);
    await form.locator('button[type=submit]').click();
    await expect(form.locator('.alert')).toHaveText('Web „does-not-exist-xyz“ neexistuje.');

    await form.locator('[name=site]').fill(name);
    await form.locator('button[type=submit]').click();
    await expect(form).toBeHidden();
    await expect(other.locator(`.site-card[data-name="${name}"]`)).toBeVisible();

    await other.locator('#add-toggle').click();
    await expect(form).toBeVisible();
    await other.locator('#add-toggle').click();
    await expect(form).toBeHidden();
    await other.context().close();
  });

  test('a site deleted elsewhere can be removed from the list', async ({ page, request }) => {
    const name = unique('gone');
    await page.goto('/');
    const password = await publishViaUi(page, name);
    await request.post(`/api/sites/${name}/delete`, { headers: { 'X-Requested-With': 'fetch' }, data: { password } });

    await page.reload();
    const card = page.locator(`.site-card[data-name="${name}"]`);
    await expect(card.locator('.site-status')).toHaveText('Web už neexistuje (byl smazán nebo přejmenován).');
    await expect(card.locator('[data-action=update]')).toBeHidden();
    await card.locator('[data-action=forget]').click();
    await expect(card).toHaveCount(0);
  });
});
