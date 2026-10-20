'use strict';

let allSites = [];

function sitesLabel(n) {
  if (n === 1) return '1 web';
  if (n >= 2 && n <= 4) return `${n} weby`;
  return `${n} webů`;
}

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
      row.dataset.name = site.name;
      $('.site-name', row).textContent = site.name;
      $('.site-url', row).textContent = site.url;
      $('.site-url', row).href = site.url;
      $('[data-files]', row).textContent = site.files ?? '–';
      $('[data-size]', row).textContent = formatBytes(site.bytes);
      $('[data-updated]', row).textContent = timeAgo(site.updatedAt);
      $('[data-updated]', row).title = site.updatedAt ? new Date(site.updatedAt).toLocaleString('cs-CZ') : '';
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
      const next = prompt(`Nový název pro „${name}“:`, name);
      if (!next || slugify(next) === name) return;
      const result = await api(`/sites/${encodeURIComponent(name)}/rename`, { method: 'POST', json: { name: next } });
      toast(`Přejmenováno na ${result.name}`);
      await load();
    } else if (button.dataset.action === 'delete') {
      if (!confirm(`Smazat „${name}“? Web ${site.url} bude trvale odstraněn.`)) return;
      await api(`/sites/${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast(`Smazáno: ${name}`);
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
  document.querySelector('main').textContent = `Nepodařilo se načíst: ${err.message}`;
});
