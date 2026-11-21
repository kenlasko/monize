import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KMY_ERROR_CODES,
  KMY_FORMAT,
  KMY_WARNING_CODES,
  MNY_FORMAT,
  isStagedFileMissing,
} from './binary-import-format';
import { kmyImportApi } from './import-kmy';
import { mnyImportApi } from './import-mny';

const catalog = JSON.parse(
  readFileSync(join(__dirname, '..', 'i18n', 'messages', 'en', 'import.json'), 'utf8'),
) as Record<string, unknown>;

/** Resolves a dotted key the way `t()` does inside the `import` namespace. */
function lookup(key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    catalog,
  );
}

describe('binary import format descriptors', () => {
  it('give each format its own client', () => {
    expect(MNY_FORMAT.client).toBe(mnyImportApi);
    expect(KMY_FORMAT.client).toBe(kmyImportApi);
  });

  it('switch the sections only one format has', () => {
    expect([MNY_FORMAT.showEra, MNY_FORMAT.showMissingTables, MNY_FORMAT.passwordPrompt]).toEqual([true, true, true]);
    expect([KMY_FORMAT.showEra, KMY_FORMAT.showMissingTables, KMY_FORMAT.passwordPrompt]).toEqual([false, false, false]);
  });

  it('strip the right extension from the report name', () => {
    expect('finances.mny'.replace(MNY_FORMAT.reportExtension, '')).toBe('finances');
    expect('budget.kmy'.replace(KMY_FORMAT.reportExtension, '')).toBe('budget');
    expect('budget.XML'.replace(KMY_FORMAT.reportExtension, '')).toBe('budget');
    expect('budget.kmy'.replace(MNY_FORMAT.reportExtension, '')).toBe('budget.kmy');
  });

  describe.each([MNY_FORMAT, KMY_FORMAT])('$id copy', (format) => {
    it.each(Object.entries(format.copy))('%s names an English string', (_slot, key) => {
      expect(typeof lookup(key)).toBe('string');
    });

    it('names an English string for the upload fallback error', () => {
      expect(typeof lookup(format.errorKey(format.uploadFallbackErrorCode))).toBe('string');
    });
  });

  it('keeps Money keys exactly as the Money components used them', () => {
    expect(MNY_FORMAT.copy.reviewHeading).toBe('mnyReview.heading');
    expect(MNY_FORMAT.copy.uploadFailedHeading).toBe('upload.mnyFailedHeading');
    expect(MNY_FORMAT.warningKey('splitSumMismatch')).toBe('mnyWarnings.splitSumMismatch');
    expect(MNY_FORMAT.errorKey('mnyStagedFileMissing')).toBe('mnyErrors.mnyStagedFileMissing');
    expect(MNY_FORMAT.errorDocsLink('mnyNotAMoneyFile')).toBe('importMnyTroubleshooting');
  });

  describe('KMyMoney keys', () => {
    it('resolves warnings under kmyWarnings', () => {
      expect(KMY_FORMAT.warningKey('budgetsNotImported')).toBe('kmyWarnings.budgetsNotImported');
    });

    it('resolves kmy codes and the staged-file key under kmyErrors, and the neutral job keys under mnyErrors', () => {
      expect(KMY_FORMAT.errorKey('kmyEncryptedFile')).toBe('kmyErrors.kmyEncryptedFile');
      expect(KMY_FORMAT.errorKey('mnyStagedFileMissing')).toBe('kmyErrors.kmyStagedFileMissing');
      expect(KMY_FORMAT.errorKey('mnyJobStalled')).toBe('mnyErrors.mnyJobStalled');
    });

    it('links every error to the KMyMoney guide', () => {
      expect(KMY_FORMAT.errorDocsLink('kmyCorruptFile')).toBe('importKmyTroubleshooting');
    });
  });

  it('names the payee alias tiles for KMyMoney only', () => {
    expect(KMY_FORMAT.copy.countsPayeeAliases).toBe('kmyReview.counts.payeeAliases');
    expect(KMY_FORMAT.copy.completePayeeDefaultCategories).toBe('kmyComplete.counts.payeeDefaultCategories');
    expect(MNY_FORMAT.copy.countsPayeeAliases).toBeUndefined();
    expect(MNY_FORMAT.copy.countsPayeeAliasesDetail).toBeUndefined();
    expect(MNY_FORMAT.copy.completePayeeAliases).toBeUndefined();
    expect(MNY_FORMAT.copy.completePayeeDefaultCategories).toBeUndefined();
  });

  it('lists the payee and transfer-rate codes after holdingsReplayDiffers', () => {
    const tail = KMY_WARNING_CODES.slice(KMY_WARNING_CODES.indexOf('holdingsReplayDiffers') + 1);
    expect(tail).toEqual([
      'payeeMatchingDisabled',
      'payeeMatchKeyNotImported',
      'payeeMatchCaseWidened',
      'payeeMatchKeyConflict',
      'payeeMatchKeyOverlap',
      'payeeDefaultCategoryNotImported',
      'payeeDetailsKept',
      'originalNameCut',
      'crossCurrencyTransferRateMissing',
      'tradeAmountsDiffer',
      'investmentTransactionUnclassified',
      'sameAccountTransferUnlinked',
      'reconciliationHistoryNotImported',
      'securityTransferInferred',
      'sharesRounded',
      'loanTermsNotImported',
    ]);
  });

  it('has an English sentence for every KMyMoney warning code', () => {
    const missing = KMY_WARNING_CODES.filter(
      (code) => typeof lookup(KMY_FORMAT.warningKey(code)) !== 'string',
    );
    expect(missing).toEqual([]);
  });

  it('lists each warning code once', () => {
    expect(new Set(KMY_WARNING_CODES).size).toBe(KMY_WARNING_CODES.length);
  });

  describe('the three warning-code lists (backend, frontend, English catalog)', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', '..', 'backend', 'src', 'import', 'kmy', 'model', 'kmy-warnings.ts'),
      'utf8',
    );
    const block = /KMY_WARNING_CODES[^=]*=\s*\[([\s\S]*?)\n\];/.exec(source);
    const backend = [...(block?.[1] ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]);
    // The two lines under kmyWarnings that are footers, not warning codes.
    const FOOTER_KEYS = [KMY_FORMAT.copy.reviewInSource, KMY_FORMAT.copy.reviewInSourceTruncated].map(
      (key) => key.split('.')[1],
    );
    const english = Object.keys(catalog.kmyWarnings as Record<string, string>).filter(
      (key) => !FOOTER_KEYS.includes(key),
    );

    it('reads a non-empty backend list from its source', () => {
      expect(backend.length).toBeGreaterThan(50);
    });

    it('has the frontend list equal to the backend list, in the same order', () => {
      expect([...KMY_WARNING_CODES]).toEqual(backend);
    });

    it('has an English sentence for exactly the backend codes, no more and no fewer', () => {
      expect([...english].sort()).toEqual([...backend].sort());
    });
  });

  it('has an English sentence for every KMyMoney error code', () => {
    const missing = KMY_ERROR_CODES.filter(
      (code) => typeof lookup(KMY_FORMAT.errorKey(code)) !== 'string',
    );
    expect(missing).toEqual([]);
  });

  it('lists the backend refusal codes, plus the staged-file one', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', '..', 'backend', 'src', 'import', 'kmy', 'model', 'kmy-errors.ts'),
      'utf8',
    );
    const block = /export type KmyErrorCode =([\s\S]*?);/.exec(source);
    const backend = [...(block?.[1] ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(backend.length).toBeGreaterThan(5);
    expect([...KMY_ERROR_CODES].sort()).toEqual([...backend, 'kmyStagedFileMissing'].sort());
  });

  it('shows the two newest refusals under kmyErrors', () => {
    expect(KMY_FORMAT.errorKey('kmyTooManyRecords')).toBe('kmyErrors.kmyTooManyRecords');
    expect(KMY_FORMAT.errorKey('kmyMappingFailed')).toBe('kmyErrors.kmyMappingFailed');
  });

  it('recognises both spellings of a missing staged file', () => {
    expect(isStagedFileMissing('mnyStagedFileMissing')).toBe(true);
    expect(isStagedFileMissing('kmyStagedFileMissing')).toBe(true);
    expect(isStagedFileMissing('mnyAlreadyImported')).toBe(false);
    expect(isStagedFileMissing(undefined)).toBe(false);
  });
});
