'use strict';

const state = {
  config: null,
  pending: null, // files waiting for a decision on a name conflict: { files, name }
  files: [], // [{ path, file }] new files, [{ path, from, size }] files kept from the edited site
  emptyDirs: new Set(), // folders created with "New folder" that have no files yet
  collapsed: new Set(), // folder paths shown collapsed
  seenDirs: new Set(),
  dragging: null, // { path, kind } while a tree row is being dragged
  edit: null, // { name, password } while editing an existing site
  previewTimer: null,
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
  tree: $('#staged-list'),
};

const signedIn = () => Boolean(state.config.user);
// Publishing without an account is possible only from whitelisted IPs (site passwords).
const passwordMode = () => !signedIn() && state.config.whitelisted;
const needsIdentity = () => !signedIn() && !state.config.whitelisted;

async function init() {
  state.config = await api('/config');
  updateAddress();
  $('.dropzone .hint').innerHTML = t('drop.hint', { limit: `${state.config.siteMaxMb} MB` });
  restoreIdentity();
  if (state.config.user?.blocked) {
    showNotice(t('account.blocked'));
    $('#notice').classList.add('warn');
  }
  renderStaged();
  await renderMySites();
  await handleQuery();
}

async function handleQuery() {
  const params = new URLSearchParams(location.search);
  if (![...params.keys()].length) return;
  history.replaceState(null, '', location.pathname);
  if (params.has('accountDeleted')) {
    showNotice(t('notice.accountDeleted', { days: state.config.retentionDays, contact: state.config.contact }));
  }
  if (params.has('published') && signedIn()) {
    const { sites } = await api('/me');
    const site = sites.find((s) => s.name === params.get('published'));
    if (site) done({ ...site, hasIndex: true });
  }
  if (params.has('edit')) startEdit(params.get('edit'), ownedPassword(params.get('edit')));
}

function showNotice(text) {
  $('#notice').textContent = text;
  $('#notice').hidden = false;
}

/* ---------- address bar ---------- */

function siteUrl(name) {
  return state.config.urlTemplate.replace('{name}', name);
}

// The name input sits inside an address bar: <prefix>[name]<suffix>.
function updateAddress() {
  const [prefix, suffix] = state.config.urlTemplate.split('{name}');
  $('#url-prefix').textContent = prefix;
  $('#url-suffix').textContent = suffix;
  $('#how-live').textContent = siteUrl(t('how.example')).replace(/^https?:\/\//, '');
}

els.name.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && state.files.length) {
    e.preventDefault();
    publish();
  }
});
els.name.addEventListener('blur', () => {
  els.name.value = slugify(els.name.value);
});

/* ---------- picking files from the computer ---------- */

$('#pick-folder').addEventListener('click', async (e) => {
  e.stopPropagation();
  addFolder(await pickFiles());
});
$('#pick-files').addEventListener('click', async (e) => {
  e.stopPropagation();
  addFiles((await pickFiles({ folder: false })).map((f) => f.file));
});
els.dropzone.addEventListener('click', async (e) => {
  if (e.target.closest('a, button')) return;
  addFolder(await pickFiles());
});
els.dropzone.addEventListener('keydown', async (e) => {
  if (e.target === els.dropzone && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    addFolder(await pickFiles());
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
  addDataTransfer(e.dataTransfer);
});

// Adds whatever was dropped from the computer, into folder `dest` ('' = root).
async function addDataTransfer(dataTransfer, dest = '') {
  // Entries must be grabbed synchronously, before any await.
  const entries = [...dataTransfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null));
  if (!entries.length || !entries.every(Boolean)) return addFiles([...dataTransfer.files], dest);
  const loose = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      const files = [];
      await walk(entry, '', files);
      await addFolder(files, dest, entry.name);
    } else {
      loose.push(await new Promise((resolve, reject) => entry.file(resolve, reject)));
    }
  }
  if (loose.length) await addFiles(loose, dest);
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

/* ---------- the site's file tree, built before publishing ---------- */

function randomName() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => alphabet[b % alphabet.length]).join('');
}

const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);
const parentOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);
const sizeOf = (f) => (f.file ? f.file.size : f.size || 0);
const isInside = (p, dir) => p === dir || p.startsWith(`${dir}/`);

function changed() {
  els.error.hidden = true;
  hidePreview();
  renderStaged();
}

// Asks before files at `paths` are overwritten. Resolves with 'overwrite',
// 'skip' (keep the existing files; only offered when `canSkip`) or 'cancel'.
function confirmOverwrite(paths, { moving = false, canSkip = false } = {}) {
  const dialog = $('#overwrite-dialog');
  const one = paths.length === 1;
  $('#overwrite-title').textContent = t(one ? 'overwrite.titleOne' : 'overwrite.title');
  $('#overwrite-text').textContent = one
    ? t(moving ? 'overwrite.moveOne' : 'overwrite.textOne', { name: paths[0] })
    : t(moving ? 'overwrite.move' : 'overwrite.text', { count: filesLabel(paths.length) });
  const shown = one ? [] : paths.slice(0, 8);
  $('#overwrite-list').replaceChildren(
    ...shown.map((path) => Object.assign(document.createElement('li'), { textContent: path })),
    ...(paths.length > shown.length && !one ? [Object.assign(document.createElement('li'), { className: 'more', textContent: t('overwrite.more', { n: paths.length - shown.length }) })] : []),
  );
  $('#overwrite-list').hidden = one;
  $('#overwrite-skip').hidden = !canSkip;
  dialog.returnValue = '';
  dialog.showModal();
  $('#overwrite-yes').focus();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue || 'cancel'), { once: true });
  });
}

// Adds files; asks first when some would overwrite files already in the tree.
async function putFiles(list) {
  list = cleanFiles(list);
  if (!list.length) return;
  const existing = new Set(state.files.map((f) => f.path));
  const clashes = list.filter((f) => existing.has(f.path)).map((f) => f.path);
  if (clashes.length) {
    const choice = await confirmOverwrite(clashes, { canSkip: clashes.length < list.length });
    if (choice === 'cancel') return;
    if (choice === 'skip') list = list.filter((f) => !existing.has(f.path));
  }
  const incoming = new Set(list.map((f) => f.path));
  state.files = state.files.filter((f) => !incoming.has(f.path)).concat(list);
  for (const f of list) for (let d = parentOf(f.path); d; d = parentOf(d)) state.emptyDirs.delete(d);
  changed();
}

function prefillName(fallback) {
  if (!state.edit && !slugify(els.name.value)) els.name.value = slugify(fallback) || randomName();
}

// A picked folder arrives as "folder/…". Into an empty tree its contents
// become the site root; otherwise it is added as a subfolder of `dest`.
async function addFolder(files, dest = '', label = files[0]?.path.split('/')[0]) {
  if (!files.length) return;
  const asRoot = state.files.length === 0 && state.emptyDirs.size === 0 && !dest;
  if (asRoot) prefillName(label);
  const strip = (path) => (path.startsWith(`${label}/`) ? path.slice(label.length + 1) : path);
  await putFiles(files.map(({ path, file }) => ({ path: joinPath(dest, asRoot ? strip(path) : path), file })));
}

async function addFiles(files, dest = '') {
  if (!files.length) return;
  if (state.files.length === 0) prefillName(files.length === 1 && /\.zip$/i.test(files[0].name) ? files[0].name : '');
  await putFiles(files.map((file) => ({ path: joinPath(dest, file.name), file })));
}

// Replaces everything inside folder `dir` ('' = the whole site) with a picked folder's contents.
function replaceFolder(dir, files) {
  if (!files.length) return;
  const label = files[0].path.split('/')[0];
  state.files = state.files.filter((f) => !(dir ? isInside(f.path, dir) : true));
  if (!dir) state.emptyDirs.clear();
  putFiles(files.map(({ path, file }) => ({ path: joinPath(dir, path.slice(label.length + 1)), file })));
  toast(t('toast.replacedFolder', { name: dir ? `${dir}/` : t('tree.root') }));
}

function replaceFile(path, file) {
  state.files = state.files.map((f) => (f.path === path ? { path, file } : f));
  changed();
  toast(t('toast.replacedFile', { name: baseName(path) }));
}

function buildTree() {
  const root = { name: '', path: '', dirs: new Map(), files: [], count: 0, size: 0 };
  const dirNode = (path) => {
    let node = root;
    for (const part of path ? path.split('/') : []) {
      if (!node.dirs.has(part)) {
        node.dirs.set(part, { name: part, path: joinPath(node.path, part), dirs: new Map(), files: [], count: 0, size: 0 });
      }
      node = node.dirs.get(part);
    }
    return node;
  };
  for (const dir of state.emptyDirs) dirNode(dir);
  for (const item of state.files) {
    const size = sizeOf(item);
    let node = root;
    root.count++;
    root.size += size;
    for (const part of item.path.split('/').slice(0, -1)) {
      node = dirNode(joinPath(node.path, part));
      node.count++;
      node.size += size;
    }
    node.files.push({ name: baseName(item.path), path: item.path, size, isNew: Boolean(item.file && state.edit) });
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
  more: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  chevron: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
};

function treeRow({ kind, path, name, meta, depth, isNew = false, empty = false }) {
  const li = document.createElement('li');
  li.className = `tree-row tree-${kind}${empty ? ' tree-empty' : ''}`;
  li.dataset.path = path;
  li.dataset.kind = kind;
  li.style.setProperty('--depth', depth);
  if (kind !== 'root') li.draggable = true;
  const collapsed = kind === 'dir' && state.collapsed.has(path);
  li.innerHTML =
    (kind === 'dir'
      ? `<button type="button" class="twisty" data-act="toggle" aria-expanded="${!collapsed}">${ICONS.chevron}</button>`
      : '<span class="twisty-space"></span>') +
    `<span class="tree-icon">${ICONS[kind === 'file' ? 'file' : 'dir']}</span><span class="tree-name"></span>` +
    (isNew ? `<span class="tree-badge">${t('tree.new')}</span>` : '') +
    '<span class="tree-meta"></span>' +
    `<span class="tree-actions"><button type="button" class="tree-btn" data-act="menu" aria-haspopup="menu">${ICONS.more}</button></span>`;
  $('.tree-name', li).textContent = name;
  $('.tree-meta', li).textContent = meta;
  $('[data-act=menu]', li).setAttribute('aria-label', t('tree.actions', { name }));
  $('[data-act=menu]', li).title = t('tree.actions', { name });
  return li;
}

function renderStaged() {
  const files = state.files;
  const hasContent = files.length > 0 || state.emptyDirs.size > 0 || Boolean(state.edit);
  $('#staged').hidden = !hasContent || !els.progress.hidden || !els.result.hidden || !$('#pending').hidden;
  els.dropzone.hidden = hasContent || !els.progress.hidden || !els.result.hidden || !$('#pending').hidden;
  const totalSize = files.reduce((sum, f) => sum + sizeOf(f), 0);
  $('#staged-summary').textContent = `${filesLabel(files.length)}, ${formatBytes(totalSize)}`;
  renderLimits(totalSize);
  $('[data-tool="replace-all"]').hidden = !state.edit;
  $('#clear-staged').hidden = Boolean(state.edit); // "Cancel editing" in the banner does that

  // Who publishes: e-mail form for visitors, "signed in as" for accounts.
  $('#identity').hidden = !needsIdentity() || Boolean(state.edit);
  $('#signed-as').hidden = !signedIn();
  if (signedIn()) $('#signed-as').textContent = t('identity.signedAs', { email: state.config.user.email });
  $('#publish').textContent = t(state.edit ? 'edit.save' : needsIdentity() ? 'publish.confirm' : 'publish');

  const tree = buildTree();
  const rows = [treeRow({ kind: 'root', path: '', name: t('tree.root'), meta: '', depth: 0 })];
  const walkNode = (node, depth) => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const leaves = [...node.files].sort((a, b) => (b.name === 'index.html') - (a.name === 'index.html') || a.name.localeCompare(b.name));
    for (const dir of dirs) {
      if (!state.seenDirs.has(dir.path)) {
        state.seenDirs.add(dir.path);
        if (dir.count > 20) state.collapsed.add(dir.path); // big folders start collapsed
      }
      const empty = dir.count === 0;
      const meta = empty ? t('tree.emptyDir') : `${filesLabel(dir.count)}, ${formatBytes(dir.size)}`;
      rows.push(treeRow({ kind: 'dir', path: dir.path, name: `${dir.name}/`, meta, depth, empty }));
      if (!state.collapsed.has(dir.path)) walkNode(dir, depth + 1);
    }
    for (const leaf of leaves) rows.push(treeRow({ kind: 'file', path: leaf.path, name: leaf.name, meta: formatBytes(leaf.size), depth, isNew: leaf.isNew }));
  };
  walkNode(tree, 1);
  els.tree.replaceChildren(...rows);
  state.tree = tree;
}

// Moves a file or a whole folder into folder `dest` ('' = root).
function moveEntry(path, kind, dest) {
  return renameEntry(path, kind, joinPath(dest, baseName(path)));
}

// Gives a file or folder a new path (rename or move).
async function renameEntry(path, kind, target) {
  if (target === path) return renderStaged();
  if (kind === 'dir' && isInside(target, path)) return renderStaged();
  const inside = (p) => (kind === 'dir' ? p.startsWith(`${path}/`) : p === path);
  const moved = state.files.filter((f) => inside(f.path)).map((f) => ({ ...f, path: target + f.path.slice(path.length) }));
  const movedPaths = new Set(moved.map((f) => f.path));
  const clashes = state.files.filter((f) => !inside(f.path) && movedPaths.has(f.path)).map((f) => f.path);
  if (clashes.length && (await confirmOverwrite(clashes, { moving: true })) !== 'overwrite') return renderStaged();
  state.files = state.files.filter((f) => !inside(f.path) && !movedPaths.has(f.path)).concat(moved);
  if (kind === 'dir') {
    for (const dir of [...state.emptyDirs]) {
      if (isInside(dir, path)) {
        state.emptyDirs.delete(dir);
        state.emptyDirs.add(target + dir.slice(path.length));
      }
    }
    if (state.collapsed.delete(path)) state.collapsed.add(target);
  }
  changed();
}

function removeEntry(path, kind) {
  state.files = state.files.filter((f) => (kind === 'dir' ? !f.path.startsWith(`${path}/`) : f.path !== path));
  if (kind === 'dir') for (const dir of [...state.emptyDirs]) if (isInside(dir, path)) state.emptyDirs.delete(dir);
  changed();
}

const validSegment = (name) => name && !name.includes('/') && name !== '.' && name !== '..' && !/[\\\0]/.test(name);

// Edits a row's name in place; `onCommit(newName)` runs on Enter or blur.
function inlineName(row, initial, onCommit, onCancel = renderStaged) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tree-input';
  input.value = initial;
  input.spellcheck = false;
  input.setAttribute('aria-label', t('tree.nameLabel'));
  $('.tree-name', row).replaceChildren(input);
  row.draggable = false;
  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (commit && validSegment(value)) onCommit(value);
    else {
      if (commit && value) toast(t('tree.badName'));
      onCancel();
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.focus();
  const dot = initial.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : initial.length);
}

function newFolder(parent) {
  const taken = new Set([...state.tree ? allFolders(state.tree) : []]);
  let name = t('tree.newFolderName');
  for (let i = 2; taken.has(joinPath(parent, name)); i++) name = `${t('tree.newFolderName')}-${i}`;
  const path = joinPath(parent, name);
  state.emptyDirs.add(path);
  state.collapsed.delete(parent);
  renderStaged();
  const row = els.tree.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`);
  inlineName(row, name, (value) => {
    state.emptyDirs.delete(path);
    state.emptyDirs.add(joinPath(parent, value));
    renderStaged();
  });
}

// "Move to…": a folder picker in place of the row's buttons (works on touch screens too).
function showMoveMenu(row) {
  const { path, kind } = row.dataset;
  const select = document.createElement('select');
  select.className = 'tree-move';
  select.setAttribute('aria-label', t('tree.move', { name: path }));
  const targets = ['', ...allFolders(state.tree)].filter((dest) => dest !== parentOf(path) && !(kind === 'dir' && isInside(dest, path)));
  select.append(new Option(t('tree.moveTo'), '', true, true));
  select.options[0].disabled = true;
  for (const dest of targets) select.append(new Option(dest ? `${dest}/` : t('tree.root'), dest || '/'));
  select.addEventListener('change', () => moveEntry(path, kind, select.value === '/' ? '' : select.value));
  select.addEventListener('blur', () => renderStaged());
  $('.tree-actions', row).replaceChildren(select);
  select.focus();
}

/* ---------- the ⋯ menu of a tree row ---------- */

function menuItems(kind) {
  if (kind === 'file') return ['replace-file', 'rename', 'move', '-', 'remove'];
  const add = ['add-files', 'add-folder', 'mkdir', '-', 'replace-folder'];
  return kind === 'root' ? add : [...add, 'rename', 'move', '-', 'remove'];
}

let openMenu = null;
function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

function showMenu(button) {
  closeMenu();
  const row = button.closest('.tree-row');
  const { kind } = row.dataset;
  const menu = document.createElement('div');
  menu.className = 'menu glass';
  menu.setAttribute('role', 'menu');
  for (const item of menuItems(kind)) {
    if (item === '-') {
      menu.append(Object.assign(document.createElement('hr'), {}));
      continue;
    }
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.setAttribute('role', 'menuitem');
    entry.dataset.menu = item;
    entry.textContent = t(`menu.${item}${kind === 'root' && item === 'replace-folder' ? '-root' : ''}`);
    if (item === 'remove') entry.className = 'danger';
    menu.append(entry);
  }
  menu.addEventListener('click', (e) => {
    const entry = e.target.closest('button[data-menu]');
    if (!entry) return;
    closeMenu();
    runMenu(entry.dataset.menu, row);
  });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
    else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
    else if (e.key === 'Escape') {
      closeMenu();
      button.focus();
    } else return;
    e.preventDefault();
  });
  document.body.append(menu);
  const rect = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  const below = rect.bottom + 4 + height < window.innerHeight;
  menu.style.setProperty('--x', `${left + window.scrollX}px`);
  menu.style.setProperty('--y', `${(below ? rect.bottom + 4 : rect.top - height - 4) + window.scrollY}px`);
  openMenu = menu;
  menu.owner = button;
  menu.querySelector('button').focus();
}

document.addEventListener('click', (e) => {
  if (openMenu && !e.target.closest('.menu, [data-act=menu]')) closeMenu();
});
window.addEventListener('resize', closeMenu);

async function runMenu(action, row) {
  const { path, kind } = row.dataset;
  const dir = kind === 'file' ? parentOf(path) : path;
  if (action === 'add-files') addFiles((await pickFiles({ folder: false })).map((f) => f.file), dir);
  else if (action === 'add-folder') addFolder(await pickFiles(), dir);
  else if (action === 'mkdir') newFolder(dir);
  else if (action === 'replace-folder') replaceFolder(dir, cleanFiles(await pickFiles()));
  else if (action === 'replace-file') {
    const [picked] = await pickFiles({ folder: false, multiple: false });
    if (picked) replaceFile(path, picked.file);
  } else if (action === 'rename') {
    const current = baseName(path);
    inlineName(row, current, (value) => renameEntry(path, kind, joinPath(parentOf(path), value)));
  } else if (action === 'move') showMoveMenu(row);
  else if (action === 'remove') removeEntry(path, kind);
}

els.tree.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-act]');
  if (!button) return;
  const row = button.closest('.tree-row');
  const { path, kind } = row.dataset;
  if (button.dataset.act === 'toggle') {
    if (!state.collapsed.delete(path)) state.collapsed.add(path);
    renderStaged();
  } else if (button.dataset.act === 'menu') {
    const same = openMenu?.owner === button;
    closeMenu();
    if (!same) showMenu(button);
  }
});
els.tree.addEventListener('dblclick', (e) => {
  const row = e.target.closest('.tree-row');
  if (!row || row.dataset.kind === 'root' || e.target.closest('button, input')) return;
  runMenu('rename', row);
});

// Drag rows onto folders to move them; drop files from the computer onto a folder to add them there.
const dropFolderOf = (row) => (row.dataset.kind === 'file' ? parentOf(row.dataset.path) : row.dataset.path);
function clearDropTarget() {
  for (const el of els.tree.querySelectorAll('.drop-target')) el.classList.remove('drop-target');
}
els.tree.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.tree-row');
  if (!row || row.dataset.kind === 'root') return;
  state.dragging = { path: row.dataset.path, kind: row.dataset.kind };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', row.dataset.path);
  row.classList.add('dragging');
});
els.tree.addEventListener('dragend', () => {
  state.dragging = null;
  clearDropTarget();
  for (const el of els.tree.querySelectorAll('.dragging')) el.classList.remove('dragging');
});
els.tree.addEventListener('dragover', (e) => {
  const row = e.target.closest('.tree-row');
  if (!row) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = state.dragging ? 'move' : 'copy';
  const folder = dropFolderOf(row);
  clearDropTarget();
  els.tree.querySelector(`.tree-row[data-path="${CSS.escape(folder)}"]:not(.tree-file)`)?.classList.add('drop-target');
});
els.tree.addEventListener('dragleave', (e) => {
  if (!els.tree.contains(e.relatedTarget)) clearDropTarget();
});
els.tree.addEventListener('drop', (e) => {
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
    addDataTransfer(e.dataTransfer, dest);
  }
});

// Toolbar above the tree: always works on the site root.
$('.tree-toolbar').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-tool]');
  if (!button) return;
  const root = els.tree.querySelector('.tree-root');
  runMenu({ files: 'add-files', folder: 'add-folder', mkdir: 'mkdir', 'replace-all': 'replace-folder' }[button.dataset.tool], root);
});

$('#clear-staged').addEventListener('click', () => {
  if (state.edit) return cancelEdit();
  resetStaging();
});

function resetStaging() {
  state.files = [];
  state.emptyDirs.clear();
  state.collapsed.clear();
  state.seenDirs.clear();
  hidePreview();
  renderStaged();
}

/* ---------- editing an existing site ---------- */

async function startEdit(name, password = null) {
  els.error.hidden = true;
  let data;
  try {
    data = await api(`/sites/${encodeURIComponent(name)}/files`, { method: 'POST', json: { password } });
  } catch (err) {
    return showError(err.message);
  }
  resetStaging();
  state.edit = { name, password };
  state.files = data.files.map((f) => ({ path: f.path, from: f.path, size: f.size }));
  els.name.value = name;
  els.name.disabled = true;
  $('#edit-text').textContent = t('edit.banner', { name });
  $('#edit-banner').hidden = false;
  setStage('pick');
  renderStaged();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cancelEdit() {
  state.edit = null;
  els.name.disabled = false;
  els.name.value = '';
  $('#edit-banner').hidden = true;
  resetStaging();
}
$('#edit-cancel').addEventListener('click', cancelEdit);

/* ---------- identity (visitors without an account) ---------- */

const IDENTITY_KEY = 'freepages.identity';
function restoreIdentity() {
  try {
    const saved = JSON.parse(localStorage.getItem(IDENTITY_KEY) || 'null');
    if (!saved) return;
    $('#id-remember').checked = true;
    $('#id-email').value = saved.email || '';
    $('#id-first').value = saved.firstName || '';
    $('#id-last').value = saved.lastName || '';
  } catch {
    /* storage unavailable */
  }
}
function readIdentity() {
  const form = $('#identity');
  if (!form.reportValidity()) return null;
  const identity = { email: $('#id-email').value.trim(), firstName: $('#id-first').value.trim(), lastName: $('#id-last').value.trim() };
  // Kept only when asked to ("Remember my details").
  try {
    if ($('#id-remember').checked) localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
    else localStorage.removeItem(IDENTITY_KEY);
  } catch {
    /* storage unavailable */
  }
  return identity;
}
$('#identity').addEventListener('submit', (e) => {
  e.preventDefault();
  publish();
});

/* ---------- preview ---------- */

function hidePreview() {
  clearInterval(state.previewTimer);
  $('#preview-box').hidden = true;
}

function showPreview(preview) {
  const box = $('#preview-box');
  box.hidden = false;
  box.classList.remove('expired');
  $('#preview-title').textContent = t('preview.ready');
  $('#preview-open').href = preview.url;
  $('#preview-open').hidden = false;
  $('#preview-again').hidden = true;
  const end = new Date(preview.expiresAt).getTime();
  const tick = () => {
    const left = Math.max(0, Math.round((end - Date.now()) / 1000));
    if (!left) {
      clearInterval(state.previewTimer);
      box.classList.add('expired');
      $('#preview-title').textContent = t('preview.expired');
      $('#preview-time').textContent = t('preview.expiredHint');
      $('#preview-open').hidden = true;
      $('#preview-again').hidden = false;
      return;
    }
    const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    $('#preview-time').textContent = t('preview.expires', { time: clock, url: preview.url.replace(/^https?:\/\//, '') });
  };
  clearInterval(state.previewTimer);
  tick();
  state.previewTimer = setInterval(tick, 1000);
}

$('#preview-again').addEventListener('click', () => $('#preview').click());
$('#preview').addEventListener('click', async () => {
  const files = cleanFiles(state.files);
  if (!files.length) return showError(t('err.noFiles'));
  const button = $('#preview');
  button.disabled = true;
  button.textContent = t('preview.making');
  const { status, data } = await uploadSite({
    files,
    name: slugify(els.name.value) || 'preview',
    preview: true,
    replacePreview: state.lastPreview || '', // the old preview is deleted right away
    exact: Boolean(state.edit),
    base: state.edit?.name || '',
    password: state.edit?.password || '',
  });
  button.disabled = false;
  button.textContent = t('preview.button');
  if (status >= 200 && status < 300 && data.preview) {
    state.lastPreview = data.preview.code;
    els.error.hidden = true;
    showPreview(data.preview);
  } else {
    showError(data.error);
  }
});

/* ---------- publishing ---------- */


$('#publish').addEventListener('click', () => publish());

function showError(message, { askPassword = false, askReplace = false } = {}) {
  els.errorText.textContent = message;
  els.conflict.hidden = !askPassword && !askReplace;
  els.conflictPassword.hidden = !askPassword;
  els.error.hidden = false;
  if (askPassword) els.conflictPassword.focus();
}

function setStage(stage) {
  els.progress.hidden = stage !== 'upload';
  els.result.hidden = stage !== 'done';
  $('#pending').hidden = stage !== 'pending';
  els.name.disabled = stage === 'upload' || Boolean(state.edit);
  renderStaged();
}

async function publish() {
  els.error.hidden = true;
  const files = cleanFiles(state.files);
  if (!files.length) return showError(t('err.noFiles'));

  if (state.edit) return upload(files, state.edit.name, { replace: true, password: state.edit.password, base: state.edit.name });

  if (!slugify(els.name.value)) els.name.value = randomName();
  const name = slugify(els.name.value);
  els.name.value = name;

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
  let identity = null;
  if (needsIdentity()) {
    identity = readIdentity();
    if (!identity) return;
  }
  state.pending = { files, name, identity };
  // Your own site: ask whether to replace it. Anyone else's: publish right
  // away; the server adds a suffix (name-k3x).
  if (check.exists && check.mine) return showError(t('err.existsMine', { name }), { askReplace: true });
  const saved = check.exists && passwordMode() && ownedPassword(name);
  if (saved) {
    els.conflictPassword.value = saved;
    return showError(t('err.existsOwned', { name }), { askPassword: true });
  }
  upload(files, name, { identity });
}

els.conflict.addEventListener('submit', (e) => {
  e.preventDefault();
  const { files, name } = state.pending || {};
  if (!files) return;
  const password = els.conflictPassword.hidden ? '' : els.conflictPassword.value.trim();
  if (!els.conflictPassword.hidden && !password) return els.conflictPassword.focus();
  els.error.hidden = true;
  upload(files, name, { replace: true, password });
});
$('#as-new').addEventListener('click', () => {
  const { files, name, identity } = state.pending || {};
  els.error.hidden = true;
  if (files) upload(files, name, { identity });
});
$('#cancel').addEventListener('click', () => {
  state.pending = null;
  els.error.hidden = true;
});

async function upload(files, name, { replace = false, password = '', base = '', identity = null } = {}) {
  const totalBytes = files.reduce((sum, f) => sum + (f.file ? f.file.size : 0), 0);
  if (totalBytes > state.config.maxUploadMb * 1024 * 1024) {
    return showError(t('err.tooBig', { size: formatBytes(totalBytes), limit: state.config.maxUploadMb }));
  }

  hidePreview();
  setStage('upload');
  $('#progress-title').textContent = t('progress.uploadingName', { name });
  $('#progress-files').textContent = `${filesLabel(files.length)}, ${formatBytes(files.reduce((s, f) => s + sizeOf(f), 0))}`;
  els.bar.style.width = '0%';
  $('#progress-pct').textContent = '0%';

  const { status, data } = await uploadSite({
    files,
    name,
    overwrite: replace,
    password,
    base,
    identity,
    exact: Boolean(state.edit),
    onProgress: (p) => {
      const pct = Math.round(p * 100);
      els.bar.style.width = `${pct}%`;
      $('#progress-pct').textContent = pct === 100 ? t('progress.publishing') : `${pct}%`;
    },
  });

  if (status >= 200 && status < 300) {
    state.pending = null;
    if (state.edit) {
      state.edit = null;
      $('#edit-banner').hidden = true;
    }
    resetStaging();
    if (data.pending) return pendingDone(data);
    if (data.password) rememberSite(data.name, data.password);
    else if (password && data.hasPassword) rememberSite(data.name, password);
    done(data);
    renderMySites();
    return;
  }
  setStage('pick');
  if (data.exists) {
    state.pending = { files, name, identity };
    if (data.wrongPassword) return showError(data.error + t('err.tryAgain'), { askPassword: true });
  }
  showError(data.error);
}

function pendingDone(data) {
  setStage('pending');
  $('#pending-text').textContent = t('pending.text', { email: data.email, name: data.name });
  $('#pending-note').textContent = t('pending.note', { hours: data.hours });
}

function done(site) {
  setStage('done');
  $('#result-title').textContent = t(site.replaced ? 'result.updated' : 'result.liveName', { name: site.name });
  $('#result-link').textContent = site.url;
  $('#result-link').href = site.url;
  $('#open').href = site.url;
  $('#result-password').hidden = !site.password;
  $('#result-password-value').textContent = site.password || '';
  els.name.value = site.name;
  $('#result-note').textContent =
    (site.requestedName ? t('result.renamed', { requested: site.requestedName, name: site.name }) + ' ' : '') +
    `${filesLabel(site.files)}, ${formatBytes(site.bytes)}.` +
    (site.hasIndex ? '' : t('result.noIndex'));
}

$('#copy').addEventListener('click', () => copy($('#result-link').href));
$('#copy-password').addEventListener('click', () => copy($('#result-password-value').textContent, t('toast.pwCopied')));
for (const id of ['#again', '#pending-again']) {
  $(id).addEventListener('click', () => {
    els.name.value = '';
    setStage('pick');
  });
}

/* ---------- my sites ---------- */

function siteCard({ name, url, info, password = null }) {
  const row = $('#my-row').content.firstElementChild.cloneNode(true);
  applyI18n(row);
  row.dataset.name = name;
  row.dataset.initial = name[0];
  $('.site-name', row).textContent = name;
  $('.site-url', row).textContent = url;
  $('.site-url', row).href = url;
  if (info?.files != null) {
    const chips = [filesLabel(info.files), formatBytes(info.bytes), t('chip.updated', { ago: timeAgo(info.updatedAt) })];
    $('.site-meta', row).replaceChildren(...chips.map((text) => Object.assign(document.createElement('span'), { className: 'chip', textContent: text })));
  }
  if (password) {
    row.dataset.password = '1';
    $('.site-pw code', row).textContent = password;
    $('[data-action="password"]', row).hidden = false;
    $('[data-action="forget"]', row).hidden = false;
  }
  return row;
}

// The size limits, right where the site is put together.
function renderLimits(size) {
  const MB = 1024 * 1024;
  const siteMax = state.config.siteMaxMb * MB;
  const siteShare = Math.min(1, size / siteMax);
  $('#site-meter').style.width = `${(siteShare * 100).toFixed(1)}%`;
  let over = size > siteMax;
  $('#site-limit').textContent = t(over ? 'limits.siteOver' : 'limits.site', { limit: formatBytes(siteMax) });

  const usage = state.usage;
  const accountLimit = $('#account-limit');
  accountLimit.hidden = !usage?.limit;
  if (usage?.limit) {
    // Editing or replacing a site frees its current size first.
    const replaced = state.edit ? state.sites?.find((s) => s.name === state.edit.name)?.bytes || 0 : 0;
    const after = usage.used - replaced + size;
    const accountOver = after > usage.limit;
    over ||= accountOver;
    accountLimit.textContent = t(accountOver ? 'limits.accountOver' : 'limits.account', { after: formatBytes(after), limit: formatBytes(usage.limit) });
    accountLimit.classList.toggle('over', accountOver);
  }
  $('#site-meter').classList.toggle('full', over || siteShare >= 0.8);
  $('#site-limit').classList.toggle('over', size > siteMax);
  $('#publish').disabled = over;
}

async function renderMySites() {
  const list = $('#my-list');
  const cards = [];
  if (signedIn()) {
    const { sites, usage } = await api('/me');
    state.usage = usage;
    state.sites = sites;
    for (const site of sites) cards.push(siteCard({ name: site.name, url: site.url, info: site }));
  }
  const owned = signedIn() && !state.config.whitelisted ? [] : loadOwned();
  if (owned.length) {
    let status = {};
    try {
      const { sites } = await api('/my-sites', { method: 'POST', json: { sites: owned } });
      status = Object.fromEntries(sites.map((s) => [s.name, s]));
    } catch {
      /* show what we have locally */
    }
    for (const { name, password } of owned) {
      const info = status[name] || { status: 'unknown' };
      const card = siteCard({ name, url: info.url || siteUrl(name), info: info.status === 'ok' ? info : null, password });
      if (info.status === 'missing' || info.status === 'wrong-password') {
        $('.site-status', card).textContent = t(info.status === 'missing' ? 'my.missing' : 'my.wrongPw');
        $('.site-status', card).hidden = false;
        card.classList.add('dim');
        for (const action of ['edit', 'delete']) $(`[data-action="${action}"]`, card).hidden = true;
      }
      cards.push(card);
    }
  }
  list.replaceChildren(...cards);
  $('#my-count').textContent = cards.length;
  $('#add-toggle').hidden = !state.config.whitelisted;
  $('#login-inline').hidden = signedIn();
  $('#my-empty').hidden = cards.length > 0 || !signedIn();
}

$('#my-list').addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const row = button.closest('.site-card');
  const name = row.dataset.name;
  const password = row.dataset.password ? ownedPassword(name) : null;
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
    if (!(await uiConfirm(`${t('confirm.deleteOwn', { name, url })}\n\n${retentionNote(state.config)}`, { title: t('delete.title', { name }), ok: t('delete.ok'), danger: true }))) return;
    try {
      await api(`/sites/${encodeURIComponent(name)}/delete`, { method: 'POST', json: { password } });
      if (password) forgetSite(name);
      if (state.edit?.name === name) cancelEdit();
      toast(t('toast.deleted', { name }));
      renderMySites();
    } catch (err) {
      uiError(err);
    }
    return;
  }
  if (action === 'edit') startEdit(name, password);
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
