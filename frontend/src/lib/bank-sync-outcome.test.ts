import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { isUnknownSyncOutcome } from './bank-sync-outcome';

const withStatus = (status: number) =>
  new AxiosError('failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: {},
  });

describe('isUnknownSyncOutcome', () => {
  it('is true for a timeout and for a request that never reached the server', () => {
    expect(isUnknownSyncOutcome(new AxiosError('timeout of 120000ms exceeded', 'ECONNABORTED'))).toBe(true);
    expect(isUnknownSyncOutcome(new AxiosError('Network Error', 'ERR_NETWORK'))).toBe(true);
  });

  it.each([500, 502, 503, 504])('is true for a %s: the server may have written before the answer was lost', (status) => {
    expect(isUnknownSyncOutcome(withStatus(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 429])('is false for a %s refusal, which wrote nothing', (status) => {
    expect(isUnknownSyncOutcome(withStatus(status))).toBe(false);
  });

  it('is false for an error that is not an HTTP failure', () => {
    expect(isUnknownSyncOutcome(new Error('boom'))).toBe(false);
    expect(isUnknownSyncOutcome(null)).toBe(false);
    expect(isUnknownSyncOutcome({ response: { status: 500 } })).toBe(false);
  });
});
