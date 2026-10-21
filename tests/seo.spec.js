// @ts-check
const { test, expect } = require('./test');
const { unique, publishViaApi } = require('./helpers');

const BASE = 'http://localhost:4317';
const head = async (request, path, headers = {}) => {
  const res = await request.get(path, { headers });
  return { res, html: await res.text() };
};
const meta = (html, attr, name) => html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1];
const link = (html, rel, extra = '') => html.match(new RegExp(`<link rel="${rel}"${extra} href="([^"]*)"`))?.[1];

test('public pages have title, description, canonical, hreflang and social cards in both languages', async ({ request }) => {
  for (const path of ['/', '/docs', '/podminky', '/soukromi']) {
    const cs = await head(request, `${path}?lang=cs`);
    const en = await head(request, `${path}?lang=en`);
    expect(cs.html, path).toContain('<html lang="cs">');
    expect(en.html, path).toContain('<html lang="en">');
    expect(cs.html).not.toEqual(en.html);
    for (const [lang, { html }] of [['cs', cs], ['en', en]]) {
      const title = html.match(/<title[^>]*>([^<]+)<\/title>/)[1];
      expect(title, path).toContain('freepages.dev');
      const description = meta(html, 'name', 'description');
      expect(description?.length, `${path} ${lang}`).toBeGreaterThan(50);
      expect(description?.length, `${path} ${lang}`).toBeLessThan(200);
      expect(link(html, 'canonical')).toBe(`${BASE}${path}?lang=${lang}`);
      expect(link(html, 'alternate', ' hreflang="cs"')).toBe(`${BASE}${path}?lang=cs`);
      expect(link(html, 'alternate', ' hreflang="en"')).toBe(`${BASE}${path}?lang=en`);
      expect(link(html, 'alternate', ' hreflang="x-default"')).toBe(`${BASE}${path}`);
      expect(meta(html, 'property', 'og:title')).toBe(title);
      expect(meta(html, 'property', 'og:image')).toBe(`${BASE}/og-${lang}.png`);
      expect(meta(html, 'property', 'og:url')).toBe(`${BASE}${path}?lang=${lang}`);
      expect(meta(html, 'name', 'twitter:card')).toBe('summary_large_image');
      expect(html).not.toContain('noindex');
    }
  }
  // Without ?lang the browser's language decides and the canonical is the bare URL.
  const auto = await head(request, '/docs', { 'Accept-Language': 'en-US' });
  expect(auto.html).toContain('<html lang="en">');
  expect(link(auto.html, 'canonical')).toBe(`${BASE}/docs`);
  expect(auto.res.headers().vary).toContain('Accept-Language');
  // /terms is the same page as /podminky.
  expect(link((await head(request, '/terms')).html, 'canonical')).toBe(`${BASE}/podminky`);
});

test('the home page describes the app with structured data', async ({ request }) => {
  const { html } = await head(request, '/?lang=en');
  const json = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
  expect(json).toMatchObject({ '@type': 'WebApplication', name: 'freepages.dev', url: `${BASE}/`, offers: { price: '0' } });
  expect(html.match(/<h1/g)).toHaveLength(1);
});

test('private pages and previews are kept out of search engines', async ({ request }) => {
  for (const path of ['/ucet', '/admin', '/email/whatever']) {
    const { res, html } = await head(request, path);
    expect(res.headers()['x-robots-tag'], path).toBe('noindex');
    expect(html, path).toContain('<meta name="robots" content="noindex">');
    expect(html, path).not.toContain('rel="canonical"');
  }
  const { body } = await publishViaApi(request, unique('pv'), '<h1>p</h1>', { preview: '1' }, { token: null });
  expect((await request.get(body.preview.url)).headers()['x-robots-tag']).toBe('noindex, nofollow');
});

test('robots.txt and sitemap.xml', async ({ request }) => {
  const robots = await (await request.get('/robots.txt')).text();
  for (const line of ['Disallow: /admin', 'Disallow: /ucet', 'Disallow: /email/', 'Disallow: /api/', `Sitemap: ${BASE}/sitemap.xml`]) {
    expect(robots).toContain(line);
  }
  const res = await request.get('/sitemap.xml');
  expect(res.headers()['content-type']).toContain('application/xml');
  const xml = await res.text();
  for (const path of ['/', '/docs', '/podminky', '/soukromi']) {
    for (const suffix of ['', '?lang=cs', '?lang=en']) expect(xml).toContain(`<loc>${BASE}${path}${suffix}</loc>`);
  }
  expect(xml).toContain('hreflang="x-default"');
  expect(xml).not.toContain('/admin');
});

test('favicons, app icons, manifest and share images are all served', async ({ request }) => {
  const { html } = await head(request, '/');
  expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32">');
  expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
  expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
  expect(html).toContain('<link rel="manifest" href="/site.webmanifest">');
  expect(meta(html, 'name', 'theme-color')).toBe('#0d9488');

  const ico = await request.get('/favicon.ico');
  expect(ico.status()).toBe(200);
  const bytes = await ico.body();
  expect([...bytes.subarray(0, 4)]).toEqual([0, 0, 1, 0]); // a real ICO file
  expect(bytes.readUInt16LE(4)).toBe(3); // 16, 32 and 48 px

  const png = async (path, size) => {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    const body = await res.body();
    expect(body.subarray(1, 4).toString(), path).toBe('PNG');
    expect([body.readUInt32BE(16), body.readUInt32BE(20)], path).toEqual(size);
  };
  await png('/apple-touch-icon.png', [180, 180]);
  await png('/apple-touch-icon-precomposed.png', [180, 180]);
  await png('/icon-192.png', [192, 192]);
  await png('/icon-512.png', [512, 512]);
  await png('/icon-maskable-512.png', [512, 512]);
  await png('/og-cs.png', [1200, 630]);
  await png('/og-en.png', [1200, 630]);
  expect((await request.get('/favicon.svg')).headers()['content-type']).toContain('image/svg+xml');

  const manifest = await (await request.get('/site.webmanifest')).json();
  expect(manifest.name).toBe('freepages.dev');
  for (const icon of manifest.icons) expect((await request.get(icon.src)).status(), icon.src).toBe(200);
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
});

test('?lang= switches the page language and the CS/EN switch keeps it in the address', async ({ page }) => {
  await page.goto('/docs?lang=en');
  await expect(page.locator('[data-lang=en] h1')).toBeVisible();
  await page.locator('[data-set-lang=cs]').click();
  await expect(page).toHaveURL('/docs?lang=cs');
  await expect(page.locator('[data-lang=cs] h1')).toBeVisible();
  // The choice is remembered on pages without ?lang.
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
});
