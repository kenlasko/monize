import { describe, it, expect } from 'vitest';
import { buildTransactionsHref } from './transactions-href';

describe('buildTransactionsHref', () => {
  it('links a category over a range', () => {
    expect(
      buildTransactionsHref({ categoryId: 'cat-1', startDate: '2026-09-01', endDate: '2026-09-30' }),
    ).toBe('/transactions?categoryId=cat-1&startDate=2026-09-01&endDate=2026-09-30');
  });

  it('passes a pseudo-id through as the category', () => {
    expect(
      buildTransactionsHref({ categoryId: 'uncategorized', startDate: '2026-09-01', endDate: '2026-09-30' }),
    ).toBe('/transactions?categoryId=uncategorized&startDate=2026-09-01&endDate=2026-09-30');
  });

  it('joins the accounts into one comma-separated parameter', () => {
    const href = buildTransactionsHref({
      accountIds: ['a-1', 'a-2'],
      startDate: '2026-09-01',
      endDate: '2026-09-30',
    });
    expect(new URLSearchParams(href.split('?')[1]).get('accountIds')).toBe('a-1,a-2');
  });

  it('asks for a category type', () => {
    expect(buildTransactionsHref({ categoryType: 'expense', endDate: '2026-09-30' })).toBe(
      '/transactions?categoryType=expense&endDate=2026-09-30',
    );
  });

  it('leaves out what is absent or empty', () => {
    expect(buildTransactionsHref({ categoryId: null, accountIds: [] })).toBe('/transactions');
  });

  it('encodes a value the URL would otherwise misread', () => {
    const href = buildTransactionsHref({ categoryId: 'a&b=c' });
    expect(new URLSearchParams(href.split('?')[1]).get('categoryId')).toBe('a&b=c');
  });
});

describe('buildTransactionsHref with a report drill-down', () => {
  it('carries every list, the search, the account status and the target row', () => {
    const href = buildTransactionsHref({
      categoryIds: ['c-1', 'c-2'],
      accountIds: ['a-1'],
      accountStatus: 'all',
      payeeIds: ['p-1'],
      tagIds: ['t-1'],
      search: 'gift, wrap',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      targetTransactionId: 'tx-1',
    });
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('categoryIds')).toBe('c-1,c-2');
    expect(params.get('accountIds')).toBe('a-1');
    expect(params.get('accountStatus')).toBe('all');
    expect(params.get('payeeIds')).toBe('p-1');
    expect(params.get('tagIds')).toBe('t-1');
    expect(params.get('search')).toBe('gift, wrap');
    expect(params.get('targetTransactionId')).toBe('tx-1');
  });

  it('leaves out empty lists and a blank search', () => {
    expect(buildTransactionsHref({ categoryIds: [], payeeIds: [], tagIds: [], search: '' })).toBe(
      '/transactions',
    );
  });
});
