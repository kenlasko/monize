import { describe, it, expect } from 'vitest';

/**
 * Guard for issue #1316: the configured number locale is the single source of
 * truth for every figure addressed to a user, the way `useDateFormat()` is for
 * dates.
 *
 * Monize has had a preference-aware formatter (`useNumberFormat()`) and a
 * preference-blind one (`@/lib/format`) side by side for a long time, and the
 * second is the one a component reaches for when the first needs a hook. So a
 * Polish user with `numberFormat: 'pl-PL'` read `zl18,812.71` on the Securities
 * page and `18 812,71 zl` on the page beside it.
 *
 * Four fingerprints reproduce every instance that was found:
 *
 *   1. a React/UI file importing the raw `formatCurrency` / `formatShareQuantity`;
 *   2. a numeric `toLocaleString()`, which follows the BROWSER -- and an explicit
 *      `numberFormat` exists precisely to override the browser, so swapping a
 *      hardcoded `en-US` for a bare `toLocaleString()` is not a fix;
 *   3. `toFixed(n)` concatenated with a literal `%`, which is a `.` decimal in
 *      every locale and puts the `%` where English puts it;
 *   4. a hardcoded `en-US` `Intl.NumberFormat` in runtime code.
 *
 * Each allowlist entry below is a classified fixed-locale contract, not a
 * grandfathered offender. Prefer shrinking it to widening a pattern.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** Source files only: a test may legitimately spell the pattern it asserts on. */
function productionSources(): [string, string][] {
  return Object.entries(sources).filter(
    ([path]) => !/\.test\.tsx?$/.test(path),
  );
}

/**
 * Blank out comment bodies, keeping line breaks so reported line numbers still
 * point at the source. The prose above and in `useNumberFormat.ts` has to NAME
 * `toLocaleString()` and `toFixed` to explain why they are banned, and a scan
 * that reads its own explanation as a violation is worse than no scan -- the
 * cheap way out of it is a weaker comment. Same technique as
 * `lib/loan-history.guard.test.ts`.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, before: string) =>
        before + ' '.repeat(match.length - before.length),
    );
}

/** 1-indexed line number of a character offset, for an offender report. */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

describe('the comment stripper', () => {
  it('blanks a comment while preserving line numbers', () => {
    const stripped = withoutComments('const a = 1;\n// toFixed(1)}%\nconst b = 2;');
    expect(stripped).not.toContain('toFixed');
    expect(stripped.split('\n')).toHaveLength(3);
  });

  it('leaves code alone, so a real offender is still found', () => {
    const stripped = withoutComments("const a = `${x.toFixed(1)}%`;");
    expect(stripped).toContain('toFixed(1)}%');
  });

  it('does not mistake a URL for a comment', () => {
    expect(withoutComments("const u = 'https://x.test/a';")).toContain('//x.test');
  });
});

describe('user-facing money and share counts go through useNumberFormat', () => {
  /**
   * `@/lib/format` keeps `formatCurrency` and `formatShareQuantity` as pure
   * deterministic helpers -- they are fine in a non-React, non-user-facing
   * context. What must not happen is a component rendering through them: that is
   * the `en-US` the user's preference was supposed to override.
   */
  const RAW_CURRENCY_IMPORT =
    /import\s*\{[^}]*\b(formatCurrency|formatShareQuantity)\b[^}]*\}\s*from\s*['"]@\/lib\/format['"]/;

  const UI_FILE = /^\/src\/(components|app|hooks)\//;

  it('has no UI file importing the raw currency or share helper', () => {
    const offenders = productionSources()
      .filter(([path]) => UI_FILE.test(path))
      .filter(([, content]) => RAW_CURRENCY_IMPORT.test(withoutComments(content)))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it('still finds the helpers, so the rule cannot pass by accident', () => {
    // Were either renamed or moved, the check above would trivially pass over an
    // empty set. This fails first and says what to update.
    const format = sources['/src/lib/format.ts'];
    expect(format, '/src/lib/format.ts not found -- update this guard').toBeTruthy();
    expect(format).toContain('export function formatCurrency');
    expect(format).toContain('export function formatShareQuantity');
  });

  it('offers a locale-aware share formatter to migrate to', () => {
    // The migration target. Without it the rule above has no answer for a
    // holdings column, and the honest response would be to allowlist it.
    const hook = sources['/src/hooks/useNumberFormat.ts'];
    expect(hook).toContain('const formatShareQuantity = useCallback');
    expect(hook).toContain('SHARE_QUANTITY_MAX_FRACTION_DIGITS');
  });
});

describe('a number is not formatted through the browser locale', () => {
  /**
   * `toLocaleString()` on a Date is a date, which `useDateFormat()` governs and
   * this guard does not. Everything else reaching for it is a number following
   * the browser instead of the user's `numberFormat`.
   */
  const TO_LOCALE_STRING = /\.toLocaleString\(/g;

  /** The receiver expression a `.toLocaleString(` call is made on. */
  function receiverBefore(source: string, index: number): string {
    const lineStart = source.lastIndexOf('\n', index) + 1;
    return source.slice(lineStart, index);
  }

  /**
   * Files with a classified non-numeric `toLocaleString`, each with its reason.
   * A `new Date(...)` receiver needs no entry -- it is self-evidently a date.
   */
  const ALLOWLIST: Record<string, string> = {
    '/src/components/budgets/BudgetWizard.tsx':
      "a month name for the default budget NAME (`now.toLocaleString('default', { month: 'long' })`), not a figure",
    '/src/lib/utils.ts':
      "machine-shaped wall-clock timestamps in a fixed 'sv-SE' (ISO-like) form for timezone arithmetic; never displayed",
  };

  it('has no numeric toLocaleString outside the classified set', () => {
    const offenders: string[] = [];
    for (const [path, raw] of productionSources()) {
      if (path in ALLOWLIST) continue;
      const content = withoutComments(raw);
      for (const match of content.matchAll(TO_LOCALE_STRING)) {
        const receiver = receiverBefore(content, match.index);
        if (/\bDate\b/.test(receiver)) continue;
        offenders.push(`${path}:${lineOf(content, match.index)}`);
      }
    }

    // Use `useNumberFormat().formatNumber(value, 0)` for a count, `formatPercent`
    // for a percentage, `formatCurrency` for money. A bare `toLocaleString()`
    // renders `12,345` for a Polish user whose preference asks for `12 345`,
    // because it reads the browser and not the preference.
    expect(offenders).toEqual([]);
  });

  it('keeps every allowlisted file honest', () => {
    // An entry that no longer names a real file, or a file that no longer holds
    // the pattern, is a stale exemption -- it would silently cover a future
    // offender in the same file.
    for (const path of Object.keys(ALLOWLIST)) {
      expect(sources[path], `${path} is allowlisted but does not exist`).toBeTruthy();
      expect(
        withoutComments(sources[path]),
        `${path} no longer calls toLocaleString -- delete its allowlist entry`,
      ).toContain('.toLocaleString(');
    }
  });
});

describe('a percentage is not written beside a literal %', () => {
  /**
   * The first pass of this guard matched `.toFixed(n)}%` and `x.toFixed(n) + '%'`
   * -- the two shapes the migration had just removed -- and reported clean over
   * fourteen surviving offenders, because the codebase's commonest shape names no
   * formatter at all: `{percentage}%`, `{Math.round(x)}%`, `{cond ? a : '0.0'}%`.
   * A scan written from the diff sees what was fixed, not what the rule is.
   *
   * So the subject is the literal `%` itself: any `}` immediately followed by one.
   * That is the whole family, and it needs no list of shapes to keep up with.
   */
  const CLOSING_BRACE_PERCENT = /\}%/g;

  /**
   * A CSS percentage is a length, not a figure: `width: ${pct}%` inside a style
   * is the one legitimate `}%`, and it must stay a plain number because CSS does
   * not read the user's locale. Recognised by the property it is assigned to,
   * looking only at the text before the match on its own line.
   */
  const CSS_LENGTH =
    /(width|height|left|right|top|bottom|translate|basis|offset|inset|size|margin|padding)/i;

  /** The three modules whose job IS composing a percentage from its parts. */
  const FORMATTER_MODULES = new Set([
    '/src/hooks/useNumberFormat.ts',
    '/src/lib/format.ts',
    '/src/test/number-format-mock.ts',
  ]);

  it('has no percentage composed beside a literal % outside the formatters', () => {
    const offenders: string[] = [];
    for (const [path, raw] of productionSources()) {
      if (FORMATTER_MODULES.has(path)) continue;
      const content = withoutComments(raw);
      for (const match of content.matchAll(CLOSING_BRACE_PERCENT)) {
        const lineStart = content.lastIndexOf('\n', match.index) + 1;
        if (CSS_LENGTH.test(content.slice(lineStart, match.index))) continue;
        offenders.push(`${path}:${lineOf(content, match.index)}`);
      }
    }

    // A literal `%` lands where English puts it (fr-FR writes "12,3 %"), and the
    // number beside it carries a `.` decimal. Use
    // `useNumberFormat().formatPercent(value, decimals)` where the surface has
    // decided a decimal count, `formatPercentTrimmed(value)` where the value
    // arrives already rounded and the count must not change what is displayed,
    // or `formatSignedPercent` where an explicit leading sign is wanted.
    expect(offenders).toEqual([]);
  });

  it('still finds the formatter modules, so the exemption is not vacuous', () => {
    for (const path of FORMATTER_MODULES) {
      expect(sources[path], `${path} not found -- update this guard`).toBeTruthy();
      expect(withoutComments(sources[path])).toMatch(CLOSING_BRACE_PERCENT);
    }
  });

  it('leaves a CSS length alone but catches a figure on the same line', () => {
    // The exemption is keyed on the text BEFORE the match, so a percentage
    // rendered on a line that also sets a width is still caught.
    const css = 'style={{ width: `${pct}%` }}';
    const figure = '<span>{pct}%</span>';
    const lineOfText = (text: string) =>
      CSS_LENGTH.test(text.slice(0, text.indexOf('}%')));
    expect(lineOfText(css)).toBe(true);
    expect(lineOfText(figure)).toBe(false);
  });
});

describe('en-US is not hardcoded in a formatter', () => {
  /**
   * `undefined` is included deliberately. It is not a fixed locale, it is the
   * BROWSER's -- the same defect the `toLocaleString()` scan above covers,
   * wearing an explicit argument. The AI usage dashboard formatted money through
   * `new Intl.NumberFormat(undefined, ...)` beside counts that had just been
   * migrated, so one table row disagreed with itself.
   */
  const HARDCODED_EN_US =
    /(?:Intl\.NumberFormat|toLocaleString)\(\s*(?:['"]en-US['"]|undefined)/g;

  /** The one module whose documented contract IS a fixed deterministic locale. */
  const DETERMINISTIC_HELPERS = '/src/lib/format.ts';

  /**
   * Files whose fixed `en-US` is a classified contract rather than a defect.
   * `productionSources()` filters out `*.test.ts` but not a test HELPER, and
   * this one is deliberately deterministic -- it stands in for the hook so a
   * component test's output does not move with the runner's locale.
   */
  const ALLOWLIST = new Set([
    DETERMINISTIC_HELPERS,
    '/src/test/number-format-mock.ts',
  ]);

  it('appears only in the deterministic helper module', () => {
    const offenders: string[] = [];
    for (const [path, raw] of productionSources()) {
      if (ALLOWLIST.has(path)) continue;
      const content = withoutComments(raw);
      for (const match of content.matchAll(HARDCODED_EN_US)) {
        offenders.push(`${path}:${lineOf(content, match.index)}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('still finds the helper module, so the exemption is not vacuous', () => {
    expect(
      HARDCODED_EN_US.test(withoutComments(sources[DETERMINISTIC_HELPERS])),
    ).toBe(true);
  });
});

describe('a figure is not formatted with toFixed in UI code', () => {
  /**
   * `toFixed(n)` is a `.` decimal with no grouping in every locale, so a figure
   * a person reads that goes through it ignores `numberFormat`. The loan setup
   * dialog and the investment form wrote `toFixed(2)` / `toFixed(4)` into their
   * readouts beside hooks that already formatted the rest of the same sentence.
   * Use `useNumberFormat()`: `formatCurrency(value, code, digits)`,
   * `formatShareQuantity`, `formatPrice`, `formatNumber(value, digits)`.
   */
  const TO_FIXED = /\.toFixed\(/g;
  const UI_SOURCE = /^\/src\/(components|app|hooks)\//;

  type Entry = { count: number; reason: string };

  /** Not a readout: the call produces a value a machine or a table reads. */
  const CLASSIFIED: Record<string, Entry> = {
    '/src/components/securities/detail/SecurityBondScenarioPanel.tsx': {
      count: 1,
      reason:
        'percentToFraction builds the fraction string the API takes, a wire value and not a readout',
    },
  };

  /**
   * Known readout offenders owned by other streams. Shrink-only: the stream that
   * owns the file migrates it to `useNumberFormat()` and lowers or deletes the
   * entry in the same commit. Never add a file or raise a count here.
   */
  const BASELINE: Record<string, Entry> = {
    '/src/components/reports/SavingsRateReport.tsx': {
      count: 1,
      reason: 'tooltipRate: point.savingsRate.toFixed(1); reports stream migrates it to formatPercent',
    },
    '/src/components/reports/MonteCarloReport.tsx': {
      count: 2,
      reason: 'collapsedCustomReturns return/vol toFixed(1); reports stream migrates it to formatPercent',
    },
    '/src/components/reports/CurrencyExposureReport.tsx': {
      count: 2,
      reason: 'FX rate readout toFixed(FX_RATE_DISPLAY_DECIMALS); reports stream migrates it',
    },
    '/src/components/accounts/loan-detail/LoanSummaryCards.tsx': {
      count: 1,
      reason: 'effectiveRate toFixed(3); loans stream migrates it to formatPercent',
    },
    '/src/components/currencies/CurrencyList.tsx': {
      count: 1,
      reason: 'exchange rate readout toFixed(FX_RATE_DISPLAY_DECIMALS); currencies stream migrates it',
    },
    '/src/components/investments/InvestmentTransactionListParts.tsx': {
      count: 1,
      reason: 'share quantity trimmed through toFixed(4); investments list stream migrates it to formatShareQuantity',
    },
  };

  function expectedCount(path: string): number {
    return (CLASSIFIED[path]?.count ?? 0) + (BASELINE[path]?.count ?? 0);
  }

  function actualCounts(): Map<string, number[]> {
    const found = new Map<string, number[]>();
    for (const [path, raw] of productionSources()) {
      if (!UI_SOURCE.test(path)) continue;
      const content = withoutComments(raw);
      for (const match of content.matchAll(TO_FIXED)) {
        const lines = found.get(path) ?? [];
        lines.push(lineOf(content, match.index));
        found.set(path, lines);
      }
    }
    return found;
  }

  it('has no toFixed outside the classified and baseline sets', () => {
    const offenders: string[] = [];
    for (const [path, lines] of actualCounts()) {
      if (lines.length > expectedCount(path)) {
        offenders.push(
          `${path}: ${lines.length} found, ${expectedCount(path)} allowed (lines ${lines.join(', ')})`,
        );
      }
    }
    // Use `useNumberFormat()` (`formatCurrency`, `formatShareQuantity`,
    // `formatPrice`, `formatNumber`, `formatPercent`). A machine value (CSV, an
    // API string) is classified above with its reason; a readout never is.
    expect(offenders).toEqual([]);
  });

  it('keeps every entry honest: a lower count means the entry must shrink', () => {
    const found = actualCounts();
    const stale: string[] = [];
    for (const path of new Set([...Object.keys(CLASSIFIED), ...Object.keys(BASELINE)])) {
      const actual = found.get(path)?.length ?? 0;
      if (actual < expectedCount(path)) {
        stale.push(`${path}: ${actual} found, ${expectedCount(path)} listed -- lower or delete the entry`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('gives every entry a reason and a positive count', () => {
    for (const list of [CLASSIFIED, BASELINE]) {
      for (const [path, entry] of Object.entries(list)) {
        expect(entry.count, `${path} count`).toBeGreaterThan(0);
        expect(entry.reason.length, `${path} reason`).toBeGreaterThan(10);
      }
    }
  });

  it('still finds toFixed in UI code, so the scan is not vacuous', () => {
    const found = actualCounts();
    expect(found.size).toBeGreaterThan(0);
    expect(found.get('/src/components/reports/MonteCarloReport.tsx')?.length).toBeGreaterThanOrEqual(2);
  });
});
