'use strict';

// Czech / English UI. The language is the visitor's saved choice, otherwise
// the browser's preferred language (Czech and Slovak get Czech, the rest English).

const LANG_KEY = 'freepages.lang';
const LANGS = ['cs', 'en'];

const I18N = {
  cs: {
    'hero.tag': 'Zdarma · bez registrace · HTTPS',
    'hero.title1': 'Web online',
    'hero.title2': 'jedním přetažením.',
    'hero.text': 'Přetáhněte složku s webem a za pár sekund běží na vlastní adrese. Každý web dostane heslo, takže ho nikdo jiný nepřepíše.',
    'name.inline': 'název je nepovinný',
    'how.title': 'Složka s index.html stačí.',
    'how.text': 'HTML, CSS, JavaScript, obrázky i podsložky se zveřejní tak, jak jsou. Adresy bez .html a vlastní stránka 404 fungují samy.',
    'how.docs': 'Přečíst návod',
    'how.example': 'muj-web',
    'chip.updated': 'aktualizováno {ago}',
    'title.index': 'Publikování webů',
    'title.admin': 'Správa webů',
    'title.docs': 'Návod – Publikování webů',
    brand: 'Publikování',
    'brand.admin': 'správa',
    'nav.mySites': 'Moje weby',
    'nav.docs': 'Návod',
    'nav.publish': '+ Zveřejnit',
    'nav.logout': 'Odhlásit',
    'footer.by': 'Vytvořil',
    'footer.abuse': 'Nahlásit zneužití',
    'footer.abuseSubject': 'Nahlášení zneužití – {host}',

    'name.placeholder': 'muj-web',
    'conflict.placeholder': 'Heslo k webu',
    'conflict.replace': 'Nahradit web',
    cancel: 'Zrušit',
    'drop.aria': 'Vybrat složku ke zveřejnění',
    'drop.title': 'Přetáhněte sem složku s webem',
    'drop.hint': 'nebo soubor .zip &middot; musí obsahovat <code>index.html</code>',
    'pick.folder': 'Vybrat složku',
    'pick.zip': 'Nahrát .zip',
    'progress.uploading': 'Nahrávám…',
    'progress.uploadingName': 'Nahrávám {name}…',
    'progress.publishing': 'Zveřejňuji…',
    'result.live': 'Web je online',
    'result.liveName': 'Web {name} je online',
    'result.updated': 'Web {name} byl aktualizován',
    'result.pwLabel': 'Heslo k webu',
    'result.pwNote': 'Heslo je uložené v tomto prohlížeči (Moje weby). Bez něj web nepůjde aktualizovat ani smazat, proto si ho uschovejte.',
    'result.noIndex': ' V hlavní složce chybí index.html, návštěvníci uvidí seznam souborů.',
    copy: 'Kopírovat',
    open: 'Otevřít',
    again: 'Zveřejnit další',
    'err.enterName': 'Zadejte název webu a stiskněte Enter.',
    'err.existsOwned': 'Web „{name}“ už existuje a je mezi vašimi weby. Chcete ho nahradit tímto nahráním?',
    'err.existsAsk': 'Web „{name}“ už existuje. Pokud je váš, zadejte jeho heslo. Jinak zvolte jiný název a stiskněte Enter.',
    'err.tryAgain': ' Zkuste to znovu, nebo zvolte jiný název.',
    'err.tooBig': 'Nahrávaná data mají {size}, limit je {limit} MB.',
    'err.load': 'Nepodařilo se načíst: {message}',
    'err.siteMissing': 'Web „{name}“ neexistuje.',
    'err.wrongSitePw': 'Nesprávné heslo k webu.',

    'my.title': 'Moje weby',
    'my.add': 'Přidat existující web',
    'my.intro': 'Hesla jsou uložená jen v tomto prohlížeči. Na jiném zařízení web přidáte jeho názvem a heslem.',
    'my.namePlaceholder': 'Název webu',
    'my.pwPlaceholder': 'Heslo k webu',
    'my.addSubmit': 'Přidat',
    'my.empty': 'Zatím jste odsud nic nezveřejnili.',
    'my.missing': 'Web už neexistuje (byl smazán nebo přejmenován).',
    'my.wrongPw': 'Uložené heslo už neplatí.',
    'row.copyLink': 'Kopírovat odkaz',
    'row.password': 'Heslo',
    'row.pwPrefix': 'Heslo:',
    'row.update': 'Aktualizovat',
    'row.delete': 'Smazat',
    'row.forget': 'Odebrat ze seznamu',
    'row.replace': 'Nahradit',
    'row.rename': 'Přejmenovat',
    'row.newPw': 'Nové heslo',
    'confirm.deleteOwn': 'Smazat web „{name}“? Adresa {url} přestane fungovat.',
    'toast.deleted': 'Web {name} byl smazán',
    'toast.added': 'Web {name} přidán',
    'toast.linkCopied': 'Odkaz zkopírován',
    'toast.pwCopied': 'Heslo zkopírováno',
    'prompt.copy': 'Zkopírujte:',

    'admin.loginTitle': 'Přihlášení do správy',
    'admin.passwordPlaceholder': 'Heslo',
    'admin.login': 'Přihlásit',
    'admin.h1': 'Weby',
    'admin.lead': 'Všechny zveřejněné weby. Jako správce můžete kterýkoli web nahradit, přejmenovat, smazat nebo mu vygenerovat nové heslo.',
    'admin.filter': 'Hledat weby…',
    'admin.thSite': 'Web',
    'admin.thFiles': 'Soubory',
    'admin.thSize': 'Velikost',
    'admin.thUpdated': 'Aktualizováno',
    'admin.empty': 'Zatím tu nejsou žádné weby. <a href="/">Zveřejněte první →</a>',
    'admin.noPw': 'bez hesla',
    'admin.renamePrompt': 'Nový název pro „{name}“:',
    'admin.renamed': 'Přejmenováno na {name}',
    'admin.replaced': 'Web {name} byl nahrazen',
    'admin.resetConfirm': 'Vygenerovat pro „{name}“ nové heslo? Staré heslo přestane platit.',
    'admin.resetPrompt': 'Nové heslo pro „{name}“ (předejte ho majiteli webu):',
    'admin.deleteConfirm': 'Smazat „{name}“? Web {url} bude trvale odstraněn.',
    'admin.deleted': 'Smazáno: {name}',

    'request.failed': 'Požadavek selhal ({status})',
    'upload.tooLarge': 'Nahrávaná data jsou pro server příliš velká.',
    'upload.failedHttp': 'Nahrávání selhalo (HTTP {status}).',
    'upload.network': 'Nahrávání selhalo – zkontrolujte připojení a zkuste to znovu.',
    'time.now': 'právě teď',
    'time.minutes': 'před {n} min',
    'time.hours': 'před {n} h',
    'time.yesterday': 'včera',
    'time.days': 'před {n} dny',
  },

  en: {
    'hero.tag': 'Free · no sign-up · HTTPS',
    'hero.title1': 'Your site online',
    'hero.title2': 'in one drop.',
    'hero.text': 'Drop your website folder and within seconds it runs on its own address. Every site gets a password, so nobody else can overwrite it.',
    'name.inline': 'the name is optional',
    'how.title': 'A folder with index.html is all you need.',
    'how.text': 'HTML, CSS, JavaScript, images and subfolders are published as they are. Clean URLs without .html and a custom 404 page just work.',
    'how.docs': 'Read the guide',
    'how.example': 'my-site',
    'chip.updated': 'updated {ago}',
    'title.index': 'Publish a website',
    'title.admin': 'Site admin',
    'title.docs': 'Guide – Publish a website',
    brand: 'Publisher',
    'brand.admin': 'admin',
    'nav.mySites': 'My sites',
    'nav.docs': 'Guide',
    'nav.publish': '+ Publish',
    'nav.logout': 'Log out',
    'footer.by': 'Made by',
    'footer.abuse': 'Report abuse',
    'footer.abuseSubject': 'Abuse report – {host}',

    'name.placeholder': 'my-site',
    'conflict.placeholder': 'Site password',
    'conflict.replace': 'Replace site',
    cancel: 'Cancel',
    'drop.aria': 'Choose a folder to publish',
    'drop.title': 'Drop your website folder here',
    'drop.hint': 'or a .zip file &middot; must contain an <code>index.html</code>',
    'pick.folder': 'Choose folder',
    'pick.zip': 'Upload .zip',
    'progress.uploading': 'Uploading…',
    'progress.uploadingName': 'Uploading {name}…',
    'progress.publishing': 'Publishing…',
    'result.live': 'Your site is live',
    'result.liveName': '{name} is live',
    'result.updated': '{name} was updated',
    'result.pwLabel': 'Site password',
    'result.pwNote': 'The password is saved in this browser (My sites). Without it the site cannot be updated or deleted, so keep it safe.',
    'result.noIndex': ' There is no index.html at the top level, so visitors will see a file list.',
    copy: 'Copy',
    open: 'Open',
    again: 'Publish another',
    'err.enterName': 'Type a name for your site and press Enter.',
    'err.existsOwned': 'Site "{name}" already exists and is one of your sites. Replace it with this upload?',
    'err.existsAsk': 'Site "{name}" already exists. If it is yours, enter its password. Otherwise choose another name and press Enter.',
    'err.tryAgain': ' Try again or choose another name.',
    'err.tooBig': 'This upload is {size}, the limit is {limit} MB.',
    'err.load': 'Could not load: {message}',
    'err.siteMissing': 'Site "{name}" does not exist.',
    'err.wrongSitePw': 'Wrong site password.',

    'my.title': 'My sites',
    'my.add': 'Add existing site',
    'my.intro': 'Passwords are stored only in this browser. On another device, add a site with its name and password.',
    'my.namePlaceholder': 'Site name',
    'my.pwPlaceholder': 'Site password',
    'my.addSubmit': 'Add',
    'my.empty': 'You have not published anything from here yet.',
    'my.missing': 'This site no longer exists (deleted or renamed).',
    'my.wrongPw': 'The saved password is no longer valid.',
    'row.copyLink': 'Copy link',
    'row.password': 'Password',
    'row.pwPrefix': 'Password:',
    'row.update': 'Update',
    'row.delete': 'Delete',
    'row.forget': 'Remove from list',
    'row.replace': 'Replace',
    'row.rename': 'Rename',
    'row.newPw': 'New password',
    'confirm.deleteOwn': 'Delete site "{name}"? {url} will stop working.',
    'toast.deleted': '{name} was deleted',
    'toast.added': '{name} added',
    'toast.linkCopied': 'Link copied',
    'toast.pwCopied': 'Password copied',
    'prompt.copy': 'Copy:',

    'admin.loginTitle': 'Admin login',
    'admin.passwordPlaceholder': 'Password',
    'admin.login': 'Log in',
    'admin.h1': 'Sites',
    'admin.lead': 'All published sites. As the admin you can replace, rename or delete any site, or generate a new password for it.',
    'admin.filter': 'Filter sites…',
    'admin.thSite': 'Site',
    'admin.thFiles': 'Files',
    'admin.thSize': 'Size',
    'admin.thUpdated': 'Updated',
    'admin.empty': 'No sites yet. <a href="/">Publish the first one →</a>',
    'admin.noPw': 'no password',
    'admin.renamePrompt': 'New name for "{name}":',
    'admin.renamed': 'Renamed to {name}',
    'admin.replaced': '{name} was replaced',
    'admin.resetConfirm': 'Generate a new password for "{name}"? The old one will stop working.',
    'admin.resetPrompt': 'New password for "{name}" (give it to the site owner):',
    'admin.deleteConfirm': 'Delete "{name}"? {url} will be removed permanently.',
    'admin.deleted': 'Deleted {name}',

    'request.failed': 'Request failed ({status})',
    'upload.tooLarge': 'The upload is too large for the server.',
    'upload.failedHttp': 'Upload failed (HTTP {status}).',
    'upload.network': 'Upload failed – check your connection and try again.',
    'time.now': 'just now',
    'time.minutes': '{n} min ago',
    'time.hours': '{n} h ago',
    'time.yesterday': 'yesterday',
    'time.days': '{n} days ago',
  },
};

function detectLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (LANGS.includes(saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  for (const lang of navigator.languages || [navigator.language || '']) {
    const code = String(lang).toLowerCase();
    if (code.startsWith('cs') || code.startsWith('sk')) return 'cs';
    if (code.startsWith('en')) return 'en';
  }
  return 'en';
}

const LANG = detectLang();

function t(key, vars = {}) {
  const template = I18N[LANG][key] ?? I18N.cs[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

function setLang(lang) {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* storage unavailable */
  }
  location.reload();
}

// Fills every element marked with data-i18n* attributes, and shows only the
// [data-lang] blocks of the current language.
function applyI18n(root = document) {
  document.documentElement.lang = LANG;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-lang]')) el.hidden = el.dataset.lang !== LANG;
}

applyI18n();

// CS / EN toggle.
for (const holder of document.querySelectorAll('[data-lang-switch]')) {
  holder.setAttribute('role', 'group');
  holder.setAttribute('aria-label', 'Jazyk / Language');
  for (const lang of LANGS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.setLang = lang;
    button.textContent = lang.toUpperCase();
    button.setAttribute('aria-pressed', String(lang === LANG));
    button.addEventListener('click', () => lang !== LANG && setLang(lang));
    holder.append(button);
  }
}

// The brand is simply the domain this runs on.
for (const el of document.querySelectorAll('[data-brand]')) {
  const host = location.hostname.replace(/^www\./, '');
  const dot = host.indexOf('.');
  el.replaceChildren(dot > 0 ? host.slice(0, dot) : host);
  if (dot > 0) el.append(Object.assign(document.createElement('span'), { className: 'tld', textContent: host.slice(dot) }));
}

for (const link of document.querySelectorAll('.abuse-link')) {
  link.href = `mailto:martin@balcar.me?subject=${encodeURIComponent(t('footer.abuseSubject', { host: location.host }))}`;
}
