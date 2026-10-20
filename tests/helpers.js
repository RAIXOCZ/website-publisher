'use strict';

const path = require('path');
const crypto = require('crypto');

const FIXTURES = {
  site: path.join(__dirname, 'fixtures', 'sample-site'),
  siteV2: path.join(__dirname, 'fixtures', 'sample-site-v2'),
  zip: path.join(__dirname, 'fixtures', 'zipped-site.zip'),
};

const ADMIN_PASSWORD = 'test-admin';
const PASSWORD_RE = /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/;

// Unique site name per test so tests can run in parallel against one server.
function unique(prefix) {
  return `${prefix}-${crypto.randomBytes(3).toString('hex')}`;
}

// Clicks something that opens a file picker and answers it with `files`.
async function pick(page, locator, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), locator.click()]);
  await chooser.setFiles(files);
}

// Publishes FIXTURES.site (or `dir`) through the UI and returns the password.
async function publishViaUi(page, name, dir = FIXTURES.site) {
  await page.locator('#name').fill(name);
  await pick(page, page.locator('#pick-folder'), dir);
  await page.locator('#result').waitFor();
  return (await page.locator('#result-password-value').textContent()).trim();
}

// Publishes a one-file site straight through the API; returns the response JSON.
async function publishViaApi(request, name, html = '<h1>API site</h1>', extra = {}) {
  const res = await request.post('/api/sites', {
    headers: { 'X-Requested-With': 'fetch' },
    multipart: { name, ...extra, f: { name: 'index.html', mimeType: 'text/html', buffer: Buffer.from(html) } },
  });
  return { status: res.status(), body: await res.json() };
}

// Answers browser dialogs (confirm/prompt) in order; returns what they showed.
function answerDialogs(page, answers) {
  const seen = [];
  page.on('dialog', async (dialog) => {
    seen.push({ type: dialog.type(), message: dialog.message(), value: dialog.defaultValue() });
    const answer = answers.shift();
    if (answer === false) await dialog.dismiss();
    else await dialog.accept(typeof answer === 'string' ? answer : undefined);
  });
  return seen;
}

async function clipboard(page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

module.exports = { FIXTURES, ADMIN_PASSWORD, PASSWORD_RE, unique, pick, publishViaUi, publishViaApi, answerDialogs, clipboard };
