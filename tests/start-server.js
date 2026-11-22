'use strict';

// Starts the app on a fresh, throwaway data directory (used by playwright.config.js).
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-test-'));

// The whitelisted test server: same as adding the IPs in the admin panel.
for (const ip of (process.env.TEST_WHITELIST || '').split(',').filter(Boolean)) {
  require('../src/db').open();
  require('../src/accounts').addWhitelist(ip, 'tests');
}

// The Turnstile test server checks tokens against this stand-in for
// Cloudflare's siteverify: only "pass-token" with the right secret passes.
if (process.env.TEST_TURNSTILE_PORT) {
  const http = require('http');
  http
    .createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const { secret, response } = JSON.parse(body || '{}');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: secret === process.env.TURNSTILE_SECRET_KEY && response === 'pass-token' }));
      });
    })
    .listen(Number(process.env.TEST_TURNSTILE_PORT));
}

require('../src/server.js');
