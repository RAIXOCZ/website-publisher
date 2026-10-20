// @ts-check
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { FIXTURES, HEADERS, unique, uniqueEmail, pick, pickAndPublish, mailToken, signIn, publishViaApi, answerDialogs, clipboard } = require('./helpers');

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const row = (page, path) => page.locator(`.tree-row[data-path="${path}"]`);

// Opens the ⋯ menu of a tree row and picks an item.
async function menu(page, path, item) {
  await row(page, path).hover();
  await row(page, path).locator('[data-act=menu]').click();
  await page.locator(`.menu [data-menu="${item}"]`).click();
}

async function publishSignedIn(page, name, dir = FIXTURES.site) {
  await page.locator('#name').fill(name);
  await pickAndPublish(page, page.locator('#pick-folder'), dir);
  await expect(page.locator('#result')).toBeVisible();
}

test('home page works without logging in and does not link to admin', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Web online jedním přetažením.');
  await expect(page.locator('#pick-folder')).toBeVisible();
  await expect(page.locator('a[href="/admin"]')).toHaveCount(0);
  await expect(page.locator('#nav-account')).toHaveText('Přihlásit se');
  await expect(page.locator('#login-inline')).toBeVisible();
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

test.describe('publishing without an account', () => {
  test('the site goes live after confirming the e-mail, which also creates the account', async ({ page, request }) => {
    const name = unique('visitor');
    const email = uniqueEmail('visitor');
    await page.goto('/');
    await page.locator('#name').fill(name);
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    await expect(page.locator('#identity')).toBeVisible();
    await expect(page.locator('#publish')).toHaveText('Poslat potvrzení');

    // The e-mail fields are required.
    await page.locator('#publish').click();
    await expect(page.locator('#pending')).toBeHidden();
    expect(await page.locator('#id-email').evaluate((el) => el.validity.valueMissing)).toBe(true);

    await page.locator('#id-email').fill(email);
    await page.locator('#id-first').fill('Jana');
    await page.locator('#id-last').fill('Nováková');
    await expect(page.locator('#id-remember')).not.toBeChecked();
    await page.locator('#id-remember').check();
    await page.locator('#publish').click();
    await expect(page.locator('#pending')).toBeVisible();
    await expect(page.locator('#pending-text')).toContainText(email);
    await expect(page.locator('#pending-note')).toContainText('24 hodin');
    expect((await request.get(`/${name}/`)).status()).toBe(404);

    const token = await mailToken(request, email, 'publish');
    await page.goto(`/email/${token}`);
    await expect(page.locator('#confirm-title')).toHaveText(`Zveřejnit web ${name}`);
    await page.locator('#confirm-button').click();

    await expect(page).toHaveURL('/');
    await expect(page.locator('#result-title')).toHaveText(`Web ${name} je online`);
    await expect(page.locator('#nav-account')).toHaveText('Účet');
    await expect(page.locator(`.site-card[data-name="${name}"]`)).toBeVisible();
    expect(await (await request.get(`/${name}/`)).text()).toContain('Sample site');

    // The link works only once.
    await page.goto(`/email/${token}`);
    await expect(page.locator('#confirm-title')).toHaveText('Odkaz nelze použít');

    // The details are remembered for next time, because that was ticked.
    expect(await page.evaluate(() => localStorage.getItem('freepages.identity'))).toContain(email);
  });

  test('the API wants an e-mail and a name', async ({ request }) => {
    const send = (fields) =>
      request.post('/api/sites', {
        headers: { ...HEADERS, 'Accept-Language': 'cs' },
        multipart: { name: unique('api'), ...fields, f: { name: 'index.html', mimeType: 'text/html', buffer: Buffer.from('<h1>x</h1>') } },
      });
    expect((await send({})).status()).toBe(400);
    expect((await (await send({ email: 'not-an-email' })).json()).error).toBe('Pro zveřejnění zadejte e-mail, jméno a příjmení.');
    expect((await (await send({ email: uniqueEmail() })).json()).error).toBe('Zadejte jméno a příjmení.');
    const ok = await send({ email: uniqueEmail(), firstName: 'A', lastName: 'B' });
    expect(await ok.json()).toMatchObject({ pending: true, hours: 24 });
  });

  test('reserved names are rejected before asking for the e-mail', async ({ page }) => {
    await page.goto('/');
    await page.locator('#name').fill('admin');
    await pickAndPublish(page, page.locator('#pick-folder'), FIXTURES.site);
    await expect(page.locator('#error-text')).toContainText('rezervovaný');
  });
});

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto('/');
  });

  test('publishes right away and shows the link', async ({ page, context }) => {
    const name = unique('folder');
    await expect(page.locator('#nav-account')).toHaveText('Účet');
    await page.locator('#name').fill(name);
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    await expect(page.locator('#identity')).toBeHidden();
    await expect(page.locator('#signed-as')).toContainText('Zveřejníte jako');
    await page.locator('#publish').click();

    const url = `http://localhost:4317/${name}/`;
    await expect(page.locator('#result-title')).toHaveText(`Web ${name} je online`);
    await expect(page.locator('#result-link')).toHaveAttribute('href', url);
    await expect(page.locator('#result-note')).toContainText('5 souborů');
    await expect(page.locator('#result-password')).toBeHidden();

    await page.locator('#copy').click();
    await expect(page.locator('.toast')).toHaveText('Odkaz zkopírován');
    expect(await clipboard(page)).toBe(url);

    const [tab] = await Promise.all([context.waitForEvent('page'), page.locator('#open').click()]);
    await expect(tab.locator('h1')).toHaveText('Sample site');

    const card = page.locator(`.site-card[data-name="${name}"]`);
    await expect(card.locator('.chip')).toHaveText(['5 souborů', /B$/, 'aktualizováno právě teď']);
    await expect(page.locator('#my-count')).toHaveText('2');
    await card.locator('[data-action=copy]').click();
    expect(await clipboard(page)).toBe(url);
  });

  test('clicking the drop zone opens the folder picker', async ({ page }) => {
    const name = unique('dropzone');
    await page.locator('#name').fill(name);
    await pickAndPublish(page, page.locator('#dropzone .title'), FIXTURES.site);
    await expect(page.locator('#result-title')).toHaveText(`Web ${name} je online`);
  });

  test('"Přidat soubory" with a .zip publishes its contents', async ({ page, request }) => {
    const name = unique('zip');
    await page.locator('#name').fill(name);
    await pickAndPublish(page, page.locator('#pick-files'), FIXTURES.zip);
    await expect(page.locator('#result-title')).toHaveText(`Web ${name} je online`);
    expect(await (await request.get(`/${name}/`)).text()).toContain('Zipped site');
  });

  test('dropping a .zip file onto the drop zone publishes it', async ({ page, request }) => {
    const name = unique('drop');
    await page.locator('#name').fill(name);
    const zip = fs.readFileSync(FIXTURES.zip).toString('base64');
    const dataTransfer = await page.evaluateHandle((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'dropped.zip', { type: 'application/zip' }));
      return dt;
    }, zip);
    await page.dispatchEvent('#dropzone', 'drop', { dataTransfer });
    await expect(page.locator('.tree-file')).toHaveText(/dropped\.zip/);
    await page.locator('#publish').click();
    await expect(page.locator('#result-title')).toHaveText(`Web ${name} je online`);
    expect(await (await request.get(`/${name}/`)).text()).toContain('Zipped site');
  });

  test('"Zveřejnit další" resets the form', async ({ page }) => {
    await publishSignedIn(page, unique('again'));
    await page.locator('#again').click();
    await expect(page.locator('#dropzone')).toBeVisible();
    await expect(page.locator('#result')).toBeHidden();
    await expect(page.locator('#name')).toHaveValue('');
  });

  test('re-publishing your own site asks to replace it', async ({ page, request }) => {
    const name = unique('mine');
    await publishSignedIn(page, name);
    await page.locator('#again').click();
    await page.locator('#name').fill(name);
    await pickAndPublish(page, page.locator('#pick-folder'), FIXTURES.siteV2);
    await expect(page.locator('#error-text')).toHaveText(`Web „${name}“ už máte. Chcete ho nahradit těmito soubory?`);
    await expect(page.locator('#conflict-password')).toBeHidden();
    await page.locator('#conflict button[type=submit]').click();
    await expect(page.locator('#result')).toBeVisible();
    await expect(page.locator('#result-title')).toHaveText(`Web ${name} byl aktualizován`);
    expect(await (await request.get(`/${name}/`)).text()).toContain('Version 2');
  });

  test('"Zrušit" dismisses the replace prompt, "Zveřejnit jako nový web" adds a suffix', async ({ page, request }) => {
    const name = unique('copy');
    await publishSignedIn(page, name);
    await page.locator('#again').click();
    await page.locator('#name').fill(name);
    await pickAndPublish(page, page.locator('#pick-folder'), FIXTURES.siteV2);
    await page.locator('#cancel').click();
    await expect(page.locator('#error')).toBeHidden();

    await page.locator('#publish').click();
    await page.locator('#as-new').click();
    await expect(page.locator('#result-title')).toHaveText(new RegExp(`^Web ${name}-[a-z0-9]{3} je online$`));
    expect(await (await request.get(`/${name}/`)).text()).toContain('Sample site');
  });

  test("someone else's taken name gets a random suffix", async ({ page, browser, request }) => {
    const name = unique('taken');
    await publishSignedIn(page, name);

    const stranger = await (await browser.newContext({ locale: 'cs-CZ' })).newPage();
    await signIn(stranger);
    await stranger.goto('/');
    await publishSignedIn(stranger, name, FIXTURES.siteV2);
    await expect(stranger.locator('#conflict')).toBeHidden();
    const link = await stranger.locator('#result-link').getAttribute('href');
    const newName = new URL(link).pathname.split('/')[1];
    expect(newName).toMatch(new RegExp(`^${name}-[a-z0-9]{3}$`));
    await expect(stranger.locator('#result-note')).toContainText(`Název „${name}“ už byl obsazený, proto web dostal adresu ${newName}.`);
    expect(await (await request.get(`/${name}/`)).text()).toContain('Sample site');
    expect(await (await request.get(`/${newName}/`)).text()).toContain('Version 2');

    // Nor can they replace or delete it.
    const res = await stranger.request.post(`/api/sites/${name}/delete`, { headers: HEADERS, data: {} });
    expect(res.status()).toBe(403);
    await stranger.context().close();
  });

  test('"Smazat" deletes the site after a confirmation that mentions the retention', async ({ page, request }) => {
    const name = unique('delete');
    await publishSignedIn(page, name);
    const card = page.locator(`.site-card[data-name="${name}"]`);
    const dialogs = answerDialogs(page, [false, true]);
    await card.locator('[data-action=delete]').click();
    await expect(card).toBeVisible();
    await card.locator('[data-action=delete]').click();
    await expect(card).toHaveCount(0);
    await expect(page.locator('.toast')).toHaveText(`Web ${name} byl smazán`);
    expect(dialogs[0].message).toContain(name);
    expect(dialogs[0].message).toContain('90 dní');
    expect(dialogs[0].message).toContain('martin@freepages.dev');
    expect((await request.get(`/${name}/`)).status()).toBe(404);
  });
});

test.describe('preview', () => {
  test('shows the staged files at a temporary preview address with a countdown', async ({ page, request }) => {
    await page.goto('/');
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    await row(page, 'about.html').dragTo(row(page, 'css'));
    await page.locator('#preview').click();
    await expect(page.locator('#preview-box')).toBeVisible();
    await expect(page.locator('#preview-time')).toHaveText(/preview-[a-z0-9]{6}\/ · vyprší za [45]:\d\d/);
    const url = await page.locator('#preview-open').getAttribute('href');
    expect(url).toMatch(/^http:\/\/localhost:4317\/preview-[a-z0-9]{6}\/$/);
    expect(await (await request.get(url)).text()).toContain('Sample site');
    expect(await (await request.get(`${url}css/about`)).text()).toContain('About page');

    // Changing the files hides the outdated preview.
    await row(page, 'css/about.html').dragTo(page.locator('.tree-root'));
    await expect(page.locator('#preview-box')).toBeHidden();
  });

  test('expired or unknown previews say so, and the name prefix is reserved', async ({ request }) => {
    const cs = { headers: { 'Accept-Language': 'cs' } };
    const res = await request.get('/preview-zzzzzz/', cs);
    expect(res.status()).toBe(404);
    expect(await res.text()).toContain('Tento náhled vypršel');
    const check = await (await request.get('/api/check-name?name=preview-abc', cs)).json();
    expect(check.error).toContain('rezervovaný');
  });

  test('the API creates previews too', async ({ request }) => {
    const { status, body } = await publishViaApi(request, unique('pv'), '<h1>Preview me</h1>', { preview: '1' }, { token: null });
    expect(status).toBe(200);
    expect(body.preview.minutes).toBe(5);
    expect(await (await request.get(body.preview.url)).text()).toContain('Preview me');
  });
});

test.describe('editing a site', () => {
  test('replace a file, add a folder and files, remove, preview and save', async ({ page, request }) => {
    const { site } = await signIn(page, { html: '<h1>Old home</h1>' });
    await page.goto('/');
    const card = page.locator(`.site-card[data-name="${site}"]`);
    await card.locator('[data-action=edit]').click();

    await expect(page.locator('#edit-banner')).toContainText(`Upravujete web ${site}`);

    await page.waitForFunction(() => window.scrollY === 0);
    await expect(page.locator('#name')).toHaveValue(site);
    await expect(page.locator('#name')).toBeDisabled();
    await expect(row(page, 'index.html')).toBeVisible();
    await expect(page.locator('#publish')).toHaveText('Uložit změny');

    // Replace index.html with another file (keeps its path).
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), menu(page, 'index.html', 'replace-file')]);
    expect(chooser.isMultiple()).toBe(false);
    await chooser.setFiles(`${FIXTURES.siteV2}/index.html`);
    await expect(row(page, 'index.html').locator('.tree-badge')).toHaveText('nový');

    // A new folder, named in place, with files added into it.
    await page.locator('[data-tool=mkdir]').click();
    await page.locator('.tree-input').fill('docs');
    await page.locator('.tree-input').press('Enter');
    await expect(row(page, 'docs')).toContainText('prázdná');
    const [files] = await Promise.all([page.waitForEvent('filechooser'), menu(page, 'docs', 'add-files')]);
    await files.setFiles([`${FIXTURES.site}/about.html`]);
    await expect(row(page, 'docs/about.html')).toBeVisible();

    // A whole folder added into the root.
    const [folder] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-tool=folder]').click()]);
    await folder.setFiles(FIXTURES.site);
    await expect(row(page, 'sample-site/css/style.css')).toBeVisible();
    await row(page, 'sample-site').locator('[data-act=remove]').click({ force: true });
    await expect(row(page, 'sample-site')).toHaveCount(0);

    await page.locator('#preview').click();
    await expect(page.locator('#preview-open')).toHaveAttribute('href', /preview-/);
    const preview = await page.locator('#preview-open').getAttribute('href');
    expect(await (await request.get(preview)).text()).toContain('Version 2');
    expect(await (await request.get(`/${site}/`)).text()).toContain('Old home');

    await page.locator('#publish').click();
    await expect(page.locator('#result-title')).toHaveText(`Web ${site} byl aktualizován`);
    expect(await (await request.get(`/${site}/`)).text()).toContain('Version 2');
    expect(await (await request.get(`/${site}/docs/about`)).text()).toContain('About page');
    expect((await request.get(`/${site}/sample-site/`)).status()).toBe(404);
  });

  test('keeps untouched files and can replace the whole site with a folder', async ({ page, request }) => {
    await signIn(page);
    await page.goto('/');
    const name = unique('keep');
    await publishSignedIn(page, name);
    await page.locator(`.site-card[data-name="${name}"] [data-action=edit]`).click();
    await expect(row(page, 'css/style.css')).toBeVisible();
    await page.waitForFunction(() => window.scrollY === 0);

    // Rename a kept file (double-click) and move it.
    await row(page, 'about.html').locator('.tree-name').dblclick();
    await page.locator('.tree-input').fill('o-nas.html');
    await page.locator('.tree-input').press('Enter');
    await menu(page, 'o-nas.html', 'move');
    await row(page, 'o-nas.html').locator('select').selectOption('files');
    await expect(row(page, 'files/o-nas.html')).toBeVisible();
    await page.locator('#publish').click();
    await expect(page.locator('#result')).toBeVisible();
    await expect(page.locator('#result-title')).toHaveText(`Web ${name} byl aktualizován`);
    expect(await (await request.get(`/${name}/files/o-nas`)).text()).toContain('About page');
    expect(await (await request.get(`/${name}/css/style.css`)).text()).toContain('rebeccapurple');
    expect((await request.get(`/${name}/about`)).status()).toBe(404);

    await page.locator(`.site-card[data-name="${name}"] [data-action=edit]`).click();
    await page.waitForFunction(() => window.scrollY === 0);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-tool=replace-all]').click()]);
    await chooser.setFiles(FIXTURES.siteV2);
    await expect(row(page, 'css')).toHaveCount(0);
    await page.locator('#publish').click();
    await expect(page.locator('#result')).toBeVisible();
    await expect(page.locator('#result-title')).toHaveText(`Web ${name} byl aktualizován`);
    expect((await request.get(`/${name}/css/style.css`)).status()).toBe(404);
    expect(await (await request.get(`/${name}/`)).text()).toContain('Version 2');
  });

  test('"Zrušit úpravy" leaves the site as it was', async ({ page }) => {
    const { site } = await signIn(page);
    await page.goto(`/?edit=${site}`);
    await expect(page.locator('#edit-banner')).toBeVisible();
    await page.waitForFunction(() => window.scrollY === 0);
    await expect(page).toHaveURL('/');
    await page.locator('#edit-cancel').click();
    await expect(page.locator('#edit-banner')).toBeHidden();
    await expect(page.locator('#dropzone')).toBeVisible();
    await expect(page.locator('#name')).toBeEnabled();
  });

  test("you cannot open someone else's site for editing", async ({ page, browser }) => {
    const { site } = await signIn(page);
    const stranger = await (await browser.newContext({ locale: 'cs-CZ' })).newPage();
    await signIn(stranger);
    await stranger.goto(`/?edit=${site}`);
    await expect(stranger.locator('#error-text')).toHaveText('Tento web nemůžete upravovat.');
    await expect(stranger.locator('#edit-banner')).toBeHidden();
    await stranger.context().close();
  });
});

test.describe('file tree before publishing', () => {
  test('choosing a folder shows all its content and prefills the name', async ({ page, request }) => {
    await page.goto('/');
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    await expect(page.locator('#name')).toHaveValue('sample-site');
    await expect(page.locator('.tree-root')).toContainText('Kořen webu');
    await expect(row(page, 'css')).toContainText('1 soubor');
    // Folders first, then files with index.html on top.
    const order = await page.locator('.tree-row').evaluateAll((rows) => rows.map((r) => r.dataset.path));
    expect(order).toEqual(['', 'css', 'css/style.css', 'files', 'files/readme.txt', 'index.html', '404.html', 'about.html']);
    await expect(page.locator('#dropzone')).toBeHidden();
    await expect(page.locator('#staged-summary')).toContainText('5 souborů');
    expect((await request.get('/sample-site/')).status()).toBe(404);
  });

  test('a typed name is kept when a folder is added', async ({ page }) => {
    await page.goto('/');
    await page.locator('#name').fill('my-own-name');
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    await expect(page.locator('#name')).toHaveValue('my-own-name');
  });

  test('loose files get a random 6-character name', async ({ page }) => {
    await page.goto('/');
    await pick(page, page.locator('#pick-files'), [`${FIXTURES.site}/index.html`, `${FIXTURES.site}/about.html`]);
    await expect(page.locator('.tree-file')).toHaveCount(2);
    await expect(page.locator('#name')).toHaveValue(/^[a-z0-9]{6}$/);
  });

  test('the toolbar adds files, folders and new folders; a second folder becomes a subfolder', async ({ page }) => {
    await page.goto('/');
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    await pick(page, page.locator('[data-tool=files]'), FIXTURES.zip);
    await pick(page, page.locator('[data-tool=folder]'), FIXTURES.siteV2);
    await expect(row(page, 'zipped-site.zip')).toBeVisible();
    await expect(row(page, 'sample-site-v2/index.html')).toBeVisible();
    await expect(page.locator('#staged-summary')).toContainText('7 souborů');

    await page.locator('[data-tool=mkdir]').click();
    await expect(page.locator('.tree-input')).toBeFocused();
    await page.locator('.tree-input').press('Enter');
    await expect(row(page, 'nova-slozka')).toBeVisible();
    await page.locator('[data-tool=mkdir]').click();
    await page.locator('.tree-input').press('Enter');
    await expect(row(page, 'nova-slozka-2')).toBeVisible();
  });

  test('the ⋯ menu adds a folder or a subfolder inside a folder', async ({ page }) => {
    await page.goto('/');
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), menu(page, 'css', 'add-folder')]);
    await chooser.setFiles(FIXTURES.siteV2);
    await expect(row(page, 'css/sample-site-v2/index.html')).toBeVisible();

    await menu(page, 'files', 'mkdir');
    await page.locator('.tree-input').fill('img');
    await page.locator('.tree-input').press('Enter');
    await expect(row(page, 'files/img')).toBeVisible();

    const [replace] = await Promise.all([page.waitForEvent('filechooser'), menu(page, 'css', 'replace-folder')]);
    await replace.setFiles(FIXTURES.siteV2);
    await expect(row(page, 'css/style.css')).toHaveCount(0);
    await expect(row(page, 'css/index.html')).toBeVisible();
  });

  test('the menu works with the keyboard and closes on Escape or outside clicks', async ({ page }) => {
    await page.goto('/');
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    await row(page, 'index.html').hover();
    await row(page, 'index.html').locator('[data-act=menu]').click();
    await expect(page.locator('.menu [data-menu]')).toHaveText(['Nahradit jiným souborem…', 'Přejmenovat', 'Přesunout do…', 'Odebrat']);
    await expect(page.locator('.menu [data-menu=replace-file]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.menu [data-menu=rename]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.menu')).toHaveCount(0);

    await row(page, 'css').hover();
    await row(page, 'css').locator('[data-act=menu]').click();
    await expect(page.locator('.menu')).toBeVisible();
    await page.locator('h1').click();
    await expect(page.locator('.menu')).toHaveCount(0);
  });

  test('names with a slash are refused when renaming', async ({ page }) => {
    await page.goto('/');
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    await menu(page, 'about.html', 'rename');
    await page.locator('.tree-input').fill('a/b.html');
    await page.locator('.tree-input').press('Enter');
    await expect(page.locator('.toast')).toHaveText('Neplatný název.');
    await expect(row(page, 'about.html')).toBeVisible();
  });

  test.describe('overwriting asks first', () => {
    const dialog = (page) => page.locator('#overwrite-dialog');

    test('adding a file that exists: "Zrušit" keeps the old one, "Přepsat" replaces it', async ({ page }) => {
      await page.goto('/');
      await pick(page, page.locator('#pick-folder'), FIXTURES.site);
      await pick(page, page.locator('[data-tool=files]'), `${FIXTURES.siteV2}/index.html`);
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page).locator('h2')).toHaveText('Přepsat soubor?');
      await expect(dialog(page).locator('#overwrite-text')).toHaveText('Soubor index.html už ve webu je. Nový ho nahradí.');
      await expect(page.locator('#overwrite-skip')).toBeHidden();
      await expect(page.locator('#overwrite-yes')).toBeFocused();
      await dialog(page).getByRole('button', { name: 'Zrušit' }).click();
      await expect(dialog(page)).toBeHidden();
      await expect(row(page, 'index.html')).toContainText('101 B');

      await pick(page, page.locator('[data-tool=files]'), `${FIXTURES.siteV2}/index.html`);
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toBeHidden();
      await expect(row(page, 'index.html')).toContainText('101 B');

      await pick(page, page.locator('[data-tool=files]'), `${FIXTURES.siteV2}/index.html`);
      await page.locator('#overwrite-yes').click();
      await expect(row(page, 'index.html')).toContainText('58 B');
      await expect(row(page, 'index.html')).toHaveCount(1);
      await expect(page.locator('#staged-summary')).toContainText('5 souborů');
    });

    test('several clashes are listed, and "Ponechat stávající" adds only the new files', async ({ page }) => {
      await page.goto('/');
      await pick(page, page.locator('#pick-folder'), FIXTURES.site);
      await pick(page, page.locator('[data-tool=files]'), [`${FIXTURES.siteV2}/index.html`, `${FIXTURES.site}/about.html`, FIXTURES.zip]);
      await expect(dialog(page).locator('h2')).toHaveText('Přepsat soubory?');
      await expect(dialog(page).locator('#overwrite-text')).toContainText('2 soubory');
      await expect(page.locator('#overwrite-list li')).toHaveText(['index.html', 'about.html']);
      await page.locator('#overwrite-skip').click();
      await expect(row(page, 'zipped-site.zip')).toBeVisible();
      await expect(row(page, 'index.html')).toContainText('101 B');
      await expect(page.locator('#staged-summary')).toContainText('6 souborů');
    });

    test('dropping a folder onto a folder that has the same files asks too', async ({ page }) => {
      await page.goto('/');
      await pick(page, page.locator('#pick-folder'), FIXTURES.site);
      await pick(page, page.locator('[data-tool=folder]'), FIXTURES.siteV2);
      await expect(dialog(page)).toBeHidden(); // sample-site-v2/ is new
      await pick(page, page.locator('[data-tool=folder]'), FIXTURES.siteV2);
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page).locator('#overwrite-text')).toContainText('sample-site-v2/index.html');
      await page.locator('#overwrite-yes').click();
      await expect(dialog(page)).toBeHidden();
    });

    test('moving or renaming onto an existing file asks; cancelling keeps both', async ({ page }) => {
      await page.goto('/');
      await pick(page, page.locator('#pick-folder'), FIXTURES.site);
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), menu(page, 'css', 'add-files')]);
      await chooser.setFiles(`${FIXTURES.site}/about.html`);
      await expect(row(page, 'css/about.html')).toBeVisible();

      await row(page, 'about.html').dragTo(row(page, 'css'));
      await expect(dialog(page).locator('#overwrite-text')).toHaveText('Na cílovém místě už je soubor css/about.html. Přesunutý ho nahradí.');
      await dialog(page).getByRole('button', { name: 'Zrušit' }).click();
      await expect(row(page, 'about.html')).toBeVisible();
      await expect(row(page, 'css/about.html')).toBeVisible();

      await menu(page, 'about.html', 'rename');
      await page.locator('.tree-input').fill('404.html');
      await page.locator('.tree-input').press('Enter');
      await expect(dialog(page)).toBeVisible();
      await page.locator('#overwrite-yes').click();
      await expect(row(page, 'about.html')).toHaveCount(0);
      await expect(row(page, '404.html')).toContainText('55 B');
      await expect(page.locator('#staged-summary')).toContainText('5 souborů');

      // Moving a folder into one with clashing files lists them.
      await menu(page, 'files', 'mkdir');
      await page.locator('.tree-input').fill('css');
      await page.locator('.tree-input').press('Enter');
      await expect(row(page, 'files/css')).toBeVisible();
      await row(page, 'css').dragTo(row(page, 'files'));
      await expect(dialog(page)).toBeHidden(); // files/css is empty, nothing to overwrite
      await expect(row(page, 'files/css/style.css')).toBeVisible();
    });
  });

  test('files and folders can be moved by dragging onto a folder', async ({ page, request }) => {
    await signIn(page);
    const name = unique('drag');
    await page.goto('/');
    await page.locator('#name').fill(name);
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    await row(page, 'about.html').dragTo(row(page, 'css'));
    await expect(row(page, 'css/about.html')).toBeVisible();
    await expect(row(page, 'about.html')).toHaveCount(0);
    await row(page, 'files').dragTo(row(page, 'css'));
    await expect(row(page, 'css/files/readme.txt')).toBeVisible();
    await row(page, 'css/style.css').dragTo(page.locator('.tree-root'));
    await expect(row(page, 'style.css')).toBeVisible();

    await page.locator('#publish').click();
    await expect(page.locator('#result-title')).toHaveText(`Web ${name} je online`);
    expect(await (await request.get(`/${name}/css/about`)).text()).toContain('About page');
    expect(await (await request.get(`/${name}/css/files/readme.txt`)).text()).toContain('Just a text file');
    expect(await (await request.get(`/${name}/style.css`)).text()).toContain('rebeccapurple');
  });

  test('a folder cannot be moved into itself', async ({ page }) => {
    await page.goto('/');
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    await row(page, 'files').dragTo(row(page, 'files/readme.txt'));
    await expect(row(page, 'files/readme.txt')).toBeVisible();
    await expect(row(page, 'files/files/readme.txt')).toHaveCount(0);
  });

  test('"Přesunout do…" moves an item without dragging', async ({ page }) => {
    await page.goto('/');
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    await menu(page, 'about.html', 'move');
    const select = row(page, 'about.html').locator('select');
    await expect(select.locator('option')).toHaveText(['Přesunout do…', 'css/', 'files/']);
    await select.selectOption('files');
    await expect(row(page, 'files/about.html')).toBeVisible();
    await menu(page, 'files/about.html', 'move');
    await row(page, 'files/about.html').locator('select').selectOption('/');
    await expect(row(page, 'about.html')).toBeVisible();
  });

  test('files dropped from the computer onto a folder are added into it', async ({ page }) => {
    await page.goto('/');
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['img'], 'logo.png', { type: 'image/png' }));
      return dt;
    });
    await page.dispatchEvent('.tree-row[data-path="css"]', 'drop', { dataTransfer });
    await expect(row(page, 'css/logo.png')).toBeVisible();
  });

  test('items can be removed, folders collapsed and the list cleared', async ({ page }) => {
    await page.goto('/');
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    await row(page, 'about.html').hover();
    await row(page, 'about.html').getByRole('button', { name: 'Odebrat about.html' }).click();
    await expect(row(page, 'about.html')).toHaveCount(0);
    await menu(page, 'files', 'remove');
    await expect(row(page, 'files/readme.txt')).toHaveCount(0);
    await expect(page.locator('#staged-summary')).toContainText('3 soubory');

    await row(page, 'css').locator('.twisty').click();
    await expect(row(page, 'css/style.css')).toHaveCount(0);
    await row(page, 'css').locator('.twisty').click();
    await expect(row(page, 'css/style.css')).toBeVisible();

    await page.locator('#clear-staged').click();
    await expect(page.locator('#staged')).toBeHidden();
    await expect(page.locator('#dropzone')).toBeVisible();
  });

  test('pressing Enter in the name field publishes the staged files', async ({ page }) => {
    await signIn(page);
    const name = unique('enter');
    await page.goto('/');
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    await page.locator('#name').fill(name);
    await page.locator('#name').press('Enter');
    await expect(page.locator('#result-title')).toHaveText(`Web ${name} je online`);
  });
});
