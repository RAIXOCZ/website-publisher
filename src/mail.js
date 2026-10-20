'use strict';

// Sends e-mail through Resend's HTTP API (free tier: 3,000 e-mails a month).
// Without RESEND_API_KEY, messages are only logged (and kept in memory for
// tests when MAIL_DEV_OUTBOX is on).
const config = require('./config');

const outbox = [];

const TEMPLATES = {
  cs: {
    login: {
      subject: 'Přihlášení do Freepages',
      text: 'Dobrý den,\n\npro přihlášení do Freepages otevřete tento odkaz:\n{link}\n\nOdkaz platí {minutes} minut a lze ho použít jen jednou. Pokud jste o přihlášení nežádali, e-mail ignorujte.',
    },
    loginNoAccount: {
      subject: 'Přihlášení do Freepages',
      text: 'Dobrý den,\n\nněkdo (pravděpodobně vy) se chtěl přihlásit do Freepages s touto e-mailovou adresou, ale účet s ní neexistuje. Účet vytvoříte zveřejněním prvního webu na {app}.\n\nPokud jste o přihlášení nežádali, e-mail ignorujte.',
    },
    publish: {
      subject: 'Potvrďte zveřejnění webu {name}',
      text: 'Dobrý den,\n\npro zveřejnění webu {name} potvrďte svou e-mailovou adresu otevřením tohoto odkazu:\n{link}\n\nOdkaz platí {hours} hodin. Potvrzením zároveň vytvoříte účet (pokud ho ještě nemáte) a přijímáte podmínky použití: {terms}\n\nPokud jste nic nenahrávali, e-mail ignorujte; nahrané soubory se pak samy smažou.',
    },
    deleteAccount: {
      subject: 'Potvrďte smazání účtu Freepages',
      text: 'Dobrý den,\n\npro smazání svého účtu Freepages otevřete tento odkaz:\n{link}\n\nPo smazání přestanou být vaše weby veřejné. Údaje o účtu, weby a historii aktivit uchováváme ještě {days} dní kvůli řešení případného zneužití a poté je smažeme. Pokud chcete vše smazat okamžitě, napište na {contact}.\n\nPokud jste o smazání nežádali, e-mail ignorujte.',
    },
  },
  en: {
    login: {
      subject: 'Sign in to Freepages',
      text: 'Hello,\n\nto sign in to Freepages, open this link:\n{link}\n\nThe link is valid for {minutes} minutes and can be used once. If you did not ask to sign in, ignore this e-mail.',
    },
    loginNoAccount: {
      subject: 'Sign in to Freepages',
      text: 'Hello,\n\nsomeone (probably you) tried to sign in to Freepages with this e-mail address, but no account uses it. You create an account by publishing your first site at {app}.\n\nIf you did not ask to sign in, ignore this e-mail.',
    },
    publish: {
      subject: 'Confirm publishing {name}',
      text: 'Hello,\n\nto publish the site {name}, confirm your e-mail address by opening this link:\n{link}\n\nThe link is valid for {hours} hours. Confirming also creates your account (if you do not have one yet) and accepts the terms of use: {terms}\n\nIf you did not upload anything, ignore this e-mail; the uploaded files will be deleted automatically.',
    },
    deleteAccount: {
      subject: 'Confirm deleting your Freepages account',
      text: 'Hello,\n\nto delete your Freepages account, open this link:\n{link}\n\nAfter deletion your sites are no longer public. We keep your account details, sites and activity history for {days} more days to deal with possible abuse, and then delete them. If you want everything deleted immediately, write to {contact}.\n\nIf you did not ask for this, ignore this e-mail.',
    },
  },
};

function render(lang, kind, params) {
  const tpl = (TEMPLATES[lang] || TEMPLATES.cs)[kind];
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''));
  const text = `${fill(tpl.text)}\n\n—\nFreepages · ${config.PUBLIC_URL}`;
  const html = `<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#0b1324">${text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>')}</div>`;
  return { subject: fill(tpl.subject), text, html };
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
    body: JSON.stringify({ from: config.MAIL_FROM, to: [to], subject: message.subject, text: message.text, html: message.html }),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}: ${await res.text()}`);
}

module.exports = { send, outbox };
