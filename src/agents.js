'use strict';

// What AI agents read: /llms.txt (an index of the service for language
// models), Markdown versions of the public pages (/docs.md, and the same
// pages when asked for with "Accept: text/markdown"), /llms-full.txt (all
// of it in one file), an MCP server card under /.well-known and an OpenAPI
// description of the upload API.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const sites = require('./sites');
const { version } = require('../package.json');

const publicDir = path.join(__dirname, '..', 'public');

// Public pages that have a Markdown version: page file → paths.
const PAGES = {
  'docs.html': { md: '/docs.md', title: { cs: 'Návod', en: 'Guide' } },
  'terms.html': { md: '/podminky.md', title: { cs: 'Podmínky použití', en: 'Terms of use' } },
  'privacy.html': { md: '/soukromi.md', title: { cs: 'Zásady ochrany osobních údajů', en: 'Privacy policy' } },
};

const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

// The values the page's script would fill in.
function fillPlaceholders(html, lang = null) {
  const values = {
    'url-example': sites.siteUrl(lang ? (lang === 'en' ? 'site-name' : 'nazev-webu') : '{name}'),
    'api-example': `${config.PUBLIC_URL}/api/sites`,
    'mcp-url': `${config.PUBLIC_URL}/mcp`,
    'max-upload': `${config.MAX_UPLOAD_MB} MB`,
    'site-max': `${config.SITE_MAX_MB} MB`,
    'account-max': `${config.ACCOUNT_MAX_MB} MB`,
  };
  return html.replace(/<(span|code|b) class="([\w-]+)">[^<]*<\/\1>/g, (match, tag, cls) =>
    cls in values ? `<${tag}${lang ? ` class="${cls}"` : ''}>${values[cls]}</${tag}>` : match,
  );
}

const absolute = (href) => (href.startsWith('/') ? config.PUBLIC_URL + href : href);

// Turns the simple HTML of the guide and the legal pages into Markdown.
function toMarkdown(html) {
  const blocks = [];
  const keep = (text) => `\u0000${blocks.push(text) - 1}\u0000`;
  let s = fillPlaceholders(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/g, (_, code) => keep(`\n\n\`\`\`\n${decode(code.replace(/<[^>]+>/g, '')).trim()}\n\`\`\`\n\n`));
  s = s
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/g, (_, c) => keep(`\`${decode(c.replace(/<[^>]+>/g, ''))}\``))
    .replace(/<(b|strong)>([\s\S]*?)<\/\1>/g, '**$2**')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, (_, href, text) => `[${text}](${absolute(decode(href))})`)
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/g, '\n\n# $1\n\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/g, '\n\n## $1\n\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/g, '\n\n### $1\n\n')
    .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/g, (_, items) => {
      let n = 0;
      return `\n\n${items.replace(/<li[^>]*>([\s\S]*?)<\/li>/g, (__, li) => `\n${++n}. ${li.trim()}`)}\n\n`;
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/g, (_, li) => `\n- ${li.trim()}`)
    .replace(/<\/?(ul|p|div|section)[^>]*>/g, '\n\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '');
  s = decode(s)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)])
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^((?:- |\d+\. ).*)\n\n(?=- |\d+\. )/gm, '$1\n') // tight lists
    .trim();
  return `${s}\n`;
}

// The part of a page in one language (pages hold both, one is hidden).
function pageMarkdown(name, lang) {
  const html = fs.readFileSync(path.join(publicDir, name), 'utf8');
  const start = html.indexOf(`data-lang="${lang}"`);
  if (start < 0) return null;
  const from = html.lastIndexOf('<div', start);
  const next = html.indexOf('<div class="page" data-lang=', start + 10);
  const end = next > 0 ? next : html.indexOf('</main>');
  return toMarkdown(html.slice(from, end));
}

function homeMarkdown(lang) {
  const example = sites.siteUrl(lang === 'en' ? 'my-site' : 'muj-web');
  if (lang === 'en') {
    return `# Freepages – publish a website for free in one drop

Freepages publishes static websites. Drop a folder (or a .zip) with HTML, CSS, JavaScript and images, and seconds later it runs at its own address, such as ${example}, with HTTPS.

- Publishing: ${config.PUBLIC_URL}/ (drag and drop in the browser)
- Guide: ${config.PUBLIC_URL}/docs.md
- Limits: ${config.SITE_MAX_MB} MB per site, ${config.ACCOUNT_MAX_MB} MB per account
- For agents: an MCP server at ${config.PUBLIC_URL}/mcp and an HTTP API at ${config.PUBLIC_URL}/api/sites (see ${config.PUBLIC_URL}/llms.txt)
- Terms: ${config.PUBLIC_URL}/podminky.md?lang=en · Privacy: ${config.PUBLIC_URL}/soukromi.md?lang=en
`;
  }
  return `# Freepages – zveřejněte web zdarma jedním přetažením

Freepages zveřejňuje statické weby. Přetáhněte složku (nebo .zip) s HTML, CSS, JavaScriptem a obrázky a za pár sekund web běží na vlastní adrese, například ${example}, s HTTPS.

- Zveřejnění: ${config.PUBLIC_URL}/ (přetažením v prohlížeči)
- Návod: ${config.PUBLIC_URL}/docs.md
- Limity: ${config.SITE_MAX_MB} MB na web, ${config.ACCOUNT_MAX_MB} MB na účet
- Pro agenty: MCP server na ${config.PUBLIC_URL}/mcp a HTTP API na ${config.PUBLIC_URL}/api/sites (viz ${config.PUBLIC_URL}/llms.txt)
- Podmínky: ${config.PUBLIC_URL}/podminky.md · Soukromí: ${config.PUBLIC_URL}/soukromi.md
`;
}

/** Markdown of a public page (index.html, docs.html, …) in `lang`, or null. */
function markdown(name, lang) {
  if (name === 'index.html') return homeMarkdown(lang);
  return PAGES[name] ? pageMarkdown(name, lang) : null;
}

// Where the Markdown version of a page lives.
function markdownPath(name) {
  if (name === 'index.html') return '/index.md';
  return PAGES[name]?.md || null;
}

function llmsTxt() {
  const u = config.PUBLIC_URL;
  return `# Freepages

> Free hosting for static websites. A folder of HTML, CSS, JavaScript and images becomes a public website at its own address (${sites.siteUrl('{name}')}) in seconds. AI agents can publish and manage sites for a user through the MCP server or the HTTP API, signed in with the user's API key.

Each site is a set of static files; index.html is the home page, addresses work without .html, and 404.html is the error page. Limits: ${config.SITE_MAX_MB} MB per site, ${config.ACCOUNT_MAX_MB} MB per account. Sites are public; uploading illegal content, phishing or malware is forbidden by the terms. The service and its pages are in Czech and English; add ?lang=en to any link below for English.

## For agents

- [MCP server](${u}/mcp): Streamable HTTP endpoint. Tools: list_sites, list_files, read_file, publish_site, create_preview, rename_site, delete_site, get_visits. Sign-in: OAuth 2.1 with PKCE and dynamic client registration (${u}/.well-known/oauth-authorization-server); the user enters an e-mail and confirms by a link, which also creates an account when needed. Alternatively "Authorization: Bearer <API key>" with a key from ${u}/ucet#api-klice.
- [MCP server card](${u}/.well-known/mcp/server-card.json): how to connect, in JSON.
- [HTTP API (OpenAPI)](${u}/openapi.json): publish with a multipart POST to ${u}/api/sites, same API key.
- [Guide: API keys, curl and MCP](${u}/docs.md?lang=en): examples for the command line and for MCP clients.

## Docs

- [Guide](${u}/docs.md?lang=en): how to publish, what the folder should contain, editing, previews, name rules and limits.
- [Home page](${u}/index.md?lang=en): what Freepages is.

## Optional

- [Terms of use](${u}/podminky.md?lang=en)
- [Privacy policy](${u}/soukromi.md?lang=en)
- [Everything in one file](${u}/llms-full.txt)
`;
}

function llmsFullTxt() {
  return [llmsTxt(), markdown('index.html', 'en'), markdown('docs.html', 'en'), markdown('terms.html', 'en'), markdown('privacy.html', 'en')].join('\n---\n\n');
}

function serverCard() {
  return {
    version: '1.0',
    protocolVersion: '2025-06-18',
    serverInfo: { name: 'freepages', title: 'Freepages', version },
    description: 'Publish and manage static websites on Freepages.',
    documentationUrl: `${config.PUBLIC_URL}/docs.md?lang=en`,
    transport: { type: 'streamable-http', endpoint: `${config.PUBLIC_URL}/mcp` },
    authentication: {
      required: true,
      schemes: ['oauth2', 'bearer'],
      authorizationServer: config.PUBLIC_URL,
      protectedResourceMetadata: `${config.PUBLIC_URL}/.well-known/oauth-protected-resource`,
      description: `OAuth 2.1 sign-in (the user confirms by e-mail), or an API key from ${config.PUBLIC_URL}/ucet#api-klice sent as "Authorization: Bearer <key>".`,
    },
    capabilities: { tools: { listChanged: false } },
    tools: require('./mcp').TOOLS.map(({ name, title, description }) => ({ name, title, description })),
  };
}

function openApi() {
  const error = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  const nameParam = { name: 'name', in: 'path', required: true, schema: { type: 'string' }, description: 'Site name' };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Freepages API',
      version,
      description: `Publish static websites. Authenticate with an API key from ${config.PUBLIC_URL}/ucet#api-klice ("Authorization: Bearer <key>"). For AI agents the MCP server at ${config.PUBLIC_URL}/mcp is usually easier.`,
    },
    servers: [{ url: `${config.PUBLIC_URL}/api` }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'API key from the account page' } },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' } } },
        Site: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            url: { type: 'string', format: 'uri' },
            files: { type: 'integer' },
            bytes: { type: 'integer' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    paths: {
      '/sites': {
        post: {
          summary: 'Publish or update a site',
          description: 'Multipart upload. Send one .zip (it is extracted), or several files as pairs: a "p" field with the path, then an "f" file.',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Site name (lowercase letters, digits, hyphens). A taken name gets a suffix unless overwrite=1.' },
                    overwrite: { type: 'string', enum: ['1'], description: 'Replace your existing site of that name.' },
                    preview: { type: 'string', enum: ['1'], description: `Create a ${config.PREVIEW_MINUTES}-minute preview instead.` },
                    p: { type: 'string', description: 'Path of the next file, e.g. css/style.css' },
                    f: { type: 'string', format: 'binary', description: 'A file, or a single .zip' },
                  },
                  required: ['f'],
                },
              },
            },
          },
          responses: { 200: { description: 'Published', content: { 'application/json': { schema: { $ref: '#/components/schemas/Site' } } } }, 400: error, 403: error, 413: error },
        },
      },
      '/me': {
        get: {
          summary: 'The account, its sites and storage use',
          responses: { 200: { description: 'Account', content: { 'application/json': { schema: { type: 'object', properties: { sites: { type: 'array', items: { $ref: '#/components/schemas/Site' } } } } } } }, 401: error },
        },
      },
      '/sites/{name}/files': {
        post: { summary: 'List the files of a site', parameters: [nameParam], responses: { 200: { description: 'Files' }, 403: error, 404: error } },
      },
      '/sites/{name}/rename': {
        post: {
          summary: 'Rename a site',
          parameters: [nameParam],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } } },
          responses: { 200: { description: 'Renamed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Site' } } } }, 400: error, 403: error },
        },
      },
      '/sites/{name}/delete': {
        post: { summary: 'Delete a site', parameters: [nameParam], responses: { 200: { description: 'Deleted' }, 403: error, 404: error } },
      },
      '/me/stats': {
        get: {
          summary: 'Page views',
          parameters: [
            { name: 'range', in: 'query', schema: { type: 'string', enum: ['24h', '7d', '30d'] } },
            { name: 'site', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Views per hour or day' }, 401: error },
        },
      },
    },
  };
}

module.exports = { fillPlaceholders, markdown, markdownPath, llmsTxt, llmsFullTxt, serverCard, openApi, toMarkdown };
