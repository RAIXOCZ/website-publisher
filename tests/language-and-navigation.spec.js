// @ts-check
const { test, expect } = require('./test');
const { FIXTURES, pick, pickAndPublish } = require('./helpers');

test.describe('language detection', () => {
  test('Czech browsers get Czech', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
    await expect(page.locator('h1')).toHaveText('Web online jedním přetažením.');
    await expect(page.locator('[data-set-lang=cs]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-set-lang=en]')).toHaveAttribute('aria-pressed', 'false');
  });

  test.describe('English browser', () => {
    test.use({ locale: 'en-US' });
    test('gets English, including server messages', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page).toHaveTitle('Freepages – publish a website for free in one drop');
      await expect(page.locator('h1')).toHaveText('Your site online in one drop.');
      await page.locator('#name').fill('api');
      await pickAndPublish(page, page.locator('#pick-folder'), FIXTURES.site);
      await expect(page.locator('#error-text')).toHaveText('"api" is reserved, please choose another name.');
    });
  });

  test.describe('other languages', () => {
    test.use({ locale: 'de-DE' });
    test('fall back to English', async ({ page }) => {
      await page.goto('/docs');
      await expect(page.locator('[data-lang=en] h1')).toBeVisible();
      await expect(page.locator('[data-lang=cs]')).toBeHidden();
    });
  });
});

test('the CS/EN switch changes and remembers the language', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-set-lang=cs]').click();
  await expect(page.locator('h1')).toHaveText('Web online jedním přetažením.');

  await page.locator('[data-set-lang=en]').click();
  await expect(page.locator('h1')).toHaveText('Your site online in one drop.');
  await expect(page.locator('[data-set-lang=en]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tree:visible')).toContainText('my-site/');

  await page.goto('/docs');
  await expect(page.locator('[data-lang=en] h1')).toHaveText('Guide');
  await page.goto('/admin');
  await expect(page.locator('#login h2')).toHaveText('Admin login');

  await page.locator('[data-set-lang=cs]').click();
  await expect(page.locator('#login h2')).toHaveText('Přihlášení do správy');
});

test('header navigation links work', async ({ page }) => {
  await page.goto('/');
  await page.locator('.nav a[href="/docs"]').click();
  await expect(page).toHaveURL('/docs');
  await expect(page.locator('[data-lang=cs] h1')).toHaveText('Návod');

  await page.locator('.nav a[href="/"]').click();
  await expect(page).toHaveURL('/');

  await page.locator('.nav a[href="#my-sites"]').click();
  await expect(page).toHaveURL('/#my-sites');

  await page.locator('a.brand').click();
  await expect(page).toHaveURL('/');
});

test('"Přečíst návod" opens the guide with this server\'s details', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#how-live')).toHaveText('localhost:4317/muj-web/');
  await page.locator('.how a[href="/docs"]').click();
  await expect(page).toHaveURL('/docs');
  await expect(page.locator('[data-lang=cs] .url-example')).toHaveText('http://localhost:4317/nazev-webu/');
  await expect(page.locator('[data-lang=cs] .max-upload')).toHaveText('100 MB');
});

for (const path of ['/', '/docs', '/admin']) {
  test(`footer on ${path} credits Martin Balcar and links to abuse reports`, async ({ page }) => {
    await page.goto(path);
    const footer = page.locator('.site-footer');
    await expect(footer).toContainText('Vytvořil Martin Balcar');
    await expect(footer.locator('a', { hasText: 'Martin Balcar' })).toHaveAttribute('href', 'https://martin-balcar.cz');
    await expect(footer).toContainText('Nahlásit zneužití');
    const abuse = footer.locator('a.abuse-link');
    await expect(abuse).toHaveText('martin@freepages.dev');
    await expect(abuse).toHaveAttribute('href', /^mailto:martin@freepages\.dev\?subject=Nahl%C3%A1%C5%A1en%C3%AD%20zneu%C5%BEit%C3%AD/);
  });
}


test.describe('phone', () => {
  test.use({ viewport: { width: 360, height: 740 } });
  for (const path of ['/', '/docs', '/podminky', '/soukromi', '/ucet', '/admin']) {
    test(`the header and page fit the screen on ${path}`, async ({ page }) => {
      await page.goto(path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
      const bar = await page.locator('.topbar .bar').boundingBox();
      const lang = await page.locator('[data-lang-switch]').boundingBox();
      expect(lang.x + lang.width).toBeLessThanOrEqual(bar.x + bar.width);
      // Only the logo is shown; the name is still there for screen readers.
      await expect(page.locator('.brand [data-brand]')).toHaveCSS('position', 'absolute');
      await expect(page.locator('.brand')).toHaveAccessibleName(/localhost/);
    });
  }
});
