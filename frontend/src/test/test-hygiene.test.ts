import { describe, it, expect } from 'vitest';

/**
 * Guard tests for the testing conventions in `frontend/CLAUDE.md`.
 *
 * Sibling of `ui-conventions.test.ts`, for mistakes in the *tests* rather than
 * in the components. Each one here produced act warnings that a green suite
 * happily printed and nobody read, so the rule needs a failing test rather than
 * a paragraph.
 */
const sources = import.meta.glob('/src/**/*.{test,spec}.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** The body of every `afterEach(...)` callback in a file, braces balanced. */
function afterEachBodies(content: string): string[] {
  const bodies: string[] = [];
  const opener = /afterEach\(\s*(?:async\s*)?\(\s*\)\s*=>\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(content)) !== null) {
    const start = content.indexOf('{', match.index);
    let depth = 0;
    for (let i = start; i < content.length; i += 1) {
      if (content[i] === '{') depth += 1;
      else if (content[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          bodies.push(content.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return bodies;
}

describe('a shared store is reset only after the tree is unmounted', () => {
  /**
   * Testing Library registers its `cleanup` at import time, and vitest runs
   * after-hooks in reverse registration order -- so a file's own `afterEach`
   * runs *first*, while the component it rendered is still mounted and still
   * subscribed. Writing to a Zustand store there re-renders that component
   * outside act, once per selector it reads through. `SecurityDetailHeader`
   * produced three such warnings in every one of its tests for exactly this.
   *
   * Call `cleanup()` at the top of the hook. A second cleanup afterwards is a
   * no-op, so this costs nothing where the hazard does not apply.
   */
  it('has no afterEach that writes a store before calling cleanup()', () => {
    const offenders = Object.entries(sources)
      .filter(([, content]) =>
        afterEachBodies(content).some(
          (body) => /\w+\.setState\(/.test(body) && !body.includes('cleanup('),
        ),
      )
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});

describe('intl context in tests comes from the shared provider', () => {
  /**
   * A test that mounts its own `NextIntlClientProvider` has to name the
   * namespaces its subject reads, and that list is a guess about someone
   * else's code: `useImportWizard` grew a `useTranslations('common')` beside
   * its `'import'` one, its wrapper listed only `'import'`, and every run
   * printed 1800 MISSING_MESSAGE traces that nobody read because the suite was
   * green throughout.
   *
   * `@/test/intl` supplies every English namespace and throws on a missing
   * message, so the same gap fails the test that caused it. Use `render` from
   * `@/test/render`, or `intlWrapper()` / `TestIntlProvider` for a hook test or
   * a non-English locale -- `TestIntlProvider` takes `locale` and a `messages`
   * override merged over English.
   */
  it('has no test mounting NextIntlClientProvider directly', () => {
    const offenders = Object.entries(sources)
      .filter(([, content]) => content.includes('NextIntlClientProvider'))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});
