'use strict';

let config;

async function init() {
  config = await api('/config');
  $('#signin').hidden = Boolean(config.user);
  $('#account').hidden = !config.user;
  if (config.user) await load();
  if (new URLSearchParams(location.search).has('welcome')) {
    history.replaceState(null, '', location.pathname);
    toast(t('register.welcome'));
  }
}

async function load() {
  let me;
  try {
    me = await api('/me');
  } catch (err) {
    if (err.status === 401) return init();
    throw err;
  }
  const { user, siteCount, tokens, usage } = me;
  $('#account-name').textContent = `${user.firstName} ${user.lastName}`.trim() || user.email;
  $('#account-avatar').textContent = (user.firstName || user.email)[0].toUpperCase();
  $('#account-email').textContent = user.email;
  $('#account-email').title = user.email;
  $('#account-since').textContent = t('account.since', { date: new Date(user.createdAt).toLocaleDateString(LANG) });
  $('#profile').firstName.value = user.firstName;
  $('#profile').lastName.value = user.lastName;
  $('#delete-text').textContent = t('account.deleteText', { days: config.retentionDays, contact: config.contact });
  $('#admin-link').hidden = !config.admin;
  $('#blocked-notice').hidden = !user.blocked;
  $('#delete-account').hidden = user.isAdmin;
  $('#delete-admin').hidden = !user.isAdmin;
  $('#cli-how').href = LANG === 'en' ? '/docs#en-api-keys' : '/docs#cs-api-klice';
  $('#sites-search').hidden = siteCount < 6 && !$('#sites-search').value;
  renderUsage(usage);
  renderVisits(siteCount);
  renderTokens(tokens);
  await Promise.all([siteList.reset(), auditList.reset()]);
}

/* ---------- sites ---------- */

// Loaded a page at a time while scrolling; the search asks the server.
const siteList = infiniteList({
  list: $('#sites'),
  load: (cursor) => api(`/me/sites?${new URLSearchParams({ q: $('#sites-search').value.trim(), ...(cursor ? { cursor } : {}) })}`),
  render: siteCard,
  onPage: (page, items) => {
    const searching = Boolean($('#sites-search').value.trim());
    $('#sites-empty').hidden = items.length > 0 || searching;
    $('#sites-none').hidden = items.length > 0 || !searching;
  },
});
$('#sites-search').addEventListener('input', debounce(() => siteList.reset()));

function siteCard(site) {
  const card = document.createElement('article');
  card.className = 'site-card glass';
  card.dataset.name = site.name;
  card.dataset.initial = site.name[0];
  card.innerHTML = `<div><h3></h3><a class="site-url" target="_blank" rel="noopener"></a></div>
    <div class="chips site-meta"></div>
    <div class="site-actions">
      <a class="btn btn-sm btn-accent" data-action="edit"></a>
      <button class="btn btn-sm" data-action="copy"></button>
      ${moreMenu([[t('row.rename'), 'rename'], '-', [t('row.delete'), 'delete', 'btn-danger']])}
    </div>`;
  $('h3', card).textContent = site.name;
  $('.site-url', card).textContent = site.url;
  $('.site-url', card).href = site.url;
  $('[data-action=edit]', card).textContent = t('row.edit');
  $('[data-action=copy]', card).textContent = t('row.copyLink');
  $('[data-action=edit]', card).href = `/?edit=${encodeURIComponent(site.name)}`;
  const chips = [filesLabel(site.files), formatBytes(site.bytes), t('chip.updated', { ago: timeAgo(site.updatedAt) })];
  $('.site-meta', card).replaceChildren(...chips.map((text) => Object.assign(document.createElement('span'), { className: 'chip', textContent: text })));
  return card;
}

$('#sites').addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const name = button.closest('.site-card').dataset.name;
  if (button.dataset.action === 'copy') return copy($('.site-url', button.closest('.site-card')).href);
  try {
    if (button.dataset.action === 'rename') {
      const next = await uiPrompt(t('rename.label', { name }), name, { title: t('rename.title'), ok: t('rename.ok') });
      if (!next || slugify(next) === name) return;
      const site = await api(`/sites/${encodeURIComponent(name)}/rename`, { method: 'POST', json: { name: next } });
      toast(t('admin.renamed', { name: site.name }));
    } else if (button.dataset.action === 'delete') {
      const url = $('.site-url', button.closest('.site-card')).href;
      if (!(await uiConfirm(`${t('confirm.deleteOwn', { name, url })}\n\n${retentionNote(config)}`, { title: t('delete.title', { name }), ok: t('delete.ok'), danger: true }))) return;
      await api(`/sites/${encodeURIComponent(name)}/delete`, { method: 'POST', json: {} });
      toast(t('toast.deleted', { name }));
    }
    await load();
  } catch (err) {
    uiError(err);
  }
});

// How much of the account's storage the sites use (the admin has no limit).
function renderUsage({ used, limit }) {
  $('#usage-text').textContent = limit ? t('usage.used', { used: formatBytes(used), limit: formatBytes(limit) }) : t('usage.unlimited', { used: formatBytes(used) });
  const share = limit ? Math.min(1, used / limit) : 0;
  $('#usage-bar').style.width = `${(share * 100).toFixed(1)}%`;
  $('#usage-bar').classList.toggle('full', share >= 0.8); // almost full
  $('.usage .meter').hidden = !limit;
}

// The visits chart, built once; its site picker searches the account's sites.
let visits = null;
function renderVisits(siteCount) {
  if (visits) return visits.reload();
  visits = statsPanel($('#visits'), { endpoint: '/me/stats', sites: '/me/sites', siteCount });
}

/* ---------- profile ---------- */

$('#profile').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    await api('/me', { method: 'POST', json: { firstName: form.firstName.value, lastName: form.lastName.value } });
    toast(t('toast.saved'));
    await load();
  } catch (err) {
    uiError(err);
  }
});

/* ---------- API tokens ---------- */

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
        if (!(await uiConfirm(t('account.revokeConfirm', { name: tok.name }), { title: t('account.revokeTitle'), ok: t('account.revoke'), danger: true }))) return;
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
  } catch (err) {
    uiError(err);
  }
});
$('#token-copy').addEventListener('click', () => copy($('#token-value').textContent, t('toast.tokenCopied')));

/* ---------- audit log ---------- */

const auditList = infiniteList({
  list: $('#audit'),
  after: $('#audit').closest('.table-wrap'),
  load: async (cursor) => {
    const page = await api(`/me/audit${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    return { items: page.events, next: page.next };
  },
  render: (event) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="num"></td><td></td><td></td>';
    tr.children[0].textContent = formatDateTime(event.at);
    tr.children[1].textContent = actionLabel(event.action);
    tr.children[2].textContent = event.site || '';
    return tr;
  },
});

/* ---------- account deletion ---------- */

$('#delete-account').addEventListener('click', async () => {
  if (!(await uiConfirm(t('account.deleteConfirm', { days: config.retentionDays, contact: config.contact }), { title: t('account.deleteTitle'), ok: t('account.deleteButton'), danger: true }))) return;
  try {
    await api('/me/delete', { method: 'POST' });
    $('#delete-sent').textContent = t('account.deleteSent', { email: config.user.email });
    $('#delete-sent').hidden = false;
  } catch (err) {
    uiError(err);
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  location.href = '/';
});

// Signing in and creating an account both end on their own "check your
// e-mail" view. The e-mail can be sent again once a minute; "Zadat jiný
// e-mail" goes back to the forms.
const RESEND_SECONDS = 60;
let resend = null;
let resendTimer = null;

function showSent(text, again) {
  resend = again;
  $('#signin').hidden = true;
  $('.sent-text', $('#signin-sent')).textContent = text;
  $('#signin-sent').hidden = false;
  window.scrollTo({ top: 0 });
  startResendWait();
}

function startResendWait() {
  const button = $('#sent-again');
  const until = Date.now() + RESEND_SECONDS * 1000;
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    button.disabled = left > 0;
    button.textContent = left > 0 ? t('sent.againIn', { seconds: left }) : t('sent.again');
    if (left <= 0) clearInterval(resendTimer);
  };
  clearInterval(resendTimer);
  resendTimer = setInterval(tick, 1000);
  tick();
}

$('#sent-again').addEventListener('click', async () => {
  $('#sent-again').disabled = true;
  try {
    await resend();
    toast(t('sent.againDone'));
    startResendWait();
  } catch (err) {
    $('#sent-again').disabled = false;
    uiError(err);
  }
});

$('.sent-back').addEventListener('click', (e) => {
  e.preventDefault();
  clearInterval(resendTimer);
  $('#signin-sent').hidden = true;
  $('#signin').hidden = false;
  $('#signin-form input[name=email]').focus();
});

setupEmailLogin($('#signin-form'), {
  onSent: (email) => showSent(t('login.sent', { email }), () => api('/auth/login', { method: 'POST', json: { email } })),
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const alert = $('.alert', form);
  const button = $('button[type=submit]', form);
  alert.hidden = true;
  button.disabled = true;
  try {
    const body = { email: form.email.value.trim(), firstName: form.firstName.value.trim(), lastName: form.lastName.value.trim() };
    await api('/auth/register', { method: 'POST', json: body });
    form.reset();
    showSent(t('register.sent', { email: body.email }), () => api('/auth/register', { method: 'POST', json: body }));
  } catch (err) {
    alert.textContent = err.message;
    alert.hidden = false;
  } finally {
    button.disabled = false;
  }
});

// Each section of the account is its own page, chosen by the address (#weby,
// #navstevnost…), so the side navigation and the back button both work.
const SECTIONS = $$('.account-main > section').map((s) => s.id);
function showSection() {
  const id = SECTIONS.includes(location.hash.slice(1)) ? location.hash.slice(1) : SECTIONS[0];
  for (const section of $$('.account-main > section')) section.hidden = section.id !== id;
  for (const link of $$('.account-side .side-nav a')) {
    const current = link.hash.slice(1) === id;
    link.classList.toggle('active', current);
    if (current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', () => {
  showSection();
  window.scrollTo({ top: 0 });
});
showSection();

init().catch((err) => {
  document.querySelector('main').textContent = t('err.load', { message: err.message });
});
