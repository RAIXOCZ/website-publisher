'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const Busboy = require('busboy');
const yauzl = require('yauzl');
const config = require('./config');

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED = new Set([
  'admin', 'api', 'app', 'docs', 'www', 'static', 'assets', 'login', 'logout',
  'mail', 'ftp', 'dashboard', 'favicon.ico', 'robots.txt',
]);
// Files that operating systems sprinkle into folders and nobody wants published.
const JUNK = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '__macosx', '.git']);

// An expected problem to report to the user. `key` refers to a message in
// i18n.js and is translated when the response is sent.
class UserError extends Error {
  constructor(key, status = 400, extra = {}, params = {}) {
    super(key);
    this.key = key;
    this.status = status;
    this.extra = extra;
    this.params = params;
  }
}

async function init() {
  await fsp.mkdir(config.SITES_DIR, { recursive: true });
  await fsp.mkdir(config.META_DIR, { recursive: true });
  await fsp.rm(config.TMP_DIR, { recursive: true, force: true });
  await fsp.mkdir(config.TMP_DIR, { recursive: true });
}

function slugify(input) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.zip$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

function validateName(name) {
  if (!name) return 'nameMissing';
  if (!NAME_RE.test(name)) return 'nameInvalid';
  if (RESERVED.has(name) || `${name}.${config.SITE_DOMAIN}` === config.APP_HOSTNAME) {
    return 'nameReserved';
  }
  return null;
}

function siteDir(name) {
  return path.join(config.SITES_DIR, name);
}

function siteUrl(name) {
  if (config.SITE_DOMAIN) return `${config.SCHEME}://${name}.${config.SITE_DOMAIN}/`;
  return `${config.PUBLIC_URL}/${name}/`;
}

async function exists(name) {
  try {
    return (await fsp.stat(siteDir(name))).isDirectory();
  } catch {
    return false;
  }
}

async function readMeta(name) {
  try {
    return JSON.parse(await fsp.readFile(path.join(config.META_DIR, `${name}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function writeMeta(name, meta) {
  const file = path.join(config.META_DIR, `${name}.json`);
  await fsp.writeFile(`${file}.tmp`, JSON.stringify(meta, null, 2));
  await fsp.rename(`${file}.tmp`, file);
}

async function list() {
  const entries = await fsp.readdir(config.SITES_DIR, { withFileTypes: true });
  const sites = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !NAME_RE.test(entry.name)) continue;
    sites.push(publicMeta(entry.name, (await readMeta(entry.name)) || {}));
  }
  sites.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return sites;
}

// Turns a client-supplied relative path into safe path segments, or null if
// the file should be skipped.
function cleanPath(raw) {
  const parts = String(raw || '').replace(/\\/g, '/').split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..' || part.includes('\0')) throw new UserError('invalidPath', 400, {}, { path: raw });
    if (JUNK.has(part.toLowerCase()) || part.startsWith('._')) return null;
    out.push(part);
  }
  return out.length ? out : null;
}

class Budget {
  constructor() {
    this.files = 0;
    this.bytes = 0;
    this.maxBytes = config.MAX_UPLOAD_MB * 1024 * 1024;
  }

  addFile() {
    if (++this.files > config.MAX_FILES) throw new UserError('tooManyFiles', 413, {}, { limit: config.MAX_FILES });
  }

  addBytes(n) {
    this.bytes += n;
    if (this.bytes > this.maxBytes) throw new UserError('tooLarge', 413, {}, { limit: config.MAX_UPLOAD_MB });
  }
}

// Stream that counts bytes against the budget and aborts when it is exceeded.
function counter(budget) {
  const { Transform } = require('stream');
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        budget.addBytes(chunk.length);
        cb(null, chunk);
      } catch (err) {
        cb(err);
      }
    },
  });
}

async function writeFile(root, segments, source, budget) {
  budget.addFile();
  const target = path.join(root, ...segments);
  if (!target.startsWith(root + path.sep)) throw new UserError('invalidPath', 400, {}, { path: segments.join('/') });
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await pipeline(source, counter(budget), fs.createWriteStream(target));
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, decodeStrings: true }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

async function extractZip(zipFile, root, budget) {
  let zip;
  try {
    zip = await openZip(zipFile);
  } catch {
    throw new UserError('zipUnreadable');
  }
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        const handle = async () => {
          if (/\/$/.test(entry.fileName)) return;
          const segments = cleanPath(entry.fileName);
          if (!segments) return;
          const stream = await new Promise((res, rej) =>
            zip.openReadStream(entry, (err, s) => (err ? rej(err) : res(s))),
          );
          await writeFile(root, segments, stream, budget);
        };
        handle().then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError('zipFailed', 400, {}, { reason: err.message });
  } finally {
    zip.close();
  }
}

// If everything sits inside a single top-level folder (the usual case when
// you drop "my-site/"), publish the contents of that folder instead.
async function unwrapSingleFolder(root) {
  let dir = root;
  let wrapper = null;
  for (;;) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) break;
    wrapper = wrapper || entries[0].name;
    dir = path.join(dir, entries[0].name);
  }
  return { dir, wrapper };
}

async function stats(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    files++;
    bytes += (await fsp.stat(path.join(entry.parentPath ?? entry.path, entry.name))).size;
  }
  return { files, bytes };
}

const busy = new Set();

/* ---------- per-site passwords ---------- */

// Passwords are generated by the server (~60 random bits), so a fast salted
// hash is enough; there is nothing to gain from a slow KDF here.
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function generatePassword() {
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
  return chars.match(/.{4}/g).join('-');
}

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

function passwordFields(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, passwordHash: hashPassword(password, salt) };
}

async function checkSitePassword(name, password) {
  if (!password || validateName(name)) return false;
  const meta = await readMeta(name);
  if (!meta?.passwordHash || !meta.salt) return false;
  const expected = Buffer.from(meta.passwordHash, 'hex');
  const actual = Buffer.from(hashPassword(String(password).trim().toLowerCase(), meta.salt), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function resetPassword(name) {
  if (validateName(name) || !(await exists(name))) throw new UserError('siteNotFound', 404);
  const password = generatePassword();
  const meta = (await readMeta(name)) || { name };
  await writeMeta(name, { ...meta, ...passwordFields(password) });
  return password;
}

// Public view of a site: never includes the password hash.
function publicMeta(name, meta = {}) {
  return {
    name,
    url: siteUrl(name),
    files: meta.files ?? null,
    bytes: meta.bytes ?? null,
    createdAt: meta.createdAt ?? null,
    updatedAt: meta.updatedAt ?? null,
    hasPassword: Boolean(meta.passwordHash),
  };
}

async function info(name) {
  if (validateName(name) || !(await exists(name))) return null;
  return publicMeta(name, (await readMeta(name)) || {});
}

// Swap the freshly uploaded directory into place. Visitors see either the old
// or the new version, never a half-written one.
async function publish(name, sourceDir, extraMeta = {}) {
  const target = siteDir(name);
  const previous = await readMeta(name);
  const old = path.join(config.TMP_DIR, `old-${crypto.randomUUID()}`);
  const replaced = await exists(name);
  if (replaced) await fsp.rename(target, old);
  await fsp.rename(sourceDir, target);
  if (replaced) fsp.rm(old, { recursive: true, force: true }).catch(() => {});

  const now = new Date().toISOString();
  const meta = {
    ...(replaced ? previous : {}),
    name,
    createdAt: (replaced && previous?.createdAt) || now,
    updatedAt: now,
    ...(await stats(target)),
    ...extraMeta,
  };
  await writeMeta(name, meta);
  return { ...publicMeta(name, meta), replaced };
}

/**
 * Handles a multipart upload. The client sends, in order:
 *   name      – desired site name (optional, falls back to the folder name)
 *   overwrite – "1" to replace an existing site
 *   password  – that site's password (not needed for the admin)
 *   then pairs of  p (relative path)  +  f (file)
 * A single uploaded .zip is extracted. A new site gets a generated password,
 * returned once in the response.
 */
async function handleUpload(req, { isAdmin, onWrongPassword }) {
  const work = path.join(config.TMP_DIR, `up-${crypto.randomUUID()}`);
  const raw = path.join(work, 'raw');
  await fsp.mkdir(raw, { recursive: true });
  const budget = new Budget();
  const fields = { name: '', overwrite: false, password: '' };
  const uploaded = [];

  try {
    await new Promise((resolve, reject) => {
      let bb;
      try {
        bb = Busboy({
          headers: req.headers,
          limits: { files: config.MAX_FILES, fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, fields: config.MAX_FILES + 10 },
        });
      } catch {
        return reject(new UserError('expectedUpload'));
      }
      const writes = [];
      let pendingPath = null;
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        req.unpipe(bb);
        req.resume();
        reject(err);
      };

      bb.on('field', (field, value) => {
        if (field === 'name') fields.name = value;
        else if (field === 'overwrite') fields.overwrite = value === '1' || value === 'true';
        else if (field === 'password') fields.password = value;
        else if (field === 'p') pendingPath = value;
      });
      bb.on('file', (_field, stream, info) => {
        const relPath = pendingPath || info.filename;
        pendingPath = null;
        let segments;
        try {
          segments = cleanPath(relPath);
        } catch (err) {
          stream.resume();
          return fail(err);
        }
        if (!segments || failed) return stream.resume();
        uploaded.push(segments);
        stream.on('limit', () => fail(new UserError('tooLarge', 413, {}, { limit: config.MAX_UPLOAD_MB })));
        writes.push(writeFile(raw, segments, stream, budget).catch(fail));
      });
      bb.on('filesLimit', () => fail(new UserError('tooManyFiles', 413, {}, { limit: config.MAX_FILES })));
      bb.on('error', (err) => fail(new UserError('uploadFailed', 400, {}, { reason: err.message })));
      bb.on('close', () => Promise.all(writes).then(() => !failed && resolve(), fail));
      req.on('aborted', () => fail(new UserError('uploadAborted')));
      req.pipe(bb);
    });

    if (!uploaded.length) throw new UserError('noFiles');

    let content = raw;
    let fallbackName = uploaded[0].length > 1 ? uploaded[0][0] : '';
    if (uploaded.length === 1 && /\.zip$/i.test(uploaded[0].at(-1))) {
      fallbackName = uploaded[0].at(-1);
      content = path.join(work, 'zip');
      await fsp.mkdir(content);
      await extractZip(path.join(raw, ...uploaded[0]), content, new Budget());
    }

    const { dir, wrapper } = await unwrapSingleFolder(content);
    const name = slugify(fields.name || fallbackName || wrapper) || `site-${crypto.randomBytes(3).toString('hex')}`;
    const invalid = validateName(name);
    if (invalid) throw new UserError(invalid, 400, {}, { name });
    if ((await fsp.readdir(dir)).length === 0) throw new UserError('emptyUpload');

    if (busy.has(name)) throw new UserError('busy', 409);
    busy.add(name);
    try {
      let password = null;
      let extraMeta = {};
      if (await exists(name)) {
        if (!fields.overwrite) throw new UserError('siteExists', 409, { exists: true, name }, { name });
        if (!isAdmin && !(await checkSitePassword(name, fields.password))) {
          onWrongPassword?.();
          throw new UserError('wrongSitePasswordNamed', 403, { exists: true, name, wrongPassword: true }, { name });
        }
      } else {
        password = generatePassword();
        extraMeta = passwordFields(password);
      }
      const result = await publish(name, dir, extraMeta);
      result.hasIndex = fs.existsSync(path.join(siteDir(name), 'index.html'));
      if (password) result.password = password;
      return result;
    } finally {
      busy.delete(name);
    }
  } finally {
    fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function remove(name) {
  if (validateName(name) || !(await exists(name))) throw new UserError('siteNotFound', 404);
  const trash = path.join(config.TMP_DIR, `del-${crypto.randomUUID()}`);
  await fsp.rename(siteDir(name), trash);
  await fsp.rm(path.join(config.META_DIR, `${name}.json`), { force: true });
  await fsp.rm(trash, { recursive: true, force: true });
}

async function rename(from, to) {
  to = slugify(to);
  const invalid = validateName(to);
  if (invalid) throw new UserError(invalid, 400, {}, { name: to });
  if (validateName(from) || !(await exists(from))) throw new UserError('siteNotFound', 404);
  if (from === to) return { name: to, url: siteUrl(to) };
  if (await exists(to)) throw new UserError('siteExists', 409, {}, { name: to });
  await fsp.rename(siteDir(from), siteDir(to));
  const meta = (await readMeta(from)) || {};
  await writeMeta(to, { ...meta, name: to, updatedAt: new Date().toISOString() });
  await fsp.rm(path.join(config.META_DIR, `${from}.json`), { force: true });
  return { name: to, url: siteUrl(to) };
}

module.exports = {
  UserError,
  init,
  slugify,
  validateName,
  siteDir,
  siteUrl,
  exists,
  list,
  info,
  checkSitePassword,
  resetPassword,
  handleUpload,
  remove,
  rename,
  NAME_RE,
};
