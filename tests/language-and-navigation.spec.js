// @ts-check
const { test, expect } = require('@playwright/test');
const { FIXTURES, pick } = require('./helpers');

test.describe('language detection', () => {
  test('Czech browsers get Czech', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
    await expect(page.locator('h1')).toHaveText('Web online jedním přetažením.');
    await expect(page.locator('.lang-button')).toContainText('Čeština');
  });

  test.describe('English browser', () => {
    test.use({ locale: 'en-US' });
    test('gets English, including server messages', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page).toHaveTitle('Publish a website');
      await expect(page.locator('h1')).toHaveText('Your site online in one drop.');
      await page.locator('#name').fill('api');
      await pick(page, page.locator('#pick-folder'), FIXTURES.site);
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

test('the language dropdown switches and remembers the language', async ({ page }) => {
  await page.goto('/');
  const button = page.locator('.lang-button');
  const menu = page.locator('.lang-menu');

  await button.click();
  await expect(menu).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  await button.click();
  await page.locator('h1').click();
  await expect(menu).toBeHidden();

  await button.click();
  await menu.locator('[data-set-lang=en]').click();
  await expect(page.locator('h1')).toHaveText('Your site online in one drop.');
  await expect(button).toContainText('English');

  await page.goto('/docs');
  await expect(page.locator('[data-lang=en] h1')).toHaveText('Guide');
  await page.goto('/admin');
  await expect(page.locator('#login h2')).toHaveText('Admin login');

  await page.locator('.lang-button').click();
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
  await page.locator('.band a[href="/docs"]').click();
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
    await expect(abuse).toHaveText('martin@balcar.me');
    await expect(abuse).toHaveAttribute('href', /^mailto:martin@balcar\.me\?subject=Nahl%C3%A1%C5%A1en%C3%AD%20zneu%C5%BEit%C3%AD/);
  });
}

test('"Nahlásit zneužití" button in the band is a mail link', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.band a.abuse-link')).toHaveAttribute('href', /^mailto:martin@balcar\.me/);
});
