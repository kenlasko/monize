import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXCHANGE_OPTIONS,
  getDateFormatOptions,
  getExportDateFormatOptions,
} from './constants';

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** Blank out comment bodies, so a `]` or a quoted word in one cannot be read as data. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, before: string) => before + ' '.repeat(match.length - before.length),
    );
}

// Minimal translator stub: echoes the key, appending {sample} when supplied so
// we can assert the injected sample without loading the real catalog.
const t = (key: string, values?: Record<string, string | number>) =>
  values && 'sample' in values ? `${key}|${values.sample}` : key;

describe('getDateFormatOptions', () => {
  it('injects a sample formatted for the given browser locale', () => {
    const us = getDateFormatOptions(t, 'en-US').find((o) => o.value === 'browser')!;
    expect(us.label).toBe('dateFormat.browserAuto|12/31/2024');

    const gb = getDateFormatOptions(t, 'en-GB').find((o) => o.value === 'browser')!;
    expect(gb.label).toBe('dateFormat.browserAuto|31/12/2024');
  });

  it('still produces a sample when no locale is supplied (browser default)', () => {
    const browser = getDateFormatOptions(t).find((o) => o.value === 'browser')!;
    expect(browser.label).toMatch(/^dateFormat\.browserAuto\|.*\d/);
  });

  it('keeps the verbatim pattern options unchanged', () => {
    const values = getDateFormatOptions(t, 'en-US').map((o) => o.value);
    expect(values).toEqual([
      'browser',
      'YYYY-MM-DD',
      'MM/DD/YYYY',
      'DD/MM/YYYY',
      'DD-MMM-YYYY',
    ]);
  });
});

describe('getExportDateFormatOptions', () => {
  it('threads the browser locale and appends a custom entry', () => {
    const opts = getExportDateFormatOptions(t, 'en-GB');
    expect(opts.find((o) => o.value === 'browser')!.label).toBe(
      'dateFormat.browserAuto|31/12/2024',
    );
    expect(opts[opts.length - 1]).toEqual({
      value: 'custom',
      label: 'dateFormat.custom',
    });
  });
});

/**
 * The backend constrains the AI assistant's and MCP's `exchange` argument to
 * `SECURITY_EXCHANGES`; an exchange the picker offers and the server does not
 * know (or the reverse) is a value one surface can store and the other refuses.
 */
describe('EXCHANGE_OPTIONS', () => {
  it('matches the backend SECURITY_EXCHANGES list', () => {
    const source = withoutComments(
      readFileSync(join(REPO_ROOT, 'backend/src/securities/security-enums.ts'), 'utf8'),
    );
    const match = /SECURITY_EXCHANGES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(source);
    expect(match, 'SECURITY_EXCHANGES declaration not found').toBeTruthy();
    const backend = [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(backend.length).toBeGreaterThan(0);
    expect(EXCHANGE_OPTIONS.map((option) => option.value)).toEqual(backend);
  });

  it('offers the canonical crypto exchange', () => {
    expect(EXCHANGE_OPTIONS).toContainEqual({
      value: 'CRYPTO',
      label: 'Crypto',
      subtitle: 'Cryptocurrency (Yahoo)',
    });
  });
});
