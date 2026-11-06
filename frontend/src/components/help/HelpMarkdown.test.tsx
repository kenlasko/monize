import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent } from '@/test/render';
import { HelpMarkdown } from './HelpMarkdown';
import type { HelpTocEntry } from '@/lib/help';
import { githubSlug } from '@/lib/markdown/remark-help';

const DOCS_DIR = join(process.cwd(), '..', 'website', 'docs');
const ONLINE = 'https://www.monize.net/docs/budgets';

interface RenderOptions {
  toc?: HelpTocEntry[];
  slug?: string;
  onNavigate?: (target: { page: string; section?: string }) => void;
}

function renderMarkdown(markdown: string, opts: RenderOptions = {}) {
  const onNavigate = opts.onNavigate ?? vi.fn();
  const utils = render(
    <HelpMarkdown
      markdown={markdown}
      toc={opts.toc ?? []}
      slug={opts.slug ?? 'budgets'}
      onlineUrl={ONLINE}
      onNavigate={onNavigate}
    />,
  );
  return { ...utils, onNavigate };
}

describe('HelpMarkdown: structure', () => {
  it('drops the page title and renders the headings with the ids from the toc', () => {
    renderMarkdown('# Budgets\n\nIntro.\n\n## Creating a budget\n\n### Step 1: Analyze\n', {
      toc: [
        { depth: 2, id: 'creating-a-budget', heading: 'Creating a budget' },
        { depth: 3, id: 'step-1-analyze', heading: 'Step 1: Analyze' },
      ],
    });
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Creating a budget' })).toHaveAttribute(
      'id',
      'creating-a-budget',
    );
    expect(screen.getByRole('heading', { level: 3 })).toHaveAttribute('id', 'step-1-analyze');
  });

  it('prefers the toc id over its own slug so the app cannot disagree with the website', () => {
    renderMarkdown('## Alerts\n', { toc: [{ depth: 2, id: 'alerts-1', heading: 'Alerts' }] });
    expect(screen.getByRole('heading', { level: 2 })).toHaveAttribute('id', 'alerts-1');
  });

  it('numbers a repeated deeper heading the way the website does', () => {
    renderMarkdown('## Reports\n\n#### Setup\n\n#### Setup\n', {
      toc: [{ depth: 2, id: 'reports', heading: 'Reports' }],
    });
    const ids = screen.getAllByRole('heading', { level: 4 }).map((h) => h.id);
    expect(ids).toEqual(['setup', 'setup-1']);
  });

  it('turns an <a id> line into an anchor target and drops other raw HTML', () => {
    const { container } = renderMarkdown(
      '## One\n\n<a id="custom-target"></a>\n\n<div>raw</div>\n\nText after.\n',
      { toc: [{ depth: 2, id: 'one', heading: 'One' }] },
    );
    const target = container.querySelector('#custom-target');
    expect(target?.tagName).toBe('SPAN');
    expect(container).not.toHaveTextContent('raw');
    expect(container).toHaveTextContent('Text after.');
  });

  it('renders a callout with its translated label', () => {
    const { container } = renderMarkdown('> [!WARNING]\n> Careful with this.\n');
    const aside = container.querySelector('aside[data-callout="warning"]');
    expect(aside).not.toBeNull();
    expect(aside).toHaveTextContent('Warning');
    expect(aside).toHaveTextContent('Careful with this.');
    expect(aside).not.toHaveTextContent('[!WARNING]');
  });

  it('renders an ordinary blockquote as a quote', () => {
    const { container } = renderMarkdown('> Just a quote.\n');
    expect(container.querySelector('blockquote')).toHaveTextContent('Just a quote.');
    expect(container.querySelector('aside')).toBeNull();
  });

  it('renders a table inside a scroller', () => {
    const { container } = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n');
    expect(container.querySelector('table')?.parentElement).toHaveClass('overflow-x-auto');
    expect(screen.getByRole('columnheader', { name: 'A' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '2' })).toBeInTheDocument();
  });
});

describe('HelpMarkdown: links', () => {
  // jsdom cannot navigate; swallow the default action the browser would take
  // after React has seen the click.
  const swallow = (e: Event) => e.preventDefault();
  beforeEach(() => document.addEventListener('click', swallow));
  afterEach(() => document.removeEventListener('click', swallow));

  it('follows name.md#anchor inside the panel on a plain click', () => {
    const { onNavigate } = renderMarkdown('See [Reports](reports.md#budget-reports).');
    const link = screen.getByRole('link', { name: 'Reports' });
    expect(link).toHaveAttribute('href', 'https://www.monize.net/docs/reports#budget-reports');
    expect(link).not.toHaveAttribute('target');
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith({ page: 'reports', section: 'budget-reports' });
  });

  it('follows a link to a page with no anchor, and to the landing page', () => {
    const { onNavigate } = renderMarkdown('[Tags](tags.md) and [Home](index.md)');
    fireEvent.click(screen.getByRole('link', { name: 'Tags' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ page: 'tags' });
    const home = screen.getByRole('link', { name: 'Home' });
    expect(home).toHaveAttribute('href', 'https://www.monize.net/docs/');
    fireEvent.click(home);
    expect(onNavigate).toHaveBeenLastCalledWith({ page: 'index' });
  });

  it('follows a #section link on the page being shown', () => {
    const { onNavigate } = renderMarkdown('[Down](#alerts)', { slug: 'budgets' });
    fireEvent.click(screen.getByRole('link', { name: 'Down' }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'budgets', section: 'alerts' });
  });

  it('leaves a modified click to the browser', () => {
    const { onNavigate } = renderMarkdown('[Reports](reports.md)');
    const link = screen.getByRole('link', { name: 'Reports' });
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { shiftKey: true });
    fireEvent.click(link, { button: 1 });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('opens an absolute link in a new tab without opener access', () => {
    const { onNavigate } = renderMarkdown('[GitHub](https://github.com/kenlasko/monize)');
    const link = screen.getByRole('link', { name: 'GitHub' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    fireEvent.click(link);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('renders a link of any other kind as plain text', () => {
    const { container } = renderMarkdown('[Odd](javascript:alert(1)) and [Rel](images/x.png)');
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container).toHaveTextContent('Odd and Rel');
  });
});

describe('HelpMarkdown: images', () => {
  const md = '## Dashboard\n\n![The budget dashboard](images/budget-dashboard.png)\n';
  const toc = [{ depth: 2, id: 'dashboard', heading: 'Dashboard' }];

  it('shows the caption and a link to the section online, with no <img>', () => {
    const { container } = renderMarkdown(md, { toc });
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('The budget dashboard');
    const link = screen.getByRole('link', { name: /View screenshot on monize.net/ });
    expect(link).toHaveAttribute('href', `${ONLINE}#dashboard`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('links to the page itself for a picture above the first section', () => {
    renderMarkdown('![Top](images/top.png)\n');
    expect(screen.getByRole('link', { name: /View screenshot/ })).toHaveAttribute('href', ONLINE);
  });

  it('falls back to a generic caption when the picture has no alt text', () => {
    const { container } = renderMarkdown('![](images/top.png)\n');
    expect(container).toHaveTextContent('Screenshot');
  });

  it('does not nest a block in a paragraph', () => {
    const { container } = renderMarkdown('![A](images/a.png)\n![B](images/b.png)\n');
    expect(container.querySelector('p')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(2);
  });
});

/**
 * The parity guard between the app's renderer and the website's: every anchor a
 * link can name must exist in both. The generated HTML is what the website
 * serves, so a heading slug or anchor target that the two disagree about fails
 * here instead of leaving a link that lands at the top of the page.
 */
describe('HelpMarkdown: id parity with the generated website', () => {
  interface IndexEntry {
    u: string;
    h: string;
  }
  const index: IndexEntry[] = readFileSync(join(DOCS_DIR, 'search-index.json'), 'utf8')
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as IndexEntry);

  /** The `##`/`###` levels outside code fences, as the backend reads them. */
  function headingDepths(markdown: string): number[] {
    const depths: number[] = [];
    let fence: string | null = null;
    for (const line of markdown.split(/\r?\n/)) {
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        if (fence === null) fence = marker;
        else if (fence === marker) fence = null;
        continue;
      }
      if (fence !== null) continue;
      const heading = /^ {0,3}(#{2,3})\s+\S/.exec(line);
      if (heading) depths.push(heading[1].length);
    }
    return depths;
  }

  /** The toc the help API returns for a page: search-index sections paired with heading levels. */
  function tocFor(slug: string, markdown: string): HelpTocEntry[] {
    const pagePath = slug === 'index' ? '' : slug;
    const sections = index
      .map((e) => ({ path: e.u.replace(/^\/docs\//, '').split('#'), heading: e.h }))
      .filter((e) => e.path[0] === pagePath && e.path[1])
      .map((e) => ({ id: e.path[1], heading: e.heading }));
    const depths = headingDepths(markdown);
    return sections.map((s, i) => ({
      depth: (depths.length === sections.length ? depths[i] : 2) as 2 | 3,
      ...s,
    }));
  }

  const navGroupIds = (
    JSON.parse(readFileSync(join(DOCS_DIR, 'nav.json'), 'utf8')) as { group: string }[]
  ).map((g) => githubSlug(g.group));

  const slugs = readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));

  it('finds the guide pages', () => {
    expect(slugs.length).toBeGreaterThan(10);
    expect(slugs).toContain('index');
  });

  it.each(slugs)('%s renders the ids the website page has', (slug) => {
    const markdown = readFileSync(join(DOCS_DIR, `${slug}.md`), 'utf8');
    const html = readFileSync(join(DOCS_DIR, `${slug}.html`), 'utf8');

    // The page template adds ids before the body (header, sidebar, the content
    // wrapper itself) and after it (the search box); the body is what lies between.
    const start = html.indexOf('id="content"') + 'id="content"'.length;
    const end = html.indexOf('id="search"', start);
    const body = html.slice(start, end === -1 ? undefined : end);
    // The landing page's template also draws a card per nav group, each with an id.
    const cardIds = slug === 'index' ? navGroupIds : [];
    const websiteIds = [...body.matchAll(/\sid="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((id) => !cardIds.includes(id));

    const { container } = renderMarkdown(markdown, {
      slug,
      toc: tocFor(slug, markdown),
    });
    const appIds = [...container.querySelectorAll('[id]')].map((el) => el.id);

    expect(appIds).toEqual(websiteIds);
  });
});
