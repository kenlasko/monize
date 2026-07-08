import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loanRateChangesApi } from './loan-rate-changes';
import apiClient from './api';
import { invalidateCache } from './apiCache';
import { LoanRateChange } from '@/types/loan-rate-change';

vi.mock('./api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('./apiCache', () => ({
  dedupe: vi.fn((_key: string, fn: () => unknown) => fn()),
  invalidateCache: vi.fn(),
}));

const accountId = 'account-1';

function makeRateChange(overrides: Partial<LoanRateChange> = {}): LoanRateChange {
  return {
    id: 'rc-1',
    accountId,
    effectiveDate: '2024-06-01',
    annualRate: 4.9,
    newPaymentAmount: null,
    source: 'manual',
    note: null,
    createdAt: '2024-06-01',
    updatedAt: '2024-06-01',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loanRateChangesApi', () => {
  it('gets the rate history for an account', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [makeRateChange()] });

    const result = await loanRateChangesApi.getAll(accountId);

    expect(apiClient.get).toHaveBeenCalledWith('/accounts/account-1/rate-changes');
    expect(result).toHaveLength(1);
  });

  it('creates a rate change and invalidates both caches', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: makeRateChange() });

    await loanRateChangesApi.create(accountId, {
      effectiveDate: '2024-06-01',
      annualRate: 4.9,
    });

    expect(apiClient.post).toHaveBeenCalledWith('/accounts/account-1/rate-changes', {
      effectiveDate: '2024-06-01',
      annualRate: 4.9,
    });
    expect(invalidateCache).toHaveBeenCalledWith('loan-rate-changes:account-1');
    expect(invalidateCache).toHaveBeenCalledWith('accounts:');
  });

  it('updates a rate change and invalidates both caches', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: makeRateChange() });

    await loanRateChangesApi.update(accountId, 'rc-1', { annualRate: 5.1 });

    expect(apiClient.patch).toHaveBeenCalledWith('/accounts/account-1/rate-changes/rc-1', {
      annualRate: 5.1,
    });
    expect(invalidateCache).toHaveBeenCalledWith('loan-rate-changes:account-1');
    expect(invalidateCache).toHaveBeenCalledWith('accounts:');
  });

  it('deletes a rate change and invalidates both caches', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});

    await loanRateChangesApi.delete(accountId, 'rc-1');

    expect(apiClient.delete).toHaveBeenCalledWith('/accounts/account-1/rate-changes/rc-1');
    expect(invalidateCache).toHaveBeenCalledWith('loan-rate-changes:account-1');
    expect(invalidateCache).toHaveBeenCalledWith('accounts:');
  });

  it('runs detection and invalidates both caches', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { created: [makeRateChange({ source: 'inferred' })], replacedCount: 0, warnings: [] },
    });

    const result = await loanRateChangesApi.detect(accountId);

    expect(apiClient.post).toHaveBeenCalledWith('/accounts/account-1/rate-changes/detect');
    expect(result.created).toHaveLength(1);
    expect(invalidateCache).toHaveBeenCalledWith('loan-rate-changes:account-1');
    expect(invalidateCache).toHaveBeenCalledWith('accounts:');
  });
});
