import { describe, it, expect } from 'vitest';
import { mnyErrorDocsLink } from './import-mny-error-docs';

describe('mnyErrorDocsLink', () => {
  it('names the troubleshooting table for a known error code', () => {
    expect(mnyErrorDocsLink('mnyPasswordIncorrect')).toBe('importMnyTroubleshooting');
  });

  it('falls back to the troubleshooting table for an unknown or missing code', () => {
    expect(mnyErrorDocsLink('somethingUnexpected')).toBe('importMnyTroubleshooting');
    expect(mnyErrorDocsLink(null)).toBe('importMnyTroubleshooting');
    expect(mnyErrorDocsLink(undefined)).toBe('importMnyTroubleshooting');
  });
});
