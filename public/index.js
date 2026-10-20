'use strict';

const state = {
  config: null,
  pending: null, // files waiting for a name fix or a password: { files, name? }
};

const els = {
  name: $('#name'),
  preview: $('#url-preview'),
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

$('#pick-folder').addEventListener('click', async (e) => {
  e.stopPropagation();
  start(await pickFiles());
});
$('#pick-zip').addEventListener('click', async (e) => {
  e.stopPropagation();
  start(await pickFiles({ zip: true }));
});
els.dropzone.addEventListener('click', async () => start(await pickFiles()));
els.dropzone.addEventListener('keydown', async (e) => {
  if (e.target === els.dropzone && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    start(await pickFiles());
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

function showError(message, { askPassword = false } = {}) {
  els.errorText.textContent = message;
  els.conflict.hidden = !askPassword;
  els.error.hidden = false;
  if (askPassword) els.conflictPassword.focus();
}

function setStage(stage) {
  els.dropzone.hidden = stage !== 'pick';
  els.progress.hidden = stage !== 'upload';
  els.result.hidden = stage !== 'done';
  els.name.disabled = stage === 'upload';
}

async function start(files) {
  els.error.hidden = true;
  files = cleanFiles(files);
  if (!files.length) return;

  const name = slugify(els.name.value) || suggestName(files);
  if (!els.name.value && name) els.name.value = name;
  updatePreview();
  state.pending = { files, name };
  if (!name) {
    els.name.focus();
    return showError('Zadejte název webu a stiskněte Enter.');
  }

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
  if (check.exists) {
    const saved = ownedPassword(name);
    els.conflictPassword.value = saved || '';
    return showError(
      saved
        ? `Web „${name}“ už existuje a je mezi vašimi weby. Chcete ho nahradit tímto nahráním?`
        : `Web „${name}“ už existuje. Pokud je váš, zadejte jeho heslo. Jinak zvolte jiný název a stiskněte Enter.`,
      { askPassword: true },
    );
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
$('#cancel').addEventListener('click', () => {
  state.pending = null;
  els.error.hidden = true;
});

async function upload(files, name, password = null) {
  const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);
  if (totalBytes > state.config.maxUploadMb * 1024 * 1024) {
    return showError(`Nahrávaná data mají ${formatBytes(totalBytes)}, limit je ${state.config.maxUploadMb} MB.`);
  }

  setStage('upload');
  $('#progress-title').textContent = `Nahrávám ${name}…`;
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
      $('#progress-pct').textContent = pct === 100 ? 'Zveřejňuji…' : `${pct}%`;
    },
  });

  if (status >= 200 && status < 300) {
    state.pending = null;
    if (data.password) rememberSite(data.name, data.password);
    else if (password) rememberSite(data.name, password);
    done(data);
    renderMySites();
    return;
  }
  setStage('pick');
  if (data.exists) {
    state.pending = { files, name };
    return showError(data.wrongPassword ? `${data.error} Zkuste to znovu, nebo zvolte jiný název.` : data.error, { askPassword: true });
  }
  showError(data.error);
}

function done(site) {
  setStage('done');
  $('#result-title').textContent = site.replaced ? `Web ${site.name} byl aktualizován` : `Web ${site.name} je online`;
  $('#result-link').textContent = site.url;
  $('#result-link').href = site.url;
  $('#open').href = site.url;
  $('#result-password').hidden = !site.password;
  $('#result-password-value').textContent = site.password || '';
  $('#result-note').textContent =
    `${filesLabel(site.files)}, ${formatBytes(site.bytes)}.` +
    (site.hasIndex ? '' : ' V hlavní složce chybí index.html, návštěvníci uvidí seznam souborů.');
}

$('#copy').addEventListener('click', () => copy($('#result-link').href));
$('#copy-password').addEventListener('click', () => copy($('#result-password-value').textContent, 'Heslo zkopírováno'));
$('#again').addEventListener('click', () => {
  els.name.value = '';
  updatePreview();
  setStage('pick');
});

/* ---------- my sites ---------- */

async function renderMySites() {
  const owned = loadOwned();
  const list = $('#my-list');
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
      row.dataset.name = name;
      $('.site-name', row).textContent = name;
      const url = info.url || siteUrl(name);
      $('.site-url', row).textContent = url;
      $('.site-url', row).href = url;
      $('.site-pw code', row).textContent = password;
      const meta = $('.site-meta', row);
      const ok = info.status === 'ok' || info.status === 'unknown';
      if (info.status === 'ok') {
        meta.textContent = `${filesLabel(info.files)} · ${formatBytes(info.bytes)} · aktualizováno ${timeAgo(info.updatedAt)}`;
      } else if (info.status === 'missing') {
        meta.textContent = 'Web už neexistuje (byl smazán nebo přejmenován).';
      } else if (info.status === 'wrong-password') {
        meta.textContent = 'Uložené heslo už neplatí.';
      }
      if (!ok) row.classList.add('site-row-dim');
      for (const action of ['update', 'delete']) $(`[data-action="${action}"]`, row).hidden = !ok;
      $('[data-action="forget"]', row).hidden = ok;
      return row;
    }),
  );
}

$('#my-list').addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const row = button.closest('.site-row');
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
    if (!confirm(`Smazat web „${name}“? Adresa ${url} přestane fungovat.`)) return;
    try {
      await api(`/sites/${encodeURIComponent(name)}/delete`, { method: 'POST', json: { password } });
      forgetSite(name);
      toast(`Web ${name} byl smazán`);
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
      throw new Error(result.status === 'missing' ? `Web „${name}“ neexistuje.` : 'Nesprávné heslo k webu.');
    }
    rememberSite(name, password);
    form.reset();
    form.hidden = true;
    toast(`Web ${name} přidán`);
    renderMySites();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

init().catch((err) => {
  document.querySelector('main').textContent = `Nepodařilo se načíst: ${err.message}`;
});
