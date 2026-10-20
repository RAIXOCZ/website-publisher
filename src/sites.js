'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const Busboy = require('busboy');
const yauzl = require('yauzl');
const config = require('./config');
const { one, all, run, now, inMinutes, inDays } = require('./db');
const accounts = require('./accounts');

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED = new Set([
  'admin', 'api', 'app', 'docs', 'podminky', 'soukromi', 'terms', 'privacy', 'ucet', 'account', 'email', 'www', 'static',
  'assets', 'login', 'logout', 'mail', 'ftp', 'dashboard', 'favicon.ico', 'robots.txt',
]);
const PREVIEW_PREFIX = 'preview-';
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

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const randomCode = (length) => [...crypto.randomBytes(length)].map((b) => ALNUM[b % ALNUM.length]).join('');

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
  if (RESERVED.has(name) || name.startsWith(PREVIEW_PREFIX) || `${name}.${config.SITE_DOMAIN}` === config.APP_HOSTNAME) {
    return 'nameReserved';
  }
  return null;
}

const siteDir = (name) => path.join(config.SITES_DIR, name);

function siteUrl(name) {
  if (config.SITE_DOMAIN) return `${config.SCHEME}://${name}.${config.SITE_DOMAIN}/`;
  return `${config.PUBLIC_URL}/${name}/`;
}

const activeSite = (name) => (NAME_RE.test(name || '') ? one('SELECT * FROM sites WHERE name = ? AND deleted_at IS NULL', name) : null);
const siteById = (id) => one('SELECT * FROM sites WHERE id = ?', id);
const exists = (name) => Boolean(activeSite(name));

function publicSite(row) {
  return {
    id: row.id,
    name: row.name,
    url: siteUrl(row.name),
    files: row.files,
    bytes: row.bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasPassword: Boolean(row.password_hash),
  };
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

// `name` if it is free, otherwise `name-xyz` with a random 3-character suffix.
function freeName(name) {
  if (!busy.has(name) && !exists(name)) return name;
  const base = name.slice(0, 59).replace(/-+$/, '');
  for (;;) {
    const candidate = `${base}-${randomCode(3)}`;
    if (!validateName(candidate) && !busy.has(candidate) && !exists(candidate)) return candidate;
  }
}

/* ---------- passwords (only for uploads from whitelisted IPs) ---------- */

// Passwords are generated by the server (~60 random bits), so a fast salted
// hash is enough; there is nothing to gain from a slow KDF here.
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function generatePassword() {
  const chars = [...crypto.randomBytes(12)].map((b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
  return chars.match(/.{4}/g).join('-');
}

const hashPassword = (password, salt) => crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');

function checkSitePassword(site, password) {
  if (!site?.password_hash || !password) return false;
  const expected = Buffer.from(site.password_hash, 'hex');
  const actual = Buffer.from(hashPassword(String(password).trim().toLowerCase(), site.salt), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function resetPassword(site) {
  const password = generatePassword();
  const salt = crypto.randomBytes(16).toString('hex');
  run('UPDATE sites SET password_hash = ?, salt = ? WHERE id = ?', hashPassword(password, salt), salt, site.id);
  return password;
}

/* ---------- reading uploads ---------- */

/**
 * Reads a multipart upload into a temporary folder. Fields (all optional):
 *   name, overwrite ("1"), password, email, firstName, lastName, preview ("1"),
 *   exact ("1": paths are final, do not unwrap a single top folder),
 *   base (site to copy kept files from) and keep (JSON [{ path, from }]),
 *   then pairs of p (relative path) + f (file), or just files.
 */
async function parseUpload(req) {
  const work = path.join(config.TMP_DIR, `up-${crypto.randomUUID()}`);
  const raw = path.join(work, 'raw');
  await fsp.mkdir(raw, { recursive: true });
  const budget = new Budget();
  const fields = {};
  const uploaded = [];
  const cleanup = () => fsp.rm(work, { recursive: true, force: true }).catch(() => {});

  try {
    await new Promise((resolve, reject) => {
      let bb;
      try {
        bb = Busboy({
          headers: req.headers,
          limits: { files: config.MAX_FILES, fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, fields: config.MAX_FILES + 20, fieldSize: 5 * 1024 * 1024 },
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
        if (field === 'p') pendingPath = value;
        else fields[field] = value;
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
  } catch (err) {
    await cleanup();
    throw err;
  }

  const flag = (v) => v === '1' || v === 'true';
  let keep = [];
  if (fields.keep) {
    try {
      keep = JSON.parse(fields.keep);
    } catch {
      await cleanup();
      throw new UserError('invalidJson');
    }
    if (!Array.isArray(keep)) keep = [];
  }
  return {
    work,
    raw,
    uploaded,
    keep,
    budget,
    cleanup,
    fields: {
      name: fields.name || '',
      overwrite: flag(fields.overwrite),
      preview: flag(fields.preview),
      exact: flag(fields.exact),
      password: fields.password || '',
      email: fields.email || '',
      firstName: fields.firstName || '',
      lastName: fields.lastName || '',
      base: fields.base || '',
    },
  };
}

/**
 * Turns a parsed upload into the folder that will be published. Kept files
 * are copied from `baseDir` (an existing site the caller may edit).
 */
async function assemble(upload, { baseDir = null } = {}) {
  const { raw, work, uploaded, keep, fields } = upload;
  if (keep.length && baseDir) {
    for (const entry of keep.slice(0, config.MAX_FILES)) {
      const to = cleanPath(entry?.path);
      const from = cleanPath(entry?.from);
      if (!to || !from) continue;
      const source = path.join(baseDir, ...from);
      const target = path.join(raw, ...to);
      if (!source.startsWith(baseDir + path.sep) || !target.startsWith(raw + path.sep) || fs.existsSync(target)) continue;
      const st = await fsp.stat(source).catch(() => null);
      if (!st?.isFile()) continue;
      upload.budget.addFile();
      upload.budget.addBytes(st.size);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(source, target);
    }
  }
  const total = uploaded.length + keep.length;
  if (!total) throw new UserError('noFiles');

  let content = raw;
  let fallbackName = uploaded[0] && uploaded[0].length > 1 ? uploaded[0][0] : '';
  if (uploaded.length === 1 && !keep.length && /\.zip$/i.test(uploaded[0].at(-1))) {
    fallbackName = uploaded[0].at(-1);
    content = path.join(work, 'zip');
    await fsp.mkdir(content);
    await extractZip(path.join(raw, ...uploaded[0]), content, new Budget());
  }
  let dir = content;
  let wrapper = null;
  if (!fields.exact) ({ dir, wrapper } = await unwrapSingleFolder(content));
  if ((await fsp.readdir(dir)).length === 0) throw new UserError('emptyUpload');
  const requested = slugify(fields.name || fallbackName || wrapper) || randomCode(6);
  return { dir, requested };
}

/* ---------- publishing ---------- */

async function moveInto(sourceDir, target) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.rename(sourceDir, target);
}

async function createSite({ requested, dir, userId = null, withPassword = false, ip }) {
  const invalid = validateName(requested);
  if (invalid) throw new UserError(invalid, 400, {}, { name: requested });
  const name = freeName(requested);
  busy.add(name);
  try {
    await moveInto(dir, siteDir(name));
    const { files, bytes } = await stats(siteDir(name));
    let password = null;
    let salt = null;
    let hash = null;
    if (withPassword) {
      password = generatePassword();
      salt = crypto.randomBytes(16).toString('hex');
      hash = hashPassword(password, salt);
    }
    const t = now();
    const info = run(
      'INSERT INTO sites (name, user_id, password_hash, salt, files, bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      name, userId, hash, salt, files, bytes, t, t,
    );
    const site = siteById(Number(info.lastInsertRowid));
    accounts.audit('site.published', { userId, siteId: site.id, siteName: name, ip, detail: { files, bytes, email: accounts.userById(userId)?.email } });
    const result = { ...publicSite(site), replaced: false, hasIndex: fs.existsSync(path.join(siteDir(name), 'index.html')) };
    if (password) result.password = password;
    if (name !== requested) result.requestedName = requested;
    return result;
  } finally {
    busy.delete(name);
  }
}

// Swap the new folder into place: visitors see the old or the new version, never half of it.
async function replaceSite(site, dir, { userId = null, ip, by = 'owner' }) {
  if (busy.has(site.name)) throw new UserError('busy', 409);
  busy.add(site.name);
  try {
    const target = siteDir(site.name);
    const old = path.join(config.TMP_DIR, `old-${crypto.randomUUID()}`);
    await fsp.rename(target, old).catch(() => {});
    await moveInto(dir, target);
    fsp.rm(old, { recursive: true, force: true }).catch(() => {});
    const { files, bytes } = await stats(target);
    run('UPDATE sites SET files = ?, bytes = ?, updated_at = ? WHERE id = ?', files, bytes, now(), site.id);
    accounts.audit(by === 'admin' ? 'site.updated_by_admin' : 'site.updated', {
      userId: site.user_id ?? userId, siteId: site.id, siteName: site.name, ip,
      detail: { files, bytes, email: accounts.userById(userId)?.email },
    });
    return { ...publicSite(siteById(site.id)), replaced: true, hasIndex: fs.existsSync(path.join(target, 'index.html')) };
  } finally {
    busy.delete(site.name);
  }
}

// Keeps an upload until its owner confirms their e-mail address.
async function savePending(dir) {
  const id = crypto.randomUUID();
  await moveInto(dir, path.join(config.PENDING_DIR, id));
  return id;
}

function pendingDir(id) {
  const dir = path.join(config.PENDING_DIR, path.basename(String(id || '')));
  return fs.existsSync(dir) ? dir : null;
}

/* ---------- previews ---------- */

const previewUrl = (code) =>
  config.SITE_DOMAIN ? `${config.SCHEME}://${PREVIEW_PREFIX}${code}.${config.SITE_DOMAIN}/` : `${config.PUBLIC_URL}/${PREVIEW_PREFIX}${code}/`;

async function savePreview(dir, { userId = null, ip, siteName = null }) {
  const code = randomCode(6);
  await moveInto(dir, path.join(config.PREVIEWS_DIR, code));
  const expiresAt = inMinutes(config.PREVIEW_MINUTES);
  run('INSERT INTO previews (code, user_id, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', code, userId, ip, now(), expiresAt);
  accounts.audit('preview.created', { userId, siteName, ip, detail: { preview: `${PREVIEW_PREFIX}${code}` } });
  return { code, url: previewUrl(code), expiresAt, minutes: config.PREVIEW_MINUTES };
}

// Folder of a live preview ("preview-abc123"), or null when unknown or expired.
function previewRoot(name) {
  if (!String(name).startsWith(PREVIEW_PREFIX)) return null;
  const code = name.slice(PREVIEW_PREFIX.length);
  if (!/^[a-z0-9]{6}$/.test(code)) return null;
  const row = one('SELECT * FROM previews WHERE code = ? AND expires_at > ?', code, now());
  return row ? path.join(config.PREVIEWS_DIR, code) : null;
}

/* ---------- managing sites ---------- */

async function listFiles(site) {
  const root = siteDir(site.name);
  const out = [];
  for (const entry of await fsp.readdir(root, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    out.push({ path: path.relative(root, full).split(path.sep).join('/'), size: (await fsp.stat(full)).size });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// Takes the site offline and keeps its files for RETENTION_DAYS.
async function softDelete(site, { by = 'owner', ip }) {
  const trash = path.join(config.TRASH_DIR, `${site.id}-${site.name}`);
  await fsp.rm(trash, { recursive: true, force: true });
  if (fs.existsSync(siteDir(site.name))) await moveInto(siteDir(site.name), trash);
  run(
    'UPDATE sites SET deleted_at = ?, deleted_by = ?, trash_dir = ?, purge_after = ? WHERE id = ?',
    now(), by, trash, inDays(config.RETENTION_DAYS), site.id,
  );
  accounts.audit(by === 'admin' ? 'site.deleted_by_admin' : 'site.deleted', { userId: site.user_id, siteId: site.id, siteName: site.name, ip });
}

// Erases a site for good: its files, its record and its audit entries.
async function purgeSite(site) {
  if (!site.deleted_at) await fsp.rm(siteDir(site.name), { recursive: true, force: true });
  if (site.trash_dir) await fsp.rm(site.trash_dir, { recursive: true, force: true });
  run('DELETE FROM audit_log WHERE site_id = ?', site.id);
  run('DELETE FROM sites WHERE id = ?', site.id);
}

async function rename(site, to, { ip, by = 'owner' }) {
  to = slugify(to);
  const invalid = validateName(to);
  if (invalid) throw new UserError(invalid, 400, {}, { name: to });
  if (site.name === to) return publicSite(site);
  if (exists(to)) throw new UserError('siteExists', 409, {}, { name: to });
  await fsp.rename(siteDir(site.name), siteDir(to));
  run('UPDATE sites SET name = ?, updated_at = ? WHERE id = ?', to, now(), site.id);
  accounts.audit(by === 'admin' ? 'site.renamed_by_admin' : 'site.renamed', { userId: site.user_id, siteId: site.id, siteName: to, ip, detail: { from: site.name } });
  return publicSite(siteById(site.id));
}

function sitesOfUser(userId) {
  return all('SELECT * FROM sites WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC', userId).map(publicSite);
}

function listAll() {
  return all(`
    SELECT s.*, u.email AS owner_email, u.first_name AS owner_first, u.last_name AS owner_last
    FROM sites s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.purged_at IS NULL
    ORDER BY s.deleted_at IS NOT NULL, s.updated_at DESC`).map((row) => ({
    ...publicSite(row),
    status: row.deleted_at ? 'deleted' : 'active',
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    purgeAfter: row.purge_after,
    owner: row.user_id ? { id: row.user_id, email: row.owner_email, firstName: row.owner_first, lastName: row.owner_last } : null,
  }));
}

/* ---------- start-up ---------- */

// Sites from before accounts existed (folders + meta/*.json with passwords)
// become sites of the ADMIN_EMAIL account; their passwords are dropped.
async function migrateLegacy() {
  const dirs = (await fsp.readdir(config.SITES_DIR, { withFileTypes: true })).filter((e) => e.isDirectory() && NAME_RE.test(e.name));
  const missing = dirs.filter((e) => !exists(e.name));
  if (!missing.length) return;
  let admin = accounts.activeUserByEmail(config.ADMIN_EMAIL);
  if (!admin) {
    admin = accounts.createUser({ email: config.ADMIN_EMAIL, firstName: config.ADMIN_FIRST_NAME, lastName: config.ADMIN_LAST_NAME, ip: null });
  }
  for (const entry of missing) {
    let meta = {};
    try {
      meta = JSON.parse(await fsp.readFile(path.join(config.META_DIR, `${entry.name}.json`), 'utf8'));
    } catch {
      /* no metadata */
    }
    const { files, bytes } = await stats(siteDir(entry.name));
    const t = now();
    const info = run(
      'INSERT INTO sites (name, user_id, files, bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      entry.name, admin.id, files, bytes, meta.createdAt || t, meta.updatedAt || t,
    );
    accounts.audit('site.migrated', { userId: admin.id, siteId: Number(info.lastInsertRowid), siteName: entry.name });
  }
  await fsp.rm(config.META_DIR, { recursive: true, force: true });
  console.log(`migrated ${missing.length} existing site(s) to ${config.ADMIN_EMAIL}`);
}

async function init() {
  for (const dir of [config.SITES_DIR, config.TRASH_DIR, config.PENDING_DIR, config.PREVIEWS_DIR]) await fsp.mkdir(dir, { recursive: true });
  await fsp.rm(config.TMP_DIR, { recursive: true, force: true });
  await fsp.mkdir(config.TMP_DIR, { recursive: true });
  await migrateLegacy();
}

module.exports = {
  UserError,
  NAME_RE,
  PREVIEW_PREFIX,
  init,
  slugify,
  validateName,
  randomCode,
  siteDir,
  siteUrl,
  activeSite,
  siteById,
  exists,
  publicSite,
  checkSitePassword,
  resetPassword,
  parseUpload,
  assemble,
  createSite,
  replaceSite,
  savePending,
  pendingDir,
  savePreview,
  previewRoot,
  previewUrl,
  listFiles,
  softDelete,
  purgeSite,
  rename,
  sitesOfUser,
  listAll,
};
