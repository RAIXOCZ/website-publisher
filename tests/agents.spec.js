// @ts-check
const { test, expect } = require('./test');

test('llms.txt points agents to the MCP server, the API and Markdown pages', async ({ request }) => {
  const res = await request.get('/llms.txt');
  expect(res.headers()['content-type']).toContain('text/plain');
  const text = await res.text();
  expect(text).toMatch(/^# freepages\.dev\n\n> /);
  for (const link of ['/mcp', '/openapi.json', '/docs.md?lang=en', '/.well-known/mcp/server-card.json', '/llms-full.txt']) expect(text).toContain(`http://localhost:4317${link}`);
  const full = await (await request.get('/llms-full.txt')).text();
  expect(full).toContain('## API keys');
  expect(full).toContain('# Terms of use');
});

test('public pages exist as Markdown, by .md address or by the Accept header', async ({ request }) => {
  const md = await request.get('/docs.md?lang=cs');
  expect(md.headers()['content-type']).toContain('text/markdown');
  const text = await md.text();
  expect(text).toMatch(/^# Návod/);
  expect(text).toContain('## API klíče');
  expect(text).toContain('claude mcp add --transport http freepages.dev http://localhost:4317/mcp');
  expect(text).not.toMatch(/<[a-z]+[ >]/); // no HTML left
  expect(await (await request.get('/podminky.md?lang=en')).text()).toMatch(/^# Terms of use/);
  expect(await (await request.get('/soukromi.md?lang=cs')).text()).toMatch(/^# Zásady ochrany osobních údajů/);
  expect(await (await request.get('/index.md?lang=en')).text()).toContain('MCP server at http://localhost:4317/mcp');

  const negotiated = await request.get('/docs?lang=en', { headers: { Accept: 'text/markdown' } });
  expect(negotiated.headers()['content-type']).toContain('text/markdown');
  expect(negotiated.headers()['vary']).toContain('Accept');
  expect(await negotiated.text()).toMatch(/^# Guide/);

  const html = await request.get('/docs?lang=en');
  expect(html.headers()['content-type']).toContain('text/html');
  expect(html.headers()['link']).toContain('</docs.md?lang=en>; rel="alternate"; type="text/markdown"');
  expect(await html.text()).toContain('<link rel="alternate" type="text/markdown" href="/docs.md?lang=en">');
  // Private pages have no Markdown version.
  expect((await request.get('/ucet', { headers: { Accept: 'text/markdown' } })).headers()['content-type']).toContain('text/html');
});

test('the MCP server card and the OpenAPI description', async ({ request }) => {
  const card = await (await request.get('/.well-known/mcp/server-card.json')).json();
  expect(card.transport.endpoint).toBe('http://localhost:4317/mcp');
  expect(card.tools.map((tool) => tool.name)).toContain('publish_site');
  const api = await (await request.get('/openapi.json')).json();
  expect(api.openapi).toBe('3.1.0');
  expect(api.paths['/sites'].post).toBeTruthy();
});
