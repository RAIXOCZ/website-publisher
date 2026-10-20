'use strict';

const state = {
  config: null,
  pending: null, // files waiting for a name fix or overwrite confirmation: { files, name? }
};

const els = {
  login: $('#login'),
  uploader: $('#uploader'),
  name: $('#name'),
  preview: $('#url-preview'),
  dropzone: $('#dropzone'),
  folderInput: $('#folder-input'),
  zipInput: $('#zip-input'),
  error: $('#error'),
  errorText: $('#error-text'),
  conflict: $('#conflict-actions'),
  progress: $('#progress'),
  bar: $('#progress-bar'),
  result: $('#result'),
};

async function init() {
  state.config = await api('/config');
  const { authed, publicUpload } = state.config;
  $('#nav-admin').hidden = !authed;
  $('#nav-logout').hidden = !authed;
  if (!authed && !publicUpload) {
    els.login.hidden = false;
    els.uploader.hidden = true;
    return;
  }
  els.login.hidden = true;
  els.uploader.hidden = false;
  updatePreview();
}

setupLogin($('#login form'), init);
$('#nav-logout').addEventListener('click', logout);

/* ---------- name & URL preview ---------- */

function siteUrl(name) {
  return state.config.urlTemplate.replace('{name}', name);
}

function updatePreview() {
  const name = slugify(els.name.value);
  if (!name) {
    els.preview.textContent = `Bude zveřejněno na ${siteUrl('nazev-slozky')}`;
    return;
  }
  const [before, after] = siteUrl('\u0000').split('\u0000');
  els.preview.replaceChildren('Bude zveřejněno na ', before, Object.assign(document.createElement('b'), { textContent: name }), after);
}

els.name.addEventListener('input', updatePreview);
// After a name problem, pressing Enter retries with the files already chosen.
els.name.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && state.pending) {
    e.preventDefault();
    start(state.pending.files);
  }
});
els.name.addEventListener('blur', () => {
  els.name.value = slugify(els.name.value);
  updatePreview();
});

/* ---------- picking files ---------- */

$('#pick-folder').addEventListener('click', (e) => {
  e.stopPropagation();
  els.folderInput.click();
});
$('#pick-zip').addEventListener('click', (e) => {
  e.stopPropagation();
  els.zipInput.click();
});
els.dropzone.addEventListener('click', () => els.folderInput.click());
els.dropzone.addEventListener('keydown', (e) => {
  if (e.target === els.dropzone && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    els.folderInput.click();
  }
});

els.folderInput.addEventListener('change', () => {
  const files = [...els.folderInput.files].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
  els.folderInput.value = '';
  start(files);
});
els.zipInput.addEventListener('change', () => {
  const files = [...els.zipInput.files].map((file) => ({ path: file.name, file }));
  els.zipInput.value = '';
  start(files);
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
els.dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropzone.classList.remove('dragging');
  // Entries must be grabbed synchronously, before any await.
  const entries = [...e.dataTransfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null));
  let files;
  if (entries.length && entries.every(Boolean)) {
    files = [];
    for (const entry of entries) await walk(entry, '', files);
  } else {
    files = [...e.dataTransfer.files].map((file) => ({ path: file.name, file }));
  }
  start(files);
});

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

function suggestName(files) {
  if (files.length === 1 && /\.zip$/i.test(files[0].path)) return slugify(files[0].path.split('/').pop());
  const tops = new Set(files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '')));
  return tops.size === 1 ? slugify([...tops][0]) : '';
}

function showError(message, { conflict = false } = {}) {
  els.errorText.textContent = message;
  els.conflict.hidden = !conflict;
  els.error.hidden = false;
}

function setStage(stage) {
  els.dropzone.hidden = stage !== 'pick';
  els.progress.hidden = stage !== 'upload';
  els.result.hidden = stage !== 'done';
  els.name.disabled = stage === 'upload';
}

async function start(files) {
  els.error.hidden = true;
  files = files.filter((f) => !/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(f.path));
  if (!files.length) return showError('Složka je prázdná.');

  const name = slugify(els.name.value) || suggestName(files);
  if (!els.name.value && name) els.name.value = name;
  updatePreview();
  if (!name) {
    els.name.focus();
    state.pending = { files };
    return showError('Zadejte název webu a stiskněte Enter.');
  }

  let check;
  try {
    check = await api(`/check-name?name=${encodeURIComponent(name)}`);
  } catch (err) {
    return showError(err.message);
  }
  if (check.error) {
    state.pending = { files };
    els.name.focus();
    return showError(check.error);
  }
  if (check.exists) {
    state.pending = { files, name };
    if (state.config.authed) {
      return showError(`Web „${name}“ už existuje. Chcete ho nahradit tímto nahráním?`, { conflict: true });
    }
    els.name.focus();
    return showError(`Název „${name}“ je už obsazený. Zadejte jiný a stiskněte Enter.`);
  }
  upload(files, name, false);
}

$('#replace').addEventListener('click', () => {
  const { files, name } = state.pending || {};
  els.error.hidden = true;
  if (files) upload(files, name, true);
});
$('#cancel').addEventListener('click', () => {
  state.pending = null;
  els.error.hidden = true;
});

function upload(files, name, overwrite) {
  state.pending = null;
  const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);
  if (totalBytes > state.config.maxUploadMb * 1024 * 1024) {
    return showError(`Nahrávaná data mají ${formatBytes(totalBytes)}, limit je ${state.config.maxUploadMb} MB.`);
  }

  const form = new FormData();
  form.append('name', name);
  form.append('overwrite', overwrite ? '1' : '0');
  for (const { path, file } of files) {
    form.append('p', path);
    form.append('f', file, file.name);
  }

  setStage('upload');
  $('#progress-title').textContent = `Nahrávám ${name}…`;
  $('#progress-files').textContent = `${filesLabel(files.length)} · ${formatBytes(totalBytes)}`;
  els.bar.style.width = '0%';
  $('#progress-pct').textContent = '0%';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/sites');
  xhr.setRequestHeader('X-Requested-With', 'fetch');
  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    els.bar.style.width = `${pct}%`;
    $('#progress-pct').textContent = pct === 100 ? 'Zveřejňuji…' : `${pct}%`;
  });
  xhr.addEventListener('load', () => {
    let data = {};
    try {
      data = JSON.parse(xhr.responseText);
    } catch {
      /* not JSON */
    }
    if (xhr.status >= 200 && xhr.status < 300) return done(data);
    setStage('pick');
    if (xhr.status === 401) return init();
    if (xhr.status === 413 && !data.error) data.error = 'Nahrávaná data jsou pro server nebo proxy příliš velká.';
    if (data.exists && data.canOverwrite) {
      state.pending = { files, name };
      return showError(data.error + ' Chcete ho nahradit?', { conflict: true });
    }
    showError(data.error || `Nahrávání selhalo (HTTP ${xhr.status}).`);
  });
  xhr.addEventListener('error', () => {
    setStage('pick');
    showError('Nahrávání selhalo – zkontrolujte připojení a zkuste to znovu.');
  });
  xhr.send(form);
}

function done(site) {
  setStage('done');
  $('#result-title').textContent = site.replaced ? `Web ${site.name} byl aktualizován` : `Web ${site.name} je online`;
  $('#result-link').textContent = site.url;
  $('#result-link').href = site.url;
  $('#open').href = site.url;
  $('#result-note').textContent =
    `${filesLabel(site.files)}, ${formatBytes(site.bytes)}.` +
    (site.hasIndex ? '' : ' V hlavní složce chybí index.html, návštěvníci uvidí seznam souborů.');
}

$('#copy').addEventListener('click', () => copy($('#result-link').href));
$('#again').addEventListener('click', () => {
  els.name.value = '';
  updatePreview();
  setStage('pick');
});

init().catch((err) => {
  document.querySelector('main').textContent = `Nepodařilo se načíst: ${err.message}`;
});
