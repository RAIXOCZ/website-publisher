'use strict';

// Long documents (guide, terms, privacy) get a sticky table of contents
// built from their section headings, highlighting the section being read.
for (const page of document.querySelectorAll('.page[data-lang]')) {
  const prose = $('.prose', page);
  const headings = prose ? [...prose.querySelectorAll('h2')] : [];
  if (headings.length < 3) continue;

  const nav = document.createElement('nav');
  nav.className = 'side-nav';
  nav.setAttribute('aria-label', t('docs.toc'));
  for (const h of headings) {
    h.id ||= `${page.dataset.lang}-${slugify(h.textContent.replace(/^\d+\.\s*/, ''))}`;
    const link = document.createElement('a');
    link.href = `#${h.id}`;
    link.textContent = h.textContent;
    nav.append(link);
  }

  const aside = document.createElement('aside');
  aside.className = 'side-panel glass toc';
  aside.append(Object.assign(document.createElement('p'), { className: 'side-title', textContent: t('docs.toc') }), nav);

  const layout = document.createElement('div');
  layout.className = 'with-side doc-layout';
  prose.replaceWith(layout);
  layout.append(aside, prose);
  if (!page.hidden) scrollSpy(nav);
}
