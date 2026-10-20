// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// Three servers: path-style URLs (localhost:4317/<name>/) for the browser tests,
// per-site subdomains (<name>.pub.test on :4318) for host-routing tests, and
// one where this machine is on the IP whitelist (password sites, :4319).
// E-mails are not sent; tests read them from /api/dev/outbox.
const common = {
  ADMIN_PASSWORD: 'test-admin',
  PUBLISH_PER_HOUR: '100000',
  MAX_FAILED_ATTEMPTS: '100000',
  EMAILS_PER_HOUR: '100000',
  MAIL_DEV_OUTBOX: '1',
};

module.exports = defineConfig({
  testDir: 'tests',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4317',
    locale: 'cs-CZ',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'node --disable-warning=ExperimentalWarning tests/start-server.js',
      url: 'http://localhost:4317/api/config',
      env: { ...common, PORT: '4317', PUBLIC_URL: 'http://localhost:4317' },
      reuseExistingServer: false,
    },
    {
      command: 'node --disable-warning=ExperimentalWarning tests/start-server.js',
      url: 'http://localhost:4318/api/config',
      env: { ...common, PORT: '4318', PUBLIC_URL: 'http://pub.test', SITE_DOMAIN: 'pub.test' },
      reuseExistingServer: false,
    },
    {
      command: 'node --disable-warning=ExperimentalWarning tests/start-server.js',
      url: 'http://localhost:4319/api/config',
      env: { ...common, PORT: '4319', PUBLIC_URL: 'http://localhost:4319', IP_WHITELIST: '127.0.0.1,::1' },
      reuseExistingServer: false,
    },
  ],
});
