import {
  render,
  renderHook,
  RenderHookOptions,
  RenderOptions,
} from '@testing-library/react';
import { ComponentType, ReactElement, ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { withReportNames } from '@/i18n/client-messages';
import { recordIfIntlError } from './intl-guard';

// Eagerly load every English namespace so component tests resolve translated
// strings without mocking next-intl. New namespaces are picked up automatically
// -- no need to edit this file when a feature area is extracted.
//
// `import.meta.glob` is a Vite/Vitest build-time macro: it is statically
// replaced during transformation, so it must be referenced by its full literal
// name (see `src/types/vite-glob.d.ts` for the tsc type declaration).
const namespaceModules = import.meta.glob<{ default: Record<string, unknown> }>(
  '@/i18n/messages/en/*.json',
  { eager: true },
);

const testMessages = withReportNames(
  Object.fromEntries(
    Object.entries(namespaceModules).map(([path, mod]) => {
      const namespace = path.split('/').pop()!.replace(/\.json$/, '');
      return [namespace, mod.default];
    }),
  ),
);

type Wrapper = ComponentType<{ children: ReactNode }>;

/**
 * `onError` turns a missing or malformed message into a test failure instead of
 * a buffered stderr line -- see `intl-guard.ts`. Returning without rethrowing
 * keeps the render going, so the failure is reported once, by name, in the
 * `afterEach` rather than as a render crash pointing at next-intl's internals.
 */
function AllProviders({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider
      locale="en"
      messages={testMessages}
      onError={recordIfIntlError}
    >
      <ThemeProvider>{children}</ThemeProvider>
    </NextIntlClientProvider>
  );
}

/**
 * Compose the caller's wrapper INSIDE the shared providers rather than
 * replacing them.
 *
 * RTL takes a single `wrapper`, so a test needing one more layer (StrictMode,
 * a store provider) used to have to give up intl and theme to get it -- which
 * is how several of these tests ended up hand-building a provider in the first
 * place. Nesting means the extra layer costs nothing.
 */
function composeWrapper(inner?: Wrapper): Wrapper {
  if (!inner) return AllProviders;
  const Inner = inner;
  return function ComposedWrapper({ children }: { children: ReactNode }) {
    return (
      <AllProviders>
        <Inner>{children}</Inner>
      </AllProviders>
    );
  };
}

function customRender(ui: ReactElement, options?: RenderOptions) {
  return render(ui, { ...options, wrapper: composeWrapper(options?.wrapper) });
}

/**
 * `renderHook` with the same providers `render` gives a component.
 *
 * This exists because its absence was a trap rather than a gap: `export * from
 * '@testing-library/react'` below re-exports RTL's own `renderHook`, so a test
 * importing it from this module still got no intl context and no theme, and the
 * only symptom was a hook's translated strings silently resolving to their keys.
 * The explicit export at the bottom shadows the star export -- the same
 * mechanism that makes `customRender` win over RTL's `render`.
 */
function customRenderHook<Result, Props>(
  callback: (initialProps: Props) => Result,
  options?: RenderHookOptions<Props>,
) {
  return renderHook(callback, {
    ...options,
    wrapper: composeWrapper(options?.wrapper),
  });
}

/**
 * Render in a locale other than `en`, for a test whose subject IS what a
 * different catalogue draws.
 *
 * The shared providers pin `en`, so a test about another locale used to have
 * no option but to build a `NextIntlClientProvider` of its own and reach past
 * this module for RTL's `render` -- two exemptions in
 * `intl-harness.guard.test.ts` each time, and a provider carrying whatever
 * namespaces its author happened to list.
 *
 * Building it here instead keeps this module the one place the provider is
 * constructed, and keeps `onError` attached: a namespace the caller did not
 * supply fails the test by name rather than rendering its keys, which is the
 * defect the hand-built wrappers kept reintroducing. The caller still chooses
 * the namespaces, because globbing twenty locales' catalogues into every test
 * file that imports this module is not worth what it costs.
 */
function renderInLocale(
  ui: ReactElement,
  {
    locale,
    messages,
    ...options
  }: RenderOptions & { locale: string; messages: Record<string, unknown> },
) {
  function LocaleProviders({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider
        locale={locale}
        messages={messages}
        onError={recordIfIntlError}
      >
        <ThemeProvider>{children}</ThemeProvider>
      </NextIntlClientProvider>
    );
  }

  return render(ui, { ...options, wrapper: LocaleProviders });
}

export * from '@testing-library/react';
export { customRender as render, customRenderHook as renderHook, renderInLocale };
