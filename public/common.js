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

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Odkaz zkopírován');
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
