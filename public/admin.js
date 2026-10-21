'use strict';

const data = { whitelist: [], yourIp: '', activeSites: 0 };
let config;

// The server only serves this page to the signed-in admin.
async function init() {
  config = await api('/config');
  await load();
}

async function load() {
  try {
    const whitelist = await api('/admin/whitelist');
    data.whitelist = whitelist.ips;
    data.yourIp = whitelist.yourIp;
  } catch (err) {
    if (err.status === 404) return location.reload(); // signed out meanwhile
    throw err;
  }
  renderWhitelist();
  await Promise.all([siteList.reset(), userList.reset()]);
}

const cell = (tr, i) => tr.children[i];
const query = (tab) => $(`.filter[data-for="${tab}"]`).value.trim();
// The lists ask the server for one page at a time; search and filters too.
const pageUrl = (path, tab, cursor) =>
  `${path}?${new URLSearchParams({ q: query(tab), deleted: $(`#show-deleted-${tab}`).checked ? 'all' : 'active', ...(cursor ? { cursor } : {}) })}`;

function button(label, action, extra = '') {
  return `<button class="btn btn-sm ${extra}" data-action="${action}">${label}</button>`;
}

function statusChip(item) {
  if (!item.deletedAt) return '';
  const by = t(item.deletedBy === 'admin' ? 'admin.byAdmin' : 'admin.byUser');
  return `<span class="chip chip-danger" title="${t('admin.purgeAfter', { date: formatDateTime(item.purgeAfter) })}">${t('admin.deletedChip')} ${by}</span>`;
}

/* ---------- sites ---------- */

const siteList = infiniteList({
  list: $('#site-rows'),
  after: $('#site-rows').closest('.table-wrap'),
  empty: $('#sites-empty'),
  load: (cursor) => api(pageUrl('/admin/sites', 'sites', cursor)),
  render: siteRow,
  onPage: (page) => {
    data.activeSites = page.active;
    $('#count-sites').textContent = page.active;
    const { used, limit } = page.storage;
    const share = limit ? Math.min(1, used / limit) : 0;
    $('#storage-text').textContent = `${formatBytes(used)} / ${formatBytes(limit)}`;
    $('#storage-bar').style.width = `${(share * 100).toFixed(1)}%`;
    $('#storage-bar').classList.toggle('full', share >= 0.8);
    $('#stats').textContent = `${sitesLabel(page.total)}, ${t('usage.total', { used: formatBytes(used), limit: formatBytes(limit) })}`;
  },
});

function siteRow(site) {
  const tr = document.createElement('tr');
  tr.dataset.id = site.id;
  if (site.deletedAt) tr.classList.add('dim');
  tr.innerHTML = '<td><div class="site-name"><span></span> </div><a class="site-url" target="_blank" rel="noopener"></a><p class="site-size muted small"><span></span>, <span></span></p></td><td></td><td class="actions"></td>';
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
  size[0].textContent = `${filesLabel(site.files)}, ${formatBytes(site.bytes)}`;
  size[1].textContent = t('chip.updated', { ago: timeAgo(site.updatedAt) });
  size[1].title = formatDateTime(site.updatedAt);
  // An edit button and history; the rest is under "⋯", delete last.
  // "Delete permanently" is offered only once a site is deleted.
  let actions;
  if (site.deletedAt) actions = [button(t('preview.button'), 'preview', 'btn-accent'), button(t('admin.history'), 'audit'), moreMenu([[t('admin.purge'), 'purge', 'btn-danger']])];
  else {
    const more = [[t('row.rename'), 'rename']];
    if (!site.owner) more.push([t('row.newPw'), 'password']);
    more.push('-', [t('row.delete'), 'delete', 'btn-danger']);
    actions = [
      `<a class="btn btn-sm btn-accent" href="/?edit=${encodeURIComponent(site.name)}">${t('row.edit')}</a>`,
      button(t('admin.history'), 'audit'),
      moreMenu(more),
    ];
  }
  cell(tr, 2).innerHTML = `<div class="actions-wrap">${actions.join('')}</div>`;
  return tr;
}

$('#site-rows').addEventListener('click', async (e) => {
  const el = e.target.closest('button[data-action]');
  if (!el) return;
  const site = siteList.find((s) => s.id === Number(el.closest('tr').dataset.id));
  const { name } = site;
  try {
    if (el.dataset.action === 'preview') {
      // A deleted site, as a temporary preview in a new tab. The tab opens
      // right away (inside the click), so pop-up blockers let it through.
      const tab = window.open('', '_blank');
      try {
        const { preview } = await api(`/admin/sites/${site.id}/preview`, { method: 'POST' });
        if (tab) tab.location.href = preview.url;
        toast(t('admin.previewReady', { minutes: preview.minutes }));
      } catch (err) {
        tab?.close();
        throw err;
      }
      return;
    }
    if (el.dataset.action === 'audit') {
      return showAudit(t('admin.siteHistory', { name }), site.owner ? site.owner.email : t('admin.passwordSite'), `/admin/sites/${site.id}/audit`);
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

const userList = infiniteList({
  list: $('#user-rows'),
  after: $('#user-rows').closest('.table-wrap'),
  empty: $('#users-empty'),
  load: (cursor) => api(pageUrl('/admin/users', 'users', cursor)),
  render: userRow,
  onPage: (page) => {
    $('#count-users').textContent = page.active;
  },
});

function userRow(user) {
  const tr = document.createElement('tr');
  tr.dataset.id = user.id;
  if (user.deletedAt) tr.classList.add('dim');
  tr.innerHTML = '<td><div class="owner"><div class="owner-name"><b></b></div><span class="muted small"></span></div></td><td class="num"><span></span><br><code class="muted small"></code></td><td class="num hide-sm"></td><td class="actions"></td>';
  $('b', tr).textContent = `${user.firstName} ${user.lastName}`.trim() || '';
  $('.owner-name', tr).insertAdjacentHTML('beforeend', statusChip(user));
  $('.owner .muted', tr).textContent = user.email;
  $('td:nth-child(2) span', tr).textContent = formatDateTime(user.createdAt);
  $('td:nth-child(2) code', tr).textContent = user.createdIp || '';
  cell(tr, 2).textContent = user.deletedSites ? `${user.sites} (+${user.deletedSites} ${t('admin.deletedShort')})` : String(user.sites);
  const actions = [button(t('admin.sites'), 'sites'), button(t('admin.history'), 'audit')];
  if (user.isAdmin) {
    $('.owner-name', tr).insertAdjacentHTML('beforeend', `<span class="chip">${t('admin.adminChip')}</span>`);
  } else {
    if (user.blockedAt) $('.owner-name', tr).insertAdjacentHTML('beforeend', `<span class="chip chip-danger">${t('admin.blockedChip')}</span>`);
    if (user.deletedAt) actions.push(moreMenu([[t('admin.purge'), 'purge', 'btn-danger']]));
    else {
      const block = user.blockedAt ? [t('admin.unblock'), 'unblock'] : [t('admin.block'), 'block'];
      actions.push(moreMenu([block, '-', [t('row.delete'), 'delete', 'btn-danger']]));
    }
  }
  cell(tr, 3).innerHTML = `<div class="actions-wrap">${actions.join('')}</div>`;
  return tr;
}

$('#user-rows').addEventListener('click', async (e) => {
  const el = e.target.closest('button[data-action]');
  if (!el) return;
  const user = userList.find((u) => u.id === Number(el.closest('tr').dataset.id));
  const label = user.email;
  try {
    if (el.dataset.action === 'audit') {
      return showAudit(t('admin.userHistory', { name: `${user.firstName} ${user.lastName}`.trim() || label }), label, `/admin/users/${user.id}/audit`);
    }
    if (el.dataset.action === 'sites') {
      $('.filter[data-for="sites"]').value = user.email;
      $('#show-deleted-sites').checked = Boolean(user.deletedAt);
      siteList.reset();
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

// The history of a site or user, loaded a page at a time as it is scrolled.
let auditSource = '';
const auditDialogList = infiniteList({
  list: $('#audit-rows'),
  after: $('#audit-rows').closest('.table-wrap') || $('#audit-rows').closest('table'),
  load: async (cursor) => {
    const page = await api(`${auditSource}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    return { items: page.events, next: page.next };
  },
  render: (event) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="num"></td><td></td><td></td><td class="num"><code></code></td><td class="detail"></td>';
    cell(tr, 0).textContent = formatDateTime(event.at);
    cell(tr, 1).textContent = actionLabel(event.action);
    cell(tr, 2).textContent = event.site || '';
    $('code', tr).textContent = event.ip || '';
    const detail = event.detail || {};
    cell(tr, 4).textContent = Object.entries(detail)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}: ${k === 'bytes' ? formatBytes(v) : v}`)
      .join(', ');
    return tr;
  },
  onPage: (page, items) => {
    if (items.length) return;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="5" class="muted">${t('admin.noHistory')}</td>`;
    $('#audit-rows').append(tr);
  },
});

function showAudit(title, subtitle, source) {
  $('#audit-title').textContent = title;
  $('#audit-sub').textContent = subtitle;
  auditSource = source;
  $('#audit-dialog').showModal();
  return auditDialogList.reset();
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
    if (visits) visits.reload();
    else visits = statsPanel($('#visits'), { endpoint: '/admin/stats', sites: '/admin/sites', siteCount: data.activeSites });
  }
  for (const el of document.querySelectorAll('[role=tab]')) el.setAttribute('aria-selected', String(el.dataset.tab === tab));
  for (const el of document.querySelectorAll('[data-panel]')) el.hidden = el.dataset.panel !== tab;
}
for (const el of document.querySelectorAll('[role=tab]')) el.addEventListener('click', () => showTab(el.dataset.tab));
const lists = { sites: siteList, users: userList };
for (const el of document.querySelectorAll('.filter')) el.addEventListener('input', debounce(() => lists[el.dataset.for].reset()));
$('#show-deleted-sites').addEventListener('change', () => siteList.reset());
$('#show-deleted-users').addEventListener('change', () => userList.reset());

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  location.href = '/';
});

init().catch((err) => {
  document.querySelector('main').textContent = t('err.load', { message: err.message });
});
