'use strict';

// Small helpers shared by the upload page and the admin panel.

async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options, headers: { 'X-Requested-With': 'fetch', 'X-Lang': LANG, ...(options.headers || {}) } };
  if (opts.json !== undefined) {
    opts.body = JSON.stringify(opts.json);
    opts.headers['Content-Type'] = 'application/json';
    delete opts.json;
  }
  const res = await fetch(`/api${path}`, opts);
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const err = new Error(data.error || t('request.failed', { status: res.status }));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function $(selector, root = document) {
  return root.querySelector(selector);
}

function formatBytes(n) {
  if (n == null) return '–';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function timeAgo(iso) {
  if (!iso) return '–';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return t('time.now');
  if (s < 3600) return t('time.minutes', { n: Math.floor(s / 60) });
  if (s < 86400) return t('time.hours', { n: Math.floor(s / 3600) });
  if (s < 86400 * 2) return t('time.yesterday');
  if (s < 86400 * 30) return t('time.days', { n: Math.floor(s / 86400) });
  return new Date(iso).toLocaleDateString(LANG);
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

// Czech plurals: 1 soubor, 2–4 soubory, 5+ souborů.
function plural(n, cs, en) {
  if (LANG === 'en') return `${n} ${n === 1 ? en[0] : en[1]}`;
  return `${n} ${n === 1 ? cs[0] : n >= 2 && n <= 4 ? cs[1] : cs[2]}`;
}

function filesLabel(n) {
  return plural(n, ['soubor', 'soubory', 'souborů'], ['file', 'files']);
}

function sitesLabel(n) {
  return plural(n, ['web', 'weby', 'webů'], ['site', 'sites']);
}

let toastTimer;
function toast(message) {
  let el = $('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.append(el);
  }
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

async function copy(text, message = t('toast.linkCopied')) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    prompt(t('prompt.copy'), text);
  }
}

// Wires up a login form; calls onSuccess after a correct password.
function setupLogin(form, onSuccess) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('button', form);
    const error = $('.alert', form);
    button.disabled = true;
    error.hidden = true;
    try {
      await api('/login', { method: 'POST', json: { password: form.password.value } });
      form.password.value = '';
      onSuccess();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      form.password.select();
    } finally {
      button.disabled = false;
    }
  });
}

async function logout(e) {
  e?.preventDefault();
  await api('/logout', { method: 'POST' });
  location.reload();
}

/* ---------- sites owned by this browser (name + password in localStorage) ---------- */

const OWNED_KEY = 'freepages.sites';

function loadOwned() {
  try {
    const list = JSON.parse(localStorage.getItem(OWNED_KEY));
    return Array.isArray(list) ? list.filter((s) => s && s.name && s.password) : [];
  } catch {
    return [];
  }
}

function saveOwned(list) {
  try {
    localStorage.setItem(OWNED_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable (private mode) */
  }
}

function rememberSite(name, password) {
  const list = loadOwned().filter((s) => s.name !== name);
  list.unshift({ name, password, addedAt: new Date().toISOString() });
  saveOwned(list);
}

function forgetSite(name) {
  saveOwned(loadOwned().filter((s) => s.name !== name));
}

function ownedPassword(name) {
  return loadOwned().find((s) => s.name === name)?.password || null;
}

/* ---------- picking and uploading folders ---------- */

// Opens the browser's folder picker (or, with folder: false, a picker for any
// number of files); resolves with [{ path, file }].
function pickFiles({ folder = true, multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (folder) input.webkitdirectory = true;
    else input.multiple = multiple;
    input.addEventListener('change', () => {
      resolve([...input.files].map((file) => ({ path: file.webkitRelativePath || file.name, file })));
    });
    input.click();
  });
}

function cleanFiles(files) {
  return files.filter((f) => !/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(f.path));
}

/**
 * Uploads a site. `files` are [{ path, file }] for new files and
 * [{ path, from }] for files kept from the existing site `base`.
 * Resolves with { status, data } whatever the outcome, so callers can react
 * to 403/409 themselves.
 */
function uploadSite({ files, name, overwrite = false, password = '', preview = false, base = '', exact = false, identity = null, onProgress }) {
  const form = new FormData();
  form.append('name', name);
  form.append('overwrite', overwrite ? '1' : '0');
  form.append('password', password || '');
  if (preview) form.append('preview', '1');
  if (exact) form.append('exact', '1');
  if (base) form.append('base', base);
  if (identity) for (const key of ['email', 'firstName', 'lastName']) form.append(key, identity[key] || '');
  const keep = files.filter((f) => f.from).map(({ path, from }) => ({ path, from }));
  if (keep.length) form.append('keep', JSON.stringify(keep));
  for (const { path, file } of files) {
    if (!file) continue;
    form.append('p', path);
    form.append('f', file, file.name);
  }
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/sites');
    xhr.setRequestHeader('X-Requested-With', 'fetch');
    xhr.setRequestHeader('X-Lang', LANG);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (!data.error && (xhr.status < 200 || xhr.status >= 300)) {
        data.error = xhr.status === 413 ? t('upload.tooLarge') : t('upload.failedHttp', { status: xhr.status });
      }
      resolve({ status: xhr.status, data });
    });
    xhr.addEventListener('error', () =>
      resolve({ status: 0, data: { error: t('upload.network') } }),
    );
    xhr.send(form);
  });
}

/* ---------- signing in with an e-mail link ---------- */

function setupEmailLogin(form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('button[type=submit]', form);
    const alert = $('.alert', form);
    alert.hidden = true;
    button.disabled = true;
    try {
      await api('/auth/login', { method: 'POST', json: { email: form.email.value.trim() } });
      form.replaceChildren(Object.assign(document.createElement('p'), {
        className: 'sent',
        textContent: t('login.sent', { email: form.email.value.trim() }),
      }));
    } catch (err) {
      alert.textContent = err.message;
      alert.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
}

function retentionNote(config) {
  return t('retention.note', { days: config.retentionDays, contact: config.contact });
}

function formatDateTime(iso) {
  return iso ? new Date(iso).toLocaleString(LANG, { dateStyle: 'medium', timeStyle: 'short' }) : '–';
}

// Human-readable audit action, e.g. "site.published" → "Web zveřejněn".
function actionLabel(action) {
  const key = `audit.${action}`;
  const label = t(key);
  return label === key ? action : label;
}
