'use strict';

// What search engines and link previews see: per-page titles and
// descriptions in Czech and English, canonical URLs, hreflang alternates,
// Open Graph / Twitter cards, structured data, favicons, robots.txt and the
// sitemap. Each page exists as /page?lang=cs and /page?lang=en; the bare
// /page picks the language from the browser (x-default).
const config = require('./config');
const sites = require('./sites');

const LANGS = ['cs', 'en'];
const exampleHost = (name) => sites.siteUrl(name).replace(/^https?:\/\//, '').replace(/\/$/, '');

const PAGES = {
  'index.html': {
    path: '/',
    cs: {
      title: 'Freepages – zveřejněte web zdarma jedním přetažením',
      description: () =>
        `Zveřejněte statický web zdarma: přetáhněte složku s webem a za pár sekund běží na vlastní adrese ${exampleHost('muj-web')} s HTTPS. Náhledy, úpravy v prohlížeči i nahrávání přes curl.`,
    },
    en: {
      title: 'Freepages – publish a website for free in one drop',
      description: () =>
        `Publish a static website for free: drop the folder with your site and seconds later it runs at its own address ${exampleHost('my-site')} with HTTPS. Previews, in-browser editing and uploads via curl.`,
    },
    structuredData: true,
  },
  'docs.html': {
    path: '/docs',
    cs: {
      title: 'Návod – Freepages',
      description: () => 'Jak zveřejnit statický web na Freepages: co má složka obsahovat, nahrání .zip, úpravy a náhledy webu, nahrávání přes curl s API tokenem a pravidla pro názvy.',
    },
    en: {
      title: 'Guide – Freepages',
      description: () => 'How to publish a static website on Freepages: what the folder should contain, .zip uploads, editing and previews, uploading with curl and an API token, and name rules.',
    },
  },
  'terms.html': {
    path: '/podminky',
    cs: { title: 'Podmínky použití – Freepages', description: () => 'Podmínky použití služby Freepages pro bezplatné zveřejňování statických webů.' },
    en: { title: 'Terms of use – Freepages', description: () => 'Terms of use of Freepages, the free static website publishing service.' },
  },
  'privacy.html': {
    path: '/soukromi',
    cs: {
      title: 'Zásady ochrany osobních údajů – Freepages',
      description: () => 'Jak Freepages zpracovává osobní údaje: účty, historie aktivit, doba uchování, příjemci a vaše práva podle GDPR.',
    },
    en: {
      title: 'Privacy policy – Freepages',
      description: () => 'How Freepages processes personal data: accounts, activity history, retention, recipients and your rights under the GDPR.',
    },
  },
};

// Pages that must never show up in search results.
const PRIVATE = new Set(['account.html', 'admin.html', 'confirm.html']);

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const url = (path, lang) => `${config.PUBLIC_URL}${path}${lang ? `?lang=${lang}` : ''}`;

const ICONS = [
  '<link rel="icon" href="/favicon.ico" sizes="32x32">',
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  '<link rel="manifest" href="/site.webmanifest">',
  '<meta name="theme-color" content="#0d9488">',
];

function structuredData(lang, description) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'Freepages',
    url: `${config.PUBLIC_URL}/`,
    description,
    inLanguage: LANGS,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any (web browser)',
    image: `${config.PUBLIC_URL}/og-${lang}.png`,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
    creator: { '@type': 'Person', name: 'Martin Balcar', url: 'https://martin-balcar.cz' },
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

/**
 * Fills in a page template for one request. `lang` is the language the
 * page is rendered in; `explicit` tells whether the URL asked for it
 * (?lang=…) or it was guessed from the browser.
 */
function render(name, html, { lang, explicit }) {
  const page = PAGES[name];
  const tags = [...ICONS];
  if (PRIVATE.has(name) || !page) {
    if (!/name="robots"/.test(html)) tags.unshift('<meta name="robots" content="noindex">');
  } else {
    const meta = page[lang];
    const description = meta.description();
    const canonical = url(page.path, explicit ? lang : null);
    html = html.replace(/(<title[^>]*>)[^<]*(<\/title>)/, (_, open, close) => `${open}${escape(meta.title)}${close}`);
    tags.unshift(
      `<meta name="description" content="${escape(description)}">`,
      `<link rel="canonical" href="${canonical}">`,
      ...LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${url(page.path, l)}">`),
      `<link rel="alternate" hreflang="x-default" href="${url(page.path)}">`,
      '<meta property="og:type" content="website">',
      '<meta property="og:site_name" content="Freepages">',
      `<meta property="og:title" content="${escape(meta.title)}">`,
      `<meta property="og:description" content="${escape(description)}">`,
      `<meta property="og:url" content="${canonical}">`,
      `<meta property="og:image" content="${config.PUBLIC_URL}/og-${lang}.png">`,
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      `<meta property="og:image:alt" content="${escape(PAGES['index.html'][lang].title)}">`,
      `<meta property="og:locale" content="${lang === 'cs' ? 'cs_CZ' : 'en_US'}">`,
      `<meta property="og:locale:alternate" content="${lang === 'cs' ? 'en_US' : 'cs_CZ'}">`,
      '<meta name="twitter:card" content="summary_large_image">',
    );
    if (page.structuredData) tags.push(structuredData(lang, description));
  }
  return html
    .replace(/<html lang="[^"]*">/, `<html lang="${lang}">`)
    .replace('</head>', `  ${tags.join('\n  ')}\n</head>`);
}

function robots() {
  return [
    'User-agent: *',
    'Disallow: /admin',
    'Disallow: /ucet',
    'Disallow: /account',
    'Disallow: /email/',
    'Disallow: /api/',
    'Disallow: /mcp',
    '',
    `Sitemap: ${config.PUBLIC_URL}/sitemap.xml`,
    '',
  ].join('\n');
}

function sitemap() {
  const entries = [];
  for (const page of Object.values(PAGES)) {
    const links = [
      ...LANGS.map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${url(page.path, l)}"/>`),
      `<xhtml:link rel="alternate" hreflang="x-default" href="${url(page.path)}"/>`,
    ].join('');
    for (const lang of [null, ...LANGS]) entries.push(`<url><loc>${escape(url(page.path, lang))}</loc>${links}</url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join('\n')}
</urlset>
`;
}

function manifest() {
  return {
    name: 'Freepages',
    short_name: 'Freepages',
    description: PAGES['index.html'].en.description(),
    start_url: '/',
    scope: '/',
    display: 'browser',
    theme_color: '#0d9488',
    background_color: '#f3f5f9',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}

// Files served at the root of the publisher's own host.
const ROOT_FILES = [
  'favicon.ico',
  'favicon.svg',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'og-cs.png',
  'og-en.png',
];

module.exports = { LANGS, PRIVATE, render, robots, sitemap, manifest, ROOT_FILES };
