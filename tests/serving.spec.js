// @ts-check
const http = require('http');
const { test, expect } = require('@playwright/test');
const { FIXTURES, unique, pick, publishViaApi } = require('./helpers');

test.describe('path-style sites (localhost:4317/<name>/)', () => {
  let name;

  test.beforeAll(async ({ request }) => {
    name = unique('serve');
    const res = await request.post('/api/sites', {
      headers: { 'X-Requested-With': 'fetch' },
      multipart: {
        name,
        p: 'site/index.html',
        f: { name: 'index.html', mimeType: 'text/html', buffer: Buffer.from('<h1>Home</h1>') },
      },
    });
    expect(res.status()).toBe(200);
  });

  test('every response carries the Report-Abuse header', async ({ request }) => {
    for (const url of ['/', '/docs', '/admin', '/api/config', `/${name}/`, '/no-such-site/']) {
      const res = await request.get(url);
      expect(res.headers()['report-abuse'], url).toBe('martin@balcar.me');
    }
  });

  test('serves the site and redirects to the trailing slash', async ({ request }) => {
    const res = await request.get(`/${name}`, { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers().location).toBe(`/${name}/`);
    expect(await (await request.get(`/${name}/`)).text()).toContain('<h1>Home</h1>');
  });

  test('path-style sites are sandboxed away from the admin origin', async ({ request }) => {
    const res = await request.get(`/${name}/`);
    expect(res.headers()['content-security-policy']).toContain('sandbox');
  });

  test('unknown sites return 404', async ({ request }) => {
    const res = await request.get('/no-such-site-xyz/');
    expect(res.status()).toBe(404);
    expect(res.headers()['report-abuse']).toBe('martin@balcar.me');
  });
});

test.describe('site features', () => {
  test('clean URLs, custom 404 page and folder listings', async ({ page, request }) => {
    const name = unique('features');
    await page.goto('/');
    await page.locator('#name').fill(name);
    await pick(page, page.locator('#pick-folder'), FIXTURES.site);
    await page.locator('#result').waitFor();

    expect(await (await request.get(`/${name}/about`)).text()).toContain('About page');
    expect(await (await request.get(`/${name}/css/style.css`)).text()).toContain('rebeccapurple');

    const missing = await request.get(`/${name}/nope`);
    expect(missing.status()).toBe(404);
    expect(await missing.text()).toContain('Custom not found');

    const listing = await request.get(`/${name}/files/`);
    expect(await listing.text()).toContain('readme.txt');

    const traversal = await request.get(`/${name}/..%2f..%2fmeta/${name}.json`);
    expect(traversal.status()).not.toBe(200);
  });
});

// Raw HTTP so we can set the Host header for the subdomain server on :4318.
function get(path, host, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 4318, path, method, headers: { Host: host, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test.describe('subdomain sites (<name>.pub.test)', () => {
  let name;

  test.beforeAll(async ({ playwright }) => {
    name = unique('sub');
    const api = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4318', extraHTTPHeaders: { Host: 'pub.test' } });
    const { status } = await publishViaApi(api, name, '<h1>Subdomain site</h1>');
    expect(status).toBe(200);
    await api.dispose();
  });

  test('each site is served on its own subdomain', async () => {
    const res = await get('/', `${name}.pub.test`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Subdomain site');
    expect(res.headers['report-abuse']).toBe('martin@balcar.me');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  test('path URLs redirect to the subdomain', async () => {
    const res = await get(`/${name}/page?x=1`, 'pub.test');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe(`http://${name}.pub.test/page?x=1`);
  });

  test('the bare domain is the publisher and www redirects to it', async () => {
    expect((await get('/', 'pub.test')).body).toContain('id="pick-folder"');
    const www = await get('/', 'www.pub.test');
    expect(www.status).toBe(302);
    expect(www.headers.location).toBe('http://pub.test/');
  });

  test('a site subdomain cannot reach the publisher API', async () => {
    expect((await get('/api/config', `${name}.pub.test`)).status).toBe(404);
    const post = await get('/api/sites', `${name}.pub.test`, { method: 'POST', headers: { 'X-Requested-With': 'fetch' } });
    expect(post.status).toBe(405);
  });

  test('admin API rejects requests coming from a site origin', async () => {
    const res = await get('/api/login', 'pub.test', {
      method: 'POST',
      headers: { 'X-Requested-With': 'fetch', Origin: `http://${name}.pub.test`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-admin' }),
    });
    expect(res.status).toBe(403);
  });
});
