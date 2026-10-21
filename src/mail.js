'use strict';

// Sends e-mail through Resend's HTTP API (free tier: 3,000 e-mails a month).
// Without RESEND_API_KEY, messages are only logged (and kept in memory for
// tests when MAIL_DEV_OUTBOX is on).
const config = require('./config');

const outbox = [];

// Each e-mail: a title, paragraphs, an optional button for {link}, an
// optional quoted block (the admin's reasons) and paragraphs after it. The
// same parts make the HTML and the plain-text version.
const TEMPLATES = {
  cs: {
    greeting: 'Dobrý den,',
    footer: 'Tento e-mail vám poslala služba freepages.dev. Odpovědí na něj napíšete provozovateli.',
    login: {
      subject: 'Přihlášení do freepages.dev',
      title: 'Přihlášení do freepages.dev',
      body: ['Pro přihlášení klikněte na tlačítko.'],
      button: 'Přihlásit se',
      after: ['Odkaz platí {minutes} minut a lze ho použít jen jednou. Pokud jste o přihlášení nežádali, e-mail ignorujte.'],
    },
    loginNoAccount: {
      subject: 'Přihlášení do freepages.dev',
      title: 'K této adrese nemáme účet',
      body: ['Někdo (pravděpodobně vy) se chtěl přihlásit do freepages.dev s touto e-mailovou adresou, ale účet s ní neexistuje.'],
      button: 'Vytvořit účet',
      buttonHref: '{app}/ucet',
      after: ['Účet vznikne i zveřejněním prvního webu. Pokud jste o přihlášení nežádali, e-mail ignorujte.'],
    },
    register: {
      subject: 'Potvrďte registraci do freepages.dev',
      title: 'Potvrďte svůj e-mail',
      body: ['Kliknutím na tlačítko vytvoříte účet freepages.dev.'],
      button: 'Potvrdit a vytvořit účet',
      after: ['Odkaz platí {hours} hodin. Potvrzením přijímáte podmínky použití: {terms}', 'Pokud jste o registraci nežádali, e-mail ignorujte.'],
    },
    publish: {
      subject: 'Potvrďte zveřejnění webu {name}',
      title: 'Zveřejnit web {name}',
      body: ['Web {name} je nahraný. Po potvrzení e-mailu bude online.'],
      button: 'Potvrdit a zveřejnit',
      after: ['Odkaz platí {hours} hodin. Potvrzením vytvoříte účet (pokud ho ještě nemáte) a přijímáte podmínky použití: {terms}', 'Pokud jste nic nenahrávali, e-mail ignorujte. Nahrané soubory se samy smažou.'],
    },
    deleteAccount: {
      subject: 'Potvrďte smazání účtu freepages.dev',
      title: 'Smazat účet',
      body: ['Pro smazání účtu klikněte na tlačítko. Vaše weby pak přestanou být veřejné.'],
      button: 'Smazat účet',
      danger: true,
      after: ['Data smažeme natrvalo za {days} dní, dřív na požádání na {contact}.', 'Pokud jste o smazání nežádali, e-mail ignorujte.'],
    },
    oauth: {
      subject: 'Povolit přístup pro {client}',
      title: 'Povolit přístup pro {client}',
      body: ['Aplikace {client} chce přístup k vašemu účtu freepages.dev. Bude moci zveřejňovat, upravovat a mazat vaše weby.'],
      button: 'Povolit přístup',
      after: ['Odkaz platí {minutes} minut. Přístup kdykoli zrušíte v Účtu v části API klíče.', 'Pokud jste o to nežádali, e-mail ignorujte. Bez potvrzení aplikace přístup nedostane.'],
    },
    oauthRegister: {
      subject: 'Vytvořit účet a povolit přístup pro {client}',
      title: 'Vytvořit účet pro {client}',
      body: ['Aplikace {client} chce pro vás vytvořit účet freepages.dev a zveřejňovat, upravovat a mazat v něm weby.'],
      button: 'Vytvořit účet a povolit přístup',
      after: ['Odkaz platí {minutes} minut. Potvrzením přijímáte podmínky použití: {terms}', 'Pokud jste o to nežádali, e-mail ignorujte. Účet bez potvrzení nevznikne.'],
    },
    measure: {
      subject: 'Opatření k vašemu účtu freepages.dev',
      title: 'Opatření k vašemu účtu',
      body: ['Provozovatel služby freepages.dev přijal toto opatření: {measure}'],
      quote: { label: 'Odůvodnění', param: 'reason' },
      after: ['Rozhodl o něm člověk, bez použití automatizovaných nástrojů. Opatření vychází z podmínek použití: {terms}', 'Proti rozhodnutí se můžete ohradit odpovědí na tento e-mail nebo na adrese {contact}. Tím není dotčeno vaše právo obrátit se na soud.'],
    },
  },
  en: {
    greeting: 'Hello,',
    footer: 'This e-mail was sent by freepages.dev. Reply to it to reach the operator.',
    login: {
      subject: 'Sign in to freepages.dev',
      title: 'Sign in to freepages.dev',
      body: ['Click the button to sign in.'],
      button: 'Sign in',
      after: ['The link is valid for {minutes} minutes and can be used once. If you did not ask to sign in, ignore this e-mail.'],
    },
    loginNoAccount: {
      subject: 'Sign in to freepages.dev',
      title: 'No account uses this address',
      body: ['Someone (probably you) tried to sign in to freepages.dev with this e-mail address, but no account uses it.'],
      button: 'Create an account',
      buttonHref: '{app}/ucet',
      after: ['Publishing your first site creates an account too. If you did not ask to sign in, ignore this e-mail.'],
    },
    register: {
      subject: 'Confirm your freepages.dev registration',
      title: 'Confirm your e-mail',
      body: ['Click the button to create your freepages.dev account.'],
      button: 'Confirm and create account',
      after: ['The link is valid for {hours} hours. Confirming accepts the terms of use: {terms}', 'If you did not ask to register, ignore this e-mail.'],
    },
    publish: {
      subject: 'Confirm publishing {name}',
      title: 'Publish {name}',
      body: ['The site {name} is uploaded. It goes online once you confirm your e-mail.'],
      button: 'Confirm and publish',
      after: ['The link is valid for {hours} hours. Confirming also creates your account (if you do not have one yet) and accepts the terms of use: {terms}', 'If you did not upload anything, ignore this e-mail. The uploaded files will be deleted automatically.'],
    },
    deleteAccount: {
      subject: 'Confirm deleting your freepages.dev account',
      title: 'Delete your account',
      body: ['Click the button to delete your account. Your sites will no longer be public.'],
      button: 'Delete account',
      danger: true,
      after: ['Data is deleted permanently after {days} days, sooner on request to {contact}.', 'If you did not ask for this, ignore this e-mail.'],
    },
    oauth: {
      subject: 'Allow access for {client}',
      title: 'Allow access for {client}',
      body: ['The app {client} wants access to your freepages.dev account. It will be able to publish, edit and delete your sites.'],
      button: 'Allow access',
      after: ['The link is valid for {minutes} minutes. You can revoke access at any time under API keys in your account.', 'If you did not ask for this, ignore this e-mail. The app gets no access without your confirmation.'],
    },
    oauthRegister: {
      subject: 'Create an account and allow access for {client}',
      title: 'Create an account for {client}',
      body: ['The app {client} wants to create a freepages.dev account for you and publish, edit and delete sites in it.'],
      button: 'Create account and allow access',
      after: ['The link is valid for {minutes} minutes. Confirming accepts the terms of use: {terms}', 'If you did not ask for this, ignore this e-mail. No account is created without your confirmation.'],
    },
    measure: {
      subject: 'A measure concerning your freepages.dev account',
      title: 'A measure concerning your account',
      body: ['The operator of freepages.dev has taken this measure: {measure}'],
      quote: { label: 'Reasons', param: 'reason' },
      after: ['The decision was made by a person, without automated tools. It is based on the terms of use: {terms}', 'You can object by replying to this e-mail or at {contact}. This does not affect your right to go to court.'],
    },
  },
};

const MEASURES = {
  cs: {
    siteDeleted: 'web {name} byl smazán a už není veřejně dostupný.',
    accountBlocked: 'vašemu účtu bylo zakázáno přidávání a úpravy webů (mazat je můžete dál).',
    accountDeleted: 'váš účet byl zrušen a jeho weby už nejsou veřejně dostupné.',
  },
  en: {
    siteDeleted: 'the site {name} was deleted and is no longer publicly accessible.',
    accountBlocked: 'your account can no longer add or edit sites (you can still delete them).',
    accountDeleted: 'your account was closed and its sites are no longer publicly accessible.',
  },
};
function measureText(lang, measure, params = {}) {
  const text = (MEASURES[lang] || MEASURES.cs)[measure];
  return text.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''));
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Escapes text and turns web and e-mail addresses in it into links.
const richText = (s) =>
  escapeHtml(s)
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:])/g, '<a href="$1" style="color:#0f766e;text-decoration:underline">$1</a>')
    .replace(/([\w.+-]+@[\w-]+\.[\w.-]*\w)/g, '<a href="mailto:$1" style="color:#0f766e;text-decoration:underline">$1</a>')
    .replace(/\n/g, '<br>');

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function htmlEmail(lang, parts, preheader) {
  const p = (text, color = '#3a4456', size = 16) => `<p style="margin:0 0 16px;font:${size}px/1.6 ${FONT};color:${color}">${richText(text)}</p>`;
  const button = parts.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:10px;background:${parts.danger ? '#c2410c' : '#0f766e'}">
        <a href="${escapeHtml(parts.href)}" style="display:inline-block;padding:13px 24px;font:600 16px/1.2 ${FONT};color:#ffffff;text-decoration:none;border-radius:10px">${escapeHtml(parts.button)}</a>
      </td></tr></table>
      <p style="margin:0 0 20px;font:13px/1.5 ${FONT};color:#687083">${lang === 'en' ? 'If the button does not work, open this address:' : 'Pokud tlačítko nefunguje, otevřete tuto adresu:'}<br><a href="${escapeHtml(parts.href)}" style="color:#0f766e;word-break:break-all">${escapeHtml(parts.href)}</a></p>`
    : '';
  const quote = parts.quote
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr><td style="padding:14px 18px;background:#f3f5f9;border-left:3px solid #0f766e;border-radius:8px">
        <p style="margin:0 0 6px;font:600 13px/1.4 ${FONT};color:#586174;text-transform:uppercase;letter-spacing:.04em">${escapeHtml(parts.quote.label)}</p>
        <p style="margin:0;font:15px/1.6 ${FONT};color:#0b1324">${richText(parts.quote.text)}</p>
      </td></tr></table>`
    : '';
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(parts.subject)}</title></head>
<body style="margin:0;padding:0;background:#eef1f6">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6"><tr><td align="center" style="padding:32px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
    <tr><td style="padding:0 4px 18px">
      <!-- The logo is drawn with HTML, so the e-mail loads nothing from the web.
           (Gmail and Outlook do not show SVG in e-mails.) -->
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td width="36" height="36" align="center" valign="middle" style="width:36px;height:36px;background:#0d9488;border-radius:9px;font:700 22px/36px ${FONT};color:#ffffff">&#8593;</td>
        <td style="padding-left:10px;font:700 20px/1 ${FONT};color:#0b1324;letter-spacing:-.02em">freepages</td>
      </tr></table>
    </td></tr>
    <tr><td style="background:#ffffff;border-radius:18px;padding:32px 32px 16px;border:1px solid #e3e7ee">
      <h1 style="margin:0 0 18px;font:700 24px/1.25 ${FONT};color:#0b1324;letter-spacing:-.02em">${escapeHtml(parts.title)}</h1>
      ${p(parts.greeting, '#0b1324')}
      ${parts.body.map((t) => p(t, '#0b1324')).join('')}
      ${quote}
      ${button}
      ${parts.after.map((t) => p(t, '#586174', 14)).join('')}
    </td></tr>
    <tr><td style="padding:18px 8px;font:12px/1.6 ${FONT};color:#687083;text-align:center">${escapeHtml(parts.footer)}<br><a href="${escapeHtml(config.PUBLIC_URL)}" style="color:#586174">${escapeHtml(config.PUBLIC_URL.replace(/^https?:\/\//, ''))}</a></td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function render(lang, kind, params) {
  const all = TEMPLATES[lang] || TEMPLATES.cs;
  const tpl = all[kind];
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''));
  const parts = {
    subject: fill(tpl.subject),
    title: fill(tpl.title),
    greeting: all.greeting,
    body: tpl.body.map(fill),
    after: (tpl.after || []).map(fill),
    button: tpl.button && fill(tpl.button),
    href: tpl.buttonHref ? fill(tpl.buttonHref) : params.link,
    danger: tpl.danger,
    quote: tpl.quote && { label: tpl.quote.label, text: String(params[tpl.quote.param] ?? '') },
    footer: all.footer,
  };
  const text = [
    parts.greeting,
    ...parts.body,
    ...(parts.quote ? [`${parts.quote.label}:\n${parts.quote.text}`] : []),
    ...(parts.button ? [`${parts.button}: ${parts.href}`] : []),
    ...parts.after,
    `freepages.dev, ${config.PUBLIC_URL}`,
  ].join('\n\n');
  return { subject: parts.subject, text, html: htmlEmail(lang === 'en' ? 'en' : 'cs', parts, parts.body[0]) };
}

async function send({ to, lang = 'cs', kind, params = {} }) {
  const message = { to, kind, lang, ...render(lang, kind, params) };
  if (!config.RESEND_API_KEY) {
    if (config.MAIL_DEV_OUTBOX) {
      outbox.push({ ...message, params, at: new Date().toISOString() });
    } else if (config.SECURE_COOKIE) {
      // Production without e-mail: never put addresses or working links in the log.
      console.error(`[mail] RESEND_API_KEY is not set, a "${kind}" e-mail was not sent`);
    } else {
      console.log(`[mail] ${kind} → ${to}: ${params.link || ''}`);
    }
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.MAIL_FROM, to: [to], reply_to: config.ABUSE_EMAIL, subject: message.subject, text: message.text, html: message.html }),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}: ${await res.text()}`);
}

module.exports = { send, outbox, measureText, render };
