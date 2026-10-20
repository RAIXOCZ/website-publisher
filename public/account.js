'use strict';

let config;

async function init() {
  config = await api('/config');
  $('#signin').hidden = Boolean(config.user);
  $('#account').hidden = !config.user;
  if (config.user) await load();
}

async function load() {
  let me;
  try {
    me = await api('/me');
  } catch (err) {
    if (err.status === 401) return init();
    throw err;
  }
  const { user, sites, tokens } = me;
  $('#account-name').textContent = `${user.firstName} ${user.lastName}`.trim() || user.email;
  $('#account-email').textContent = t('account.since', { email: user.email, date: new Date(user.createdAt).toLocaleDateString(LANG) });
  $('#profile').firstName.value = user.firstName;
  $('#profile').lastName.value = user.lastName;
  $('#delete-text').textContent = t('account.deleteText', { days: config.retentionDays, contact: config.contact });
  $('#curl-example').textContent = curlExample();
  renderSites(sites);
  renderTokens(tokens);
  await renderAudit();
}

/* ---------- sites ---------- */

function renderSites(sites) {
  $('#sites-empty').hidden = sites.length > 0;
  $('#sites').replaceChildren(
    ...sites.map((site) => {
      const card = document.createElement('article');
      card.className = 'site-card glass';
      card.dataset.name = site.name;
      card.dataset.initial = site.name[0];
      card.innerHTML = `<div><h3></h3><a class="site-url" target="_blank" rel="noopener"></a></div>
        <div class="chips site-meta"></div>
        <div class="site-actions">
          <a class="btn btn-sm" data-action="edit"></a>
          <button class="btn btn-sm" data-action="rename"></button>
          <button class="btn btn-sm btn-danger" data-action="delete"></button>
        </div>`;
      $('h3', card).textContent = site.name;
      $('.site-url', card).textContent = site.url;
      $('.site-url', card).href = site.url;
      $('[data-action=edit]', card).textContent = t('row.edit');
      $('[data-action=edit]', card).href = `/?edit=${encodeURIComponent(site.name)}`;
      $('[data-action=rename]', card).textContent = t('row.rename');
      $('[data-action=delete]', card).textContent = t('row.delete');
      const chips = [filesLabel(site.files), formatBytes(site.bytes), t('chip.updated', { ago: timeAgo(site.updatedAt) })];
      $('.site-meta', card).replaceChildren(...chips.map((text) => Object.assign(document.createElement('span'), { className: 'chip', textContent: text })));
      return card;
    }),
  );
}

$('#sites').addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const name = button.closest('.site-card').dataset.name;
  try {
    if (button.dataset.action === 'rename') {
      const next = prompt(t('admin.renamePrompt', { name }), name);
      if (!next || slugify(next) === name) return;
      const site = await api(`/sites/${encodeURIComponent(name)}/rename`, { method: 'POST', json: { name: next } });
      toast(t('admin.renamed', { name: site.name }));
    } else if (button.dataset.action === 'delete') {
      if (!confirm(`${t('confirm.deleteOwn', { name, url: $('.site-url', button.closest('.site-card')).href })}\n\n${retentionNote(config)}`)) return;
      await api(`/sites/${encodeURIComponent(name)}/delete`, { method: 'POST', json: {} });
      toast(t('toast.deleted', { name }));
    }
    await load();
  } catch (err) {
    alert(err.message);
  }
});

/* ---------- profile ---------- */

$('#profile').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    await api('/me', { method: 'POST', json: { firstName: form.firstName.value, lastName: form.lastName.value } });
    toast(t('toast.saved'));
    await load();
  } catch (err) {
    alert(err.message);
  }
});

/* ---------- API tokens ---------- */

function curlExample(token = '$FREEPAGES_TOKEN') {
  const origin = location.origin;
  return [
    t('account.curlZip'),
    `curl -H "Authorization: Bearer ${token}" \\`,
    '     -F name=muj-web -F overwrite=1 -F f=@web.zip \\',
    `     ${origin}/api/sites`,
    '',
    t('account.curlFolder'),
    'cd muj-web && args=() && while IFS= read -r f; do args+=(-F "p=${f#./}" -F "f=@$f"); done < <(find . -type f) && \\',
    `curl -H "Authorization: Bearer ${token}" -F name=muj-web -F overwrite=1 "\${args[@]}" ${origin}/api/sites`,
  ].join('\n');
}

function renderTokens(tokens) {
  const active = tokens.filter((tok) => !tok.revokedAt);
  $('#tokens-table').hidden = active.length === 0;
  $('#tokens-empty').hidden = active.length > 0;
  $('#tokens').replaceChildren(
    ...active.map((tok) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><b></b> <code class="muted"></code></td><td class="num"></td><td class="num"></td><td class="actions"><button class="btn btn-sm btn-danger"></button></td>';
      $('b', tr).textContent = tok.name;
      $('code', tr).textContent = `${tok.prefix}…`;
      tr.children[1].textContent = formatDateTime(tok.createdAt);
      tr.children[2].textContent = tok.lastUsedAt ? timeAgo(tok.lastUsedAt) : t('account.never');
      const button = $('button', tr);
      button.textContent = t('account.revoke');
      button.addEventListener('click', async () => {
        if (!confirm(t('account.revokeConfirm', { name: tok.name }))) return;
        await api(`/me/tokens/${tok.id}/revoke`, { method: 'POST' });
        $('#token-new').hidden = true;
        await load();
      });
      return tr;
    }),
  );
}

$('#token-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { token } = await api('/me/tokens', { method: 'POST', json: { name: e.target.name.value } });
    e.target.reset();
    await load();
    $('#token-value').textContent = token;
    $('#token-new').hidden = false;
    $('#curl-example').textContent = curlExample(token);
  } catch (err) {
    alert(err.message);
  }
});
$('#token-copy').addEventListener('click', () => copy($('#token-value').textContent, t('toast.tokenCopied')));

/* ---------- audit log ---------- */

async function renderAudit() {
  const { events } = await api('/me/audit');
  $('#audit').replaceChildren(
    ...events.map((event) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="num"></td><td></td><td></td><td class="num"><code></code></td>';
      tr.children[0].textContent = formatDateTime(event.at);
      tr.children[1].textContent = actionLabel(event.action);
      tr.children[2].textContent = event.site || '';
      $('code', tr).textContent = event.ip || '–';
      return tr;
    }),
  );
}

/* ---------- account deletion ---------- */

$('#delete-account').addEventListener('click', async () => {
  if (!confirm(t('account.deleteConfirm', { days: config.retentionDays, contact: config.contact }))) return;
  try {
    await api('/me/delete', { method: 'POST' });
    $('#delete-sent').textContent = t('account.deleteSent', { email: config.user.email });
    $('#delete-sent').hidden = false;
  } catch (err) {
    alert(err.message);
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  location.href = '/';
});

setupEmailLogin($('#signin-form'));

init().catch((err) => {
  document.querySelector('main').textContent = t('err.load', { message: err.message });
});
