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
      await expect(page).toHaveTitle('freepages.dev: publish a website for free in one drop');
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
  await page.goto('/ucet');
  await expect(page.locator('#signin h2').first()).toHaveText('Sign in');

  await page.locator('[data-set-lang=cs]').click();
  await expect(page.locator('#signin h2').first()).toHaveText('Přihlášení');
});

test('header navigation links work', async ({ page }) => {
  await page.goto('/');
  await page.locator('.nav a[href="/docs"]').click();
  await expect(page).toHaveURL('/docs');
  await expect(page.locator('[data-lang=cs] h1')).toHaveText('Návod');

  await page.locator('.nav a[href="/"]').click();
  await expect(page).toHaveURL('/');

  await page.locator('.nav a[href="/ucet"]').click();
  await expect(page).toHaveURL('/ucet');

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

for (const path of ['/', '/docs', '/ucet']) {
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


test('every page has the same header, marking the current page', async ({ page }) => {
  const current = { '/': '/', '/docs': '/docs', '/ucet': '/ucet', '/podminky': null, '/soukromi': null };
  for (const [path, href] of Object.entries(current)) {
    await page.goto(path);
    const links = page.locator('.topbar .nav a');
    await expect(links).toHaveText(['Zveřejnit', 'Návod', 'Přihlásit se']);
    expect(await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual(['/', '/docs', '/ucet']);
    await expect(page.locator('.topbar .nav [aria-current=page]')).toHaveCount(href ? 1 : 0);
    if (href) await expect(page.locator('.topbar .nav [aria-current=page]')).toHaveAttribute('href', href);
    await expect(page.locator('.site-footer a[href="/podminky"]')).toBeVisible();
  }
});

test('the header comes in the language chosen with the switch, before any script runs', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: 'cs-CZ' });
  await context.addCookies([{ name: 'fp_lang', value: 'en', url: 'http://localhost:4317' }]);
  const page = await context.newPage();
  await page.goto('http://localhost:4317/docs');
  await expect(page.locator('.topbar .nav a')).toHaveText(['Publish', 'Guide', 'Sign in']);
  await context.close();
});

test.describe('phone', () => {
  test.use({ viewport: { width: 360, height: 740 } });
  for (const path of ['/', '/docs', '/podminky', '/soukromi', '/ucet']) {
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
