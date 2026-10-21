// @ts-check
const http = require('http');
const { test, expect } = require('./test');
const { FIXTURES, unique, pickAndPublish, signIn, apiToken, publishViaApi } = require('./helpers');

test.describe('path-style sites (localhost:4317/<name>/)', () => {
  let name;

  test.beforeAll(async ({ request }) => {
    name = unique('serve');
    const res = await request.post('/api/sites', {
      headers: { Authorization: `Bearer ${await apiToken()}` },
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
      expect(res.headers()['report-abuse'], url).toBe('martin@freepages.dev');
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
    expect(res.headers()['report-abuse']).toBe('martin@freepages.dev');
  });
});

test.describe('site features', () => {
  test('clean URLs, custom 404 page and folder listings', async ({ page, request }) => {
    const name = unique('features');
    await signIn(page);
    await page.goto('/');
    await page.locator('#name').fill(name);
    await pickAndPublish(page, page.locator('#pick-folder'), FIXTURES.site);
    await page.locator('#result').waitFor();

    expect(await (await request.get(`/${name}/about`)).text()).toContain('About page');
    expect(await (await request.get(`/${name}/css/style.css`)).text()).toContain('rebeccapurple');

    const missing = await request.get(`/${name}/nope`);
    expect(missing.status()).toBe(404);
    expect(await missing.text()).toContain('Custom not found');

    const listing = await request.get(`/${name}/files/`);
    expect(await listing.text()).toContain('readme.txt');

    for (const target of ['freepages.db', '.session-secret']) {
      const traversal = await request.get(`/${name}/..%2f..%2f${target}`);
      expect(traversal.status()).not.toBe(200);
    }
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
  let previewUrl;

  test.beforeAll(async ({ playwright }) => {
    name = unique('sub');
    const api = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4318', extraHTTPHeaders: { Host: 'pub.test' } });
    const target = { baseURL: 'http://127.0.0.1:4318', extraHTTPHeaders: { Host: 'pub.test' } };
    const { status } = await publishViaApi(api, name, '<h1>Subdomain site</h1>', {}, target);
    expect(status).toBe(200);
    const preview = await publishViaApi(api, name, '<h1>Sub preview</h1>', { preview: '1' }, target);
    previewUrl = preview.body.preview.url;
    await api.dispose();
  });

  test('each site is served on its own subdomain', async () => {
    const res = await get('/', `${name}.pub.test`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Subdomain site');
    expect(res.headers['report-abuse']).toBe('martin@freepages.dev');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  test('previews get their own preview-xxxxxx subdomain', async () => {
    const host = new URL(previewUrl).host;
    expect(host).toMatch(/^preview-[a-z0-9]{6}\.pub\.test$/);
    expect((await get('/', host)).body).toContain('Sub preview');
    expect((await get('/', 'preview-zzzzzz.pub.test')).status).toBe(404);
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

  test('the API rejects requests coming from a site origin', async () => {
    const res = await get('/api/auth/login', 'pub.test', {
      method: 'POST',
      headers: { 'X-Requested-With': 'fetch', Origin: `http://${name}.pub.test`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'martin@freepages.dev' }),
    });
    expect(res.status).toBe(403);
  });
});

test('pages reference versioned assets so a deploy never mixes old CSS/JS with new HTML', async ({ request }) => {
  for (const path of ['/', '/docs', '/admin']) {
    const res = await request.get(path);
    expect(res.headers()['cache-control'], path).toBe('no-cache');
    const html = await res.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/_app\/[^"]+)"/g)].map((m) => m[1]);
    expect(assets.length, path).toBeGreaterThan(3);
    for (const asset of assets) expect(asset, path).toMatch(/\?v=[0-9a-f]{12}$/);
  }
  const html = await (await request.get('/')).text();
  const css = html.match(/href="(\/_app\/app\.css\?v=[0-9a-f]+)"/)[1];
  expect((await request.get(css)).headers()['cache-control']).toContain('immutable');
  expect((await request.get('/_app/app.css')).headers()['cache-control']).toBe('no-cache');
  expect((await request.get('/_app/app.css?v=stale')).headers()['cache-control']).toBe('no-cache');
});

test.describe('sites without index.html', () => {
  const files = (list) => Object.fromEntries(list.flatMap(([p, html], i) => [[`p${i}`, p], [`f${i}`, { name: p.split('/').pop(), mimeType: 'text/html', buffer: Buffer.from(html) }]]));
  async function publish(request, name, list) {
    const { apiToken } = require('./helpers');
    const form = new FormData();
    form.append('name', name);
    form.append('exact', '1');
    for (const [p, html] of list) {
      form.append('p', p);
      form.append('f', new Blob([html], { type: 'text/html' }), p.split('/').pop());
    }
    const res = await request.post('/api/sites', { headers: { Authorization: `Bearer ${await apiToken()}` }, multipart: form });
    expect(res.status(), await res.text()).toBe(200);
  }

  test('the only HTML page of a folder is its start page', async ({ request }) => {
    const name = unique('one');
    await publish(request, name, [['stranka.html', '<h1>Only page</h1>'], ['style.css', 'body{}']]);
    expect(await (await request.get(`/${name}/`)).text()).toContain('Only page');
  });

  test('a root without pages leads to the subfolder with index.html', async ({ request }) => {
    const name = unique('dist');
    await publish(request, name, [['dist/index.html', '<h1>Built</h1>'], ['src/app.txt', 'x'], ['README.md', '# hi']]);
    const res = await request.get(`/${name}/`, { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers().location).toBe(`/${name}/dist/`);
    expect(await (await request.get(`/${name}/`)).text()).toContain('Built');
  });

  test('several pages and no index.html: a list of files', async ({ request }) => {
    const name = unique('many');
    await publish(request, name, [['a.html', 'a'], ['b.html', 'b']]);
    const html = await (await request.get(`/${name}/`, { headers: { 'Accept-Language': 'cs' } })).text();
    expect(html).toContain('nemá úvodní stránku');
    expect(html).toContain('a.html');
  });
});
