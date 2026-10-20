'use strict';

// Small helpers shared by the upload page and the admin panel.

async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options, headers: { 'X-Requested-With': 'fetch', ...(options.headers || {}) } };
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
    const err = new Error(data.error || `Požadavek selhal (${res.status})`);
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
  if (s < 60) return 'právě teď';
  if (s < 3600) return `před ${Math.floor(s / 60)} min`;
  if (s < 86400) return `před ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 2) return 'včera';
  if (s < 86400 * 30) return `před ${Math.floor(s / 86400)} dny`;
  return new Date(iso).toLocaleDateString('cs-CZ');
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

// Czech plural: 1 soubor, 2–4 soubory, 5+ souborů.
function filesLabel(n) {
  if (n === 1) return '1 soubor';
  if (n >= 2 && n <= 4) return `${n} soubory`;
  return `${n} souborů`;
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

async function copy(text, message = 'Odkaz zkopírován') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    prompt('Zkopírujte odkaz:', text);
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

async function logout() {
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

// Opens the browser's folder (or .zip) picker; resolves with [{ path, file }].
function pickFiles({ zip = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (zip) input.accept = '.zip,application/zip';
    else input.webkitdirectory = true;
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
 * Uploads files as a site. Resolves with { status, data } whatever the
 * outcome, so callers can react to 403/409 themselves.
 */
function uploadSite({ files, name, overwrite = false, password = '', onProgress }) {
  const form = new FormData();
  form.append('name', name);
  form.append('overwrite', overwrite ? '1' : '0');
  form.append('password', password || '');
  for (const { path, file } of files) {
    form.append('p', path);
    form.append('f', file, file.name);
  }
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/sites');
    xhr.setRequestHeader('X-Requested-With', 'fetch');
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
        data.error = xhr.status === 413 ? 'Nahrávaná data jsou pro server příliš velká.' : `Nahrávání selhalo (HTTP ${xhr.status}).`;
      }
      resolve({ status: xhr.status, data });
    });
    xhr.addEventListener('error', () =>
      resolve({ status: 0, data: { error: 'Nahrávání selhalo – zkontrolujte připojení a zkuste to znovu.' } }),
    );
    xhr.send(form);
  });
}
