'use strict';

// Visitor statistics: page views per site and hour, nothing else. No IP
// addresses, cookies or other data about visitors are stored. Counts are
// kept in memory and written to the database every few seconds.
const { one, all, run, transaction } = require('./db');

const BOTS = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|monitor|uptime|curl|wget|python-requests|go-http-client|httpclient/i;
const KEEP_DAYS = 90;

const pending = new Map(); // "siteId|hour" → views
const hourKey = (date = new Date()) => date.toISOString().slice(0, 13); // 2026-10-21T14 (UTC)

function hit(siteName, req) {
  if (req.method !== 'GET' || BOTS.test(req.headers['user-agent'] || '')) return;
  const site = one('SELECT id FROM sites WHERE name = ? AND deleted_at IS NULL', siteName);
  if (!site) return;
  const key = `${site.id}|${hourKey()}`;
  pending.set(key, (pending.get(key) || 0) + 1);
}

function flush() {
  if (!pending.size) return;
  const batch = [...pending];
  pending.clear();
  transaction(() => {
    for (const [key, views] of batch) {
      const [siteId, hour] = key.split('|');
      run(
        'INSERT INTO site_views (site_id, hour, views) VALUES (?, ?, ?) ON CONFLICT(site_id, hour) DO UPDATE SET views = views + excluded.views',
        Number(siteId), hour, views,
      );
    }
  });
}
setInterval(flush, 5000).unref();

const RANGES = { '24h': { hours: 24, unit: 'hour' }, '7d': { hours: 24 * 7, unit: 'hour' }, '30d': { hours: 24 * 30, unit: 'day' } };

/**
 * Views of the given sites over a range: one bucket per hour (24h, 7d) or
 * per day (30d), oldest first, plus the views of each site.
 */
function series(siteIds, range = '24h') {
  flush();
  const { hours, unit } = RANGES[range] || RANGES['24h'];
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const from = new Date(now.getTime() - (hours - 1) * 3600_000);
  if (!siteIds.length) return { range, unit, buckets: emptyBuckets(from, now, unit), sites: [], total: 0 };
  const marks = siteIds.map(() => '?').join(',');
  const rows = all(
    `SELECT hour, SUM(views) AS views FROM site_views WHERE site_id IN (${marks}) AND hour >= ? GROUP BY hour`,
    ...siteIds, hourKey(from),
  );
  const buckets = emptyBuckets(from, now, unit);
  const index = new Map(buckets.map((b, i) => [b.t, i]));
  for (const row of rows) {
    const key = unit === 'day' ? `${row.hour.slice(0, 10)}T00` : row.hour;
    const i = index.get(key);
    if (i !== undefined) buckets[i].views += row.views;
  }
  const perSite = all(
    `SELECT s.name, COALESCE(SUM(v.views), 0) AS views FROM sites s LEFT JOIN site_views v ON v.site_id = s.id AND v.hour >= ?
     WHERE s.id IN (${marks}) GROUP BY s.id ORDER BY views DESC, s.name`,
    hourKey(from), ...siteIds,
  );
  return { range, unit, buckets, sites: perSite, total: buckets.reduce((sum, b) => sum + b.views, 0) };
}

function emptyBuckets(from, to, unit) {
  const out = [];
  const step = unit === 'day' ? 24 * 3600_000 : 3600_000;
  let t = new Date(from);
  if (unit === 'day') t.setUTCHours(0, 0, 0, 0);
  for (; t <= to; t = new Date(t.getTime() + step)) out.push({ t: `${hourKey(t).slice(0, unit === 'day' ? 10 : 13)}${unit === 'day' ? 'T00' : ''}`, views: 0 });
  return out;
}

function cleanup() {
  flush();
  run('DELETE FROM site_views WHERE hour < ?', hourKey(new Date(Date.now() - KEEP_DAYS * 86400_000)));
  run('DELETE FROM site_views WHERE site_id NOT IN (SELECT id FROM sites)');
}

module.exports = { hit, flush, series, cleanup, RANGES };
