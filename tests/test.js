'use strict';

// Playwright's test with one rule added for every page: the app must never
// open a native alert / confirm / prompt (it has its own styled dialogs).
const base = require('@playwright/test');

const test = base.test.extend({
  page: async ({ page }, use) => {
    const native = [];
    page.on('dialog', (dialog) => {
      native.push(`${dialog.type()}: ${dialog.message()}`);
      dialog.dismiss().catch(() => {});
    });
    await use(page);
    base.expect(native, 'native browser dialogs were opened').toEqual([]);
  },
});

module.exports = { ...base, test };
