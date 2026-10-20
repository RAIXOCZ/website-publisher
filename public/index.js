'use strict';

const state = {
  config: null,
  pending: null, // files waiting for a name fix or a password: { files, name? }
};

const els = {
  name: $('#name'),
  dropzone: $('#dropzone'),
  error: $('#error'),
  errorText: $('#error-text'),
  conflict: $('#conflict'),
  conflictPassword: $('#conflict-password'),
  progress: $('#progress'),
  bar: $('#progress-bar'),
  result: $('#result'),
};

async function init() {
  state.config = await api('/config');
  updatePreview();
  renderMySites();
}

/* ---------- address bar ---------- */

function siteUrl(name) {
  return state.config.urlTemplate.replace('{name}', name);
}

// The name input sits inside an address bar: <prefix>[name]<suffix>.
function updatePreview() {
  const [prefix, suffix] = state.config.urlTemplate.split('{name}');
  $('#url-prefix').textContent = prefix;
  $('#url-suffix').textContent = suffix;
  $('#how-live').textContent = siteUrl(t('how.example')).replace(/^https?:\/\//, '');
}

// After a name problem, pressing Enter retries with the files already chosen.
els.name.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && state.files.length) {
    e.preventDefault();
    start(stagedFiles());
  }
});
els.name.addEventListener('blur', () => {
  els.name.value = slugify(els.name.value);
  updatePreview();
});

/* ---------- picking files ---------- */

$('#pick-folder').addEventListener('click', async (e) => {
  e.stopPropagation();
  stageFolderSelection(await pickFiles());
});
$('#pick-files').addEventListener('click', async (e) => {
  e.stopPropagation();
  stageFiles((await pickFiles({ folder: false })).map((f) => f.file));
});
els.dropzone.addEventListener('click', async (e) => {
  if (e.target.closest('a, button')) return;
  stageFolderSelection(await pickFiles());
});
els.dropzone.addEventListener('keydown', async (e) => {
  if (e.target === els.dropzone && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    stageFolderSelection(await pickFiles());
  }
});

// Drag & drop, including whole folders (via the File System Entry API).
let dragDepth = 0;
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
els.dropzone.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  els.dropzone.classList.add('dragging');
});
els.dropzone.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    els.dropzone.classList.remove('dragging');
  }
});
els.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropzone.classList.remove('dragging');
  stageDataTransfer(e.dataTransfer);
});

// Adds whatever was dropped from the computer, into folder `dest` ('' = root).
async function stageDataTransfer(dataTransfer, dest = '') {
  // Entries must be grabbed synchronously, before any await.
  const entries = [...dataTransfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null));
  if (!entries.length || !entries.every(Boolean)) return stageFiles([...dataTransfer.files], dest);
  const loose = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      const files = [];
      await walk(entry, '', files);
      stageFolder(entry.name, files, dest);
    } else {
      loose.push(await new Promise((resolve, reject) => entry.file(resolve, reject)));
    }
  }
  if (loose.length) stageFiles(loose, dest);
}

function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

async function walk(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ path: prefix + entry.name, file });
  } else if (entry.isDirectory) {
    for (const child of await readAllEntries(entry.createReader())) {
      await walk(child, `${prefix}${entry.name}/`, out);
    }
  }
}

/* ---------- publishing ---------- */

/* ---------- staging: the site's file tree, built before publishing ---------- */

state.files = []; // [{ path, file }] exactly as the site will be published
state.collapsed = new Set(); // folder paths shown collapsed
state.dragging = null; // { path, kind } while a tree row is being dragged

function randomName() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => alphabet[b % alphabet.length]).join('');
}

const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);

// Adds files; a file at an existing path replaces the old one.
function putFiles(list) {
  list = cleanFiles(list);
  if (!list.length) return;
  const incoming = new Set(list.map((f) => f.path));
  state.files = state.files.filter((f) => !incoming.has(f.path)).concat(list);
  els.error.hidden = true;
  renderStaged();
}

function prefillName(fallback) {
  if (!slugify(els.name.value)) els.name.value = slugify(fallback) || randomName();
}

// A folder's files arrive as "folder/…". Into an empty tree the folder's
// contents become the site root; otherwise the folder is added as a subfolder.
function stageFolder(label, files, dest = '') {
  const asRoot = state.files.length === 0 && !dest;
  if (asRoot) prefillName(label);
  putFiles(files.map(({ path, file }) => ({ path: joinPath(dest, asRoot ? path.split('/').slice(1).join('/') : path), file })));
}

function stageFolderSelection(files) {
  if (files.length) stageFolder(files[0].path.split('/')[0], files);
}

function stageFiles(files, dest = '') {
  if (!files.length) return;
  if (state.files.length === 0) prefillName(files.length === 1 && /\.zip$/i.test(files[0].name) ? files[0].name : '');
  putFiles(files.map((file) => ({ path: joinPath(dest, file.name), file })));
}

function stagedFiles() {
  return state.files;
}

function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [], count: 0, size: 0 };
  for (const { path, file } of files) {
    const parts = path.split('/');
    let node = root;
    node.count++;
    node.size += file.size;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) {
        node.dirs.set(part, { name: part, path: joinPath(node.path, part), dirs: new Map(), files: [], count: 0, size: 0 });
      }
      node = node.dirs.get(part);
      node.count++;
      node.size += file.size;
    }
    node.files.push({ name: parts.at(-1), path, size: file.size });
  }
  return root;
}

function allFolders(node, out = []) {
  for (const dir of node.dirs.values()) {
    out.push(dir.path);
    allFolders(dir, out);
  }
  return out;
}

const ICONS = {
  dir: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  file: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  move: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/></svg>',
  chevron: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
};

function treeRow({ kind, path, name, meta, depth }) {
  const li = document.createElement('li');
  li.className = `tree-row tree-${kind}`;
  li.dataset.path = path;
  li.dataset.kind = kind;
  li.style.setProperty('--depth', depth);
  if (kind !== 'root') li.draggable = true;
  const collapsed = kind === 'dir' && state.collapsed.has(path);
  li.innerHTML =
    (kind === 'dir'
      ? `<button type="button" class="twisty" data-act="toggle" aria-expanded="${!collapsed}">${ICONS.chevron}</button>`
      : '<span class="twisty-space"></span>') +
    `<span class="tree-icon">${ICONS[kind === 'file' ? 'file' : 'dir']}</span><span class="tree-name"></span><span class="tree-meta"></span>` +
    (kind === 'root'
      ? ''
      : `<span class="tree-actions"><button type="button" class="tree-btn" data-act="move">${ICONS.move}</button><button type="button" class="tree-btn tree-remove" data-act="remove">×</button></span>`);
  $('.tree-name', li).textContent = name;
  $('.tree-meta', li).textContent = meta;
  if (kind !== 'root') {
    $('[data-act=move]', li).setAttribute('aria-label', t('tree.move', { name }));
    $('[data-act=move]', li).title = t('tree.move', { name });
    $('[data-act=remove]', li).setAttribute('aria-label', t('staged.remove', { name }));
  }
  return li;
}

function renderStaged() {
  const files = state.files;
  $('#staged').hidden = files.length === 0;
  els.dropzone.classList.toggle('compact', files.length > 0);
  $('#drop-title').textContent = t(files.length ? 'drop.titleMore' : 'drop.title');
  const totalSize = files.reduce((sum, f) => sum + f.file.size, 0);
  $('#staged-summary').textContent = `${filesLabel(files.length)} · ${formatBytes(totalSize)}`;

  const tree = buildTree(files);
  const rows = [treeRow({ kind: 'root', path: '', name: t('tree.root'), meta: '', depth: 0 })];
  const walkNode = (node, depth) => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const leaves = [...node.files].sort((a, b) => (b.name === 'index.html') - (a.name === 'index.html') || a.name.localeCompare(b.name));
    for (const dir of dirs) {
      if (!state.seenDirs?.has(dir.path)) {
        (state.seenDirs ??= new Set()).add(dir.path);
        if (dir.count > 20) state.collapsed.add(dir.path); // big folders start collapsed
      }
      rows.push(treeRow({ kind: 'dir', path: dir.path, name: `${dir.name}/`, meta: `${filesLabel(dir.count)} · ${formatBytes(dir.size)}`, depth }));
      if (!state.collapsed.has(dir.path)) walkNode(dir, depth + 1);
    }
    for (const leaf of leaves) rows.push(treeRow({ kind: 'file', path: leaf.path, name: leaf.name, meta: formatBytes(leaf.size), depth }));
  };
  walkNode(tree, 1);
  $('#staged-list').replaceChildren(...rows);
  state.tree = tree;
}

const parentOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// Moves a file or a whole folder into folder `dest` ('' = root).
function moveEntry(path, kind, dest) {
  const target = joinPath(dest, path.split('/').pop());
  if (target === path) return;
  if (kind === 'dir' && (dest === path || dest.startsWith(`${path}/`))) return;
  const inside = (p) => (kind === 'dir' ? p.startsWith(`${path}/`) : p === path);
  const moved = state.files.filter((f) => inside(f.path)).map((f) => ({ path: target + f.path.slice(path.length), file: f.file }));
  const movedPaths = new Set(moved.map((f) => f.path));
  state.files = state.files.filter((f) => !inside(f.path) && !movedPaths.has(f.path)).concat(moved);
  if (kind === 'dir' && state.collapsed.delete(path)) state.collapsed.add(target);
  renderStaged();
}

function removeEntry(path, kind) {
  state.files = state.files.filter((f) => (kind === 'dir' ? !f.path.startsWith(`${path}/`) : f.path !== path));
  renderStaged();
}

// "Move to…" for touch screens: a folder picker in place of the button.
function showMoveMenu(row) {
  const { path, kind } = row.dataset;
  const select = document.createElement('select');
  select.className = 'tree-move';
  select.setAttribute('aria-label', t('tree.move', { name: path }));
  const targets = ['', ...allFolders(state.tree)].filter(
    (dest) => dest !== parentOf(path) && !(kind === 'dir' && (dest === path || dest.startsWith(`${path}/`))),
  );
  select.append(new Option(t('tree.moveTo'), '', true, true));
  select.options[0].disabled = true;
  for (const dest of targets) select.append(new Option(dest ? `${dest}/` : t('tree.root'), dest || '/'));
  select.addEventListener('change', () => moveEntry(path, kind, select.value === '/' ? '' : select.value));
  select.addEventListener('blur', () => renderStaged());
  $('.tree-actions', row).replaceChildren(select);
  select.focus();
}

const treeList = $('#staged-list');
treeList.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-act]');
  if (!button) return;
  const row = button.closest('.tree-row');
  const { path, kind } = row.dataset;
  if (button.dataset.act === 'toggle') {
    if (!state.collapsed.delete(path)) state.collapsed.add(path);
    renderStaged();
  } else if (button.dataset.act === 'remove') {
    removeEntry(path, kind);
  } else if (button.dataset.act === 'move') {
    showMoveMenu(row);
  }
});

// Drag rows onto folders to move them; drop files from the computer onto a folder to add them there.
const dropFolderOf = (row) => (row.dataset.kind === 'file' ? parentOf(row.dataset.path) : row.dataset.path);
function clearDropTarget() {
  for (const el of treeList.querySelectorAll('.drop-target')) el.classList.remove('drop-target');
}
treeList.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.tree-row');
  if (!row || row.dataset.kind === 'root') return;
  state.dragging = { path: row.dataset.path, kind: row.dataset.kind };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', row.dataset.path);
  row.classList.add('dragging');
});
treeList.addEventListener('dragend', () => {
  state.dragging = null;
  clearDropTarget();
  for (const el of treeList.querySelectorAll('.dragging')) el.classList.remove('dragging');
});
treeList.addEventListener('dragover', (e) => {
  const row = e.target.closest('.tree-row');
  if (!row) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = state.dragging ? 'move' : 'copy';
  const folder = dropFolderOf(row);
  clearDropTarget();
  const target = treeList.querySelector(`.tree-row[data-path="${CSS.escape(folder)}"]:not(.tree-file)`);
  target?.classList.add('drop-target');
});
treeList.addEventListener('dragleave', (e) => {
  if (!treeList.contains(e.relatedTarget)) clearDropTarget();
});
treeList.addEventListener('drop', (e) => {
  const row = e.target.closest('.tree-row');
  if (!row) return;
  e.preventDefault();
  e.stopPropagation();
  clearDropTarget();
  const dest = dropFolderOf(row);
  if (state.dragging) {
    const { path, kind } = state.dragging;
    state.dragging = null;
    moveEntry(path, kind, dest);
  } else {
    stageDataTransfer(e.dataTransfer, dest);
  }
});

$('#clear-staged').addEventListener('click', () => {
  state.files = [];
  state.collapsed.clear();
  renderStaged();
});
$('#publish').addEventListener('click', () => start(stagedFiles()));

function showError(message, { askPassword = false } = {}) {
  els.errorText.textContent = message;
  els.conflict.hidden = !askPassword;
  els.error.hidden = false;
  if (askPassword) els.conflictPassword.focus();
}

function setStage(stage) {
  els.dropzone.hidden = stage !== 'pick';
  $('#staged').hidden = stage !== 'pick' || state.files.length === 0;
  els.progress.hidden = stage !== 'upload';
  els.result.hidden = stage !== 'done';
  els.name.disabled = stage === 'upload';
}

async function start(files) {
  els.error.hidden = true;
  files = cleanFiles(files);
  if (!files.length) return;

  if (!slugify(els.name.value)) els.name.value = randomName();
  const name = slugify(els.name.value);
  els.name.value = name;
  state.pending = { files, name };

  let check;
  try {
    check = await api(`/check-name?name=${encodeURIComponent(name)}`);
  } catch (err) {
    return showError(err.message);
  }
  if (check.error) {
    els.name.focus();
    return showError(check.error);
  }
  // Your own site (password saved here): ask whether to replace it.
  // Anyone else's: publish right away; the server adds a suffix (name-k3x).
  const saved = check.exists && ownedPassword(name);
  if (saved) {
    els.conflictPassword.value = saved;
    return showError(t('err.existsOwned', { name }), { askPassword: true });
  }
  upload(files, name);
}

els.conflict.addEventListener('submit', (e) => {
  e.preventDefault();
  const { files, name } = state.pending || {};
  const password = els.conflictPassword.value.trim();
  if (!files || !password) return els.conflictPassword.focus();
  els.error.hidden = true;
  upload(files, name, password);
});
$('#as-new').addEventListener('click', () => {
  const { files, name } = state.pending || {};
  els.error.hidden = true;
  if (files) upload(files, name);
});
$('#cancel').addEventListener('click', () => {
  state.pending = null;
  els.error.hidden = true;
});

async function upload(files, name, password = null) {
  const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);
  if (totalBytes > state.config.maxUploadMb * 1024 * 1024) {
    return showError(t('err.tooBig', { size: formatBytes(totalBytes), limit: state.config.maxUploadMb }));
  }

  setStage('upload');
  $('#progress-title').textContent = t('progress.uploadingName', { name });
  $('#progress-files').textContent = `${filesLabel(files.length)} · ${formatBytes(totalBytes)}`;
  els.bar.style.width = '0%';
  $('#progress-pct').textContent = '0%';

  const { status, data } = await uploadSite({
    files,
    name,
    overwrite: Boolean(password),
    password,
    onProgress: (p) => {
      const pct = Math.round(p * 100);
      els.bar.style.width = `${pct}%`;
      $('#progress-pct').textContent = pct === 100 ? t('progress.publishing') : `${pct}%`;
    },
  });

  if (status >= 200 && status < 300) {
    state.pending = null;
    state.files = [];
    state.collapsed.clear();
    renderStaged();
    if (data.password) rememberSite(data.name, data.password);
    else if (password) rememberSite(data.name, password);
    done(data);
    renderMySites();
    return;
  }
  setStage('pick');
  if (data.exists) {
    state.pending = { files, name };
    return showError(data.wrongPassword ? data.error + t('err.tryAgain') : data.error, { askPassword: true });
  }
  showError(data.error);
}

function done(site) {
  setStage('done');
  $('#result-title').textContent = t(site.replaced ? 'result.updated' : 'result.liveName', { name: site.name });
  $('#result-link').textContent = site.url;
  $('#result-link').href = site.url;
  $('#open').href = site.url;
  $('#result-password').hidden = !site.password;
  $('#result-password-value').textContent = site.password || '';
  if (site.requestedName) els.name.value = site.name;
  $('#result-note').textContent =
    (site.requestedName ? t('result.renamed', { requested: site.requestedName, name: site.name }) + ' ' : '') +
    `${filesLabel(site.files)}, ${formatBytes(site.bytes)}.` +
    (site.hasIndex ? '' : t('result.noIndex'));
}

$('#copy').addEventListener('click', () => copy($('#result-link').href));
$('#copy-password').addEventListener('click', () => copy($('#result-password-value').textContent, t('toast.pwCopied')));
$('#again').addEventListener('click', () => {
  els.name.value = '';
  updatePreview();
  setStage('pick');
});

/* ---------- my sites ---------- */

async function renderMySites() {
  const owned = loadOwned();
  const list = $('#my-list');
  $('#my-count').textContent = owned.length;
  $('#my-empty').hidden = owned.length > 0;
  if (!owned.length) return list.replaceChildren();

  let status = {};
  try {
    const { sites } = await api('/my-sites', { method: 'POST', json: { sites: owned } });
    status = Object.fromEntries(sites.map((s) => [s.name, s]));
  } catch {
    /* show what we have locally */
  }

  list.replaceChildren(
    ...owned.map(({ name, password }) => {
      const info = status[name] || { status: 'unknown' };
      const row = $('#my-row').content.firstElementChild.cloneNode(true);
      applyI18n(row);
      row.dataset.name = name;
      row.dataset.initial = name[0];
      $('.site-name', row).textContent = name;
      const url = info.url || siteUrl(name);
      $('.site-url', row).textContent = url;
      $('.site-url', row).href = url;
      $('.site-pw code', row).textContent = password;
      const ok = info.status === 'ok' || info.status === 'unknown';
      if (info.status === 'ok') {
        const chips = [filesLabel(info.files), formatBytes(info.bytes), t('chip.updated', { ago: timeAgo(info.updatedAt) })];
        $('.site-meta', row).replaceChildren(...chips.map((text) => Object.assign(document.createElement('span'), { className: 'chip', textContent: text })));
      }
      if (info.status === 'missing' || info.status === 'wrong-password') {
        $('.site-status', row).textContent = t(info.status === 'missing' ? 'my.missing' : 'my.wrongPw');
        $('.site-status', row).hidden = false;
      }
      if (!ok) row.classList.add('dim');
      for (const action of ['update', 'delete']) $(`[data-action="${action}"]`, row).hidden = !ok;
      $('[data-action="forget"]', row).hidden = false;
      return row;
    }),
  );
}

$('#my-list').addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const row = button.closest('.site-card');
  const name = row.dataset.name;
  const password = ownedPassword(name);
  const url = $('.site-url', row).href;
  const action = button.dataset.action;

  if (action === 'copy') return copy(url);
  if (action === 'password') {
    $('.site-pw', row).hidden = !$('.site-pw', row).hidden;
    return;
  }
  if (action === 'forget') {
    forgetSite(name);
    return renderMySites();
  }
  if (action === 'delete') {
    if (!confirm(t('confirm.deleteOwn', { name, url }))) return;
    try {
      await api(`/sites/${encodeURIComponent(name)}/delete`, { method: 'POST', json: { password } });
      forgetSite(name);
      toast(t('toast.deleted', { name }));
      renderMySites();
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  if (action === 'update') {
    const files = cleanFiles(await pickFiles());
    if (!files.length) return;
    els.name.value = name;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    upload(files, name, password);
  }
});

$('#add-toggle').addEventListener('click', () => {
  const form = $('#add-form');
  form.hidden = !form.hidden;
  if (!form.hidden) form.site.focus();
});

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const error = $('.alert', form);
  error.hidden = true;
  const name = slugify(form.site.value);
  const password = form.password.value.trim();
  try {
    const { sites } = await api('/my-sites', { method: 'POST', json: { sites: [{ name, password }] } });
    const result = sites[0];
    if (result.status !== 'ok') {
      throw new Error(result.status === 'missing' ? t('err.siteMissing', { name }) : t('err.wrongSitePw'));
    }
    rememberSite(name, password);
    form.reset();
    form.hidden = true;
    toast(t('toast.added', { name }));
    renderMySites();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

init().catch((err) => {
  document.querySelector('main').textContent = t('err.load', { message: err.message });
});
