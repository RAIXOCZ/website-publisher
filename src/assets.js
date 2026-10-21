'use strict';

// The publisher's own pages, made light for the browser: CSS and JavaScript
// are minified once at start (esbuild, kept in memory), and every page gets
// its texts in the visitor's language on the server, from the same
// dictionary the browser uses (public/i18n.js). Nothing changes after the
// page loads, so nothing jumps.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const esbuild = require('esbuild');

const publicDir = path.join(__dirname, '..', 'public');

/* ---------- minified CSS and JavaScript ---------- */

const minified = new Map();
for (const name of fs.readdirSync(publicDir)) {
  const loader = { '.js': 'js', '.css': 'css' }[path.extname(name)];
  if (!loader) continue;
  const source = fs.readFileSync(path.join(publicDir, name), 'utf8');
  // Without a module format esbuild keeps top-level names: the scripts share them.
  const { code } = esbuild.transformSync(source, { loader, minify: true, legalComments: 'none', charset: 'utf8' });
  minified.set(`/${name}`, { code, type: loader === 'js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
}

/** Gives the fonts in the CSS the same ?v= as the page, so they are cached for good. */
function versionFonts(version) {
  for (const file of minified.values()) file.code = file.code.replace(/(\/_app\/font\/[\w-]+\.woff2)(?=["')])/g, `$1?v=${version}`);
}

/** Middleware for /_app: the minified file when there is one. */
function serveMinified(cacheControl) {
  return (req, res, next) => {
    const file = minified.get(req.path);
    if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
    res.set('Cache-Control', cacheControl(req)).type(file.type).send(file.code);
  };
}

/* ---------- texts in the visitor's language ---------- */

// The I18N object literal of public/i18n.js, evaluated on its own.
const I18N = (() => {
  const source = fs.readFileSync(path.join(publicDir, 'i18n.js'), 'utf8');
  const start = source.indexOf('const I18N = {');
  const end = source.indexOf('\n};\n', start);
  return vm.runInNewContext(`(${source.slice(start + 'const I18N = '.length, end + 2)})`);
})();

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (lang, key) => {
  const value = I18N[lang]?.[key] ?? I18N.cs[key];
  return typeof value === 'string' && !/\{\w+\}/.test(value) ? value : null; // texts with {placeholders} are left to the script
};

/** Fills data-i18n* texts and shows only the [data-lang] blocks of `lang`, as i18n.js would. */
function translate(html, lang) {
  return html
    .replace(/<([a-z][a-z0-9]*)(\s(?:[^>]*?\s)?data-i18n="([^"]+)"[^>]*)>([^<]*)<\/\1>/g, (match, tag, attrs, key) => {
      const value = text(lang, key);
      return value === null ? match : `<${tag}${attrs}>${escapeHtml(value)}</${tag}>`;
    })
    .replace(/<([a-z][a-z0-9]*)(\s(?:[^>]*?\s)?data-i18n-html="([^"]+)"[^>]*)>([\s\S]*?)<\/\1>/g, (match, tag, attrs, key) => {
      const value = text(lang, key);
      return value === null ? match : `<${tag}${attrs}>${value}</${tag}>`;
    })
    .replace(/<[a-z][^>]*\sdata-i18n-(placeholder|aria)="([^"]+)"[^>]*>/g, (tag) => {
      let out = tag;
      for (const [, kind, key] of tag.matchAll(/\sdata-i18n-(placeholder|aria)="([^"]+)"/g)) {
        const value = text(lang, key);
        if (value === null) continue;
        const attr = kind === 'aria' ? 'aria-label' : 'placeholder';
        const re = new RegExp(`\\s${attr}="[^"]*"`);
        out = re.test(out) ? out.replace(re, ` ${attr}="${escapeHtml(value)}"`) : out.replace(/\s*\/?>$/, (end) => ` ${attr}="${escapeHtml(value)}"${end}`);
      }
      return out;
    })
    .replace(/<([a-z][a-z0-9]*)(\s(?:[^>]*?\s)?data-lang="(cs|en)"[^>]*)>/g, (match, tag, attrs, blockLang) => {
      const clean = attrs.replace(/\shidden(?=[\s>]|$)/g, '');
      return `<${tag}${clean}${blockLang === lang ? '' : ' hidden'}>`;
    });
}

module.exports = { serveMinified, versionFonts, translate, I18N };
