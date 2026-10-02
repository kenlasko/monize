import { describe, it, expect } from 'vitest';
import {
  BANK_SYNC_NEEDS_PREVIEW_CODE,
  groupRefusalReasons,
  isBankSyncFailure,
  isNeedsPreviewFailure,
  syncedResults,
  totalRefused,
  totalSyncResults,
} from './bank-sync-summary';
import { safeAuthorizationUrl } from './bank-sync-redirect';
import {
  BANK_SYNC_COUNTRY_CODES,
  buildBankSyncCountryOptions,
} from './bank-sync-countries';

describe('totalSyncResults', () => {
  it('adds counts and merges refusal reasons across accounts', () => {
    const totals = totalSyncResults([
      { imported: 2, skipped: 1, refused: { currency_mismatch: 1 } },
      { imported: 3, skipped: 4, refused: { currency_mismatch: 2, invalid_amount: 1 } },
    ]);
    expect(totals).toEqual({
      imported: 5,
      skipped: 5,
      refused: { currency_mismatch: 3, invalid_amount: 1 },
    });
    expect(totalRefused(totals.refused)).toBe(4);
  });

  it('is zero for no results', () => {
    expect(totalSyncResults([])).toEqual({ imported: 0, skipped: 0, refused: {} });
  });
});

describe('isNeedsPreviewFailure', () => {
  const failure = (code: string) => ({
    bankAccountId: 'b1',
    error: { code, message: 'm' },
  });

  it('recognises the code the server reports for an account waiting for its preview', () => {
    // The server's constant is `NEEDS_PREVIEW_CODE` in `bank-sync-errors.ts`.
    expect(BANK_SYNC_NEEDS_PREVIEW_CODE).toBe('needs_preview');
    expect(isNeedsPreviewFailure(failure('needs_preview'))).toBe(true);
  });

  it('is false for every other failure, which stays a failure', () => {
    for (const code of ['refused', 'unexpected', 'credentials', 'session_expired', 'unavailable']) {
      expect(isNeedsPreviewFailure(failure(code))).toBe(false);
    }
  });
});

describe('groupRefusalReasons', () => {
  it('keeps known reasons, folds unknown ones into other and drops zeros', () => {
    expect(
      groupRefusalReasons({
        missing_date: 1,
        currency_mismatch: 0,
        something_new: 2,
        another_new: 1,
      }),
    ).toEqual([
      { reason: 'missing_date', count: 1 },
      { reason: 'other', count: 3 },
    ]);
  });
});

describe('safeAuthorizationUrl', () => {
  it('accepts an https address', () => {
    expect(safeAuthorizationUrl('https://bank.example/auth?x=1')).toBe(
      'https://bank.example/auth?x=1',
    );
  });

  it.each([
    'http://bank.example/auth',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    '//bank.example/auth',
    '',
    null,
    undefined,
  ])('refuses %s', (value) => {
    expect(safeAuthorizationUrl(value)).toBeNull();
  });
});

describe('buildBankSyncCountryOptions', () => {
  it('lists every country once, named in the locale and sorted by name', () => {
    const options = buildBankSyncCountryOptions('en');
    expect(options).toHaveLength(BANK_SYNC_COUNTRY_CODES.length);
    expect(new Set(options.map((o) => o.value)).size).toBe(options.length);
    expect(options.find((o) => o.value === 'PL')?.label).toBe('Poland');
    const labels = options.map((o) => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('names countries in the requested language', () => {
    expect(
      buildBankSyncCountryOptions('pl').find((o) => o.value === 'DE')?.label,
    ).toBe('Niemcy');
  });

  it('falls back to a usable list for a locale it cannot use', () => {
    const options = buildBankSyncCountryOptions('not a locale');
    expect(options).toHaveLength(BANK_SYNC_COUNTRY_CODES.length);
    expect(options.every((o) => o.label !== '')).toBe(true);
  });
});

describe('telling a result from a failure', () => {
  const ok = {
    bankAccountId: 'ba-1',
    imported: 0,
    skipped: 0,
    refused: {},
    pending: 0,
    beforeCutoff: 0,
    bankBalance: null,
  };
  const failed = { bankAccountId: 'ba-2', error: { code: 'refused', message: 'Busy.' } };

  it('recognises a failure by its error, and a result by its absence', () => {
    expect(isBankSyncFailure(failed)).toBe(true);
    expect(isBankSyncFailure(ok)).toBe(false);
  });

  it('keeps only the results, in order', () => {
    expect(syncedResults([failed, ok, failed])).toEqual([ok]);
    expect(syncedResults([])).toEqual([]);
  });
});
