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

  it('has an English sentence for every KMyMoney warning code', () => {
    const missing = KMY_WARNING_CODES.filter(
      (code) => typeof lookup(KMY_FORMAT.warningKey(code)) !== 'string',
    );
    expect(missing).toEqual([]);
  });

  it('lists each warning code once', () => {
    expect(new Set(KMY_WARNING_CODES).size).toBe(KMY_WARNING_CODES.length);
  });

  it('matches the backend list verbatim', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', '..', 'backend', 'src', 'import', 'kmy', 'model', 'kmy-warnings.ts'),
      'utf8',
    );
    const backend = [...source.matchAll(/^\s+"(\w+)",$/gm)].map((m) => m[1]);
    // The frontend list may be ahead of the backend only by codes a later package adds.
    expect(KMY_WARNING_CODES.slice(0, backend.length)).toEqual(backend);
  });

  it('has an English sentence for every KMyMoney error code', () => {
    const missing = KMY_ERROR_CODES.filter(
      (code) => typeof lookup(KMY_FORMAT.errorKey(code)) !== 'string',
    );
    expect(missing).toEqual([]);
  });

  it('recognises both spellings of a missing staged file', () => {
    expect(isStagedFileMissing('mnyStagedFileMissing')).toBe(true);
    expect(isStagedFileMissing('kmyStagedFileMissing')).toBe(true);
    expect(isStagedFileMissing('mnyAlreadyImported')).toBe(false);
    expect(isStagedFileMissing(undefined)).toBe(false);
  });
});
