'use strict';

// /oauth/authorize: an app (an MCP client) asks for access to the account.
// Signed in, the user allows it with one click; otherwise a link by e-mail
// confirms it (and creates the account when needed) while this page waits
// and then returns to the app.
const params = Object.fromEntries(new URLSearchParams(location.search));
let request;

function fail(message) {
  $('#oauth-title').textContent = t('oauth.invalidTitle');
  $('#oauth-text').textContent = message;
  $('#oauth-body').hidden = true;
}

const goTo = (url) => location.replace(url);

async function decide(action) {
  try {
    const { redirect } = await api(`/oauth/requests/${request.id}/${action}`, { method: 'POST' });
    goTo(redirect);
  } catch (err) {
    uiError(err);
  }
}

// Asks every 2 seconds whether the e-mail link was opened.
function waitForApproval() {
  const timer = setInterval(async () => {
    try {
      const { status, redirect } = await api(`/oauth/requests/${request.id}`);
      if (status === 'approved' && redirect) {
        clearInterval(timer);
        goTo(redirect);
      } else if (status !== 'pending') {
        clearInterval(timer);
        fail(t('oauth.expired'));
      }
    } catch {
      /* try again */
    }
  }, 2000);
}

async function init() {
  try {
    request = await api('/oauth/requests', { method: 'POST', json: params });
  } catch (err) {
    return fail(err.message);
  }
  document.title = `${t('oauth.title', { name: request.client.name })} – freepages.dev`;
  $('#oauth-title').textContent = t('oauth.title', { name: request.client.name });
  $('#oauth-text').textContent = t('oauth.text', { name: request.client.name, host: request.client.host });
  $('#oauth-body').hidden = false;
  if (request.user) {
    // "Signing in as x. You can sign in to another account."
    const line = $('#oauth-signed-as');
    const [before, after] = t('oauth.signedAs', { email: '\u0000' }).split('\u0000');
    const other = Object.assign(document.createElement('a'), { href: '#', id: 'oauth-other', textContent: t('oauth.otherAccount') });
    other.addEventListener('click', (e) => {
      e.preventDefault();
      $('#oauth-signed').hidden = true;
      $('#oauth-form').hidden = false;
      $('#oauth-form input[name=email]').focus();
    });
    line.replaceChildren(before, Object.assign(document.createElement('b'), { textContent: request.user.email }), after, ' ', other, t('oauth.otherAccountTail'));
    $('#oauth-signed').hidden = false;
  } else {
    $('#oauth-form').hidden = false;
  }
}

$('#oauth-allow').addEventListener('click', () => decide('approve'));
$('#oauth-deny').addEventListener('click', () => decide('deny'));
$('#oauth-deny-2').addEventListener('click', () => decide('deny'));

$('#oauth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const button = $('button[type=submit]', form);
  const alert = $('.alert', form);
  alert.hidden = true;
  button.disabled = true;
  try {
    const { email } = await api(`/oauth/requests/${request.id}/email`, {
      method: 'POST',
      json: { email: form.email.value.trim(), firstName: form.firstName.value.trim(), lastName: form.lastName.value.trim() },
    });
    form.hidden = true;
    $('#oauth-title').textContent = t('oauth.waitTitle');
    $('#oauth-wait-text').textContent = t('oauth.waitText', { email });
    $('#oauth-wait').hidden = false;
    waitForApproval();
  } catch (err) {
    if (err.data?.needName) {
      $('#oauth-names').hidden = false;
      $('#oauth-consent').hidden = false;
      for (const input of $$('#oauth-names input')) input.required = true;
      form.firstName.focus();
    }
    alert.textContent = err.message;
    alert.hidden = false;
  } finally {
    button.disabled = false;
  }
});

init();
