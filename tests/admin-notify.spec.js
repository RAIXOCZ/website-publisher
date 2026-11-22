// @ts-check
const { test, expect } = require('./test');
const { unique, createAccount, lastMail, publishViaApi, ADMIN_EMAIL } = require('./helpers');

const adminMails = async (request, name) => {
  const { messages } = await (await request.get('/api/dev/outbox')).json();
  return messages.filter((m) => m.to === ADMIN_EMAIL && m.kind === 'adminNewSite' && m.params.name === name);
};

test('the admin gets an e-mail about every new site, but not about updates', async ({ request }) => {
  const { email, site } = await createAccount(request);
  const message = await lastMail(request, ADMIN_EMAIL, 'adminNewSite');
  expect(message.params.name).toBe(site);
  expect(message.params.owner).toContain(email);
  expect(message.params.via).toBe('web (potvrzení e-mailem)');
  expect(message.subject).toBe(`Nový web: ${site}`);
  expect(message.text).toContain(message.params.url);

  const name = unique('notify');
  expect((await publishViaApi(request, name)).status).toBe(200);
  await expect.poll(async () => (await adminMails(request, name)).length).toBe(1);
  expect((await adminMails(request, name))[0].params.via).toBe('API klíč');

  // Replacing the site (overwrite) is an update: no new e-mail.
  const again = await publishViaApi(request, name, '<h1>v2</h1>', { overwrite: '1' });
  expect(again.body).toMatchObject({ name, replaced: true });
  await new Promise((r) => setTimeout(r, 300));
  expect(await adminMails(request, name)).toHaveLength(1);
});
