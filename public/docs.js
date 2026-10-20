'use strict';

// Fill in this server's real site address and upload limit.
api('/config')
  .then((config) => {
    for (const el of document.querySelectorAll('.url-example')) el.textContent = config.urlTemplate.replace('{name}', 'nazev-webu');
    for (const el of document.querySelectorAll('.max-upload')) el.textContent = `${config.maxUploadMb} MB`;
  })
  .catch(() => {});
