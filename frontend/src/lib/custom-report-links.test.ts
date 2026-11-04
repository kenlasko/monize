import { describe, it, expect } from 'vitest';
import { customReportDrillDownHref, reportRegisterFilters } from './custom-report-links';
import { GroupByType, type ReportFilters } from '@/types/custom-report';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '11111111-1111-4111-8111-222222222222';
const C1 = '22222222-2222-4222-8222-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-111111111111';
const T1 = '44444444-4444-4444-8444-111111111111';
const TX = '55555555-5555-4555-8555-111111111111';

const YEAR = { label: 'This year', startDate: '2025-01-01', endDate: '2025-12-31' };

const paramsOf = (href: string) => new URLSearchParams(href.split('?')[1] ?? '');

describe('reportRegisterFilters', () => {
  it('reads the legacy fields when there are no filter groups, but never the legacy tags', () => {
    expect(
      reportRegisterFilters({
        accountIds: [A1],
        categoryIds: [C1],
        payeeIds: [P1],
        tagIds: [T1],
        searchText: 'gift',
      }),
    ).toEqual({ accountIds: [A1], categoryIds: [C1], payeeIds: [P1], tagIds: [], search: 'gift' });
  });

  it('lets filter groups win over the legacy fields', () => {
    expect(
      reportRegisterFilters({
        accountIds: [A1],
        filterGroups: [{ conditions: [{ field: 'category', value: [C1] }] }],
      }),
    ).toEqual({ accountIds: [], categoryIds: [C1], payeeIds: [], tagIds: [], search: '' });
  });

  it('unions the OR conditions of a single-field group', () => {
    const filters: ReportFilters = {
      filterGroups: [
        {
          conditions: [
            { field: 'account', value: [A1] },
            { field: 'account', value: [A2, A1] },
          ],
        },
        { conditions: [{ field: 'tag', value: T1 }] },
        { conditions: [{ field: 'text', value: 'christmas' }] },
      ],
    };
    expect(reportRegisterFilters(filters)).toEqual({
      accountIds: [A1, A2],
      categoryIds: [],
      payeeIds: [],
      tagIds: [T1],
      search: 'christmas',
    });
  });

  it('drops what the register cannot express rather than narrowing past the report', () => {
    const filters: ReportFilters = {
      filterGroups: [
        // account OR category: no single register field holds it, and the
        // category it names is not carried either.
        {
          conditions: [
            { field: 'account', value: [A1] },
            { field: 'category', value: [C1] },
          ],
        },
        // A second group on category ANDs with the first: still not carried.
        { conditions: [{ field: 'category', value: [C2] }] },
        // Two payee groups AND together.
        { conditions: [{ field: 'payee', value: [P1] }] },
        { conditions: [{ field: 'payee', value: [P1] }] },
        // Text OR text.
        {
          conditions: [
            { field: 'text', value: 'a' },
            { field: 'text', value: 'b' },
          ],
        },
      ],
    };
    expect(reportRegisterFilters(filters)).toEqual({
      accountIds: [],
      categoryIds: [],
      payeeIds: [],
      tagIds: [],
      search: '',
    });
  });

  it('reads nothing from a missing filter object or empty groups', () => {
    const none = { accountIds: [], categoryIds: [], payeeIds: [], tagIds: [], search: '' };
    expect(reportRegisterFilters(undefined)).toEqual(none);
    expect(reportRegisterFilters({ filterGroups: [{ conditions: [] }] })).toEqual(none);
  });
});

describe('customReportDrillDownHref', () => {
  const christmas: ReportFilters = {
    filterGroups: [
      { conditions: [{ field: 'account', value: [A1] }] },
      { conditions: [{ field: 'category', value: [C1] }] },
    ],
  };

  it('opens a listed transaction under the report filters and dates, flashing the row', () => {
    const params = paramsOf(
      customReportDrillDownHref(christmas, { groupBy: GroupByType.NONE, timeframe: YEAR }, TX),
    );
    expect(Object.fromEntries(params)).toEqual({
      accountIds: A1,
      accountStatus: 'all',
      categoryIds: C1,
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      targetTransactionId: TX,
    });
  });

  it('does not target the aggregate cell of an ungrouped total', () => {
    const params = paramsOf(
      customReportDrillDownHref(christmas, { groupBy: GroupByType.NONE, timeframe: YEAR }, 'total'),
    );
    expect(params.has('targetTransactionId')).toBe(false);
    expect(params.get('categoryIds')).toBe(C1);
  });

  it('narrows to the clicked category, keeping the other report filters', () => {
    const params = paramsOf(
      customReportDrillDownHref(christmas, { groupBy: GroupByType.CATEGORY, timeframe: YEAR }, C2),
    );
    expect(params.get('categoryIds')).toBe(C2);
    expect(params.get('accountIds')).toBe(A1);
  });

  it('passes the uncategorized pseudo-id through', () => {
    const params = paramsOf(
      customReportDrillDownHref({}, { groupBy: GroupByType.CATEGORY, timeframe: YEAR }, 'uncategorized'),
    );
    expect(params.get('categoryIds')).toBe('uncategorized');
  });

  it('narrows to a clicked payee or tag, and keeps the report filters for a group the register cannot name', () => {
    const payee = paramsOf(customReportDrillDownHref({}, { groupBy: GroupByType.PAYEE, timeframe: YEAR }, P1));
    expect(payee.get('payeeIds')).toBe(P1);
    const tag = paramsOf(customReportDrillDownHref({}, { groupBy: GroupByType.TAG, timeframe: YEAR }, T1));
    expect(tag.get('tagIds')).toBe(T1);
    const unknown = paramsOf(
      customReportDrillDownHref(christmas, { groupBy: GroupByType.PAYEE, timeframe: YEAR }, 'unknown'),
    );
    expect(unknown.has('payeeIds')).toBe(false);
    expect(unknown.get('categoryIds')).toBe(C1);
    const untagged = paramsOf(
      customReportDrillDownHref({}, { groupBy: GroupByType.TAG, timeframe: YEAR }, 'untagged'),
    );
    expect(untagged.has('tagIds')).toBe(false);
  });

  it.each([
    [GroupByType.YEAR, '2025', '2025-01-01', '2025-12-31'],
    [GroupByType.MONTH, '2025-02', '2025-02-01', '2025-02-28'],
    [GroupByType.MONTH, '2024-02', '2024-02-01', '2024-02-29'],
    [GroupByType.WEEK, '2025-03-02', '2025-03-02', '2025-03-08'],
    [GroupByType.DAY, '2025-03-04', '2025-03-04', '2025-03-04'],
  ])('narrows the dates to a clicked %s period', (groupBy, id, start, end) => {
    const params = paramsOf(
      customReportDrillDownHref({}, { groupBy, timeframe: { label: 'x', startDate: '2024-01-01', endDate: '2025-12-31' } }, id),
    );
    expect(params.get('startDate')).toBe(start);
    expect(params.get('endDate')).toBe(end);
  });

  it('keeps a period inside the report dates', () => {
    const params = paramsOf(
      customReportDrillDownHref(
        {},
        { groupBy: GroupByType.MONTH, timeframe: { label: 'x', startDate: '2025-03-15', endDate: '2025-04-10' } },
        '2025-03',
      ),
    );
    expect(params.get('startDate')).toBe('2025-03-15');
    expect(params.get('endDate')).toBe('2025-03-31');
    const week = paramsOf(
      customReportDrillDownHref(
        {},
        { groupBy: GroupByType.WEEK, timeframe: { label: 'x', startDate: '2025-03-01', endDate: '2025-03-04' } },
        '2025-02-23',
      ),
    );
    expect(week.get('startDate')).toBe('2025-03-01');
    expect(week.get('endDate')).toBe('2025-03-01');
  });
});
