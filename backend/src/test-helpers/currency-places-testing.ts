/**
 * A mock `Currency` repository for `loadCurrencyPlaces` and
 * `loadCurrencyPlacesForRead` (`src/common/currency-places.util.ts`),
 * registered with
 * `createScopedDbMocks([[Currency, currencyPlacesRepoMock({ BTC: 8 })]])`.
 *
 * `query` answers the writer's locking read (`code = ANY($1)`, the codes its
 * first parameter names) and `find` the reader's (`where: { code: In([...]) }`)
 * with the requested codes that `places` names, as the real queries do; a code
 * it does not name has no row and reads as the column default (fiat, four
 * places). With no argument every currency is fiat, which is what a spec
 * written before per-currency precision assumed.
 */
export function currencyPlacesRepoMock(
  places: Readonly<Record<string, number>> = {},
): { find: jest.Mock; query: jest.Mock } {
  const known = (requested: unknown): string[] =>
    (Array.isArray(requested)
      ? (requested as string[])
      : Object.keys(places)
    ).filter((code) => code in places);
  return {
    find: jest.fn(async (options?: { where?: { code?: unknown } }) =>
      known((options?.where?.code as { value?: unknown })?.value).map(
        (code) => ({ code, decimalPlaces: places[code] }),
      ),
    ),
    query: jest.fn(async (_sql: string, params?: unknown[]) =>
      known(params?.[0]).map((code) => ({
        code,
        decimal_places: places[code],
      })),
    ),
  };
}
