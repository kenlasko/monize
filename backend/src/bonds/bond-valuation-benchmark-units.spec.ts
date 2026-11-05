import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { manifestDocument } from "./adapters/pl/pl-test-input";
import { BondDataInconsistentError } from "./bond-errors";
import { BondValuationService } from "./bond-valuation.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/** A series stored in `unit`, read by the EDO series (a rate rule on an inflation benchmark). */
function serviceWith(unit: string | undefined) {
  const { manager, dataSource } = createScopedDbMocks();
  manager.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM bond_programs")) return [];
    if (sql.includes("FROM bond_instruments"))
      return [
        {
          id: "i2",
          series_code: "EDO1036",
          program_code: "EDO",
          currency_code: "PLN",
        },
      ];
    if (sql.includes("FROM bond_terms_versions"))
      return [{ version: 1, terms: manifestDocument("edo1036") }];
    if (sql.includes("FROM bond_period_rates")) return [];
    if (sql.includes("FROM benchmark_series"))
      return [
        { kind: "MONTHLY", publisher: "GUS", unit, covered_through: null },
      ];
    if (sql.includes("FROM benchmark_values"))
      return [{ observation_date: "2027-08-01", value: "0.0290000000" }];
    throw new Error(`unexpected query: ${sql}`);
  });
  return new BondValuationService(dataSource as unknown as DataSource);
}

const request = {
  issuerCountryCode: "PL",
  issuerCode: "PL_MF",
  seriesCode: "EDO1036",
  lot: { purchaseDate: "2026-10-15", quantity: 1 },
  asOf: "2027-04-15",
};

describe("a rate rule reads a RATE_FRACTION series only", () => {
  it("values the lot when the stored series is a RATE_FRACTION one", async () => {
    const valuation = await serviceWith("RATE_FRACTION").valueLot(request);
    expect(valuation.grossValue).not.toBeNull();
  });

  it("refuses an INDEX_LEVEL series with BENCHMARK_UNIT_MISMATCH and the three values", async () => {
    const run = serviceWith("INDEX_LEVEL").valueLot(request);
    await expect(run).rejects.toBeInstanceOf(BondDataInconsistentError);
    await expect(run).rejects.toMatchObject({
      code: "BENCHMARK_UNIT_MISMATCH",
      params: {
        benchmarkId: "PL_CPI_GUS_YOY",
        unit: "INDEX_LEVEL",
        expected: "RATE_FRACTION",
      },
    });
  });
});
