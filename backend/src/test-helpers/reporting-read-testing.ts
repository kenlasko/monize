/** Service-focused unit fixtures supply native rows; actual projections/defaults
 * are tested through enforced PostgreSQL and real services, not reproduced here.
 * Plain functions survive resetAllMocks without changing fixture response order.
 */
export function reportingBasisMockModule() {
  return {
    ReportingRead: () => () => undefined,
    reportingResultCurrency: () => undefined,
    withReportingRead: async (
      _source: unknown,
      _user: string,
      fn: () => Promise<unknown>,
    ) => fn(),
    reportingExecutionBasis: () => "cash",
    currentReportingRead: () => ({ basis: "cash", currency: "USD" }),
  };
}
export function reportingQueryMockModule() {
  return {
    reportingQuery: (
      manager: { query: (sql: string, params: unknown[]) => unknown },
      _userId: string,
      sql: string,
      params: unknown[],
    ) => manager.query(sql, params),
    reportingRawMany: (
      _manager: unknown,
      _userId: string,
      query: { getRawMany: () => unknown },
    ) => query.getRawMany(),
    reportingRawOne: (
      _manager: unknown,
      _userId: string,
      query: { getRawOne: () => unknown },
    ) => query.getRawOne(),
    reportingEntities: (
      _manager: unknown,
      _userId: string,
      query: { getMany: () => unknown },
    ) => query.getMany(),
  };
}
export function reportingInterceptorMockModule() {
  return {
    ReportingBasisInterceptor: class {
      intercept(_context: unknown, next: { handle: () => unknown }) {
        return next.handle();
      }
    },
  };
}

/** Presentation fixtures already supply amounts in the fixture reporting currency.
 * Currency conversion and recognition are exercised separately against PostgreSQL. */
export function reportingMoneyMockModule() {
  return {
    reportingMoneyMany: async (
      _m: unknown,
      _u: string,
      q: { getRawMany: () => Promise<any[]> },
      _c: string,
      absolute = false,
    ) => {
      const rows = await q.getRawMany();
      return absolute
        ? rows.map((row) => ({
            ...row,
            total: String(Math.abs(Number(row.total))),
          }))
        : rows;
    },
    reportingMoneyOne: async (
      _m: unknown,
      _u: string,
      q: { getRawOne: () => Promise<any> },
      _c: string,
      absolute = false,
    ) => {
      const row = await q.getRawOne();
      return absolute && row
        ? { ...row, total: String(Math.abs(Number(row.total))) }
        : row;
    },
    reportingRates: async () => new Map(),
    reportingAmount: (value: number | string) => Number(value),
  };
}
export function reportingCustomMoneyMockModule() {
  return {
    convertReportTransactions: async (
      _m: unknown,
      _u: string,
      transactions: unknown[],
    ) => ({ transactions, currency: "USD" }),
  };
}
