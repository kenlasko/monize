import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DOCS_LINKS, docsUrl, type DocsLink } from './docs-links';

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

describe('no help link points at the retired GitHub wiki', () => {
  it('names a destination in DOCS_LINKS instead', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.endsWith('docs-links.test.ts'))
      .filter((file) => WIKI.test(readFileSync(file, 'utf8')))
      .map((file) => `src/${relative(SRC, file)}`);
    expect(offenders, 'use docsUrl() from @/lib/docs-links').toEqual([]);
  });
});
