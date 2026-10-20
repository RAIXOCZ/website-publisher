'use strict';

// Starts the app on a fresh, throwaway data directory (used by playwright.config.js).
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-test-'));
require('../src/server.js');
