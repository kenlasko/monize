import { describe, it, expect, vi, beforeEach } from 'vitest';
import { firstRegisterRowInMonth } from './register-month-landing';

const mockGetAll = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: { getAll: (...a: unknown[]) => mockGetAll(...a) },
}));

describe('firstRegisterRowInMonth', () => {
  beforeEach(() => {
    mockGetAll.mockReset();
  });

  it("asks for the month's oldest row under the register's filters", async () => {
    mockGetAll.mockResolvedValue({ data: [{ id: 'tx-first' }] });

    const id = await firstRegisterRowInMonth({ accountIds: ['acc-1'], search: 'rent' }, '2026-02', '', '');

    expect(id).toBe('tx-first');
    expect(mockGetAll).toHaveBeenCalledWith({
      accountIds: ['acc-1'],
      search: 'rent',
      startDate: '2026-02-01',
      endDate: '2026-02-28',
      sortBy: 'date',
      sortDirection: 'asc',
      page: 1,
      limit: 1,
    });
  });

  it("keeps to the register's date range where it cuts the month", async () => {
    mockGetAll.mockResolvedValue({ data: [] });

    await firstRegisterRowInMonth({}, '2026-03', '2026-03-10', '2026-12-31');

    expect(mockGetAll).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '2026-03-10', endDate: '2026-03-31' }),
    );
  });

  it('is null for a month with no rows', async () => {
    mockGetAll.mockResolvedValue({ data: [] });
    expect(await firstRegisterRowInMonth({}, '2026-03', '', '')).toBeNull();
  });

  it('asks nothing for a month the date range excludes', async () => {
    expect(await firstRegisterRowInMonth({}, '2026-03', '2026-04-01', '')).toBeNull();
    expect(mockGetAll).not.toHaveBeenCalled();
  });
});
