// The page shell around a rendered documentation page: header, sidebar, table
// of contents, pager, footer and the search dialog. It is a React tree rendered
// with renderToStaticMarkup, so every value from website/docs/ (nav.json and
// the Markdown) is escaped by React and the page body is placed as an element,
// never as a string of markup. A hand-written escape here is what Bearer
// reports as manual HTML sanitization (CWE-79).
import { createElement as h, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export const SITE = 'https://monize.net';
const REPO = 'https://github.com/kenlasko/monize';

export const pageUrl = (slug) => `/docs/${slug === 'index' ? '' : slug}`;

const current = (on) => (on ? { 'aria-current': 'page' } : {});

const searchIcon = () =>
  h(
    'svg',
    { 'aria-hidden': 'true', viewBox: '0 0 20 20', width: 16, height: 16 },
    h('circle', { cx: 8.5, cy: 8.5, r: 5.5, fill: 'none', stroke: 'currentColor', strokeWidth: 2 }),
    h('path', { d: 'M13 13l4.5 4.5', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
  );

function sidebar(nav, slug) {
  return h(
    'aside',
    { className: 'dside', id: 'side' },
    h(
      'nav',
      { 'aria-label': 'Documentation' },
      h('a', { className: 'dhome', href: '/docs/', ...current(slug === 'index') }, 'Overview'),
      nav.map(({ group, pages }) =>
        h(
          'div',
          { className: 'dgroup', key: group },
          h('p', { className: 'dgroup-t' }, group),
          h(
            'ul',
            null,
            pages.map((p) =>
              h('li', { key: p.slug }, h('a', { href: pageUrl(p.slug), ...current(p.slug === slug) }, p.title)),
            ),
          ),
        ),
      ),
    ),
  );
}

function tocList(toc) {
  return h(
    'ul',
    null,
    toc.map((t) => h('li', { className: `d${t.depth}`, key: t.id }, h('a', { href: `#${t.id}` }, t.text))),
  );
}

function pager(prev, next) {
  if (!prev && !next) return null;
  const card = (p, dir) =>
    p
      ? h(
          'a',
          { className: `pg pg-${dir}`, href: pageUrl(p.slug) },
          h('span', null, dir === 'prev' ? 'Previous' : 'Next'),
          h('b', null, p.title),
        )
      : h('span');
  return h('nav', { className: 'pager', 'aria-label': 'Previous and next page' }, card(prev, 'prev'), card(next, 'next'));
}

function landingCards(nav) {
  return nav.map(({ group, pages }) =>
    h(
      'section',
      { className: 'lgroup', key: group },
      h('h2', { id: group.toLowerCase().replace(/[^a-z0-9]+/g, '-') }, group),
      h(
        'div',
        { className: 'lcards' },
        pages.map((p) =>
          h(
            'a',
            { className: 'lcard', href: pageUrl(p.slug), key: p.slug },
            h('b', null, p.title),
            h('span', null, p.summary),
          ),
        ),
      ),
    ),
  );
}

function header() {
  return h(
    'header',
    { id: 'hdr', className: 'dhdr' },
    h(
      'button',
      {
        id: 'sideBtn',
        className: 'icobtn dside-btn',
        type: 'button',
        'aria-label': 'Open the page list',
        'aria-controls': 'side',
        'aria-expanded': 'false',
      },
      '☰',
    ),
    h(
      'a',
      { className: 'brand', href: '/' },
      h('img', { className: 'logo', src: '/assets/img/monize-logo.svg', alt: '', width: 30, height: 30 }),
      h('span', null, 'Monize'),
    ),
    h('a', { className: 'dlabel', href: '/docs/' }, 'Docs'),
    h(
      'button',
      {
        className: 'dsearch',
        type: 'button',
        'data-search-open': '',
        'aria-haspopup': 'dialog',
        'aria-label': 'Search the documentation',
      },
      searchIcon(),
      h('span', null, 'Search docs'),
      h('kbd', null, '/'),
    ),
    h(
      'nav',
      { className: 'dnav', 'aria-label': 'Site' },
      h('a', { href: '/' }, 'Home'),
      h('a', { href: 'https://demo.monize.net', rel: 'noopener' }, 'Live demo'),
      h('a', { href: REPO, rel: 'noopener' }, 'GitHub'),
    ),
    h(
      'button',
      {
        id: 'theme',
        className: 'icobtn',
        type: 'button',
        title: 'Toggle light / dark',
        'aria-label': 'Toggle colour theme',
      },
      '☾',
    ),
  );
}

function footer() {
  return h(
    Fragment,
    null,
    h(
      'footer',
      { className: 'dfoot' },
      h(
        'div',
        { className: 'wrap' },
        h('span', null, 'Monize is released under the AGPL-3.0 licence.'),
        h(
          'span',
          null,
          h('a', { href: '/' }, 'monize.net'),
          ' · ',
          h('a', { href: 'https://demo.monize.net', rel: 'noopener' }, 'Live demo'),
          ' · ',
          h('a', { href: REPO, rel: 'noopener' }, 'GitHub'),
        ),
      ),
    ),
    h(
      'div',
      {
        className: 'sdlg',
        id: 'search',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Search the documentation',
        hidden: true,
      },
      h(
        'div',
        { className: 'sbox' },
        h(
          'label',
          { className: 'sfield' },
          h('span', { className: 'sr' }, 'Search the documentation'),
          h('input', {
            id: 'q',
            type: 'search',
            placeholder: 'Search the docs, e.g. "split transaction"',
            autoComplete: 'off',
            spellCheck: 'false',
            'aria-controls': 'sres',
          }),
        ),
        h('ul', { id: 'sres', className: 'sres', role: 'listbox', 'aria-label': 'Results' }),
        h(
          'p',
          { className: 'shint', id: 'shint' },
          h('kbd', null, '↑'),
          h('kbd', null, '↓'),
          ' to move, ',
          h('kbd', null, 'Enter'),
          ' to open, ',
          h('kbd', null, 'Esc'),
          ' to close',
        ),
      ),
    ),
  );
}

/** One complete HTML document for a page. */
export function renderShell({ page, nav, group, summary, prev, next }) {
  const isLanding = page.slug === 'index';
  const title = isLanding ? 'Monize documentation' : `${page.title} - Monize documentation`;
  const url = `${SITE}${pageUrl(page.slug)}`;
  const toc = page.toc.filter((t) => t.depth === 2 || t.depth === 3);

  const hero = isLanding
    ? h(
        Fragment,
        null,
        h(
          'div',
          { className: 'lhero' },
          h('h1', null, page.title),
          h('p', { className: 'lede' }, summary),
          h(
            'button',
            { className: 'lsearch', type: 'button', 'data-search-open': '' },
            searchIcon(),
            h('span', null, 'Search the documentation'),
            h('kbd', null, '/'),
          ),
        ),
        landingCards(nav),
      )
    : h('h1', null, page.title);

  const document = h(
    'html',
    { lang: 'en', 'data-theme': 'dark', className: 'docs-root' },
    h(
      'head',
      null,
      h('meta', { charSet: 'utf-8' }),
      h('meta', { name: 'viewport', content: 'width=device-width,initial-scale=1' }),
      h('title', null, title),
      h('meta', { name: 'description', content: summary }),
      h('meta', { name: 'theme-color', content: '#4fa091' }),
      h('link', { rel: 'canonical', href: url }),
      h('link', { rel: 'icon', type: 'image/svg+xml', href: '/assets/img/monize-logo.svg' }),
      h('meta', { property: 'og:type', content: 'article' }),
      h('meta', { property: 'og:site_name', content: 'Monize' }),
      h('meta', { property: 'og:title', content: title }),
      h('meta', { property: 'og:description', content: summary }),
      h('meta', { property: 'og:url', content: url }),
      h('link', { rel: 'stylesheet', href: '/assets/css/styles.css' }),
      h('link', { rel: 'stylesheet', href: '/assets/css/docs.css' }),
      // Sets data-theme before the first paint; a blocking file rather than an
      // inline script, so the shell carries no script text of its own.
      h('script', { src: '/assets/js/theme-boot.js' }),
    ),
    h(
      'body',
      { className: `docs${isLanding ? ' landing' : ''}` },
      h('a', { className: 'skip', href: '#content' }, 'Skip to content'),
      header(),
      h('div', { className: 'dshade', id: 'shade', hidden: true }),
      h(
        'div',
        { className: 'dlayout' },
        sidebar(nav, page.slug),
        h(
          'main',
          { id: 'content', className: 'dmain', tabIndex: -1 },
          isLanding
            ? null
            : h(
                'nav',
                { className: 'crumbs', 'aria-label': 'Breadcrumb' },
                h('a', { href: '/docs/' }, 'Docs'),
                h('span', { 'aria-hidden': 'true' }, '/'),
                h('span', null, group),
              ),
          h(
            'article',
            { className: 'doc' },
            hero,
            toc.length > 1
              ? h('details', { className: 'toc-m' }, h('summary', null, 'On this page'), tocList(toc))
              : null,
            page.content,
          ),
          pager(prev, next),
          h(
            'p',
            { className: 'dedit' },
            h('a', { href: `${REPO}/edit/main/website/docs/${page.slug}.md`, rel: 'noopener' }, 'Edit this page on GitHub'),
            h('a', { href: `${REPO}/issues/new`, rel: 'noopener' }, 'Report a problem with the docs'),
          ),
        ),
        toc.length > 1
          ? h('aside', { className: 'dtoc', 'aria-label': 'On this page' }, h('p', null, 'On this page'), tocList(toc))
          : null,
      ),
      footer(),
      h('script', { src: '/assets/js/docs.js', defer: true }),
    ),
  );

  return (
    '<!doctype html>\n' +
    `<!-- Generated from website/docs/${page.slug}.md by frontend/scripts/build-website-docs.mjs. Edit the Markdown, then run "npm run docs:build" in frontend/. -->\n` +
    `${renderToStaticMarkup(document)}\n`
  );
}
