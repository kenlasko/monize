import { describe, it, expect } from 'vitest';
import { kmyErrorDocsLink } from './import-kmy-error-docs';
import { KMY_ERROR_CODES } from './binary-import-format';

describe('kmyErrorDocsLink', () => {
  it.each([...KMY_ERROR_CODES, 'kmyNoFile', 'kmyFileTooLarge', 'kmyStagedFileInUse'])(
    'sends %s to the KMyMoney troubleshooting section',
    (code) => {
      expect(kmyErrorDocsLink(code)).toBe('importKmyTroubleshooting');
    },
  );

  it('sends the job keys a KMyMoney import shares with Money there too', () => {
    expect(kmyErrorDocsLink('mnyImportFailedAfterCommit')).toBe('importKmyTroubleshooting');
    expect(kmyErrorDocsLink('mnyStagedFileMissing')).toBe('importKmyTroubleshooting');
  });

  it('falls back to the troubleshooting section for an unknown or missing code', () => {
    expect(kmyErrorDocsLink('somethingUnexpected')).toBe('importKmyTroubleshooting');
    expect(kmyErrorDocsLink(null)).toBe('importKmyTroubleshooting');
    expect(kmyErrorDocsLink(undefined)).toBe('importKmyTroubleshooting');
  });
});
