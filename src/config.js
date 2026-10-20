'use strict';

const path = require('path');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is not set. Put it in your .env file.');
  process.exit(1);
}

const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
const publicUrl = new URL(PUBLIC_URL);

// When set, every site is also served at https://<name>.<SITE_DOMAIN>/ and
// path-style URLs (PUBLIC_URL/<name>/) redirect there.
const SITE_DOMAIN = (process.env.SITE_DOMAIN || '').trim().toLowerCase().replace(/^\*?\./, '');

const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');

module.exports = {
  ADMIN_PASSWORD,
  PORT: int(process.env.PORT, 3000),
  DATA_DIR,
  SITES_DIR: path.join(DATA_DIR, 'sites'),
  META_DIR: path.join(DATA_DIR, 'meta'),
  TMP_DIR: path.join(DATA_DIR, 'tmp'),
  PUBLIC_URL,
  APP_HOSTNAME: publicUrl.hostname.toLowerCase(),
  SCHEME: publicUrl.protocol.replace(':', ''),
  SECURE_COOKIE: publicUrl.protocol === 'https:',
  SITE_DOMAIN,
  PUBLIC_UPLOAD: bool(process.env.PUBLIC_UPLOAD, false),
  PATH_SANDBOX: bool(process.env.PATH_SANDBOX, true),
  // Cloudflare rejects request bodies over 100 MB on Free/Pro plans.
  MAX_UPLOAD_MB: int(process.env.MAX_UPLOAD_MB, 100),
  MAX_FILES: int(process.env.MAX_FILES, 20000),
  SESSION_DAYS: int(process.env.SESSION_DAYS, 30),
  SESSION_SECRET: process.env.SESSION_SECRET || '',
};
