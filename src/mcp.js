'use strict';

// MCP server (Model Context Protocol, Streamable HTTP transport) at /mcp.
// AI assistants connect with an API key from the account page, sent as
// "Authorization: Bearer <token>", and can then list, read, publish, rename
// and delete the account's sites and read their visit statistics. The
// server is stateless: every POST carries one JSON-RPC message (or a batch)
// and gets a JSON answer.
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const accounts = require('./accounts');
const sites = require('./sites');
const stats = require('./stats');
const { langOf, t } = require('./i18n');
const { clientIp } = require('./auth');
const { version } = require('../package.json');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const READ_LIMIT = 1024 * 1024; // read_file returns at most 1 MB of text

// What agents must know before publishing an app made with a framework.
const BUILD_NOTE = [
  'Only static files are served (HTML, CSS, JavaScript, images, fonts); there is no server-side code, PHP, Node.js or database.',
  'Apps made with a framework or build tool (React, Vue, Svelte/SvelteKit, Angular, Astro, Next.js, Nuxt, Vite, Hugo, Jekyll, …) can be published too:',
  "build them first (e.g. npm run build; SvelteKit with adapter-static, Next.js with output: 'export', Nuxt with nuxi generate)",
  'and upload only the build output folder (dist/, build/, out/ or .output/public/) with index.html at its root, never the source code or node_modules.',
  'Single-page apps should use hash routing or prerendered pages, because unknown paths return 404.html.',
].join(' ');

const fileSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Path inside the site, e.g. "index.html" or "css/style.css".' },
    content: { type: 'string', description: 'File content: text, or base64 when encoding is "base64".' },
    encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
  },
  required: ['path', 'content'],
};

const TOOLS = [
  {
    name: 'list_sites',
    title: 'List sites',
    description: 'Lists the sites of the account (newest change first, 100 at a time) with their addresses, size and last update, and the storage used. Use search to find sites by name and cursor to get the next page.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Part of a site name.' },
        cursor: { type: 'string', description: 'nextCursor from the previous call.' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_files',
    title: 'List files of a site',
    description: 'Lists all files of one site with their sizes.',
    inputSchema: { type: 'object', properties: { site: { type: 'string', description: 'Site name.' } }, required: ['site'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_file',
    title: 'Read a file',
    description: 'Returns the content of a text file of a site (up to 1 MB).',
    inputSchema: {
      type: 'object',
      properties: { site: { type: 'string', description: 'Site name.' }, path: { type: 'string', description: 'Path of the file inside the site.' } },
      required: ['site', 'path'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'publish_site',
    title: 'Publish a site',
    description:
      'Publishes a static website from the given files and returns its address. Creates a new site, or with replace=true updates an existing site of the account. ' +
      'With replace=true and keep_other_files=true, only the given files are added or overwritten and the rest of the site stays. ' +
      'Paths are relative to the site root; index.html is the home page. Text files go as plain text, images and other binary files as base64. ' +
      BUILD_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Site name: lowercase letters, digits and hyphens. It becomes part of the address.' },
        files: { type: 'array', items: fileSchema, minItems: 1 },
        replace: { type: 'boolean', default: false, description: 'Update the site if it already exists in the account.' },
        keep_other_files: { type: 'boolean', default: false, description: 'When updating, keep files that are not in "files".' },
      },
      required: ['name', 'files'],
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  {
    name: 'create_preview',
    title: 'Create a preview',
    description: `Publishes the files to a temporary preview address that expires after ${config.PREVIEW_MINUTES} minutes. Nothing is changed on the account's sites.`,
    inputSchema: { type: 'object', properties: { files: { type: 'array', items: fileSchema, minItems: 1 } }, required: ['files'] },
  },
  {
    name: 'rename_site',
    title: 'Rename a site',
    description: 'Gives a site a new name; its address changes accordingly.',
    inputSchema: {
      type: 'object',
      properties: { site: { type: 'string', description: 'Current name.' }, new_name: { type: 'string', description: 'New name.' } },
      required: ['site', 'new_name'],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'delete_site',
    title: 'Delete a site',
    description: `Takes a site offline. Its data is deleted permanently after ${config.RETENTION_DAYS} days.`,
    inputSchema: { type: 'object', properties: { site: { type: 'string', description: 'Site name.' } }, required: ['site'] },
    annotations: { destructiveHint: true },
  },
  {
    name: 'get_visits',
    title: 'Get visit statistics',
    description: 'Page views of all sites of the account, or of one, per hour (24h, 7d) or per day (30d).',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site name; leave out for all sites.' },
        range: { type: 'string', enum: ['24h', '7d', '30d'], default: '7d' },
      },
    },
    annotations: { readOnlyHint: true },
  },
];

class ToolError extends Error {}

function ownSite(user, name) {
  const site = sites.activeSite(String(name || ''));
  if (!site || site.user_id !== user.id) throw new ToolError(`The account has no site named "${name}".`);
  return site;
}

function assertCanEdit(user) {
  if (accounts.isBlocked(user)) throw new sites.UserError('uploadsBlocked', 403);
}

async function publish(user, args, ip) {
  assertCanEdit(user);
  const name = sites.slugify(args.name);
  const existing = sites.activeSite(name);
  if (existing && !args.replace) {
    if (existing.user_id === user.id) throw new ToolError(`The site "${name}" already exists. Call publish_site again with replace=true to update it.`);
  }
  let keep = [];
  if (existing && args.replace && existing.user_id === user.id && args.keep_other_files) {
    const given = new Set((args.files || []).map((f) => String(f.path || '').replace(/^\/+/, '')));
    keep = (await sites.listFiles(existing)).filter((f) => !given.has(f.path)).map((f) => ({ path: f.path, from: f.path }));
  }
  const upload = await sites.uploadFromFiles(args.files, { name, keep });
  try {
    const base = keep.length ? sites.siteDir(existing.name) : null;
    const { dir, requested } = await sites.assemble(upload, { baseDir: base });
    if (existing && args.replace) {
      if (existing.user_id !== user.id) throw new ToolError(`The name "${name}" belongs to someone else. Choose another name.`);
      return await sites.replaceSite(existing, dir, { userId: user.id, ip });
    }
    return await sites.createSite({ requested, dir, userId: user.id, ip }); // await: the cleanup below must wait
  } finally {
    await upload.cleanup();
  }
}

async function preview(user, args, ip) {
  const upload = await sites.uploadFromFiles(args.files);
  try {
    const { dir } = await sites.assemble(upload);
    return await sites.savePreview(dir, { userId: user.id, ip });
  } finally {
    await upload.cleanup();
  }
}

async function readFile(user, args) {
  const site = ownSite(user, args.site);
  const root = sites.siteDir(site.name);
  const file = path.join(root, ...String(args.path || '').split('/').filter((p) => p && p !== '.'));
  if (!file.startsWith(root + path.sep)) throw new ToolError('Invalid path.');
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new ToolError(`The site "${site.name}" has no file "${args.path}".`);
  if (stat.size > READ_LIMIT) throw new ToolError(`The file has ${stat.size} bytes; read_file returns at most ${READ_LIMIT}.`);
  const data = await fsp.readFile(file);
  if (data.includes(0)) return { text: `"${args.path}" is a binary file (${stat.size} bytes).` };
  return { text: data.toString('utf8') };
}

// Runs a tool; returns [summary text, structured result].
async function callTool(name, args, user, ip) {
  switch (name) {
    case 'list_sites': {
      const page = sites.listPage({ ownerId: user.id, q: args.search || '', cursor: args.cursor || null, limit: 100 });
      const list = page.items.map((s) => ({ name: s.name, url: s.url, files: s.files, bytes: s.bytes, updatedAt: s.updatedAt }));
      const result = { sites: list, total: page.total, nextCursor: page.next, usage: sites.usage(user.id) };
      const more = page.next ? `\n(${page.total} sites in total; call list_sites with cursor "${page.next}" for more.)` : '';
      return [list.length ? list.map((s) => `${s.name}: ${s.url} (${s.files} files, ${s.bytes} bytes)`).join('\n') + more : 'No sites found.', result];
    }
    case 'list_files': {
      const site = ownSite(user, args.site);
      const files = await sites.listFiles(site);
      return [files.map((f) => `${f.path} (${f.size} bytes)`).join('\n'), { site: site.name, files }];
    }
    case 'read_file': {
      const { text } = await readFile(user, args);
      return [text, null];
    }
    case 'publish_site': {
      const result = await publish(user, args, ip);
      const verb = result.replaced ? 'Updated' : 'Published';
      return [`${verb} ${result.name}: ${result.url}${result.requestedName ? ` (the name "${result.requestedName}" was taken)` : ''}`, result];
    }
    case 'create_preview': {
      const result = await preview(user, args, ip);
      return [`Preview: ${result.url} (expires in ${result.minutes} minutes)`, result];
    }
    case 'rename_site': {
      assertCanEdit(user);
      const result = await sites.rename(ownSite(user, args.site), args.new_name, { ip, by: 'owner' });
      return [`Renamed to ${result.name}: ${result.url}`, result];
    }
    case 'delete_site': {
      const site = ownSite(user, args.site);
      await sites.softDelete(site, { by: 'owner', ip });
      return [`Deleted ${site.name}. Its data is deleted permanently after ${config.RETENTION_DAYS} days.`, { ok: true, retentionDays: config.RETENTION_DAYS }];
    }
    case 'get_visits': {
      const scope = args.site ? { siteId: ownSite(user, args.site).id } : { userId: user.id };
      const result = stats.series(scope, ['24h', '7d', '30d'].includes(args.range) ? args.range : '7d');
      const busiest = result.buckets.reduce((best, b) => (b.views > (best?.views ?? 0) ? b : best), null);
      return [`${result.total} page views${busiest ? `, the busiest ${result.unit} ${busiest.t} (${busiest.views})` : ''}.`, result];
    }
    default:
      return null;
  }
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(message, req, user) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(message?.id, -32600, 'Invalid request');
  const { id, method, params = {} } = message;
  if (id === undefined) return null; // a notification: nothing to answer
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'freepages.dev', title: 'freepages.dev', version },
        instructions: `freepages.dev publishes static websites at ${config.PUBLIC_URL}. Each site gets its own address. Use publish_site with the files of a site (index.html is the home page) and give the user the returned url. ${BUILD_NOTE} Signed in as ${user.email}.`,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      if (!TOOLS.some((tool) => tool.name === params.name)) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      try {
        const [text, structured] = await callTool(params.name, params.arguments || {}, user, accounts.normIp(clientIp(req)));
        return reply({ content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}), isError: false });
      } catch (err) {
        if (err instanceof ToolError) return reply({ content: [{ type: 'text', text: err.message }], isError: true });
        if (err instanceof sites.UserError) return reply({ content: [{ type: 'text', text: t(langOf(req), err.key, err.params) }], isError: true });
        console.error(err);
        return reply({ content: [{ type: 'text', text: 'Server error.' }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

function unauthorized(res, message) {
  // Points MCP clients to OAuth sign-in (see oauth.js).
  res.set('WWW-Authenticate', `Bearer realm="freepages.dev", resource_metadata="${config.PUBLIC_URL}/.well-known/oauth-protected-resource"`);
  res.status(401).json(rpcError(null, -32001, message));
}

async function endpoint(req, res) {
  // Browsers may only call this from the publisher itself (DNS rebinding).
  const origin = req.headers.origin;
  if (origin && origin !== new URL(config.PUBLIC_URL).origin) return res.status(403).json(rpcError(null, -32000, 'Origin not allowed'));
  if (!String(req.headers.authorization || '').startsWith('Bearer ')) {
    return unauthorized(res, `Send an API key as "Authorization: Bearer <key>". Create one at ${config.PUBLIC_URL}/ucet#api-klice.`);
  }
  const user = accounts.currentUser(req);
  if (!user) return unauthorized(res, 'Invalid or revoked API key.');

  const body = req.body;
  const batch = Array.isArray(body);
  const messages = batch ? body : [body];
  if (!messages.length) return res.status(400).json(rpcError(null, -32600, 'Invalid request'));
  const replies = (await Promise.all(messages.map((m) => handle(m, req, user)))).filter(Boolean);
  if (!replies.length) return res.status(202).end(); // only notifications or responses
  res.json(batch ? replies : replies[0]);
}

function mount(app, express) {
  // Base64 makes files about a third bigger than the upload limit counts them.
  const limit = `${Math.ceil(config.MAX_UPLOAD_MB * 1.4) + 1}mb`;
  app.post('/mcp', express.json({ limit }), endpoint);
  app.all('/mcp', (req, res) => res.set('Allow', 'POST').status(405).json(rpcError(null, -32000, 'Method not allowed: this server answers POST requests only.')));
}

module.exports = { mount, TOOLS, BUILD_NOTE };
