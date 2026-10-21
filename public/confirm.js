'use strict';

// E-mail links open this page; the action runs only after a click, so link
// scanners in mail clients cannot use the link up.
const token = location.pathname.split('/').pop();

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
  const kind = { login: 'login', publish: 'publish', register: 'register', 'delete-account': 'delete' }[info.purpose];
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
      const { redirect } = await api('/auth/consume', { method: 'POST', json: { token } });
      location.href = redirect;
    } catch (err) {
      $('#confirm-error').textContent = err.message;
      $('#confirm-error').hidden = false;
      button.disabled = false;
    }
  });
}

init().catch((err) => fail(err.message));
