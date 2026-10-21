// @ts-check
const { test, expect } = require('./test');
const { HEADERS, unique, signIn, signInAsAdmin, htmlFile } = require('./helpers');

test('page views are counted per site and hour and shown as a chart', async ({ page, request }) => {
  const { site } = await signIn(page);
  const { token } = await (await page.request.post('/api/me/tokens', { headers: HEADERS, data: { name: 'stats' } })).json();
  const second = unique('second');
  await request.post('/api/sites', { headers: { Authorization: `Bearer ${token}` }, multipart: { name: second, f: htmlFile('<h1>2</h1>') } });

  // Three page views of the first site, one of the second; images, bots and previews don't count.
  for (let i = 0; i < 3; i++) await request.get(`/${site}/`);
  await request.get(`/${second}/`);
  await request.get(`/${site}/`, { headers: { 'User-Agent': 'Googlebot/2.1' } });
  await request.get(`/${site}/missing.png`);

  const all = await (await page.request.get('/api/me/stats?range=24h')).json();
  expect(all.unit).toBe('hour');
  expect(all.buckets).toHaveLength(24);
  expect(all.total).toBe(4);
  expect(all.sites.map((s) => [s.name, s.views])).toEqual([[site, 3], [second, 1]]);
  const one = await (await page.request.get(`/api/me/stats?range=30d&site=${second}`)).json();
  expect(one.unit).toBe('day');
  expect(one.total).toBe(1);

  await page.goto('/ucet');
  const visits = page.locator('#visits');
  await expect(visits.locator('[data-stat=total]')).toHaveText('4');
  await expect(visits.locator('.chart .bars path')).toHaveCount(1);
  await expect(visits.locator('.stats-sites li')).toHaveCount(2);
  await visits.locator('.stats-site').selectOption(second);
  await expect(visits.locator('[data-stat=total]')).toHaveText('1');
  await visits.locator('.segmented [data-range="7d"]').click();
  await expect(visits.locator('.segmented [data-range="7d"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(visits.locator('.stat-label').nth(1)).toHaveText('Nejrušnější hodina');
  await visits.locator('.segmented [data-range="30d"]').click();
  await expect(visits.locator('.stat-label').nth(1)).toHaveText('Nejrušnější den');

  // Hovering a column shows its value.
  await visits.locator('.chart .hits rect').last().hover();
  await expect(visits.locator('.chart-tip')).toBeVisible();
  await expect(visits.locator('.chart-tip b')).toHaveText('1 zobrazení');
  // The same numbers are available as a table.
  await visits.locator('.stats-table summary').click();
  await expect(visits.locator('.stats-table tbody tr').first()).toContainText('1');

  // Other people's sites are not in your statistics.
  expect((await (await page.request.get('/api/me/stats?site=docs')).json()).total).toBe(0);
});

test('the admin sees visits of all sites', async ({ page, request }) => {
  const other = await (await page.context().browser().newContext()).newPage();
  const { site } = await signIn(other);
  await request.get(`/${site}/`);
  await other.context().close();
  await signInAsAdmin(page);
  await page.goto('/admin');
  await page.locator('[role=tab][data-tab=visits]').click();
  await expect(page.locator('#visits [data-stat=total]')).not.toHaveText('–');
  const stats = await (await page.request.get(`/api/admin/stats?site=${site}`)).json();
  expect(stats.total).toBe(1);
});
