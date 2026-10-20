'use strict';

const data = { sites: [], users: [], whitelist: [], yourIp: '' };
let config;

async function init() {
  config = await api('/config');
  $('#login').hidden = Boolean(config.user);
  $('#forbidden').hidden = !config.user || config.admin;
  $('#panel').hidden = !config.admin;
  $('#nav').hidden = !config.admin;
  if (config.user && !config.admin) $('#forbidden-text').textContent = t('admin.forbiddenText', { email: config.user.email });
  if (config.admin) await load();
}

async function load() {
  try {
    const [sites, users, whitelist] = await Promise.all([api('/admin/sites'), api('/admin/users'), api('/admin/whitelist')]);
    data.sites = sites.sites;
    data.users = users.users;
    data.whitelist = whitelist.ips;
    data.yourIp = whitelist.yourIp;
  } catch (err) {
    if (err.status === 401 || err.status === 403) return init();
    throw err;
  }
  render();
}

function render() {
  renderSites();
  renderUsers();
  renderWhitelist();
}

const cell = (tr, i) => tr.children[i];
const matches = (query, ...values) => !query || values.some((v) => String(v || '').toLowerCase().includes(query));
const query = (tab) => $(`.filter[data-for="${tab}"]`).value.trim().toLowerCase();

function button(label, action, extra = '') {
  return `<button class="btn btn-sm ${extra}" data-action="${action}">${label}</button>`;
}

function statusChip(item) {
  if (!item.deletedAt) return '';
  const by = t(item.deletedBy === 'admin' ? 'admin.byAdmin' : 'admin.byUser');
  return `<span class="chip chip-danger" title="${t('admin.purgeAfter', { date: formatDateTime(item.purgeAfter) })}">${t('admin.deletedChip')} · ${by}</span>`;
}

/* ---------- sites ---------- */

function renderSites() {
  const q = query('sites');
  const showDeleted = $('#show-deleted-sites').checked;
  const sites = data.sites.filter(
    (s) => (showDeleted || !s.deletedAt) && matches(q, s.name, s.owner?.email, s.owner?.firstName, s.owner?.lastName),
  );
  $('#site-rows').replaceChildren(
    ...sites.map((site) => {
      const tr = document.createElement('tr');
      tr.dataset.id = site.id;
      if (site.deletedAt) tr.classList.add('dim');
      tr.innerHTML = '<td><div class="site-name"><span></span> </div><a class="site-url" target="_blank" rel="noopener"></a></td><td></td><td class="num hide-sm"></td><td class="num"></td><td class="actions"></td>';
      $('.site-name span', tr).textContent = site.name;
      $('.site-name', tr).insertAdjacentHTML('beforeend', statusChip(site));
      if (site.deletedAt) $('.site-url', tr).remove();
      else {
        $('.site-url', tr).textContent = site.url;
        $('.site-url', tr).href = site.url;
      }
      if (site.owner) {
        cell(tr, 1).innerHTML = '<div class="owner"><b></b><span class="muted small"></span></div>';
        $('b', cell(tr, 1)).textContent = `${site.owner.firstName} ${site.owner.lastName}`.trim();
        $('span', cell(tr, 1)).textContent = site.owner.email;
      } else {
        cell(tr, 1).innerHTML = `<span class="chip">${t('admin.passwordSite')}</span>`;
      }
      cell(tr, 2).textContent = `${filesLabel(site.files)} · ${formatBytes(site.bytes)}`;
      cell(tr, 3).textContent = timeAgo(site.updatedAt);
      cell(tr, 3).title = formatDateTime(site.updatedAt);
      const actions = [button(t('admin.history'), 'audit')];
      if (!site.deletedAt) {
        actions.push(`<a class="btn btn-sm" href="/?edit=${encodeURIComponent(site.name)}">${t('row.edit')}</a>`);
        actions.push(button(t('row.rename'), 'rename'));
        if (!site.owner) actions.push(button(t('row.newPw'), 'password'));
        actions.push(button(t('row.delete'), 'delete', 'btn-danger'));
      }
      actions.push(button(t('admin.purge'), 'purge', 'btn-danger'));
      cell(tr, 4).innerHTML = actions.join('');
      return tr;
    }),
  );
  $('#sites-empty').hidden = sites.length > 0;
  const active = data.sites.filter((s) => !s.deletedAt);
  $('#count-sites').textContent = active.length;
  $('#stats').textContent = `${sitesLabel(active.length)} · ${formatBytes(active.reduce((sum, s) => sum + (s.bytes || 0), 0))}`;
}

$('#site-rows').addEventListener('click', async (e) => {
  const el = e.target.closest('button[data-action]');
  if (!el) return;
  const site = data.sites.find((s) => s.id === Number(el.closest('tr').dataset.id));
  const { name } = site;
  try {
    if (el.dataset.action === 'audit') {
      const { events } = await api(`/admin/sites/${site.id}/audit`);
      return showAudit(t('admin.siteHistory', { name }), site.owner ? site.owner.email : t('admin.passwordSite'), events);
    }
    if (el.dataset.action === 'rename') {
      const next = prompt(t('admin.renamePrompt', { name }), name);
      if (!next || slugify(next) === name) return;
      const result = await api(`/admin/sites/${site.id}/rename`, { method: 'POST', json: { name: next } });
      toast(t('admin.renamed', { name: result.name }));
    } else if (el.dataset.action === 'password') {
      if (!confirm(t('admin.resetConfirm', { name }))) return;
      const result = await api(`/admin/sites/${site.id}/reset-password`, { method: 'POST' });
      prompt(t('admin.resetPrompt', { name }), result.password);
    } else if (el.dataset.action === 'delete') {
      if (!confirm(t('admin.deleteConfirm', { name, days: config.retentionDays }))) return;
      await api(`/admin/sites/${site.id}/delete`, { method: 'POST' });
      toast(t('admin.deleted', { name }));
    } else if (el.dataset.action === 'purge') {
      if (!confirm(t('admin.purgeSiteConfirm', { name }))) return;
      await api(`/admin/sites/${site.id}/purge`, { method: 'POST' });
      toast(t('admin.purged', { name }));
    }
    await load();
  } catch (err) {
    alert(err.message);
  }
});

/* ---------- users ---------- */

function renderUsers() {
  const q = query('users');
  const showDeleted = $('#show-deleted-users').checked;
  const users = data.users.filter((u) => (showDeleted || !u.deletedAt) && matches(q, u.email, u.firstName, u.lastName, u.createdIp));
  $('#user-rows').replaceChildren(
    ...users.map((user) => {
      const tr = document.createElement('tr');
      tr.dataset.id = user.id;
      if (user.deletedAt) tr.classList.add('dim');
      tr.innerHTML = '<td><div class="owner"><b></b><span class="muted small"></span></div></td><td class="num"><span></span><br><code class="muted small"></code></td><td class="num hide-sm"></td><td class="actions"></td>';
      $('b', tr).textContent = `${user.firstName} ${user.lastName}`.trim() || '–';
      $('b', tr).insertAdjacentHTML('afterend', ` ${statusChip(user)}`);
      $('.owner .muted', tr).textContent = user.email;
      $('td:nth-child(2) span', tr).textContent = formatDateTime(user.createdAt);
      $('td:nth-child(2) code', tr).textContent = user.createdIp || '';
      cell(tr, 2).textContent = user.deletedSites ? `${user.sites} (+${user.deletedSites} ${t('admin.deletedShort')})` : String(user.sites);
      const actions = [button(t('admin.history'), 'audit'), button(t('admin.sites'), 'sites')];
      if (user.isAdmin) {
        $('b', tr).insertAdjacentHTML('afterend', ` <span class="chip">${t('admin.adminChip')}</span>`);
      } else {
        if (!user.deletedAt) actions.push(button(t('row.delete'), 'delete', 'btn-danger'));
        actions.push(button(t('admin.purge'), 'purge', 'btn-danger'));
      }
      cell(tr, 3).innerHTML = actions.join('');
      return tr;
    }),
  );
  $('#users-empty').hidden = users.length > 0;
  $('#count-users').textContent = data.users.filter((u) => !u.deletedAt).length;
}

$('#user-rows').addEventListener('click', async (e) => {
  const el = e.target.closest('button[data-action]');
  if (!el) return;
  const user = data.users.find((u) => u.id === Number(el.closest('tr').dataset.id));
  const label = user.email;
  try {
    if (el.dataset.action === 'audit') {
      const { events } = await api(`/admin/users/${user.id}/audit`);
      return showAudit(t('admin.userHistory', { name: `${user.firstName} ${user.lastName}`.trim() || label }), label, events);
    }
    if (el.dataset.action === 'sites') {
      $('.filter[data-for="sites"]').value = user.email;
      $('#show-deleted-sites').checked = Boolean(user.deletedAt);
      renderSites();
      return showTab('sites');
    }
    if (el.dataset.action === 'delete') {
      if (!confirm(t('admin.deleteUserConfirm', { email: label, days: config.retentionDays }))) return;
      await api(`/admin/users/${user.id}/delete`, { method: 'POST' });
      toast(t('admin.userDeleted', { email: label }));
    } else if (el.dataset.action === 'purge') {
      if (!confirm(t('admin.purgeUserConfirm', { email: label }))) return;
      await api(`/admin/users/${user.id}/purge`, { method: 'POST' });
      toast(t('admin.purged', { name: label }));
    }
    await load();
  } catch (err) {
    alert(err.message);
  }
});

/* ---------- audit dialog ---------- */

function showAudit(title, subtitle, events) {
  $('#audit-title').textContent = title;
  $('#audit-sub').textContent = subtitle;
  const rows = events.map((event) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="num"></td><td></td><td></td><td class="num"><code></code></td><td class="detail"></td>';
    cell(tr, 0).textContent = formatDateTime(event.at);
    cell(tr, 1).textContent = actionLabel(event.action);
    cell(tr, 2).textContent = event.site || '';
    $('code', tr).textContent = event.ip || '–';
    const detail = event.detail || {};
    cell(tr, 4).textContent = Object.entries(detail)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}: ${k === 'bytes' ? formatBytes(v) : v}`)
      .join(' · ');
    return tr;
  });
  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="5" class="muted">${t('admin.noHistory')}</td>`;
    rows.push(tr);
  }
  $('#audit-rows').replaceChildren(...rows);
  $('#audit-dialog').showModal();
}
$('#audit-close').addEventListener('click', () => $('#audit-dialog').close());
$('#audit-dialog').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

/* ---------- IP whitelist ---------- */

function renderWhitelist() {
  $('#your-ip').textContent = t('admin.yourIp', { ip: data.yourIp });
  $('#whitelist-rows').replaceChildren(
    ...data.whitelist.map((entry) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><code></code></td><td></td><td class="num"></td><td class="actions">${button(t('admin.ipRemove'), 'remove', 'btn-danger')}</td>`;
      $('code', tr).textContent = entry.ip;
      cell(tr, 1).textContent = entry.note;
      cell(tr, 2).textContent = formatDateTime(entry.createdAt);
      tr.dataset.ip = entry.ip;
      return tr;
    }),
  );
  $('#whitelist-empty').hidden = data.whitelist.length > 0;
  $('#count-whitelist').textContent = data.whitelist.length;
}

$('#whitelist-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    await api('/admin/whitelist', { method: 'POST', json: { ip: form.ip.value.trim(), note: form.note.value.trim() } });
    form.reset();
    await load();
  } catch (err) {
    alert(err.message);
  }
});

$('#whitelist-rows').addEventListener('click', async (e) => {
  const el = e.target.closest('button[data-action=remove]');
  if (!el) return;
  await api('/admin/whitelist/remove', { method: 'POST', json: { ip: el.closest('tr').dataset.ip } });
  await load();
});

/* ---------- tabs and filters ---------- */

function showTab(tab) {
  for (const el of document.querySelectorAll('[role=tab]')) el.setAttribute('aria-selected', String(el.dataset.tab === tab));
  for (const el of document.querySelectorAll('[data-panel]')) el.hidden = el.dataset.panel !== tab;
}
for (const el of document.querySelectorAll('[role=tab]')) el.addEventListener('click', () => showTab(el.dataset.tab));
for (const el of document.querySelectorAll('.filter')) el.addEventListener('input', render);
$('#show-deleted-sites').addEventListener('change', renderSites);
$('#show-deleted-users').addEventListener('change', renderUsers);

$('#logout').addEventListener('click', logout);
$('#switch-account').addEventListener('click', logout);
setupEmailLogin($('#login-form'));

init().catch((err) => {
  document.querySelector('main').textContent = t('err.load', { message: err.message });
});
