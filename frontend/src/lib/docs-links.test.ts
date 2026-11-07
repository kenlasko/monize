import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DOCS_LINKS, docsUrl, helpTarget, isGuideUrl, type DocsLink } from './docs-links';

/**
 * A help link is only as good as the section it lands on. The documentation is
 * generated into `website/docs/` from its Markdown, so each destination is
 * checked against the committed page: the page has to exist and carry an
 * element with the section's id. A heading renamed in the docs fails here and
 * names the entry to update.
 *
 * The user guide used to be the GitHub wiki, which is no longer maintained; a
 * link to it is a link to stale help, so none may come back into the app.
 */
const SRC = join(__dirname, '..');
const DOCS = join(SRC, '..', '..', 'website', 'docs');
const WIKI = /github\.com\/kenlasko\/monize\/wiki/;

function generatedPage(page: string): string {
  return join(DOCS, `${page || 'index'}.html`);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('docsUrl', () => {
  it('links the landing page and a section on a page', () => {
    expect(docsUrl('home')).toBe('https://www.monize.net/docs/');
    expect(docsUrl('dashboard')).toBe('https://www.monize.net/docs/dashboard');
    expect(docsUrl('institutions')).toBe('https://www.monize.net/docs/accounts#financial-institutions');
  });
});

describe('every documentation link lands on a page and section that exist', () => {
  it.each(Object.keys(DOCS_LINKS) as DocsLink[])('%s', (link) => {
    const target: { page: string; section?: string } = DOCS_LINKS[link];
    const file = generatedPage(target.page);
    expect(existsSync(file), `website/docs/${target.page || 'index'}.html does not exist`).toBe(true);
    if (target.section) {
      expect(
        readFileSync(file, 'utf8').includes(`id="${target.section}"`),
        `website/docs/${target.page}.md has no heading whose anchor is #${target.section}`,
      ).toBe(true);
    }
  });
});

describe('every documentation link resolves to a page the help manifest lists', () => {
  // The backend serves the landing page plus every page nav.json defines, so the
  // committed nav.json is the manifest's page set.
  const nav = JSON.parse(readFileSync(join(DOCS, 'nav.json'), 'utf8')) as {
    pages: { slug: string }[];
  }[];
  const served = new Set(['index', ...nav.flatMap((group) => group.pages.map((p) => p.slug))]);

  it.each(Object.keys(DOCS_LINKS) as DocsLink[])('%s', (link) => {
    const target = helpTarget(link);
    expect(served.has(target.page), `help serves no page "${target.page}"`).toBe(true);
    expect(target.section).toBe((DOCS_LINKS[link] as { section?: string }).section);
  });

  it('names the landing page by its help slug', () => {
    expect(helpTarget('home')).toEqual({ page: 'index' });
  });

  it('carries a section when the link names one', () => {
    expect(helpTarget('institutions')).toEqual({ page: 'accounts', section: 'financial-institutions' });
  });
});

describe('isGuideUrl', () => {
  it('resolves a page with a section', () => {
    expect(isGuideUrl('https://www.monize.net/docs/budgets#rollover-rules')).toEqual({
      page: 'budgets',
      section: 'rollover-rules',
    });
  });

  it('resolves a page with no section', () => {
    expect(isGuideUrl('https://www.monize.net/docs/budgets')).toEqual({ page: 'budgets' });
  });

  it('resolves the landing page', () => {
    expect(isGuideUrl('https://www.monize.net/docs')).toEqual({ page: 'index' });
    expect(isGuideUrl('https://www.monize.net/docs/')).toEqual({ page: 'index' });
  });

  it('falls through on an unrelated URL', () => {
    expect(isGuideUrl('https://github.com/kenlasko/monize')).toBeNull();
  });

  it('falls through on a lookalike host', () => {
    expect(isGuideUrl('https://www.monize.net.evil.com/docs/budgets')).toBeNull();
  });

  it('falls through on a path that merely starts with the same letters', () => {
    expect(isGuideUrl('https://www.monize.net/docsish/budgets')).toBeNull();
  });

  it('falls through on a relative string that is not a guide path', () => {
    expect(isGuideUrl('not a url')).toBeNull();
  });

  it('falls through on an unparsable URL', () => {
    expect(isGuideUrl('https://[::1')).toBeNull();
  });

  it('lands on the page, not a section, for a malformed %-escape in the fragment', () => {
    expect(isGuideUrl('https://www.monize.net/docs/budgets#50%')).toEqual({
      page: 'budgets',
    });
  });

  it('falls through on no href', () => {
    expect(isGuideUrl(undefined)).toBeNull();
  });
});

describe('no help link points at the retired GitHub wiki', () => {
  it('names a destination in DOCS_LINKS instead', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.endsWith('docs-links.test.ts'))
      .filter((file) => WIKI.test(readFileSync(file, 'utf8')))
      .map((file) => `src/${relative(SRC, file)}`);
    expect(offenders, 'use docsUrl() from @/lib/docs-links').toEqual([]);
  });
});
