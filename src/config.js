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

const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
const publicUrl = new URL(PUBLIC_URL);

// When set, every site is also served at https://<name>.<SITE_DOMAIN>/ and
// path-style URLs (PUBLIC_URL/<name>/) redirect there.
const SITE_DOMAIN = (process.env.SITE_DOMAIN || '').trim().toLowerCase().replace(/^\*?\./, '');

const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');

module.exports = {
  PORT: int(process.env.PORT, 3000),
  DATA_DIR,
  SITES_DIR: path.join(DATA_DIR, 'sites'),
  META_DIR: path.join(DATA_DIR, 'meta'), // legacy per-site JSON, migrated into the database
  TMP_DIR: path.join(DATA_DIR, 'tmp'),
  TRASH_DIR: path.join(DATA_DIR, 'trash'),
  PENDING_DIR: path.join(DATA_DIR, 'pending'),
  PREVIEWS_DIR: path.join(DATA_DIR, 'previews'),
  DB_FILE: path.join(DATA_DIR, 'freepages.db'),
  PUBLIC_URL,
  APP_HOSTNAME: publicUrl.hostname.toLowerCase(),
  SCHEME: publicUrl.protocol.replace(':', ''),
  SECURE_COOKIE: publicUrl.protocol === 'https:',
  SITE_DOMAIN,
  // Publishing is open to everyone; this caps uploads per IP address.
  PUBLISH_PER_HOUR: int(process.env.PUBLISH_PER_HOUR, 60),
  // Wrong site passwords allowed per IP per 15 minutes.
  MAX_FAILED_ATTEMPTS: int(process.env.MAX_FAILED_ATTEMPTS, 10),
  PATH_SANDBOX: bool(process.env.PATH_SANDBOX, true),
  // Cloudflare rejects request bodies over 100 MB on Free/Pro plans.
  MAX_UPLOAD_MB: int(process.env.MAX_UPLOAD_MB, 100),
  // Storage limits: one site, one account (not the admin), the whole service.
  SITE_MAX_MB: int(process.env.SITE_MAX_MB, 100),
  ACCOUNT_MAX_MB: int(process.env.ACCOUNT_MAX_MB, 500),
  TOTAL_MAX_GB: int(process.env.TOTAL_MAX_GB, 20),
  MAX_FILES: int(process.env.MAX_FILES, 20000),
  // Sent as a Report-Abuse header with every response, including published sites.
  ABUSE_EMAIL: 'martin@freepages.dev',

  // The administrator's account (signs in by e-mail link like everyone else).
  // Sites that existed before accounts are assigned to it.
  ADMIN_EMAIL: (process.env.ADMIN_EMAIL || 'martin@balcar.me').trim().toLowerCase(),
  ADMIN_FIRST_NAME: process.env.ADMIN_FIRST_NAME || 'Martin',
  ADMIN_LAST_NAME: process.env.ADMIN_LAST_NAME || 'Balcar',

  // E-mail: Resend (https://resend.com) when RESEND_API_KEY is set, otherwise
  // messages are only written to the log (and, with MAIL_DEV_OUTBOX, exposed
  // at /api/dev/outbox for tests).
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  MAIL_FROM: process.env.MAIL_FROM || `freepages.dev <noreply@${SITE_DOMAIN || publicUrl.hostname}>`,
  MAIL_DEV_OUTBOX: bool(process.env.MAIL_DEV_OUTBOX, false),
  EMAILS_PER_HOUR: int(process.env.EMAILS_PER_HOUR, 10),


  PREVIEW_MINUTES: int(process.env.PREVIEW_MINUTES, 5),
  // Uploads waiting for e-mail confirmation are dropped after this.
  PENDING_HOURS: int(process.env.PENDING_HOURS, 24),
  LINK_MINUTES: int(process.env.LINK_MINUTES, 30),
  USER_SESSION_DAYS: int(process.env.USER_SESSION_DAYS, 30),
  // Deleted accounts, sites and their audit logs are kept this long.
  RETENTION_DAYS: int(process.env.RETENTION_DAYS, 90),
  // Activity history entries are deleted after this, whatever happens.
  AUDIT_DAYS: int(process.env.AUDIT_DAYS, 365),
};
