'use strict';

const data = { sites: [], users: [], whitelist: [], yourIp: '', storage: { used: 0, limit: 0 } };
let config;

async function init() {
  config = await api('/config');
  $('#login').hidden = Boolean(config.user);
  $('#forbidden').hidden = !config.user || config.admin;
  $('#panel').hidden = !config.admin;
  if (config.user && !config.admin) $('#forbidden-text').textContent = t('admin.forbiddenText', { email: config.user.email });
  if (config.admin) await load();
}

async function load() {
  try {
    const [sites, users, whitelist] = await Promise.all([api('/admin/sites'), api('/admin/users'), api('/admin/whitelist')]);
    data.sites = sites.sites;
    data.storage = sites.storage;
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
      tr.innerHTML = '<td><div class="site-name"><span></span> </div><a class="site-url" target="_blank" rel="noopener"></a><p class="site-size muted small"><span></span> · <span></span></p></td><td></td><td class="actions"></td>';
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
      // Size, and below it when the site last changed.
      const size = $('.site-size', tr).children;
      size[0].textContent = `${filesLabel(site.files)} · ${formatBytes(site.bytes)}`;
      size[1].textContent = t('chip.updated', { ago: timeAgo(site.updatedAt) });
      size[1].title = formatDateTime(site.updatedAt);
      // Same order as everywhere: edit, the rest, history, delete last.
      // "Delete permanently" is offered only once a site is deleted.
      const actions = [];
      if (!site.deletedAt) {
        actions.push(`<a class="btn btn-sm btn-accent" href="/?edit=${encodeURIComponent(site.name)}">${t('row.edit')}</a>`);
        actions.push(button(t('row.rename'), 'rename'));
        if (!site.owner) actions.push(button(t('row.newPw'), 'password'));
      }
      actions.push(button(t('admin.history'), 'audit', 'btn-quiet'));
      actions.push(site.deletedAt ? button(t('admin.purge'), 'purge', 'btn-danger') : button(t('row.delete'), 'delete', 'btn-danger'));
      cell(tr, 2).innerHTML = `<div class="actions-wrap">${actions.join('')}</div>`;
      return tr;
    }),
  );
  $('#sites-empty').hidden = sites.length > 0;
  const active = data.sites.filter((s) => !s.deletedAt);
  $('#count-sites').textContent = active.length;
  const share = data.storage.limit ? Math.min(1, data.storage.used / data.storage.limit) : 0;
  $('#storage-text').textContent = `${formatBytes(data.storage.used)} / ${formatBytes(data.storage.limit)}`;
  $('#storage-bar').style.width = `${(share * 100).toFixed(1)}%`;
  $('#storage-bar').classList.toggle('full', share >= 0.8);
  $('#stats').textContent = `${sitesLabel(active.length)} · ${t('usage.total', { used: formatBytes(data.storage.used), limit: formatBytes(data.storage.limit) })}`;
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
      const next = await uiPrompt(t('rename.label', { name }), name, { title: t('rename.title'), ok: t('rename.ok') });
      if (!next || slugify(next) === name) return;
      const result = await api(`/admin/sites/${site.id}/rename`, { method: 'POST', json: { name: next } });
      toast(t('admin.renamed', { name: result.name }));
    } else if (el.dataset.action === 'password') {
      if (!(await uiConfirm(t('admin.resetConfirm', { name }), { title: t('admin.resetTitle'), ok: t('row.newPw') }))) return;
      const result = await api(`/admin/sites/${site.id}/reset-password`, { method: 'POST' });
      await uiAlert(t('admin.resetPrompt', { name }), { title: t('admin.resetTitle'), value: result.password });
    } else if (el.dataset.action === 'delete') {
      const reason = await askReason(t('admin.deleteConfirm', { name, days: config.retentionDays }), Boolean(site.owner), { title: t('delete.title', { name }), ok: t('delete.ok') });
      if (reason === null) return;
      await api(`/admin/sites/${site.id}/delete`, { method: 'POST', json: { reason } });
      toast(t('admin.deleted', { name }));
    } else if (el.dataset.action === 'purge') {
      if (!(await uiConfirm(t('admin.purgeSiteConfirm'), { title: t('admin.purgeTitle', { name }), ok: t('admin.purge'), danger: true }))) return;
      await api(`/admin/sites/${site.id}/purge`, { method: 'POST' });
      toast(t('admin.purged', { name }));
    }
    await load();
  } catch (err) {
    uiError(err);
  }
});

// Confirms a measure; when the owner has an e-mail, an optional message
// (the reasons) is sent to them. Resolves with the message, '' or null (cancelled).
async function askReason(text, hasOwner, { title, ok }) {
  if (!hasOwner) return (await uiConfirm(text, { title, ok, danger: true })) ? '' : null;
  return uiDialog({
    title, ok, danger: true, multiline: true, optional: true, input: '',
    text: `${text}\n\n${t('admin.reasonHelp')}`,
    placeholder: t('admin.reasonPlaceholder'),
  });
}

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
      tr.innerHTML = '<td><div class="owner"><div class="owner-name"><b></b></div><span class="muted small"></span></div></td><td class="num"><span></span><br><code class="muted small"></code></td><td class="num hide-sm"></td><td class="actions"></td>';
      $('b', tr).textContent = `${user.firstName} ${user.lastName}`.trim() || '–';
      $('.owner-name', tr).insertAdjacentHTML('beforeend', statusChip(user));
      $('.owner .muted', tr).textContent = user.email;
      $('td:nth-child(2) span', tr).textContent = formatDateTime(user.createdAt);
      $('td:nth-child(2) code', tr).textContent = user.createdIp || '';
      cell(tr, 2).textContent = user.deletedSites ? `${user.sites} (+${user.deletedSites} ${t('admin.deletedShort')})` : String(user.sites);
      const actions = [button(t('admin.sites'), 'sites')];
      if (!user.isAdmin && !user.deletedAt) actions.push(user.blockedAt ? button(t('admin.unblock'), 'unblock') : button(t('admin.block'), 'block'));
      actions.push(button(t('admin.history'), 'audit', 'btn-quiet'));
      if (user.isAdmin) {
        $('.owner-name', tr).insertAdjacentHTML('beforeend', `<span class="chip">${t('admin.adminChip')}</span>`);
      } else {
        if (user.blockedAt) $('.owner-name', tr).insertAdjacentHTML('beforeend', `<span class="chip chip-danger">${t('admin.blockedChip')}</span>`);
        actions.push(user.deletedAt ? button(t('admin.purge'), 'purge', 'btn-danger') : button(t('row.delete'), 'delete', 'btn-danger'));
      }
      cell(tr, 3).innerHTML = `<div class="actions-wrap">${actions.join('')}</div>`;
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
    if (el.dataset.action === 'block' || el.dataset.action === 'unblock') {
      const blocked = el.dataset.action === 'block';
      const reason = blocked ? await askReason(t('admin.blockConfirm', { email: label }), true, { title: t('admin.blockTitle'), ok: t('admin.block') }) : '';
      if (reason === null) return;
      await api(`/admin/users/${user.id}/block`, { method: 'POST', json: { blocked, reason } });
      toast(t(blocked ? 'admin.blocked' : 'admin.unblocked', { email: label }));
    } else if (el.dataset.action === 'delete') {
      const reason = await askReason(t('admin.deleteUserConfirm', { email: label, days: config.retentionDays }), true, { title: t('admin.deleteUserTitle', { email: label }), ok: t('delete.ok') });
      if (reason === null) return;
      await api(`/admin/users/${user.id}/delete`, { method: 'POST', json: { reason } });
      toast(t('admin.userDeleted', { email: label }));
    } else if (el.dataset.action === 'purge') {
      if (!(await uiConfirm(t('admin.purgeUserConfirm'), { title: t('admin.purgeTitle', { name: label }), ok: t('admin.purge'), danger: true }))) return;
      await api(`/admin/users/${user.id}/purge`, { method: 'POST' });
      toast(t('admin.purged', { name: label }));
    }
    await load();
  } catch (err) {
    uiError(err);
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
  // The address this browser comes from, with a one-click way to allow it.
  const listed = data.whitelist.some((entry) => entry.ip === data.yourIp);
  $('#your-ip').textContent = t(listed ? 'admin.myIpListed' : 'admin.yourIp', { ip: data.yourIp });
  $('#add-my-ip').textContent = t('admin.myIp', { ip: data.yourIp });
  $('#add-my-ip').hidden = listed || !data.yourIp;
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
    uiError(err);
  }
});

$('#add-my-ip').addEventListener('click', async () => {
  const note = $('#whitelist-form').note.value.trim() || t('admin.myIpNote');
  try {
    await api('/admin/whitelist', { method: 'POST', json: { ip: data.yourIp, note } });
    $('#whitelist-form').reset();
    await load();
  } catch (err) {
    uiError(err);
  }
});

$('#whitelist-rows').addEventListener('click', async (e) => {
  const el = e.target.closest('button[data-action=remove]');
  if (!el) return;
  await api('/admin/whitelist/remove', { method: 'POST', json: { ip: el.closest('tr').dataset.ip } });
  await load();
});

/* ---------- tabs and filters ---------- */

// Built when the tab is first opened, over the active sites.
let visits = null;
function showTab(tab) {
  if (tab === 'visits') {
    const names = data.sites.filter((s) => !s.deletedAt).map((s) => s.name);
    if (visits) visits.reload();
    else visits = statsPanel($('#visits'), { endpoint: '/admin/stats', siteNames: names });
  }
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
