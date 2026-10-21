'use strict';

// The header and footer shared by every page of the publisher. Pages mark
// where they go with <!--header--> and <!--footer-->; the server fills them
// in for each request, so the navigation is the same everywhere and the
// account link already says "Sign in" or "Account" before any script runs.
const config = require('./config');

const LABELS = {
  cs: { publish: 'Zveřejnit', docs: 'Návod', admin: 'Správa', account: 'Účet', login: 'Přihlásit se', main: 'Hlavní navigace', by: 'Vytvořil', terms: 'Podmínky', privacy: 'Soukromí', abuse: 'Nahlásit zneužití' },
  en: { publish: 'Publish', docs: 'Guide', admin: 'Admin', account: 'Account', login: 'Sign in', main: 'Main navigation', by: 'Made by', terms: 'Terms', privacy: 'Privacy', abuse: 'Report abuse' },
};

// The navigation item each page belongs to.
const CURRENT = { 'index.html': '/', 'docs.html': '/docs', 'account.html': '/ucet', 'admin.html': '/admin' };

function header(name, { lang, user, admin }) {
  const l = LABELS[lang];
  const current = CURRENT[name];
  const link = (href, key, label, extra = '') =>
    `<a href="${href}" data-i18n="${key}"${href === current ? ' aria-current="page"' : ''}${extra}>${label}</a>`;
  const items = [
    link('/', 'nav.publish', l.publish),
    link('/docs', 'nav.docs', l.docs),
    admin ? link('/admin', 'nav.admin', l.admin, ' class="hide-sm"') : '',
    user ? link('/ucet', 'nav.account', l.account, ' id="nav-account"') : link('/ucet', 'nav.login', l.login, ' id="nav-account"'),
  ];
  return `<header class="topbar">
    <div class="wrap">
      <div class="bar glass">
        <a class="brand" href="/"><img class="logo" src="/_app/favicon.svg" alt=""><span data-brand>freepages</span></a>
        <div class="bar-right">
          <nav class="nav" aria-label="${l.main}" data-i18n-aria="nav.main">
            ${items.filter(Boolean).join('\n            ')}
          </nav>
          <div class="lang" data-lang-switch></div>
        </div>
      </div>
    </div>
  </header>`;
}

function footer({ lang }) {
  const l = LABELS[lang];
  const abuse = config.ABUSE_EMAIL;
  return `<footer class="site-footer">
    <div class="wrap">
      <div class="footer-row">
        <p><span data-i18n="footer.by">${l.by}</span> <a href="https://martin-balcar.cz" target="_blank" rel="noopener">Martin Balcar</a></p>
        <p class="footer-links"><a href="/podminky" data-i18n="footer.terms">${l.terms}</a> · <a href="/soukromi" data-i18n="footer.privacy">${l.privacy}</a> · <span data-i18n="footer.abuse">${l.abuse}</span>: <a class="abuse-link" href="mailto:${abuse}">${abuse}</a></p>
      </div>
    </div>
  </footer>`;
}

function render(name, html, context) {
  return html.replace('<!--header-->', () => header(name, context)).replace('<!--footer-->', () => footer(context));
}

module.exports = { render };
