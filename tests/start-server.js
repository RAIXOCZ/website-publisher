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

require('../src/server.js');
