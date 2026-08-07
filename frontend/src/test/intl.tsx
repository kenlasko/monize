import { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';

// Eagerly load every English namespace so tests resolve translated strings
// without mocking next-intl. New namespaces are picked up automatically -- no
// need to edit this file when a feature area is extracted.
//
// `import.meta.glob` is a Vite/Vitest build-time macro: it is statically
// replaced during transformation, so it must be referenced by its full literal
// name (see `src/types/vite-glob.d.ts` for the tsc type declaration).
const namespaceModules = import.meta.glob<{ default: Record<string, unknown> }>(
  '@/i18n/messages/en/*.json',
  { eager: true },
);

/** Every English namespace, keyed by namespace name. */
export const testMessages = Object.fromEntries(
  Object.entries(namespaceModules).map(([path, mod]) => {
    const namespace = path.split('/').pop()!.replace(/\.json$/, '');
    return [namespace, mod.default];
  }),
);

interface TestIntlProviderProps {
  children: ReactNode;
  /** Locale to render under. Defaults to English. */
  locale?: string;
  /**
   * Namespaces to override, merged over the full English set -- for a test
   * that asserts on another locale's copy. Namespaces not listed still resolve
   * against English, so a component reaching for an unrelated one does not
   * blow up.
   */
  messages?: Record<string, unknown>;
}

/**
 * The intl context for tests. Always carries *every* English namespace, because
 * hand-picking the namespaces a component "needs" is a guess that goes stale
 * the moment it reaches for another one: `useImportWizard` gained a
 * `useTranslations('common')` alongside its `'import'` one and its test wrapper
 * did not follow, which printed 1800 MISSING_MESSAGE traces per run.
 *
 * A missing message throws rather than logging, so the next such gap fails the
 * test that caused it instead of scrolling past in CI output.
 */
export function TestIntlProvider({
  children,
  locale = 'en',
  messages,
}: TestIntlProviderProps) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={{ ...testMessages, ...messages }}
      onError={(error) => {
        throw error;
      }}
    >
      {children}
    </NextIntlClientProvider>
  );
}

/**
 * `renderHook`/`render` wrapper factory for tests that do not use
 * `@/test/render` (hook tests, and the few cases needing a non-English locale).
 */
export function intlWrapper(props: Omit<TestIntlProviderProps, 'children'> = {}) {
  return function IntlWrapper({ children }: { children: ReactNode }) {
    return <TestIntlProvider {...props}>{children}</TestIntlProvider>;
  };
}
