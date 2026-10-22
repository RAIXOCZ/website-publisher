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

function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

function formatBytes(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function timeAgo(iso) {
  if (!iso) return '';
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

// Czech plurals: 1 soubor, 2 až 4 soubory, 5+ souborů.
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
  } else if (danger && showCancel) {
    // Enter alone must not delete anything
    $('[data-ui=cancel]', dialog).focus();
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
// The input stays in the page until the picker closes: phones may drop a
// detached input (and its change event) while the picker is open. Phones
// without folder picking get a multiple-file picker instead.
function pickFiles({ folder = true, multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (folder) input.webkitdirectory = true;
    input.className = 'picker-input';
    input.tabIndex = -1;
    document.body.append(input);
    const done = (files) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', async () => {
      done(await readPicked([...input.files].map((file) => ({ path: file.webkitRelativePath || file.name, file }))));
    });
    input.addEventListener('cancel', () => done([]));
    input.click();
  });
}

// On phones a picked file is often only a reference into another app (a
// cloud drive, the gallery) that stops working by the time it is uploaded,
// so the first upload fails. Reading it right away keeps a copy; big picks
// (which the size limit refuses anyway) are left as they are.
const READ_PICKED_MAX = 150 * 1024 * 1024;
async function readPicked(picked) {
  const total = picked.reduce((sum, { file }) => sum + file.size, 0);
  if (!matchMedia('(pointer: coarse)').matches || total > READ_PICKED_MAX) return picked;
  return Promise.all(
    picked.map(async ({ path, file }) => {
      try {
        return { path, file: new File([await file.arrayBuffer()], file.name, { type: file.type, lastModified: file.lastModified }) };
      } catch {
        return { path, file };
      }
    }),
  );
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

// Sends a sign-in link; `onSent(email)` then shows the "check your e-mail" view.
function setupEmailLogin(form, { onSent }) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('button[type=submit]', form);
    const alert = $('.alert', form);
    alert.hidden = true;
    button.disabled = true;
    try {
      const email = form.email.value.trim();
      await api('/auth/login', { method: 'POST', json: { email } });
      onSent(email);
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
  return iso ? new Date(iso).toLocaleString(LANG, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

// Human-readable audit action, e.g. "site.published" → "Web zveřejněn".
function actionLabel(action) {
  const key = `audit.${action}`;
  const label = t(key);
  return label === key ? action : label;
}

/* ---------- "⋯" menu with the less frequent actions of a row ---------- */

// The items stay inside the row, so the row's own click handler runs them
// like any other action button. `items` are [label, action, extra class].
const MORE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';

function moreMenu(items) {
  const entries = items
    .map((item) => (item === '-' ? '<hr>' : `<button type="button" role="menuitem" data-action="${item[1]}" class="${item[2] || ''}">${item[0]}</button>`))
    .join('');
  return `<div class="more"><button type="button" class="btn btn-sm btn-icon more-btn" aria-haspopup="menu" aria-expanded="false" aria-label="${t('more.actions')}" title="${t('more.actions')}">${MORE_ICON}</button><div class="menu glass row-menu" role="menu" hidden>${entries}</div></div>`;
}

function closeRowMenus() {
  for (const menu of document.querySelectorAll('.row-menu:not([hidden])')) {
    menu.hidden = true;
    menu.previousElementSibling.setAttribute('aria-expanded', 'false');
  }
}

function openRowMenu(button) {
  const menu = button.nextElementSibling;
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  placeRowMenu(button, menu);
  menu.querySelector('button:not([hidden])')?.focus({ preventScroll: true });
}

// Under the button, or above it when there is no room below.
function placeRowMenu(button, menu) {
  const rect = button.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8));
  const below = rect.bottom + 4 + menu.offsetHeight < window.innerHeight;
  menu.style.setProperty('--x', `${left}px`);
  menu.style.setProperty('--y', `${below ? rect.bottom + 4 : rect.top - menu.offsetHeight - 4}px`);
}

document.addEventListener('click', (e) => {
  const button = e.target.closest('.more-btn');
  const wasOpen = button && button.getAttribute('aria-expanded') === 'true';
  closeRowMenus(); // also after an item was chosen: the row handled it first
  if (button && !wasOpen) openRowMenu(button);
});
document.addEventListener('keydown', (e) => {
  const menu = e.target.closest?.('.row-menu');
  if (!menu) return;
  const items = [...menu.querySelectorAll('button:not([hidden])')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
  else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
  else if (e.key === 'Escape' || e.key === 'Tab') {
    closeRowMenus();
    menu.previousElementSibling.focus();
  } else return;
  e.preventDefault();
});
window.addEventListener('resize', closeRowMenus);
// The menu is fixed on screen, so it follows its button while the page scrolls.
window.addEventListener('scroll', () => {
  const menu = document.querySelector('.row-menu:not([hidden])');
  if (menu) placeRowMenu(menu.previousElementSibling, menu);
}, { passive: true });

/* ---------- long lists: load more while scrolling ---------- */

function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * A list that loads the next page when its end scrolls into view, so it
 * stays fast with any number of items. `load(cursor)` resolves to
 * { items, next, total }; `render(item)` returns an element for `list`.
 * reset() starts over (e.g. after the search changed); find(pred) looks
 * among the items loaded so far.
 */
function infiniteList({ list, load, render, empty = null, after = list, onPage = null }) {
  const sentinel = document.createElement('div');
  sentinel.className = 'list-sentinel';
  sentinel.setAttribute('aria-hidden', 'true');
  after.after(sentinel);
  let items = [];
  let next = null; // null: first page, undefined: no more
  let loading = false;
  let generation = 0;
  let started = false; // nothing loads before the first reset()

  const nearView = () => sentinel.offsetParent !== null && sentinel.getBoundingClientRect().top < window.innerHeight + 600;

  async function more() {
    if (!started || loading || next === undefined) return;
    loading = true;
    sentinel.classList.add('loading');
    const gen = generation;
    try {
      const page = await load(next);
      if (gen !== generation) return;
      items.push(...page.items);
      list.append(...page.items.map(render));
      next = page.next ?? undefined;
      if (empty) empty.hidden = items.length > 0;
      onPage?.(page, items);
    } catch (err) {
      if (gen === generation) uiError(err);
      next = undefined;
    } finally {
      if (gen === generation) {
        loading = false;
        sentinel.classList.remove('loading');
      }
    }
    // A short page may not fill the screen: keep going until it does.
    if (gen === generation && next !== undefined && nearView()) more();
  }

  new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && more(), { rootMargin: '600px 0px' }).observe(sentinel);

  function reset() {
    started = true;
    generation++;
    loading = false;
    next = null;
    items = [];
    list.replaceChildren();
    return more();
  }
  return { reset, more, find: (pred) => items.find(pred), get items() { return items; } };
}

/* ---------- a searchable picker for long lists ---------- */

let pickerCount = 0;
let optionCount = 0;

/**
 * A select-like button whose options are searched and loaded page by page.
 * `load(query, cursor)` resolves to { items: [{ value, label }], next };
 * `allLabel` is the first option (value ''), or `placeholder` the button's
 * text before a pick. onChange(value) runs on a pick, onClose() when the
 * list closes without one.
 */
function comboPicker(root, { label, allLabel = '', placeholder = '', load, onChange, onClose = null }) {
  const id = `picker-${++pickerCount}`;
  root.classList.add('picker');
  root.innerHTML = `
    <button type="button" class="picker-button" aria-haspopup="listbox" aria-expanded="false"><span class="picker-value"></span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
    <div class="picker-pop" hidden>
      <input type="search" class="picker-search" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="${id}">
      <ul class="picker-list" role="listbox" id="${id}"></ul>
      <p class="picker-empty muted small" hidden></p>
    </div>`;
  const button = $('.picker-button', root);
  const pop = $('.picker-pop', root);
  const search = $('.picker-search', root);
  const listEl = $('.picker-list', root);
  button.setAttribute('aria-label', label);
  search.setAttribute('aria-label', label);
  search.placeholder = t('picker.search');
  $('.picker-empty', root).textContent = t('picker.none');
  let value = '';
  let active = -1;
  $('.picker-value', root).textContent = allLabel || placeholder;

  const option = (item) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.id = `${id}-${++optionCount}`;
    li.dataset.value = item.value;
    li.textContent = item.label;
    li.setAttribute('aria-selected', String(item.value === value));
    return li;
  };
  const list = infiniteList({
    list: listEl,
    after: listEl,
    empty: $('.picker-empty', root),
    load: async (cursor) => {
      const q = search.value.trim();
      const page = await load(q, cursor);
      // "All" leads the unfiltered list.
      if (!cursor && !q && allLabel) page.items = [{ value: '', label: allLabel }, ...page.items];
      return page;
    },
    render: option,
  });

  const options = () => [...listEl.children];
  function highlight(i) {
    const all = options();
    if (!all.length) return;
    active = (i + all.length) % all.length;
    all.forEach((li, n) => li.classList.toggle('active', n === active));
    all[active].scrollIntoView({ block: 'nearest' });
    search.setAttribute('aria-activedescendant', all[active].id);
  }
  let openedAt = 0;
  function open() {
    openedAt = performance.now();
    pop.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    search.value = '';
    active = -1;
    list.reset();
    search.focus();
  }
  function close(focus = true, picked = false) {
    if (pop.hidden) return;
    pop.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (focus) button.focus();
    if (!picked) onClose?.();
  }
  function pick(li) {
    value = li.dataset.value;
    $('.picker-value', root).textContent = li.textContent;
    close(true, true);
    onChange(value);
  }

  button.addEventListener('click', () => (pop.hidden ? open() : close()));
  search.addEventListener('input', debounce(() => {
    active = -1;
    list.reset();
  }, 200));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') highlight(active + 1);
    else if (e.key === 'ArrowUp') highlight(active - 1);
    else if (e.key === 'Enter' && active >= 0) pick(options()[active]);
    else if (e.key === 'Escape') close();
    else return;
    e.preventDefault();
  });
  listEl.addEventListener('click', (e) => {
    const li = e.target.closest('[role=option]');
    if (li) pick(li);
  });
  document.addEventListener('click', (e) => {
    // (not the click that opened it, when it was opened from elsewhere)
    if (!pop.hidden && !root.contains(e.target) && e.timeStamp > openedAt) close(false);
  });
  return { open, get value() { return value; } };
}

/** load() for comboPicker over a list already in memory: filtered, 100 at a time. */
function localPages(options) {
  return async (q, cursor) => {
    const term = q.toLowerCase();
    const matches = term ? options.filter((o) => o.label.toLowerCase().includes(term)) : options;
    const start = Number(cursor) || 0;
    return { items: matches.slice(start, start + 100), next: start + 100 < matches.length ? String(start + 100) : null };
  };
}
