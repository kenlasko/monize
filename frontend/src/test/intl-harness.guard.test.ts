import { describe, it, expect } from 'vitest';

/**
 * One test harness supplies intl and theme, and tests reach it through
 * `@/test/render`.
 *
 * The defect this replaces was structural rather than careless. `render.tsx`
 * has always loaded every English namespace from a glob, but it wrapped only
 * `render`; its `export * from '@testing-library/react'` re-exported
 * `renderHook` untouched. So a hook test had no way to get a provider except to
 * build one, and fourteen files did -- each with a hand-picked namespace list,
 * every one of them partial. `useImportWizard` reads `import` and `common`; its
 * test supplied `import` alone, so every `common` lookup returned its key while
 * the test passed.
 *
 * Two scans, because the harness has two ways to be bypassed:
 *
 *   1. Importing `render`/`renderHook` from `@testing-library/react` rather
 *      than from `@/test/render`, which is how a test ends up with no provider.
 *   2. Building a `NextIntlClientProvider` in a test, which is how it ends up
 *      with a partial one. Nested inside the shared render it is worse than it
 *      looks -- the inner provider SHADOWS the full message set for everything
 *      below it, so adding one narrows the catalogue rather than widening it.
 *
 * Both lists shrink only. An entry is a deliberate exception with a reason, not
 * a to-do. The two locale-varying entries predate `renderInLocale`
 * (`src/test/render.tsx`), which builds the provider in the one place that is
 * allowed to and keeps `onError` attached -- so a test whose subject is another
 * catalogue now needs no exemption at all, and a new one must not take one.
 */
/**
 * TEST files only. Both patterns are correct and necessary in production --
 * `app/layout.tsx` and `app/global-error.tsx` mount the real
 * `NextIntlClientProvider`, which is the thing being mirrored here -- so a scan
 * over all of `src/` would report the application itself.
 */
const sources = import.meta.glob('/src/**/*.test.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/**
 * Blank out comments, keeping line numbering, so the scans read CODE.
 *
 * This file has to name both banned patterns in prose to explain them, and the
 * docblock above quotes `NextIntlClientProvider` and the RTL import. Scanning
 * raw text would fail this file on its own explanation, and the cheap way out
 * is a weaker comment -- which is the opposite of the point.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => ' '.repeat(line.length));
}

/** `render` or `renderHook` imported from RTL rather than the shared harness. */
const RTL_RENDER_IMPORT =
  /import\s*\{[^}]*\b(?:render|renderHook)\b[^}]*\}\s*from\s*'@testing-library\/react'/;

const PROVIDER = /<NextIntlClientProvider\b/;

/**
 * Tests that legitimately render outside the shared harness. Each names why;
 * none is a partial-namespace wrapper, which is the thing being banned.
 */
const ALLOWED_RTL_RENDER = new Set([
  // Renders in Spanish and in a locale-varying wrapper: the shared provider
  // pins `en`, so these cannot use it and stay meaningful.
  '/src/app/error.test.tsx',
  '/src/components/whats-new/WhatsNewModal.test.tsx',
  // Subjects of the boot path, which is defined by having no providers around
  // it -- wrapping them would test something else.
  '/src/components/layout/BootSplash.test.tsx',
  '/src/components/providers/BootSplashHider.test.tsx',
  '/src/app/global-error.test.tsx',
  // The theme provider's own test: it mounts the provider under test.
  '/src/contexts/ThemeContext.test.tsx',
]);

const ALLOWED_PROVIDER = new Set([
  // Locale-varying, as above, and predating `renderInLocale`. (`src/test/render.tsx`
  // -- the one place the provider is legitimately built -- is not a test file, so
  // the scan never reaches it and it needs no exemption.)
  '/src/app/error.test.tsx',
  '/src/components/whats-new/WhatsNewModal.test.tsx',
]);

/**
 * Tests that still import from RTL and have not been converted yet. Unlike the
 * allow-lists above these are not exceptions -- each is a hook or component
 * test that predates the shared `renderHook` and works today only because its
 * subject happens not to translate anything. Adding a `useTranslations` to any
 * of their subjects would reintroduce the silent-key defect.
 *
 * The list SHRINKS ONLY: a new test cannot join it, and a converted one must
 * leave it (both are asserted below). Converting a file means deleting its line
 * and importing from `@/test/render`.
 */
const RTL_IMPORT_BASELINE = new Set([
  '/src/components/investments/CashRegisterFilters.test.tsx',
  '/src/components/ui/LoadingSkeleton.test.tsx',
  '/src/components/ui/LoadingSpinner.test.tsx',
  '/src/components/ui/NumericInput.test.tsx',
  '/src/components/ui/Select.test.tsx',
  '/src/components/ui/SummaryCard.test.tsx',
  '/src/hooks/useAnchorRect.test.ts',
  '/src/hooks/useBillsFilters.test.ts',
  '/src/hooks/useBrokerageFilterOptions.test.tsx',
  '/src/hooks/useClickOutside.test.ts',
  '/src/hooks/useDateFormat.test.ts',
  '/src/hooks/useDateRange.test.ts',
  '/src/hooks/useDebouncedValue.test.ts',
  '/src/hooks/useDemoMode.test.ts',
  '/src/hooks/useExchangeRates.test.ts',
  '/src/hooks/useFormDirtyNotify.test.ts',
  '/src/hooks/useFormModal.test.ts',
  '/src/hooks/useFormSubmitRef.test.ts',
  '/src/hooks/useHideOnScroll.test.ts',
  '/src/hooks/useHighlightTarget.test.ts',
  '/src/hooks/useLoanProjection.test.tsx',
  '/src/hooks/useLocalStorage.test.ts',
  '/src/hooks/useLongPress.test.ts',
  '/src/hooks/useMnyImport.test.ts',
  '/src/hooks/useNumberFormat.test.ts',
  '/src/hooks/useOnAiAction.test.ts',
  '/src/hooks/useOnUndoRedo.test.ts',
  '/src/hooks/usePersistedAccountFilter.test.ts',
  '/src/hooks/useRelativeTime.test.ts',
  '/src/hooks/useReportData.test.ts',
  '/src/hooks/useScrollSpy.test.ts',
  '/src/hooks/useScrollToTopOnNavigation.test.ts',
  '/src/hooks/useSortableTable.test.ts',
  '/src/hooks/useStaleReconciliation.test.ts',
  '/src/hooks/useSwipeNavigation.test.ts',
  '/src/hooks/useTableDensity.test.ts',
  '/src/hooks/useTourAnchor.test.ts',
  '/src/hooks/useTransactionSelection.test.ts',
  '/src/hooks/useTransactionSubmitMode.test.ts',
  '/src/hooks/useWidgetConfig.test.tsx',
]);

/**
 * This file, which cannot scan itself: the fixtures in the stripper test quote
 * both banned patterns as STRING literals, and `withoutComments` blanks
 * comments rather than strings -- so the scanner would report itself for the
 * examples that prove it works.
 */
const SELF = '/src/test/intl-harness.guard.test.ts';

function offenders(pattern: RegExp, allowed: Set<string>): string[] {
  return Object.entries(sources)
    .filter(([path]) => path !== SELF)
    .filter(([path]) => !allowed.has(path))
    .filter(([, content]) => pattern.test(withoutComments(content)))
    .map(([path]) => path)
    .sort();
}

describe('the intl test harness is reached through @/test/render', () => {
  it('strips comments but still sees code', () => {
    // Load-bearing in both directions, so tested in both.
    const stripped = withoutComments(
      [
        "// import { render } from '@testing-library/react';",
        '/* <NextIntlClientProvider> */',
        "import { renderHook } from '@testing-library/react';",
        '<NextIntlClientProvider locale="en">',
      ].join('\n'),
    ).split('\n');

    expect(RTL_RENDER_IMPORT.test(stripped[0])).toBe(false);
    expect(PROVIDER.test(stripped[1])).toBe(false);
    expect(RTL_RENDER_IMPORT.test(stripped[2])).toBe(true);
    expect(PROVIDER.test(stripped[3])).toBe(true);
    expect(stripped).toHaveLength(4);
  });

  it('found the tree to scan', () => {
    // An empty glob would make every assertion below vacuously true.
    expect(Object.keys(sources).length).toBeGreaterThan(300);
  });

  it('no NEW test imports render or renderHook from @testing-library/react', () => {
    const current = offenders(RTL_RENDER_IMPORT, ALLOWED_RTL_RENDER);
    expect(
      current.filter((path) => !RTL_IMPORT_BASELINE.has(path)),
      "Import { render, renderHook } from '@/test/render' instead: RTL's own are " +
        'unwrapped, so the tree gets no intl provider and every translated string ' +
        'resolves to its key.',
    ).toEqual([]);
  });

  it('the baseline only shrinks', () => {
    // A file that has been converted must leave the list, or the list stops
    // being a record of remaining work and becomes permission.
    const current = new Set(offenders(RTL_RENDER_IMPORT, ALLOWED_RTL_RENDER));
    expect(
      [...RTL_IMPORT_BASELINE].filter((path) => !current.has(path)),
      'These no longer import render/renderHook from @testing-library/react. ' +
        'Delete them from RTL_IMPORT_BASELINE.',
    ).toEqual([]);
  });

  it('no test builds its own NextIntlClientProvider', () => {
    expect(
      offenders(PROVIDER, ALLOWED_PROVIDER),
      'Render through `@/test/render`, whose provider carries every English ' +
        'namespace from a glob. A hand-built message set is a snapshot of what ' +
        'its subject used the day it was written, and nested inside the shared ' +
        'render it shadows the full set rather than adding to it.',
    ).toEqual([]);
  });

  it('every allowed entry still exists and still needs the exemption', () => {
    // A stale exemption is how a list stops shrinking. Both sets are checked:
    // the file must exist, and it must actually still match the pattern it is
    // exempt from -- otherwise the entry is dead and should be deleted.
    for (const path of ALLOWED_RTL_RENDER) {
      expect(sources[path], `${path} is exempt but no longer exists`).toBeDefined();
      expect(
        RTL_RENDER_IMPORT.test(withoutComments(sources[path])),
        `${path} no longer imports render from RTL -- drop its exemption`,
      ).toBe(true);
    }
    for (const path of ALLOWED_PROVIDER) {
      expect(sources[path], `${path} is exempt but no longer exists`).toBeDefined();
      expect(
        PROVIDER.test(withoutComments(sources[path])),
        `${path} no longer builds a provider -- drop its exemption`,
      ).toBe(true);
    }
  });
});
