'use strict';

let allSites = [];

async function init() {
  const config = await api('/config');
  $('#login').hidden = config.authed;
  $('#panel').hidden = !config.authed;
  $('#nav').hidden = !config.authed;
  if (config.authed) await load();
}

async function load() {
  try {
    allSites = (await api('/sites')).sites;
  } catch (err) {
    if (err.status === 401) return init();
    throw err;
  }
  render();
}

function render() {
  const query = $('#filter').value.trim().toLowerCase();
  const sites = allSites.filter((s) => s.name.includes(query));
  const rows = $('#rows');
  rows.replaceChildren(
    ...sites.map((site) => {
      const row = $('#row').content.firstElementChild.cloneNode(true);
      applyI18n(row);
      row.dataset.name = site.name;
      $('.site-name span', row).textContent = site.name;
      $('[data-nopw]', row).hidden = site.hasPassword;
      $('.site-url', row).textContent = site.url;
      $('.site-url', row).href = site.url;
      $('[data-files]', row).textContent = site.files ?? '–';
      $('[data-size]', row).textContent = formatBytes(site.bytes);
      $('[data-updated]', row).textContent = timeAgo(site.updatedAt);
      $('[data-updated]', row).title = site.updatedAt ? new Date(site.updatedAt).toLocaleString(LANG) : '';
      return row;
    }),
  );
  $('#empty').hidden = allSites.length > 0;
  const total = allSites.reduce((sum, s) => sum + (s.bytes || 0), 0);
  $('#stats').textContent = `${sitesLabel(allSites.length)} · ${formatBytes(total)}`;
}

$('#rows').addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const name = button.closest('tr').dataset.name;
  const site = allSites.find((s) => s.name === name);
  try {
    if (button.dataset.action === 'copy') {
      copy(site.url);
    } else if (button.dataset.action === 'rename') {
      const next = prompt(t('admin.renamePrompt', { name }), name);
      if (!next || slugify(next) === name) return;
      const result = await api(`/sites/${encodeURIComponent(name)}/rename`, { method: 'POST', json: { name: next } });
      toast(t('admin.renamed', { name: result.name }));
      await load();
    } else if (button.dataset.action === 'replace') {
      const files = cleanFiles(await pickFiles());
      if (!files.length) return;
      button.disabled = true;
      const { status, data } = await uploadSite({
        files,
        name,
        overwrite: true,
        onProgress: (p) => (button.textContent = `${Math.round(p * 100)} %`),
      });
      button.disabled = false;
      button.textContent = t('row.replace');
      if (status < 200 || status >= 300) throw new Error(data.error);
      toast(t('admin.replaced', { name }));
      await load();
    } else if (button.dataset.action === 'password') {
      if (!confirm(t('admin.resetConfirm', { name }))) return;
      const result = await api(`/sites/${encodeURIComponent(name)}/reset-password`, { method: 'POST' });
      prompt(t('admin.resetPrompt', { name }), result.password);
      await load();
    } else if (button.dataset.action === 'delete') {
      if (!confirm(t('admin.deleteConfirm', { name, url: site.url }))) return;
      await api(`/sites/${encodeURIComponent(name)}/delete`, { method: 'POST' });
      toast(t('admin.deleted', { name }));
      await load();
    }
  } catch (err) {
    alert(err.message);
  }
});

$('#filter').addEventListener('input', render);
$('#logout').addEventListener('click', logout);
setupLogin($('#login form'), init);

init().catch((err) => {
  document.querySelector('main').textContent = t('err.load', { message: err.message });
});
