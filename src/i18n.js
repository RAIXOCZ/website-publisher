'use strict';

// Server-side messages in Czech and English. The frontend sends its chosen
// language in the X-Lang header; otherwise Accept-Language decides.

const MESSAGES = {
  cs: {
    missingHeader: 'Chybí hlavička požadavku.',
    crossOrigin: 'Požadavek z jiné domény byl odmítnut.',
    loginRequired: 'Nejprve se přihlaste.',
    tooManyAttempts: 'Příliš mnoho pokusů. Zkuste to znovu za 15 minut.',
    wrongPassword: 'Nesprávné heslo.',
    tooManyUploads: 'Příliš mnoho nahrávání z vaší adresy. Zkuste to znovu později.',
    wrongSitePassword: 'Nesprávné heslo k webu.',
    wrongSitePasswordNamed: 'Nesprávné heslo k webu „{name}“.',
    notFound: 'Nenalezeno',
    invalidJson: 'Neplatný JSON.',
    serverError: 'Na serveru se něco pokazilo.',
    methodNotAllowed: 'Metoda není povolena',
    badRequest: 'Neplatný požadavek',
    nameMissing: 'Zvolte prosím název.',
    nameInvalid: 'Použijte malá písmena bez diakritiky, číslice a pomlčky (max. 63 znaků).',
    nameReserved: 'Název „{name}“ je rezervovaný, zvolte prosím jiný.',
    invalidPath: 'Neplatná cesta k souboru: {path}',
    tooManyFiles: 'Příliš mnoho souborů (limit {limit}).',
    tooLarge: 'Nahrávaná data jsou příliš velká (limit {limit} MB).',
    zipUnreadable: 'Soubor .zip se nepodařilo přečíst.',
    zipFailed: 'Soubor .zip se nepodařilo rozbalit: {reason}',
    siteNotFound: 'Web nebyl nalezen.',
    expectedUpload: 'Očekávalo se nahrání souborů.',
    uploadFailed: 'Nahrávání selhalo: {reason}',
    uploadAborted: 'Nahrávání bylo přerušeno.',
    noFiles: 'Nepřišly žádné soubory. Nahrajte složku, která obsahuje alespoň index.html.',
    emptyUpload: 'Nahraná data neobsahují žádné soubory ke zveřejnění.',
    busy: 'Tento web se právě zveřejňuje, zkuste to za chvíli znovu.',
    emailInvalid: 'Zadejte platnou e-mailovou adresu.',
    emailRequired: 'Pro zveřejnění zadejte e-mail, jméno a příjmení.',
    tooManyEmails: 'Příliš mnoho e-mailů. Zkuste to znovu za hodinu.',
    linkExpired: 'Odkaz vypršel nebo už byl použit.',
    nameRequired: 'Zadejte jméno a příjmení.',
    notYourSite: 'Tento web nemůžete upravovat.',
    accountSite: 'Tento web patří k účtu, heslo nelze nastavit.',
    ipInvalid: 'Neplatná IP adresa.',
    adminRequired: 'Tato část je jen pro správce.',
    adminAccount: 'Účet správce nelze smazat.',
    previewExpired: 'Tento náhled vypršel. Náhledy platí jen několik minut.',
    siteExists: 'Web „{name}“ už existuje.',
    // Pages shown to visitors of published sites
    pageNotFoundTitle: 'Nenalezeno',
    pageNotFound: '404 – Stránka nenalezena',
    noSuchSite: '404 – Web neexistuje',
    noSuchSiteText: 'Na adrese <code>{name}</code> zatím nic není zveřejněno.',
    listingText: 'Tato složka neobsahuje <code>index.html</code>, zde jsou její soubory:',
  },
  en: {
    missingHeader: 'Missing request header.',
    crossOrigin: 'Cross-origin request refused.',
    loginRequired: 'Please log in first.',
    tooManyAttempts: 'Too many attempts. Try again in 15 minutes.',
    wrongPassword: 'Wrong password.',
    tooManyUploads: 'Too many uploads from your address. Try again later.',
    wrongSitePassword: 'Wrong site password.',
    wrongSitePasswordNamed: 'Wrong password for site "{name}".',
    notFound: 'Not found',
    invalidJson: 'Invalid JSON.',
    serverError: 'Something went wrong on the server.',
    methodNotAllowed: 'Method not allowed',
    badRequest: 'Bad request',
    nameMissing: 'Please choose a name.',
    nameInvalid: 'Use lowercase letters, numbers and dashes (max 63 characters).',
    nameReserved: '"{name}" is reserved, please choose another name.',
    invalidPath: 'Invalid file path: {path}',
    tooManyFiles: 'Too many files (limit {limit}).',
    tooLarge: 'Upload too large (limit {limit} MB).',
    zipUnreadable: 'The .zip file could not be read.',
    zipFailed: 'The .zip file could not be extracted: {reason}',
    siteNotFound: 'Site not found.',
    expectedUpload: 'Expected a file upload.',
    uploadFailed: 'Upload failed: {reason}',
    uploadAborted: 'The upload was interrupted.',
    noFiles: 'No files received. Upload a folder that contains at least an index.html.',
    emptyUpload: 'The upload contains no files to publish.',
    busy: 'This site is being published right now, try again in a moment.',
    emailInvalid: 'Enter a valid e-mail address.',
    emailRequired: 'To publish, enter your e-mail, first and last name.',
    tooManyEmails: 'Too many e-mails. Try again in an hour.',
    linkExpired: 'The link has expired or was already used.',
    nameRequired: 'Enter your first and last name.',
    notYourSite: 'You cannot edit this site.',
    accountSite: 'This site belongs to an account; it has no password.',
    ipInvalid: 'Invalid IP address.',
    adminRequired: 'This is for the administrator only.',
    adminAccount: 'The administrator account cannot be deleted.',
    previewExpired: 'This preview has expired. Previews only last a few minutes.',
    siteExists: 'Site "{name}" already exists.',
    pageNotFoundTitle: 'Not found',
    pageNotFound: '404 – Page not found',
    noSuchSite: '404 – No such site',
    noSuchSiteText: 'Nothing is published at <code>{name}</code> yet.',
    listingText: 'This folder has no <code>index.html</code>, here are its files:',
  },
};

const LANGS = Object.keys(MESSAGES);

function langOf(req) {
  const explicit = String(req.headers['x-lang'] || '').toLowerCase();
  if (LANGS.includes(explicit)) return explicit;
  const accepted = String(req.headers['accept-language'] || '').toLowerCase();
  const first = accepted.split(',')[0].trim();
  return first.startsWith('cs') || first.startsWith('sk') ? 'cs' : 'en';
}

function t(lang, key, params = {}) {
  const template = MESSAGES[lang]?.[key] ?? MESSAGES.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''));
}

module.exports = { langOf, t };
