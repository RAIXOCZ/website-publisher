'use strict';

// Fill in this server's real site address and upload limit.
api('/config')
  .then((config) => {
    for (const el of document.querySelectorAll('.url-example')) el.textContent = config.urlTemplate.replace('{name}', LANG === 'en' ? 'site-name' : 'nazev-webu');
    for (const el of document.querySelectorAll('.api-example')) el.textContent = `${location.origin}/api/sites`;
    for (const el of document.querySelectorAll('.mcp-url')) el.textContent = `${location.origin}/mcp`;
    for (const el of document.querySelectorAll('.max-upload')) el.textContent = `${config.maxUploadMb} MB`;
    for (const el of document.querySelectorAll('.site-max')) el.textContent = `${config.siteMaxMb} MB`;
    for (const el of document.querySelectorAll('.account-max')) el.textContent = `${config.accountMaxMb} MB`;
  })
  .catch(() => {});
