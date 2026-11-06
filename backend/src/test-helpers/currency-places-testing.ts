/**
 * A mock `Currency` repository for `loadCurrencyPlaces`
 * (`src/common/currency-places.util.ts`), registered with
 * `createScopedDbMocks([[Currency, currencyPlacesRepoMock({ BTC: 8 })]])`.
 *
 * `find` answers the requested codes (`where: { code: In([...]) }`) that
 * `places` names, as the real query does; a code it does not name has no row
 * and reads as the column default (fiat, four places). With no argument every
 * currency is fiat, which is what a spec written before per-currency precision
 * assumed.
 */
export function currencyPlacesRepoMock(
  places: Readonly<Record<string, number>> = {},
): { find: jest.Mock } {
  return {
    find: jest.fn(async (options?: { where?: { code?: unknown } }) => {
      const requested = (options?.where?.code as { value?: unknown })?.value;
      const codes = Array.isArray(requested)
        ? (requested as string[])
        : Object.keys(places);
      return codes
        .filter((code) => code in places)
        .map((code) => ({ code, decimalPlaces: places[code] }));
    }),
  };
}
