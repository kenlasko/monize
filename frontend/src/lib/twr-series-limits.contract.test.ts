import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TWR_SERIES_MAX_ACCOUNTS } from '@/lib/constants';

/**
 * The by-account return chart sends at most `TWR_SERIES_MAX_ACCOUNTS` ids, and
 * the server refuses a request naming more with a 400. Nothing compiles the two
 * against each other, so a lowered server cap would turn every by-account chart
 * for a reader with many accounts into an error, with the 'only the first N'
 * note never shown. The two are read from source and compared here.
 */
const CONTROLLER = resolve(
  __dirname,
  '../../../backend/src/net-worth/net-worth.controller.ts',
);

describe('investments-twr-series account cap', () => {
  it('matches the backend controller', () => {
    const source = readFileSync(CONTROLLER, 'utf8');
    const match = /const TWR_SERIES_MAX_ACCOUNTS = (\d+);/.exec(source);
    expect(
      match,
      'TWR_SERIES_MAX_ACCOUNTS not found in the controller',
    ).not.toBeNull();
    expect(TWR_SERIES_MAX_ACCOUNTS).toBe(Number(match![1]));
  });
});
