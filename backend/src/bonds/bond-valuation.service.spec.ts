import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { manifestDocument } from "./adapters/pl/pl-test-input";
import { BOND_CALENDARS } from "./bond-adapters";
import {
  BondDataInconsistentError,
  BondDataNotFoundError,
} from "./bond-errors";
import {
  BondValuationService,
  ValueLotRequest,
} from "./bond-valuation.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

type Row = Record<string, unknown>;

interface Store {
  instruments: Row[];
  /** `bond_programs` rows (the program of the linked security). */
  programs: Row[];
  /** The ids the sale-window inference of a legacy row finds. */
  onSale: Row[];
  /**
   * Newest first, like the query's ORDER BY. A row naming `instrumentId` belongs
   * to that series only; one without is every series' terms.
   */
  terms: Row[];
  rates: Row[];
  series: Row[];
  values: Row[];
  /** `securities` rows for valueSecurity. */
  securities: Row[];
  /** `investment_transactions` rows for valueSecurity, in register order. */
  ledger: Row[];
}

function setup(store: Partial<Store>) {
  const data: Store = {
    instruments: [
      {
        id: "i1",
        series_code: "TOS1029",
        program_code: "TOS",
        currency_code: "PLN",
      },
    ],
    programs: [
      {
        id: "p1",
        program_code: "TOS",
        issuer_country_code: "PL",
        issuer_code: "PL_MF",
        currency_code: "PLN",
      },
    ],
    onSale: [{ id: "i1" }],
    terms: [{ version: 1, terms: manifestDocument("tos1029") }],
    rates: [],
    series: [],
    values: [],
    securities: [],
    ledger: [],
    ...store,
  };
  const { manager, dataSource } = createScopedDbMocks();
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  manager.query.mockImplementation(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes("FROM bond_programs")) return data.programs;
    if (sql.includes("saleWindow")) return data.onSale;
    if (sql.includes("FROM bond_instruments")) {
      // By id (a series of a lot) or by key (the request).
      return sql.includes("WHERE id = $1")
        ? data.instruments.filter((i) => i.id === params[0])
        : data.instruments;
    }
    if (sql.includes("FROM bond_terms_versions")) {
      const wanted = sql.includes("version = $2") ? params[1] : undefined;
      return data.terms
        .filter(
          (t) =>
            (t.instrumentId === undefined || t.instrumentId === params[0]) &&
            (wanted === undefined || t.version === wanted),
        )
        .slice(0, 1);
    }
    if (sql.includes("FROM bond_period_rates")) return data.rates;
    if (sql.includes("FROM benchmark_series")) return data.series;
    if (sql.includes("FROM benchmark_values")) return data.values;
    if (sql.includes("FROM securities")) return data.securities;
    if (sql.includes("FROM investment_transactions")) return data.ledger;
    throw new Error(`unexpected query: ${sql}`);
  });
  const service = new BondValuationService(dataSource as unknown as DataSource);
  return { service, manager, dataSource, calls };
}

const request = (over: Partial<ValueLotRequest> = {}): ValueLotRequest => ({
  issuerCountryCode: "PL",
  issuerCode: "PL_MF",
  seriesCode: "TOS1029",
  lot: { purchaseDate: "2026-10-15", quantity: 1 },
  asOf: "2027-04-15",
  ...over,
});

const edoTerms = { version: 1, terms: manifestDocument("edo1036") };
const edoInstrument = [
  {
    id: "i2",
    series_code: "EDO1036",
    program_code: "EDO",
    currency_code: "PLN",
  },
];
const edoRequest = (over: Partial<ValueLotRequest> = {}) =>
  request({
    seriesCode: "EDO1036",
    lot: { purchaseDate: "2026-10-01", quantity: 1 },
    asOf: "2027-10-16",
    ...over,
  });

describe("BondValuationService", () => {
  it("values the lot in one transaction, with the shared calendars", async () => {
    const { service, dataSource } = setup({});
    const valuation = await service.valueLot(request());
    expect(valuation).toMatchObject({
      seriesCode: "TOS1029",
      termsVersion: 1,
      earlyRedemptionValue: "101.19",
    });
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(BOND_CALENDARS.get("PL")).toBeDefined();
  });

  it("uses the newest terms version unless one is named", async () => {
    const v2 = manifestDocument("tos1029");
    v2.rateRule.annualRate = "0.0500";
    const { service, calls } = setup({
      terms: [
        { version: 2, terms: v2 },
        { version: 1, terms: manifestDocument("tos1029") },
      ],
    });
    const newest = await service.valueLot(request());
    expect(newest.termsVersion).toBe(2);
    expect(newest.currentPeriod?.annualRate).toBe("0.0500");
    expect(
      calls.find((c) => c.sql.includes("bond_terms_versions"))?.sql,
    ).toMatch(/ORDER BY version DESC\s+LIMIT 1/);

    const named = await service.valueLot(request({ termsVersion: 1 }));
    expect(named.termsVersion).toBe(1);
    expect(named.currentPeriod?.annualRate).toBe("0.0440");
  });

  it("passes announced rates through as exact strings", async () => {
    const { service } = setup({
      instruments: edoInstrument,
      terms: [edoTerms],
      rates: [{ period_number: 2, annual_rate: "0.0490000000" }],
      series: [],
    });
    const v = await service.valueLot(edoRequest());
    expect(v.currentPeriod).toMatchObject({
      index: 2,
      annualRate: "0.0490",
      rateSource: "ANNOUNCED",
    });
  });

  it("maps a MONTHLY series to year-month keys", async () => {
    const { service, calls } = setup({
      instruments: edoInstrument,
      terms: [edoTerms],
      series: [{ kind: "MONTHLY", publisher: "GUS", covered_through: null }],
      values: [{ observation_date: "2027-08-01", value: "0.0290000000" }],
    });
    const v = await service.valueLot(edoRequest());
    expect(v.currentPeriod).toMatchObject({
      annualRate: "0.0490",
      rateSource: "DERIVED",
    });
    expect(
      calls.find((c) => c.sql.includes("FROM benchmark_series"))?.params,
    ).toEqual(["PL_CPI_GUS_YOY"]);
  });

  it("names a missing month, with the publisher of the stored series", async () => {
    const { service } = setup({
      instruments: edoInstrument,
      terms: [edoTerms],
      series: [{ kind: "MONTHLY", publisher: "GUS", covered_through: null }],
      values: [{ observation_date: "2027-07-01", value: "0.0290000000" }],
    });
    const v = await service.valueLot(edoRequest());
    expect(v.grossValue).toBeNull();
    expect(v.missing).toEqual([
      {
        benchmarkId: "PL_CPI_GUS_YOY",
        observation: "2027-08",
        publisher: "GUS",
      },
    ]);
  });

  it("maps a STEP series to changes and coverage", async () => {
    const ror = { version: 1, terms: manifestDocument("ror1027") };
    const { service } = setup({
      instruments: [{ id: "i3", series_code: "ROR1027", currency_code: "PLN" }],
      terms: [ror],
      series: [
        { kind: "STEP", publisher: "NBP", covered_through: "2026-10-19" },
      ],
      values: [
        { observation_date: "2026-09-01", value: "0.0450000000" },
        { observation_date: "2026-10-19", value: "0.0425000000" },
      ],
    });
    const v = await service.valueLot(
      request({
        seriesCode: "ROR1027",
        lot: { purchaseDate: "2026-10-31", quantity: 1 },
        asOf: "2026-12-05",
      }),
    );
    expect(v.currentPeriod).toMatchObject({
      annualRate: "0.0425",
      rateSource: "DERIVED",
    });
  });

  it("treats an absent benchmark series as absent, not as zero", async () => {
    const { service, calls } = setup({
      instruments: edoInstrument,
      terms: [edoTerms],
    });
    const v = await service.valueLot(edoRequest());
    expect(v.missing).toEqual([
      {
        benchmarkId: "PL_CPI_GUS_YOY",
        observation: "2027-08",
        publisher: null,
      },
    ]);
    expect(calls.some((c) => c.sql.includes("FROM benchmark_values"))).toBe(
      false,
    );
  });

  it("does not read a benchmark for a fixed-rate bond", async () => {
    const { service, calls } = setup({});
    await service.valueLot(request());
    expect(calls.some((c) => c.sql.includes("benchmark"))).toBe(false);
  });

  it("forwards the projection to the engine", async () => {
    const { service } = setup({
      instruments: edoInstrument,
      terms: [edoTerms],
    });
    const v = await service.valueLot(
      edoRequest({
        asOf: "2026-10-10",
        projection: new Map([["PL_CPI_GUS_YOY", "0.0300"]]),
      }),
    );
    expect(v.projectionAssumptions).toHaveLength(1);
  });

  it("refuses a missing instrument, naming it", async () => {
    const { service } = setup({ instruments: [] });
    await expect(service.valueLot(request())).rejects.toMatchObject({
      code: "INSTRUMENT_NOT_FOUND",
      params: { country: "PL", issuer: "PL_MF", series: "TOS1029" },
    });
  });

  it("refuses missing terms, and a missing named version", async () => {
    const { service } = setup({ terms: [] });
    await expect(service.valueLot(request())).rejects.toMatchObject({
      code: "TERMS_NOT_FOUND",
      params: { series: "TOS1029" },
    });
    const named = setup({});
    await expect(
      named.service.valueLot(request({ termsVersion: 7 })),
    ).rejects.toMatchObject({
      code: "TERMS_VERSION_NOT_FOUND",
      params: { series: "TOS1029", version: "7" },
    });
  });

  it("refuses terms that contradict the instrument row", async () => {
    const wrongSeries = setup({
      instruments: [{ id: "i1", series_code: "TOS1030", currency_code: "PLN" }],
    });
    await expect(
      wrongSeries.service.valueLot(request()),
    ).rejects.toBeInstanceOf(BondDataInconsistentError);
    const wrongCurrency = setup({
      instruments: [{ id: "i1", series_code: "TOS1029", currency_code: "EUR" }],
    });
    await expect(
      wrongCurrency.service.valueLot(request()),
    ).rejects.toMatchObject({
      code: "TERMS_MISMATCH",
      params: {
        series: "TOS1029",
        version: "1",
        claimedCurrency: "PLN",
        storedCurrency: "EUR",
      },
    });
  });

  it("refuses stored terms that do not parse", async () => {
    const { service } = setup({
      terms: [{ version: 1, terms: { schemaVersion: 1 } }],
    });
    await expect(service.valueLot(request())).rejects.toThrow(
      /Invalid bond terms/,
    );
  });

  describe("loadReference and valueLotFrom: the data is read once", () => {
    it("loads by instrument id, then values any number of (lot, asOf) pairs without another query", async () => {
      const { service, manager, calls } = setup({});
      const reference = await service.loadReference(manager as never, "i1");
      const queries = calls.length;
      expect(
        calls.find((c) => c.sql.includes("FROM bond_instruments"))?.params,
      ).toEqual(["i1"]);
      expect(reference).toMatchObject({
        termsVersion: 1,
        instrument: {
          id: "i1",
          seriesCode: "TOS1029",
          currencyCode: "PLN",
          termsProvider: "PL_MF",
        },
      });

      const values = ["2026-10-15", "2026-10-16", "2027-04-15"].map((asOf) =>
        service.valueLotFrom(
          reference,
          { purchaseDate: "2026-10-15", quantity: 25 },
          asOf,
        ),
      );

      expect(calls).toHaveLength(queries);
      // 25 bonds, 182 days into the 365-day period: 25 x 102.19.
      expect(values.map((v) => v.grossValue)).toEqual([
        "2500.00",
        "2500.25",
        "2554.75",
      ]);
    });

    it("agrees with valueLot", async () => {
      const { service, manager } = setup({});
      const reference = await service.loadReference(manager as never, "i1");
      expect(
        service.valueLotFrom(reference, request().lot, request().asOf),
      ).toEqual(await service.valueLot(request()));
    });

    it("throws not-found for an id that is not stored, and refuses contradicting rows", async () => {
      const missing = setup({ instruments: [] });
      await expect(
        missing.service.loadReference(missing.manager as never, "nope"),
      ).rejects.toBeInstanceOf(BondDataNotFoundError);

      const wrong = setup({
        instruments: [
          { id: "i1", series_code: "TOS1029", currency_code: "EUR" },
        ],
      });
      await expect(
        wrong.service.loadReference(wrong.manager as never, "i1"),
      ).rejects.toBeInstanceOf(BondDataInconsistentError);
    });
  });

  describe("valueSecurity", () => {
    const owned = [
      {
        id: "sec-1",
        user_id: "user-1",
        symbol: "TOS1029",
        currency_code: "PLN",
        bond_program_id: "p1",
        bond_auto_fetch: false,
      },
    ];
    const buy = (
      date: string,
      quantity: string,
      series: string | null = "i1",
    ) => ({
      action: "BUY",
      status: "UNRECONCILED",
      tx_date: date,
      quantity,
      account_id: "acc-1",
      counterpart_account_id: null,
      bond_instrument_id: series,
    });

    it("values every lot open on asOf and totals them exactly", async () => {
      const { service, calls } = setup({
        securities: owned,
        ledger: [
          buy("2026-10-15", "25.00000000"),
          buy("2026-10-20", "10.00000000"),
          // After asOf: not open on that day, so neither listed nor totalled.
          buy("2027-05-01", "99.00000000"),
        ],
      });

      const result = await service.valueSecurity(
        "user-1",
        "sec-1",
        "2027-04-15",
      );

      expect(
        calls.find((c) => c.sql.includes("FROM securities"))?.params,
      ).toEqual(["sec-1", "user-1"]);
      expect(result.program).toEqual({
        id: "p1",
        programCode: "TOS",
        issuerCountryCode: "PL",
        issuerCode: "PL_MF",
        currency: "PLN",
      });
      expect(result.autoFetch).toBe(false);
      expect(result.series).toHaveLength(1);
      expect(result.series[0]).toMatchObject({
        instrumentId: "i1",
        seriesCode: "TOS1029",
        programCode: "TOS",
      });
      expect(result.lots.every((l) => l.instrumentId === "i1")).toBe(true);
      // The document the terms were read from, from the stored terms' `source`.
      expect(result.series[0].termsSource).toEqual({
        provider: "PL_MF",
        url: "https://www.obligacjeskarbowe.pl/media_files/c15a26ae-de6e-4b89-a137-cb16687a7b0a.pdf",
        document: "List emisyjny nr 97/2026",
      });
      expect(result.refusal).toBeNull();
      expect(
        result.lots.map((l) => [
          l.purchaseDate,
          l.quantity,
          l.purchaseDateAssumed,
          l.valuation.grossValue,
        ]),
      ).toEqual([
        // 182 days in: 102.19 per bond.
        ["2026-10-15", 25, false, "2554.75"],
        // 177 days in: 102.13 per bond.
        ["2026-10-20", 10, false, "1021.30"],
      ]);
      expect(result.totals).toMatchObject({
        quantity: 35,
        grossValue: "3576.05",
      });
      expect(result.totals.accruedInterest).toBe("76.05");
    });

    it("makes a total null unless every lot has the figure: a subtotal is not a total", async () => {
      const { service } = setup({
        securities: owned,
        // Bought 3 days ago, so early redemption is outside its window, while
        // the older lot is inside it.
        ledger: [buy("2026-10-02", "25"), buy("2026-10-30", "10")],
      });
      const result = await service.valueSecurity(
        "user-1",
        "sec-1",
        "2026-11-02",
      );
      expect(result.lots[0].valuation.earlyRedemptionValue).not.toBeNull();
      expect(result.lots[1].valuation.earlyRedemptionValue).toBeNull();
      expect(result.totals.earlyRedemptionValue).toBeNull();
      expect(result.totals.grossValue).not.toBeNull();
    });

    it("reports a known zero when nothing is held, and names the refusal when the lots cannot be derived", async () => {
      const none = setup({ securities: owned, ledger: [] });
      expect(
        (await none.service.valueSecurity("user-1", "sec-1", "2027-04-15"))
          .totals,
      ).toEqual({
        quantity: 0,
        grossValue: "0.00",
        earlyRedemptionValue: "0.00",
        accruedInterest: "0.00",
      });

      const split = setup({
        securities: owned,
        ledger: [
          buy("2026-10-15", "25"),
          { ...buy("2026-12-01", "2"), action: "SPLIT" },
        ],
      });
      const result = await split.service.valueSecurity(
        "user-1",
        "sec-1",
        "2027-04-15",
      );
      expect(result.lots).toEqual([]);
      // A refusal still says where the terms came from.
      expect(result.series[0].termsSource.provider).toBe("PL_MF");
      expect(result.refusal).toMatchObject({ code: "SPLIT" });
      expect(result.totals).toEqual({
        quantity: null,
        grossValue: null,
        earlyRedemptionValue: null,
        accruedInterest: null,
      });
      // The same ledger, a day before the split: lots are known.
      expect(
        (await split.service.valueSecurity("user-1", "sec-1", "2026-11-30"))
          .refusal,
      ).toBeNull();
    });

    it("answers 404 for another user's, a missing or an unlinked security", async () => {
      const foreign = setup({ securities: [] });
      await expect(
        foreign.service.valueSecurity("user-2", "sec-1", "2027-04-15"),
      ).rejects.toBeInstanceOf(NotFoundException);
      const unlinked = setup({
        securities: [{ ...owned[0], bond_program_id: null }],
      });
      await expect(
        unlinked.service.valueSecurity("user-1", "sec-1", "2027-04-15"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("scenariosOf and the assumption on valueSecurity", () => {
    const owned = [
      {
        id: "sec-1",
        user_id: "user-1",
        symbol: "EDO1036",
        currency_code: "PLN",
        bond_program_id: "p1",
        bond_auto_fetch: false,
      },
    ];
    const buy = (
      date: string,
      quantity: string,
      series: string | null = "i2",
    ) => ({
      action: "BUY",
      status: "UNRECONCILED",
      tx_date: date,
      quantity,
      account_id: "acc-1",
      counterpart_account_id: null,
      bond_instrument_id: series,
    });
    // Period 2 (CPI 2027-08 = 3.4%) is known on 2027-10-16; periods 3 to 10 are not.
    const edo = (ledger: Row[] = [buy("2026-10-01", "10")]) =>
      setup({
        instruments: edoInstrument,
        terms: [edoTerms],
        securities: owned,
        ledger,
        series: [{ kind: "MONTHLY", publisher: "GUS", covered_through: null }],
        values: [{ observation_date: "2027-08-01", value: "0.0340000000" }],
      });

    it("sums the lots' figures per assumed value from one read of the reference data", async () => {
      const { service, calls } = edo();
      const result = await service.scenariosOf(
        "user-1",
        "sec-1",
        "PL_CPI_GUS_YOY",
        ["0", "0.05"],
        "2027-10-16",
      );
      // Independently computed with python fractions: 10 bonds, r1 = 5.35%,
      // r2 = 5.4%, then max(0, CPI) + 2%; interest is exact x 10 rounded once,
      // the maturity value is the per-bond rounded value x 10.
      expect(result).toMatchObject({
        securityId: "sec-1",
        benchmarkId: "PL_CPI_GUS_YOY",
        asOf: "2027-10-16",
        refusal: null,
      });
      expect(result.scenarios).toEqual([
        {
          value: "0",
          maturityValue: "1301.00",
          totalInterest: "301.00",
          fixedInterest: "53.50",
          benchmarkInterest: "35.82",
          addendInterest: "211.68",
          announcedInterest: "0.00",
        },
        {
          value: "0.05",
          maturityValue: "1907.90",
          totalInterest: "907.86",
          fixedInterest: "53.50",
          benchmarkInterest: "605.44",
          addendInterest: "248.92",
          announcedInterest: "0.00",
        },
      ]);
      for (const table of [
        "bond_instruments",
        "bond_terms_versions",
        "bond_period_rates",
        "benchmark_series",
        "benchmark_values",
      ]) {
        expect(
          calls.filter((c) => c.sql.includes(`FROM ${table}`)),
        ).toHaveLength(1);
      }
    });

    it("refuses an assumption about a benchmark the instrument does not read", async () => {
      await expect(
        edo().service.scenariosOf(
          "user-1",
          "sec-1",
          "PL_NBP_REFERENCE",
          ["0.05"],
          "2027-10-16",
        ),
      ).rejects.toMatchObject({
        code: "BENCHMARK_NOT_READ",
        params: { benchmarkId: "PL_NBP_REFERENCE" },
      });
      await expect(
        edo().service.valueSecurity(
          "user-1",
          "sec-1",
          "2027-10-16",
          new Map([["PL_NBP_REFERENCE", "0.05"]]),
        ),
      ).rejects.toMatchObject({
        code: "BENCHMARK_NOT_READ",
        params: { benchmarkId: "PL_NBP_REFERENCE" },
      });
    });

    it("keeps the known periods across scenarios", async () => {
      const { service } = edo();
      const [low, high] = (
        await service.scenariosOf(
          "user-1",
          "sec-1",
          "PL_CPI_GUS_YOY",
          ["0", "0.05"],
          "2027-10-16",
        )
      ).scenarios;
      expect(high.fixedInterest).toBe(low.fixedInterest);
      expect(Number(high.maturityValue)).toBeGreaterThan(
        Number(low.maturityValue),
      );
      expect(Number(high.benchmarkInterest)).toBeGreaterThan(
        Number(low.benchmarkInterest),
      );
    });

    it("sums several lots, each rounded at the end of its own sum", async () => {
      const { service } = edo([
        buy("2026-10-01", "10"),
        buy("2026-10-01", "3"),
      ]);
      const result = await service.scenariosOf(
        "user-1",
        "sec-1",
        "PL_CPI_GUS_YOY",
        ["0"],
        "2027-10-16",
      );
      // Equal purchase dates fold into one lot of 13 bonds in the ledger fold,
      // or into two lots of 10 and 3: both must agree with 13 x per bond.
      expect(result.scenarios[0].totalInterest).toBe("391.30");
    });

    it("is null for every figure when a lot cannot be valued, never a partial sum", async () => {
      // 2027-10-16 without the stored 2027-08 observation: period 2 has started
      // with no rate, so the lot has no interest figure.
      const { service } = setup({
        instruments: edoInstrument,
        terms: [edoTerms],
        securities: owned,
        ledger: [buy("2026-10-01", "10")],
      });
      const result = await service.scenariosOf(
        "user-1",
        "sec-1",
        "PL_CPI_GUS_YOY",
        ["0.02"],
        "2027-10-16",
      );
      expect(result.scenarios[0]).toEqual({
        value: "0.02",
        maturityValue: null,
        totalInterest: null,
        fixedInterest: null,
        benchmarkInterest: null,
        addendInterest: null,
        announcedInterest: null,
      });
    });

    it("names the refusal and nulls the figures when the lots cannot be derived", async () => {
      const { service } = edo([
        buy("2026-10-01", "10"),
        { ...buy("2026-12-01", "2"), action: "SPLIT" },
      ]);
      const result = await service.scenariosOf(
        "user-1",
        "sec-1",
        "PL_CPI_GUS_YOY",
        ["0"],
        "2027-10-16",
      );
      expect(result.refusal).toMatchObject({ code: "SPLIT" });
      expect(result.scenarios[0].totalInterest).toBeNull();
    });

    it("answers 404 for another user's or an unlinked security", async () => {
      const foreign = setup({ securities: [] });
      await expect(
        foreign.service.scenariosOf(
          "user-2",
          "sec-1",
          "X",
          ["0"],
          "2027-10-16",
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      const unlinked = setup({
        securities: [{ ...owned[0], bond_program_id: null }],
      });
      await expect(
        unlinked.service.scenariosOf(
          "user-1",
          "sec-1",
          "X",
          ["0"],
          "2027-10-16",
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("states each benchmark's coverage date and last fetch on the security valuation", async () => {
      const { service } = setup({
        instruments: edoInstrument,
        terms: [edoTerms],
        securities: owned,
        ledger: [buy("2026-10-01", "10")],
        series: [
          {
            kind: "MONTHLY",
            publisher: "GUS",
            covered_through: "2027-08-01",
            updated_at: new Date("2027-10-10T04:00:00.000Z"),
          },
        ],
        values: [{ observation_date: "2027-08-01", value: "0.0340000000" }],
      });
      const result = await service.valueSecurity(
        "user-1",
        "sec-1",
        "2027-10-16",
      );
      expect(result.benchmarkCoverage).toEqual([
        {
          benchmarkId: "PL_CPI_GUS_YOY",
          coveredThrough: "2027-08-01",
          lastFetchedAt: "2027-10-10T04:00:00.000Z",
        },
      ]);
    });

    it("has no coverage entry for a fixed-rate series", async () => {
      const { service } = setup({
        securities: owned,
        ledger: [buy("2026-10-01", "10", "i1")],
      });
      const result = await service.valueSecurity(
        "user-1",
        "sec-1",
        "2027-04-15",
      );
      expect(result.benchmarkCoverage).toEqual([]);
    });

    it("carries the next payment, rate reset and capitalization of each lot to the response", async () => {
      const { service } = setup({
        securities: owned,
        ledger: [buy("2026-10-15", "25.00000000", "i1")],
      });
      const result = await service.valueSecurity(
        "user-1",
        "sec-1",
        "2027-04-15",
      );
      const v = result.lots[0].valuation;
      expect(v.nextPayment).toEqual(
        [...v.knownCashflows, ...v.projectedCashflows].filter(
          (f) => f.date === v.nextPayment[0].date,
        ),
      );
      expect(v.nextPayment.length).toBeGreaterThan(0);
      expect(v).toHaveProperty("nextRateReset");
      expect(v).toHaveProperty("nextCapitalization");
    });

    it("passes each series' redemption policy through, and null for a maturity-only bond", async () => {
      const onDemand = setup({
        securities: owned,
        ledger: [buy("2026-10-15", "25", "i1")],
      });
      const result = await onDemand.service.valueSecurity(
        "user-1",
        "sec-1",
        "2027-04-15",
      );
      expect(result.series[0].redemptionTerms).toEqual(
        manifestDocument("tos1029").redemption,
      );
      expect(result.series[0].redemptionTerms).toMatchObject({
        type: "ON_DEMAND",
        penalties: [{ type: "FIXED_FEE_PER_UNIT", amount: "1.00" }],
      });

      const maturityOnly = manifestDocument("tos1029");
      maturityOnly.redemption = { type: "MATURITY_ONLY" };
      const only = setup({
        terms: [{ version: 1, terms: maturityOnly }],
        securities: owned,
        ledger: [buy("2026-10-15", "25", "i1")],
      });
      expect(
        (await only.service.valueSecurity("user-1", "sec-1", "2027-04-15"))
          .series[0].redemptionTerms,
      ).toBeNull();

      // A refusal still names the policy: it belongs to the instrument.
      const refused = setup({
        securities: owned,
        ledger: [{ ...buy("2026-10-15", "25", "i1"), action: "SPLIT" }],
      });
      const r = await refused.service.valueSecurity(
        "user-1",
        "sec-1",
        "2027-04-15",
      );
      expect(r.refusal).not.toBeNull();
      expect(r.series[0].redemptionTerms).toMatchObject({ type: "ON_DEMAND" });
    });

    it("valueSecurity passes the assumption to every lot", async () => {
      const { service } = edo();
      const result = await service.valueSecurity(
        "user-1",
        "sec-1",
        "2027-10-16",
        new Map([["PL_CPI_GUS_YOY", "0.05"]]),
      );
      expect(result.lots[0].valuation.projectionAssumptions).toEqual([
        {
          benchmarkId: "PL_CPI_GUS_YOY",
          value: "0.0500",
          basis: "SUPPLIED",
          observation: null,
        },
      ]);
    });
  });

  describe("one security holding two series of a program", () => {
    const tos = manifestDocument("tos1029");
    const securityRow = [
      {
        id: "sec-1",
        user_id: "user-1",
        symbol: "BONDS",
        currency_code: "PLN",
        bond_program_id: "p1",
        bond_auto_fetch: true,
      },
    ];
    const row = (
      date: string,
      quantity: string,
      series: string | null,
      over: Row = {},
    ) => ({
      action: "BUY",
      status: "UNRECONCILED",
      tx_date: date,
      quantity,
      account_id: "acc-1",
      counterpart_account_id: null,
      bond_instrument_id: series,
      ...over,
    });
    const both = (ledger: Row[], over: Partial<Store> = {}) =>
      setup({
        instruments: [
          ...edoInstrument,
          ...[
            {
              id: "i1",
              series_code: "TOS1029",
              program_code: "TOS",
              currency_code: "PLN",
            },
          ],
        ],
        terms: [
          { instrumentId: "i2", version: 1, terms: edoTerms.terms },
          { instrumentId: "i1", version: 1, terms: tos },
        ],
        securities: securityRow,
        ledger,
        series: [{ kind: "MONTHLY", publisher: "GUS", covered_through: null }],
        values: [{ observation_date: "2027-08-01", value: "0.0340000000" }],
        ...over,
      });
    const only = (series: "i1" | "i2", date: string, quantity: string) =>
      setup({
        instruments:
          series === "i1"
            ? [
                {
                  id: "i1",
                  series_code: "TOS1029",
                  program_code: "TOS",
                  currency_code: "PLN",
                },
              ]
            : edoInstrument,
        terms: [{ version: 1, terms: series === "i1" ? tos : edoTerms.terms }],
        securities: securityRow,
        ledger: [row(date, quantity, series)],
        series: [{ kind: "MONTHLY", publisher: "GUS", covered_through: null }],
        values: [{ observation_date: "2027-08-01", value: "0.0340000000" }],
      });

    it("values each lot by its own series' terms and totals them, with a series list of the held ones", async () => {
      const mixed = both([
        row("2026-10-15", "25", "i1"),
        row("2026-10-01", "10", "i2"),
      ]);
      const result = await mixed.service.valueSecurity(
        "user-1",
        "sec-1",
        "2027-04-15",
      );
      const tosOnly = await only(
        "i1",
        "2026-10-15",
        "25",
      ).service.valueSecurity("user-1", "sec-1", "2027-04-15");
      const edoOnly = await only(
        "i2",
        "2026-10-01",
        "10",
      ).service.valueSecurity("user-1", "sec-1", "2027-04-15");

      expect(result.autoFetch).toBe(true);
      const byId = new Map(result.lots.map((l) => [l.instrumentId, l]));
      expect(byId.get("i1")?.valuation).toEqual(tosOnly.lots[0].valuation);
      expect(byId.get("i2")?.valuation).toEqual(edoOnly.lots[0].valuation);
      expect(byId.get("i1")?.valuation.seriesCode).toBe("TOS1029");
      expect(byId.get("i2")?.valuation.seriesCode).toBe("EDO1036");
      expect(result.totals.quantity).toBe(35);
      expect(result.totals.grossValue).toBe(
        (
          Number(tosOnly.totals.grossValue) + Number(edoOnly.totals.grossValue)
        ).toFixed(2),
      );
      expect(result.series.map((x) => x.seriesCode)).toEqual([
        "EDO1036",
        "TOS1029",
      ]);
      expect(result.series.map((x) => x.instrumentId)).toEqual(["i2", "i1"]);
      // One coverage entry, for the one benchmark any held series reads.
      expect(result.benchmarkCoverage.map((c) => c.benchmarkId)).toEqual([
        "PL_CPI_GUS_YOY",
      ]);
      // The reference data of each series is read once.
      for (const table of ["bond_terms_versions", "bond_period_rates"]) {
        expect(
          mixed.calls.filter((c) => c.sql.includes(`FROM ${table}`)),
        ).toHaveLength(2);
      }
    });

    it("applies an assumption to the series that read the benchmark and leaves the other unchanged", async () => {
      const mixed = both([
        row("2026-10-15", "25", "i1"),
        row("2026-10-01", "10", "i2"),
      ]);
      const [low, high] = (
        await mixed.service.scenariosOf(
          "user-1",
          "sec-1",
          "PL_CPI_GUS_YOY",
          ["0", "0.05"],
          "2027-10-16",
        )
      ).scenarios;
      const edoOnly = await both([
        row("2026-10-01", "10", "i2"),
      ]).service.scenariosOf(
        "user-1",
        "sec-1",
        "PL_CPI_GUS_YOY",
        ["0", "0.05"],
        "2027-10-16",
      );
      // The fixed-rate series adds the same interest in every scenario ...
      const addedLow =
        Number(low.totalInterest) - Number(edoOnly.scenarios[0].totalInterest);
      const addedHigh =
        Number(high.totalInterest) - Number(edoOnly.scenarios[1].totalInterest);
      expect(addedLow).toBeGreaterThan(0);
      expect(addedHigh).toBeCloseTo(addedLow, 2);
      // ... and the indexed one still moves with the assumption.
      expect(Number(high.totalInterest)).toBeGreaterThan(
        Number(low.totalInterest),
      );
    });

    it("refuses an assumption only when none of the held series reads the benchmark", async () => {
      await expect(
        both([
          row("2026-10-15", "25", "i1"),
          row("2026-10-01", "10", "i2"),
        ]).service.scenariosOf(
          "user-1",
          "sec-1",
          "PL_NBP_REFERENCE",
          ["0.05"],
          "2027-10-16",
        ),
      ).rejects.toMatchObject({ code: "BENCHMARK_NOT_READ" });
    });

    it("refuses the lots with SERIES_NOT_DETERMINED for a legacy acquisition no series covers, and infers one that is covered", async () => {
      const uncovered = both([row("2026-10-15", "25", null)], { onSale: [] });
      const refused = await uncovered.service.valueSecurity(
        "user-1",
        "sec-1",
        "2027-04-15",
      );
      expect(refused.refusal).toMatchObject({
        code: "SERIES_NOT_DETERMINED",
        params: { action: "BUY", date: "2026-10-15" },
      });
      expect(refused.lots).toEqual([]);
      expect(refused.totals.grossValue).toBeNull();

      const covered = both([row("2026-10-15", "25", null)], {
        onSale: [{ id: "i1" }],
      });
      const inferred = await covered.service.valueSecurity(
        "user-1",
        "sec-1",
        "2027-04-15",
      );
      expect(inferred.refusal).toBeNull();
      expect(inferred.lots.map((l) => l.instrumentId)).toEqual(["i1"]);
    });

    it("keeps the lots of a removal by series: selling EDO leaves TOS", async () => {
      const result = await both([
        row("2026-10-15", "25", "i1"),
        row("2026-10-01", "10", "i2"),
        row("2027-01-10", "10", "i2", { action: "SELL" }),
      ]).service.valueSecurity("user-1", "sec-1", "2027-04-15");
      expect(result.lots.map((l) => [l.instrumentId, l.quantity])).toEqual([
        ["i1", 25],
      ]);
      expect(result.series.map((x) => x.seriesCode)).toEqual(["TOS1029"]);
    });
  });
  describe("valueByAccount: a holding is its own lots' value", () => {
    const owned = [
      {
        id: "sec-1",
        user_id: "user-1",
        symbol: "TOS1029",
        currency_code: "PLN",
        bond_program_id: "p1",
        bond_auto_fetch: false,
      },
    ];
    const buy = (
      account: string,
      date: string,
      quantity: string,
      series: string | null = "i1",
    ) => ({
      action: "BUY",
      status: "UNRECONCILED",
      tx_date: date,
      quantity,
      account_id: account,
      counterpart_account_id: null,
      bond_instrument_id: series,
    });

    /** Answers the user's timezone preference on top of the store. */
    const withTimezone = (
      built: ReturnType<typeof setup>,
      timezone: string | null,
    ) => {
      const store = built.manager.query.getMockImplementation() as (
        sql: string,
        params: unknown[],
      ) => Promise<unknown>;
      built.manager.query.mockImplementation(
        async (sql: string, params: unknown[]) =>
          sql.includes("FROM user_preferences")
            ? [{ timezone, last_client_timezone: null }]
            : store(sql, params),
      );
      return built;
    };

    beforeEach(() => {
      jest.useFakeTimers({
        now: new Date("2027-04-14T12:00:00Z"),
        doNotFake: [
          "nextTick",
          "setImmediate",
          "setTimeout",
          "setInterval",
          "clearTimeout",
          "clearInterval",
          "clearImmediate",
          "queueMicrotask",
          "performance",
          "hrtime",
        ],
      });
    });
    afterEach(() => jest.useRealTimers());

    it("sums each account's lots on the person's financial today, exactly", async () => {
      const built = withTimezone(
        setup({
          securities: owned,
          ledger: [
            buy("acc-1", "2026-10-15", "25.00000000"),
            buy("acc-2", "2026-10-20", "10.00000000"),
            buy("acc-2", "2026-10-20", "5.00000000"),
          ],
        }),
        "Pacific/Kiritimati",
      );
      const spy = jest.spyOn(built.service, "valueSecurity");

      const result = await built.service.valueByAccount("user-1", "sec-1");

      // 2027-04-14T12:00Z is already the 15th at UTC+14.
      expect(result.asOf).toBe("2027-04-15");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("user-1", "sec-1", "2027-04-15");
      const whole = await spy.mock.results[0].value;
      expect(result.accounts?.get("acc-1")?.quantity).toBe(25);
      expect(result.accounts?.get("acc-2")?.quantity).toBe(15);
      const sum = [...(result.accounts?.values() ?? [])].reduce(
        (n, a) => Math.round(Number(a.grossValue) * 100) + n,
        0,
      );
      expect(sum).toBe(Math.round(Number(whole.totals.grossValue) * 100));
      expect(result.accounts?.get("acc-1")?.grossValue).toBe(
        whole.lots.find((l: { accountId?: string }) => l.accountId === "acc-1")
          .valuation.grossValue,
      );
    });

    it("has no accounts when the lots are unknowable", async () => {
      const result = await withTimezone(
        setup({
          securities: owned,
          onSale: [],
          ledger: [buy("acc-1", "2026-10-15", "25", null)],
        }),
        "UTC",
      ).service.valueByAccount("user-1", "sec-1");

      expect(result.accounts).toBeNull();
    });

    it("gives an account with a lot that has no gross value a null value, not a subtotal", async () => {
      const built = withTimezone(
        setup({
          securities: owned,
          ledger: [
            buy("acc-1", "2026-10-15", "25"),
            buy("acc-2", "2026-10-20", "10"),
          ],
        }),
        "UTC",
      );
      const real = built.service.valueSecurity.bind(built.service);
      jest
        .spyOn(built.service, "valueSecurity")
        .mockImplementation(async (...args) => {
          const v = await real(...args);
          return {
            ...v,
            lots: v.lots.map((l) =>
              l.accountId === "acc-2"
                ? { ...l, valuation: { ...l.valuation, grossValue: null } }
                : l,
            ),
          };
        });

      const result = await built.service.valueByAccount("user-1", "sec-1");

      expect(result.accounts?.get("acc-2")?.grossValue).toBeNull();
      expect(result.accounts?.get("acc-1")?.grossValue).not.toBeNull();
    });

    it("treats a REFUSED lot as having no value", async () => {
      const built = withTimezone(
        setup({
          securities: owned,
          ledger: [buy("acc-1", "2026-10-15", "25")],
        }),
        "UTC",
      );
      const real = built.service.valueSecurity.bind(built.service);
      jest
        .spyOn(built.service, "valueSecurity")
        .mockImplementation(async (...args) => {
          const v = await real(...args);
          return {
            ...v,
            lots: v.lots.map((l) => ({
              ...l,
              valuation: { ...l.valuation, status: "REFUSED" as const },
            })),
          };
        });

      const result = await built.service.valueByAccount("user-1", "sec-1");

      expect(result.accounts?.get("acc-1")?.grossValue).toBeNull();
    });
  });
});

describe("BondValuationService.valueSecurity: marketPriceRequired (INV-BOND-005)", () => {
  const owned = [
    {
      id: "sec-1",
      user_id: "user-1",
      symbol: "TOS1029",
      currency_code: "PLN",
      bond_program_id: "p1",
      bond_auto_fetch: false,
    },
  ];
  const buy = (date: string) => ({
    action: "BUY",
    status: "UNRECONCILED",
    tx_date: date,
    quantity: "10",
    account_id: "acc-1",
    counterpart_account_id: null,
    bond_instrument_id: "i1",
  });
  /** The same terms as a marketable coupon series: no sale window, paid at maturity only. */
  const marketable = () => {
    const doc = manifestDocument("tos1029");
    doc.instrument.marketability = "MARKETABLE";
    doc.saleWindow = null;
    doc.redemption = { type: "MATURITY_ONLY" };
    return doc;
  };

  it("is true when a held series trades, so the price is the person's", async () => {
    const { service } = setup({
      securities: owned,
      ledger: [buy("2026-10-15")],
      terms: [{ version: 1, terms: marketable() }],
    });
    const result = await service.valueSecurity("user-1", "sec-1", "2027-01-15");
    expect(result.marketPriceRequired).toBe(true);
    // The engine still values the lot from its terms.
    expect(result.lots[0].valuation.grossValue).not.toBeNull();
  });

  it("is false when every held series is priced by its terms", async () => {
    const { service } = setup({
      securities: owned,
      ledger: [buy("2026-10-15")],
    });
    const result = await service.valueSecurity("user-1", "sec-1", "2027-01-15");
    expect(result.marketPriceRequired).toBe(false);
  });

  it("is false when no series is held", async () => {
    const { service } = setup({ securities: owned, ledger: [] });
    const result = await service.valueSecurity("user-1", "sec-1", "2027-01-15");
    expect(result.marketPriceRequired).toBe(false);
  });
});
