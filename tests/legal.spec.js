// @ts-check
const { test, expect } = require('./test');
const { FIXTURES, pick, pickAndPublish } = require('./helpers');

const PAGES = [
  { cs: '/podminky', en: '/terms', csTitle: 'Podmínky použití', enTitle: 'terms of use' },
  { cs: '/soukromi', en: '/privacy', csTitle: 'Zásady ochrany osobních údajů', enTitle: 'privacy policy' },
];

for (const p of PAGES) {
  test(`${p.cs} is available in Czech and English (also as ${p.en})`, async ({ page }) => {
    await page.goto(p.cs);
    await expect(page.locator('[data-lang=cs] h1')).toHaveText(p.csTitle);
    await expect(page.locator('[data-lang=en]')).toBeHidden();
    await expect(page.locator('[data-lang=cs]')).toContainText('IČO 21753580');
    await expect(page.locator('[data-lang=cs]')).toContainText('martin@freepages.dev');

    await page.locator('[data-set-lang=en]').click();
    await expect(page.locator('[data-lang=en] h1')).toHaveText(p.enTitle);
    await expect(page).toHaveTitle(new RegExp(p.enTitle));

    await page.goto(p.en);
    await expect(page.locator('[data-lang=en] h1')).toHaveText(p.enTitle);
  });
}

for (const path of ['/', '/docs', '/admin', '/podminky', '/soukromi']) {
  test(`footer on ${path} links to terms and privacy`, async ({ page }) => {
    await page.goto(path);
    const footer = page.locator('.site-footer');
    await footer.locator('a[href="/podminky"]').click();
    await expect(page.locator('[data-lang=cs] h1')).toHaveText('Podmínky použití');
    await page.goto(path);
    await page.locator('.site-footer a[href="/soukromi"]').click();
    await expect(page.locator('[data-lang=cs] h1')).toHaveText('Zásady ochrany osobních údajů');
  });
}

test('the upload area says that uploading means accepting the terms', async ({ page }) => {
  await page.goto('/');
  await pick(page, page.locator('#pick-folder'), FIXTURES.site);
  const consent = page.locator('#staged .consent');
  await expect(consent).toContainText('Nahráním souhlasíte s podmínkami použití');

  // Clicking the link opens the terms, not the folder picker.
  let chooserOpened = false;
  page.on('filechooser', () => (chooserOpened = true));
  await consent.locator('a[href="/podminky"]').click();
  await expect(page).toHaveURL('/podminky');
  expect(chooserOpened).toBe(false);
});

test('legal page names cannot be taken by a site', async ({ page }) => {
  for (const name of ['podminky', 'soukromi', 'terms', 'privacy']) {
    await page.goto('/');
    await page.locator('#name').fill(name);
    await pickAndPublish(page, page.locator('#pick-folder'), FIXTURES.site);
    await expect(page.locator('#error-text')).toContainText('rezervovaný');
  }
});

test.describe('English browser', () => {
  test.use({ locale: 'en-US' });
  test('sees the English consent line and footer links', async ({ page }) => {
    await page.goto('/');
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    await expect(page.locator('#staged .consent')).toContainText('By uploading, you agree to the terms of use');
    await expect(page.locator('.site-footer a[href="/podminky"]')).toHaveText('Terms');
    await expect(page.locator('.site-footer a[href="/soukromi"]')).toHaveText('Privacy');
  });
});
