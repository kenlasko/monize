import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();
const mockPut = vi.fn();
vi.mock('./api', () => ({
  default: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
  },
}));

const mockInvalidate = vi.fn();
vi.mock('./apiCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./apiCache')>()),
  invalidateCache: (...args: unknown[]) => mockInvalidate(...args),
}));

import {
  loanFeeDraftErrors,
  loanFeeDraftsToInputs,
  loanFeesApi,
  loanFeeToDraft,
  newLoanFeeDraft,
  type LoanFeeDraft,
} from './loan-fees';

const draft = (over: Partial<LoanFeeDraft> = {}): LoanFeeDraft => ({
  ...newLoanFeeDraft(),
  name: 'Property tax',
  categoryId: 'cat-tax',
  value: 3600,
  ...over,
});

describe('loanFeesApi', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPut.mockReset();
    mockInvalidate.mockReset();
  });

  it('lists a mortgage fees', async () => {
    mockGet.mockResolvedValue({ data: [] });
    await expect(loanFeesApi.list('acc-list')).resolves.toEqual([]);
    expect(mockGet).toHaveBeenCalledWith('/accounts/acc-list/loan-fees');
  });

  it('replaces the set and drops the fee and scheduled caches', async () => {
    mockPut.mockResolvedValue({ data: [] });
    await loanFeesApi.replace('acc-1', []);
    expect(mockPut).toHaveBeenCalledWith('/accounts/acc-1/loan-fees', { fees: [] });
    expect(mockInvalidate).toHaveBeenCalledWith('loan-fees:acc-1');
    expect(mockInvalidate).toHaveBeenCalledWith('scheduled:');
  });
});

describe('loan fee drafts', () => {
  it('sends a fixed fee as an amount and a percentage as a rate', () => {
    expect(
      loanFeeDraftsToInputs([
        draft({ name: ' Tax ' }),
        draft({ categoryId: 'cat-ins', calculation: 'PERCENT_CURRENT_BALANCE', basis: 'ANNUAL', value: 0.5 }),
      ]),
    ).toEqual([
      { categoryId: 'cat-tax', name: 'Tax', calculation: 'FIXED', basis: 'PER_PAYMENT', amount: 3600, rate: null },
      {
        categoryId: 'cat-ins',
        name: 'Property tax',
        calculation: 'PERCENT_CURRENT_BALANCE',
        basis: 'ANNUAL',
        amount: null,
        rate: 0.5,
      },
    ]);
  });

  it('loads a stored fee at its stored value', () => {
    expect(
      loanFeeToDraft({
        id: 'fee-1',
        categoryId: 'cat-ins',
        name: 'Insurance',
        calculation: 'PERCENT_ORIGINAL_BALANCE',
        basis: 'PER_PAYMENT',
        amount: null,
        rate: 0.025,
        sortOrder: 0,
      }),
    ).toEqual({
      key: 'fee-1',
      categoryId: 'cat-ins',
      name: 'Insurance',
      calculation: 'PERCENT_ORIGINAL_BALANCE',
      basis: 'PER_PAYMENT',
      value: 0.025,
    });
  });

  it('names what the server would refuse', () => {
    expect(
      loanFeeDraftErrors(
        [
          draft(),
          draft({ name: '', value: undefined }),
          draft({ categoryId: 'cat-interest' }),
          draft({ categoryId: '' }),
          draft({ categoryId: 'cat-x', calculation: 'PERCENT_CURRENT_BALANCE', value: 101 }),
        ],
        'cat-interest',
      ),
    ).toEqual([
      {},
      { name: 'required', categoryId: 'duplicate', value: 'required' },
      { categoryId: 'duplicate' },
      { categoryId: 'required' },
      { value: 'range' },
    ]);
  });
});
