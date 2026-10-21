// @ts-check
const { test, expect, request: playwrightRequest } = require('@playwright/test');
const { HEADERS, unique, createAccount } = require('./helpers');

const BASE = 'http://localhost:4317';

// A fresh account with an API token, and a function that calls the MCP server with it.
async function mcpClient() {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE });
  await createAccount(ctx);
  const { token } = await (await ctx.post('/api/me/tokens', { headers: HEADERS, data: { name: 'mcp' } })).json();
  await ctx.dispose();
  const client = await playwrightRequest.newContext({ baseURL: BASE });
  let id = 0;
  const rpc = async (method, params) => {
    const res = await client.post('/mcp', { headers: { Authorization: `Bearer ${token}` }, data: { jsonrpc: '2.0', id: ++id, method, params } });
    expect(res.status()).toBe(200);
    return res.json();
  };
  const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  return { rpc, call, client, token };
}

test('MCP: initialize and list tools', async () => {
  const { rpc, client, token } = await mcpClient();
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  expect(init.result.protocolVersion).toBe('2025-06-18');
  expect(init.result.serverInfo.name).toBe('freepages');
  expect(init.result.capabilities.tools).toBeTruthy();

  const note = await client.post('/mcp', { headers: { Authorization: `Bearer ${token}` }, data: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  expect(note.status()).toBe(202);

  const { result } = await rpc('tools/list', {});
  expect(result.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(['list_sites', 'list_files', 'read_file', 'publish_site', 'create_preview', 'rename_site', 'delete_site', 'get_visits']),
  );
  expect((await rpc('nope', {})).error.code).toBe(-32601);
});

test('MCP: publish, read, update, rename and delete a site', async ({ request }) => {
  const { call } = await mcpClient();
  const name = unique('mcp');
  const files = [
    { path: 'index.html', content: '<h1>From MCP</h1>' },
    { path: 'css/style.css', content: 'h1 { color: teal }' },
    { path: 'img/dot.gif', content: 'R0lGODlhAQABAAAAACw=', encoding: 'base64' },
  ];
  const published = await call('publish_site', { name, files });
  expect(published.isError).toBe(false);
  expect(published.structuredContent.name).toBe(name);
  expect(await (await request.get(`/${name}/`)).text()).toContain('From MCP');

  const again = await call('publish_site', { name, files });
  expect(again.isError).toBe(true);
  expect(again.content[0].text).toContain('replace=true');

  const list = await call('list_sites');
  expect(list.structuredContent.sites.map((s) => s.name)).toContain(name);
  expect((await call('list_files', { site: name })).structuredContent.files.map((f) => f.path)).toEqual(['css/style.css', 'img/dot.gif', 'index.html']);
  expect((await call('read_file', { site: name, path: 'css/style.css' })).content[0].text).toBe('h1 { color: teal }');
  expect((await call('read_file', { site: name, path: 'img/dot.gif' })).content[0].text).toContain('binary');

  // Only index.html changes; the other files stay.
  const updated = await call('publish_site', { name, replace: true, keep_other_files: true, files: [{ path: 'index.html', content: '<h1>Updated</h1>' }] });
  expect(updated.content[0].text).toContain('Updated');
  expect(await (await request.get(`/${name}/`)).text()).toContain('Updated');
  expect((await request.get(`/${name}/css/style.css`)).status()).toBe(200);

  // Without keep_other_files the site is exactly the given files.
  await call('publish_site', { name, replace: true, files: [{ path: 'index.html', content: '<h1>Only</h1>' }] });
  expect((await request.get(`/${name}/css/style.css`)).status()).toBe(404);

  const renamed = unique('mcp');
  expect((await call('rename_site', { site: name, new_name: renamed })).structuredContent.name).toBe(renamed);
  expect((await call('get_visits', { site: renamed, range: '24h' })).structuredContent.unit).toBe('hour');

  expect((await call('delete_site', { site: renamed })).isError).toBe(false);
  expect((await request.get(`/${renamed}/`)).status()).toBe(404);
});

test('MCP: a preview, and no access to sites of other accounts', async ({ request }) => {
  const owner = await mcpClient();
  const other = await mcpClient();
  const name = unique('mcp');
  await owner.call('publish_site', { name, files: [{ path: 'index.html', content: '<h1>Mine</h1>' }] });

  for (const [tool, args] of [['read_file', { site: name, path: 'index.html' }], ['delete_site', { site: name }], ['rename_site', { site: name, new_name: unique('x') }]]) {
    const result = await other.call(tool, args);
    expect(result.isError, tool).toBe(true);
  }
  const replace = await other.call('publish_site', { name, replace: true, files: [{ path: 'index.html', content: 'x' }] });
  expect(replace.isError).toBe(true);
  expect(await (await request.get(`/${name}/`)).text()).toContain('Mine');

  const preview = await owner.call('create_preview', { files: [{ path: 'index.html', content: '<h1>Preview</h1>' }] });
  expect(preview.structuredContent.url).toContain('preview-');
});

test('MCP: requires an API token and refuses foreign browser origins', async ({ request }) => {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const none = await request.post('/mcp', { data: body });
  expect(none.status()).toBe(401);
  expect(none.headers()['www-authenticate']).toContain('Bearer');
  expect((await request.post('/mcp', { headers: { Authorization: 'Bearer nope' }, data: body })).status()).toBe(401);

  const { token } = await mcpClient();
  const foreign = await request.post('/mcp', { headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' }, data: body });
  expect(foreign.status()).toBe(403);
  expect((await request.get('/mcp')).status()).toBe(405);
});

test('the account page links to the guide for API keys', async ({ page }) => {
  const { signIn } = require('./helpers');
  await signIn(page);
  await page.goto('/ucet#api-klice');
  await expect(page.locator('#api-klice h2')).toHaveText('API klíče');
  await expect(page.locator('#cli-how')).toHaveAttribute('href', '/docs#cs-api-klice');
  await page.goto('/docs');
  await expect(page.locator('#cs-api-klice')).toHaveText('API klíče');
  await expect(page.locator('[data-lang=cs] .mcp-url').first()).toHaveText('http://localhost:4317/mcp');
});
