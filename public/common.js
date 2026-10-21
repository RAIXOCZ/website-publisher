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

// A short message in a pill at the bottom of the screen; it slides in and
// stays a few seconds (errors a little longer).
const TOAST_ICONS = {
  ok: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 7v6M12 17h.01"/></svg>',
};
let toastTimer;
function toast(message, { type = 'ok' } = {}) {
  let el = $('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<span class="toast-icon" aria-hidden="true"></span><span class="toast-text"></span>';
    document.body.append(el);
  }
  el.dataset.type = type;
  $('.toast-icon', el).innerHTML = TOAST_ICONS[type] || TOAST_ICONS.ok;
  $('.toast-text', el).textContent = message;
  // Restart the entrance animation when a new message replaces the old one.
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), type === 'error' ? 6000 : 4500);
}

async function copy(text, message = t('toast.linkCopied')) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    await uiAlert(t('prompt.copy'), { value: text });
  }
}

/* ---------- styled dialogs (used instead of alert / confirm / prompt) ---------- */

function uiDialogElement() {
  let dialog = $('#ui-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'ui-dialog';
  dialog.className = 'dialog glass ui-dialog';
  dialog.setAttribute('aria-labelledby', 'ui-dialog-title');
  dialog.innerHTML = `<form method="dialog">
      <h2 id="ui-dialog-title"></h2>
      <p class="ui-text"></p>
      <input type="text" class="ui-input" autocomplete="off" spellcheck="false">
      <textarea class="ui-area" rows="4"></textarea>
      <div class="field ui-value"><code></code><button type="button" class="btn btn-sm" data-ui="copy"></button></div>
      <div class="dialog-actions">
        <button type="button" class="btn" data-ui="cancel"></button>
        <button type="submit" class="btn btn-primary" data-ui="ok" value="ok"></button>
      </div>
    </form>`;
  // The OK button is the form's only submit button, so Enter in the text
  // field confirms; Cancel and Escape close without a value.
  $('[data-ui=cancel]', dialog).addEventListener('click', () => dialog.close('cancel'));
  $('[data-ui=copy]', dialog).addEventListener('click', () => copy($('.ui-value code', dialog).textContent, t('toast.copied')));
  document.body.append(dialog);
  return dialog;
}

/**
 * Shows a message in a styled modal and resolves when it is closed:
 * true/false for confirmations, the typed text (or null) with `input`.
 */
function uiDialog({ title = '', text = '', input = null, multiline = false, optional = false, placeholder = '', value = null, ok = t('ok'), cancel = t('cancel'), danger = false, showCancel = true }) {
  const dialog = uiDialogElement();
  $('#ui-dialog-title', dialog).textContent = title;
  $('#ui-dialog-title', dialog).hidden = !title;
  $('.ui-text', dialog).textContent = text;
  for (const el of [$('.ui-input', dialog), $('.ui-area', dialog)]) el.hidden = true;
  const field = $(multiline ? '.ui-area' : '.ui-input', dialog);
  field.hidden = input === null;
  field.value = input ?? '';
  field.required = input !== null && !optional;
  field.placeholder = placeholder;
  $('.ui-value', dialog).hidden = value === null;
  $('.ui-value code', dialog).textContent = value ?? '';
  $('[data-ui=copy]', dialog).textContent = t('copy');
  const okButton = $('[data-ui=ok]', dialog);
  okButton.textContent = ok;
  okButton.className = `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`;
  $('[data-ui=cancel]', dialog).textContent = cancel;
  $('[data-ui=cancel]', dialog).hidden = !showCancel;
  dialog.returnValue = '';
  dialog.dataset.shown = Number(dialog.dataset.shown || 0) + 1; // lets tests tell dialogs apart
  dialog.showModal();
  if (input !== null) {
    field.focus();
    field.select();
  } else {
    okButton.focus();
  }
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        const confirmed = dialog.returnValue === 'ok';
        resolve(input === null ? confirmed : confirmed ? field.value.trim() : null);
      },
      { once: true },
    );
  });
}

const uiConfirm = (text, options = {}) => uiDialog({ text, ...options });
const uiPrompt = (text, input, options = {}) => uiDialog({ text, input, ...options });
const uiAlert = (text, options = {}) => uiDialog({ text, showCancel: false, ok: t('ok'), ...options });
const uiError = (err) => uiAlert(err.message || String(err), { title: t('error.title') });

async function logout(e) {
  e?.preventDefault();
  await api('/auth/logout', { method: 'POST' });
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
function uploadSite({ files, name, overwrite = false, password = '', preview = false, replacePreview = '', base = '', exact = false, identity = null, onProgress }) {
  const form = new FormData();
  form.append('name', name);
  form.append('overwrite', overwrite ? '1' : '0');
  form.append('password', password || '');
  if (preview) form.append('preview', '1');
  if (replacePreview) form.append('replacePreview', replacePreview);
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

/* ---------- side navigation that follows the scroll position ---------- */

// Marks the link in `nav` whose section is currently on screen.
function scrollSpy(nav) {
  const links = [...nav.querySelectorAll('a[href^="#"]')];
  const sections = links.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean);
  if (!sections.length || !('IntersectionObserver' in window)) return;
  const visible = new Set();
  const update = () => {
    const current = sections.find((s) => visible.has(s)) || null;
    for (const a of links) a.classList.toggle('active', Boolean(current) && a.hash.slice(1) === current.id);
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) (e.isIntersecting ? visible.add(e.target) : visible.delete(e.target));
      update();
    },
    { rootMargin: '-100px 0px -55% 0px' },
  );
  for (const s of sections) observer.observe(s);
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
