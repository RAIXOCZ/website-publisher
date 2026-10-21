// @ts-check
const { test, expect } = require('./test');
const { HEADERS, htmlFile, unique, uniqueEmail, lastMail, mailToken, createAccount, signIn, answerModal, clipboard } = require('./helpers');

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('signing in with an e-mail link', async ({ page, browser, request }) => {
  const { email } = await createAccount(request);
  await page.goto('/ucet');
  await expect(page.locator('#signin')).toBeVisible();
  await expect(page.locator('#account')).toBeHidden();
  await page.locator('#signin-form input[name=email]').fill(email);
  await page.locator('#signin-form button').click();
  await expect(page.locator('#signin .sent')).toContainText(email);

  const mail = await lastMail(request, email, 'login');
  expect(mail.subject).toBe('Přihlášení do Freepages');
  expect(mail.text).toContain('30 minut');
  await page.goto(new URL(mail.params.link).pathname);
  await expect(page.locator('#confirm-title')).toHaveText('Přihlášení do Freepages');
  await page.locator('#confirm-button').click();
  await expect(page).toHaveURL('/ucet');
  await expect(page.locator('#account-email')).toContainText(email);

  // Signing out ends the session.
  await page.locator('#logout').click();
  await expect(page).toHaveURL('/');
  await page.goto('/ucet');
  await expect(page.locator('#signin')).toBeVisible();
});

test('signing in with an unknown e-mail looks the same, but the e-mail says there is no account', async ({ page, request }) => {
  const email = uniqueEmail('nobody');
  await page.goto('/');
  await page.locator('#login-inline input[name=email]').fill(email);
  await page.locator('#login-inline button').click();
  await expect(page.locator('#login-inline .sent')).toContainText(email);
  const mail = await lastMail(request, email);
  expect(mail.kind).toBe('loginNoAccount');
  expect(mail.params.link).toBeUndefined();
});

test('an invalid or used link cannot be consumed', async ({ page, request }) => {
  await page.goto('/email/not-a-real-token');
  await expect(page.locator('#confirm-title')).toHaveText('Odkaz nelze použít');
  const res = await request.post('/api/auth/consume', { headers: HEADERS, data: { token: 'nope' } });
  expect(res.status()).toBe(410);
});

test('the account page shows sites, lets you change your name and rename or delete sites', async ({ page, request }) => {
  const { email, site } = await signIn(page);
  await page.goto('/ucet');
  await expect(page.locator('#account-name')).toHaveText('Test User');
  await expect(page.locator('#account-email')).toContainText(email);

  const card = page.locator(`#sites .site-card[data-name="${site}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('[data-action=edit]')).toHaveAttribute('href', `/?edit=${site}`);

  await page.locator('#profile input[name=firstName]').fill('Jana');
  await page.locator('#profile input[name=lastName]').fill('Nováková');
  await page.locator('#profile button').click();
  await expect(page.locator('.toast')).toHaveText('Uloženo');
  await expect(page.locator('#account-name')).toHaveText('Jana Nováková');

  const renamed = unique('renamed');
  await card.locator('[data-action=rename]').click();
  const rename = await answerModal(page, renamed);
  expect(rename.title).toBe('Přejmenovat web');
  await expect(page.locator(`#sites .site-card[data-name="${renamed}"]`)).toBeVisible();
  expect((await request.get(`/${renamed}/`)).status()).toBe(200);
  expect((await request.get(`/${site}/`)).status()).toBe(404);

  await page.locator(`#sites .site-card[data-name="${renamed}"] [data-action=delete]`).click();
  const confirmDelete = await answerModal(page, true);
  expect(confirmDelete.title).toBe('Smazat web?');
  expect(confirmDelete.text).toContain('90 dní');
  await expect(page.locator('#sites-empty')).toBeVisible();
  expect((await request.get(`/${renamed}/`)).status()).toBe(404);
});

test('the activity history lists actions with IP addresses but no e-mail addresses', async ({ page }) => {
  const { email } = await signIn(page);
  await page.goto('/ucet');
  const rows = page.locator('#audit tr');
  await expect(rows.first()).toBeVisible();
  const text = await page.locator('#audit').textContent();
  expect(text).toContain('Účet vytvořen');
  expect(text).toContain('E-mail potvrzen');
  expect(text).toContain('Web zveřejněn');
  expect(text).toMatch(/127\.0\.0\.1|::1/);
  expect(text).not.toContain(email);

  const { events } = await (await page.request.get('/api/me/audit')).json();
  expect(JSON.stringify(events)).not.toContain('@');
});

test('API tokens publish and update sites with curl, and can be revoked', async ({ page, playwright }) => {
  await signIn(page);
  await page.goto('/ucet');
  await expect(page.locator('#tokens-empty')).toBeVisible();
  await page.locator('#token-form input[name=name]').fill('notebook');
  await page.locator('#token-form button').click();
  await expect(page.locator('#token-new')).toBeVisible();
  const token = (await page.locator('#token-value').textContent()) || '';
  expect(token).toMatch(/^fp_[\w-]{30,}$/);
  await expect(page.locator('#curl-example')).toContainText(`Authorization: Bearer ${token}`);
  await expect(page.locator('#curl-example')).toContainText('http://localhost:4317/api/sites');
  await page.locator('#token-copy').click();
  expect(await clipboard(page)).toBe(token);
  await expect(page.locator('#tokens tr')).toHaveCount(1);
  await expect(page.locator('#tokens')).toContainText('notebook');

  // A plain HTTP client, like curl: no cookies, no special headers.
  const curl = await playwright.request.newContext({ baseURL: 'http://localhost:4317' });
  const name = unique('cli');
  const auth = { Authorization: `Bearer ${token}` };
  let res = await curl.post('/api/sites', { headers: auth, multipart: { name, f: htmlFile('<h1>From CLI</h1>') } });
  expect(res.status()).toBe(200);
  expect(await (await curl.get(`/${name}/`)).text()).toContain('From CLI');

  res = await curl.post('/api/sites', {
    headers: auth,
    multipart: { name, overwrite: '1', exact: '1', p: 'docs/index.html', f: htmlFile('<h1>Docs</h1>') },
  });
  expect((await res.json()).replaced).toBe(true);
  expect(await (await curl.get(`/${name}/docs/`)).text()).toContain('Docs');

  await page.reload();
  await expect(page.locator('#tokens')).toContainText('právě teď');
  await page.locator('#tokens button').click();
  await answerModal(page, false);
  await expect(page.locator('#tokens tr')).toHaveCount(1);
  await page.locator('#tokens button').click();
  expect((await answerModal(page, true)).text).toContain('notebook');
  await expect(page.locator('#tokens-empty')).toBeVisible();
  res = await curl.post('/api/sites', { headers: auth, multipart: { name: unique('cli'), f: htmlFile('x') } });
  expect(res.status()).toBe(400); // no account any more → asked for an e-mail
  await curl.dispose();
});

test('deleting the account needs the e-mail link; data is kept but the e-mail can sign up again', async ({ page, request }) => {
  const { email, site } = await signIn(page);
  await page.goto('/ucet');
  await expect(page.locator('#delete-text')).toContainText('90 dní');
  await expect(page.locator('#delete-text')).toContainText('martin@freepages.dev');
  await page.locator('#delete-account').click();
  await answerModal(page, true);
  await expect(page.locator('#delete-sent')).toContainText(email);
  // Nothing happens until the link is used.
  expect((await request.get(`/${site}/`)).status()).toBe(200);

  const mail = await lastMail(request, email, 'deleteAccount');
  expect(mail.text).toContain('90');
  await page.goto(new URL(mail.params.link).pathname);
  await expect(page.locator('#confirm-title')).toHaveText('Smazat účet');
  await page.locator('#confirm-button').click();

  await expect(page).toHaveURL('/');
  await expect(page.locator('#notice')).toContainText('90 dní');
  await expect(page.locator('#nav-account')).toHaveText('Přihlásit se');
  expect((await request.get(`/${site}/`)).status()).toBe(404);

  // A new account with the same e-mail starts empty.
  const again = await createAccount(page.request, { email });
  await page.goto('/ucet');
  await expect(page.locator('#sites .site-card')).toHaveCount(1);
  await expect(page.locator(`#sites .site-card[data-name="${again.site}"]`)).toBeVisible();
  await expect(page.locator('#audit')).not.toContainText('Žádost o smazání účtu');
});

test('publishing confirmation for an existing account adds the site to it', async ({ page, request, playwright }) => {
  const other = await playwright.request.newContext({ baseURL: 'http://localhost:4317' });
  const { email } = await createAccount(other);
  await other.dispose();
  const name = unique('second');
  const res = await request.post('/api/sites', {
    headers: HEADERS,
    multipart: { name, email, f: htmlFile('<h1>Second</h1>') }, // no names needed for an existing account
  });
  expect((await res.json()).pending).toBe(true);
  const token = await mailToken(request, email, 'publish');
  await page.goto(`/email/${token}`);
  await page.locator('#confirm-button').click();
  await expect(page.locator('#result-title')).toHaveText(`Web ${name} je online`);
  await expect(page.locator('#my-list .site-card')).toHaveCount(2);
});

test('an account can be created without uploading a site', async ({ page, request }) => {
  const email = uniqueEmail('reg');
  await page.goto('/ucet');
  const form = page.locator('#register-form');
  await form.locator('[name=email]').fill(email);
  await form.locator('[name=firstName]').fill('Eva');
  await form.locator('[name=lastName]').fill('Malá');
  await form.locator('button[type=submit]').click();
  await expect(page.locator('#signin .sent')).toContainText(email);

  const mail = await lastMail(request, email, 'register');
  expect(mail.subject).toBe('Potvrďte registraci do Freepages');
  await page.goto(new URL(mail.params.link).pathname);
  await expect(page.locator('#confirm-title')).toHaveText('Vytvořit účet');
  await page.locator('#confirm-button').click();
  await expect(page).toHaveURL('/ucet');
  await expect(page.locator('.toast')).toHaveText('Vítejte! Účet je vytvořený.');
  await expect(page.locator('#account-name')).toHaveText('Eva Malá');
  await expect(page.locator('#sites-empty')).toBeVisible();

  // Registering again with the same address just sends a sign-in link.
  await request.post('/api/auth/register', { headers: HEADERS, data: { email, firstName: 'X', lastName: 'Y' } });
  expect((await lastMail(request, email)).kind).toBe('login');
  // Names are required.
  const bad = await request.post('/api/auth/register', { headers: HEADERS, data: { email: uniqueEmail() } });
  expect(bad.status()).toBe(400);
});
