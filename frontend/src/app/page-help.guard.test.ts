import { describe, it, expect } from 'vitest';

/**
 * Every `PageHeader` render names its guide page (`help`, a `DocsLink` key:
 * `docs/frontend/ui-conventions.md`, "Help for a screen"). A page added
 * without it is reachable from nowhere in the Help menu's "Help for this
 * page" entry, the header's `?` icon, or help search's per-screen context --
 * silently, since nothing else notices a missing prop. This scans every
 * source file, not only `src/app/**\/page.tsx`: a screen most often renders
 * `PageHeader` itself, but one that renders it from a shared component one
 * level away (`RuleEditorScreen`, used by both `rules/new` and `rules/[id]`)
 * is just as reachable with no help key, and flagging the component that
 * actually calls `PageHeader` is more useful than attributing the gap to
 * whichever page happens to import it.
 *
 * `loading.tsx` skeletons render `PageHeaderSkeleton`, a different
 * component, and are not in scope.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

function productionSources(): [string, string][] {
  return Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));
}

/**
 * A screen `PageHeader` cannot yet name a guide page for, each with why. This
 * is a decision recorded beside the guard, not an escape hatch: it is
 * reviewed in the PR that adds an entry and is shrink-only from then on
 * (`AGENTS.md`). A screen left off this list that the guide genuinely does
 * not cover yet is a documentation gap to report, never a reason to widen
 * this baseline.
 */
const EXEMPTIONS: Record<string, string> = {
  '/src/app/share/page.tsx':
    'Web Share Target intake has no guide page yet -- a documentation gap, tracked in docs/future-plans/in-app-help-extras-tasks.md, not a permanent exemption.',
};

const PAGE_HEADER_TAG = '<PageHeader';
/**
 * How far past the opening tag to look for its closing `/>` at the same
 * indentation. Bounded, rather than scanning to end of file, so a call whose
 * closing tag is never found this way -- a shape this codebase does not use
 * today -- stops short with whatever it collected instead of swallowing the
 * rest of the file into one "call", which could pick up an unrelated `help=`
 * far below and read as compliant.
 */
const MAX_TAG_LINES = 60;

/**
 * Every `<PageHeader ... />` call in a file, as its full source text (the
 * self-closing tag only -- this codebase never gives it children). Matched by
 * indentation rather than a bracket-depth parser: this file's own tests
 * (`describes the matcher` below) show a tag that opens other JSX before its
 * own `help` prop, and the closing `/>` reliably lands back at the opening
 * tag's indentation once Prettier has formatted it.
 */
function pageHeaderCalls(content: string): string[] {
  const lines = content.split('\n');
  const calls: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const col = lines[i].indexOf(PAGE_HEADER_TAG);
    if (col === -1) continue;
    const before = lines[i][col - 1];
    if (before !== undefined && /[A-Za-z0-9_]/.test(before)) continue;
    const after = lines[i][col + PAGE_HEADER_TAG.length];
    if (after !== undefined && /[A-Za-z0-9_]/.test(after)) continue;
    const indent = lines[i].slice(0, col);
    let body = lines[i].slice(col);
    if (!/\/>/.test(body)) {
      const limit = Math.min(lines.length, i + 1 + MAX_TAG_LINES);
      for (let j = i + 1; j < limit; j++) {
        body += `\n${lines[j]}`;
        if (lines[j] === `${indent}/>`) break;
      }
    }
    calls.push(body);
  }
  return calls;
}

/** `help="x"`, `help='x'` or `help={...}`, never a bare substring match. */
const HAS_HELP = /\bhelp=/;

/** Every file with at least one PageHeader call missing `help`, exemptions included. */
function filesWithPageHeaderWithoutHelp(): string[] {
  const found: string[] = [];
  for (const [path, content] of productionSources()) {
    for (const call of pageHeaderCalls(content)) {
      if (!HAS_HELP.test(call)) {
        found.push(path);
        break;
      }
    }
  }
  return found;
}

describe('every PageHeader names its guide page', () => {
  it('has no PageHeader without help outside the recorded exemptions', () => {
    const allowed = new Set(Object.keys(EXEMPTIONS));
    const offenders = filesWithPageHeaderWithoutHelp().filter((path) => !allowed.has(path));
    expect(offenders).toEqual([]);
  });

  it('keeps the exemption list shrink-only', () => {
    const offending = new Set(filesWithPageHeaderWithoutHelp());
    // Every exempted path must still need the exemption -- one a prior fix
    // already covered is a stale entry, not a decision anyone is reviewing.
    expect(Object.keys(EXEMPTIONS).filter((path) => !offending.has(path))).toEqual([]);
  });

  describe('the matcher', () => {
    it('catches a PageHeader missing help, including one that opens nested JSX first', () => {
      const fixture = `
        <PageHeader
          title={t('title')}
          titleAdornment={
            <Switcher onSelect={(id) => router.push(\`/x/\${id}\`)} />
          }
        />
      `;
      const calls = pageHeaderCalls(fixture);
      expect(calls).toHaveLength(1);
      expect(HAS_HELP.test(calls[0])).toBe(false);
    });

    it('passes a PageHeader with help, in the same shape', () => {
      const fixture = `
        <PageHeader
          title={t('title')}
          titleAdornment={
            <Switcher onSelect={(id) => router.push(\`/x/\${id}\`)} />
          }
          help="budgets"
        />
      `;
      const calls = pageHeaderCalls(fixture);
      expect(calls).toHaveLength(1);
      expect(HAS_HELP.test(calls[0])).toBe(true);
    });

    it('ignores PageHeaderSkeleton, a different component', () => {
      const fixture = '        <PageHeaderSkeleton />';
      expect(pageHeaderCalls(fixture)).toHaveLength(0);
    });

    it('finds a single-line call', () => {
      const withHelp = '<PageHeader title={t("title")} help="budgets" />';
      const withoutHelp = '<PageHeader title={t("title")} />';
      expect(HAS_HELP.test(pageHeaderCalls(withHelp)[0])).toBe(true);
      expect(HAS_HELP.test(pageHeaderCalls(withoutHelp)[0])).toBe(false);
    });
  });
});
