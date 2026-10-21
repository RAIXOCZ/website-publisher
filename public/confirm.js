'use strict';

// E-mail links open this page. A sign-in link signs in right away; the
// other links (publishing, a new account, deleting the account) wait for a
// click, because confirming them accepts terms or cannot be undone.
const token = location.pathname.split('/').pop();

async function consume() {
  const { redirect } = await api('/auth/consume', { method: 'POST', json: { token } });
  location.replace(redirect);
}

function fail(message) {
  $('#confirm-title').textContent = t('confirm.invalidTitle');
  $('#confirm-text').textContent = message;
  $('#confirm-button').hidden = true;
  $('#confirm-new').hidden = false;
  $('#confirm-home').hidden = false;
}

async function init() {
  const info = await api(`/auth/token?token=${encodeURIComponent(token)}`);
  if (!info.valid) return fail(t('confirm.invalid'));
  if (info.purpose === 'login') {
    $('#confirm-title').textContent = t('confirm.signingIn');
    return consume();
  }
  const kind = { publish: 'publish', register: 'register', 'delete-account': 'delete' }[info.purpose];
  $('#confirm-title').textContent = t(`confirm.${kind}Title`, { name: info.name });
  $('#confirm-text').textContent = t(`confirm.${kind}Text`, { name: info.name });
  const button = $('#confirm-button');
  button.textContent = t(`confirm.${kind}Button`);
  if (kind === 'delete') button.className = 'btn btn-danger';
  button.hidden = false;
  $('#confirm-home').hidden = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    $('#confirm-error').hidden = true;
    try {
      await consume();
    } catch (err) {
      $('#confirm-error').textContent = err.message;
      $('#confirm-error').hidden = false;
      button.disabled = false;
    }
  });
}

init().catch((err) => fail(err.message));
