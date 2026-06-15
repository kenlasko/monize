import { describe, it, expect } from 'vitest';
import { getDateFormatOptions, getExportDateFormatOptions } from './constants';

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
