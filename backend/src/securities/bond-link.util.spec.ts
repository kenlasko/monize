import { EntityManager } from "typeorm";
import {
  BOND_CASH_PRICE_BAND,
  BOND_UNIT_PRICE_BAND,
  findBondLinkProblem,
  findQuantitiesNotBonds,
  hasQuantitiesThatAreNotBonds,
} from "./bond-link.util";

const manager = (rows: unknown[]) => {
  const query = jest.fn().mockResolvedValue(rows);
  return { manager: { query } as unknown as EntityManager, query };
};

describe("findBondLinkProblem (the one definition of a valid program link)", () => {
  const link = {
    bondProgramId: "p1",
    currencyCode: "PLN",
    securityType: "BOND",
  };

  it("is valid for a BOND in the program's currency", async () => {
    const { manager: m, query } = manager([{ currency_code: "PLN" }]);
    await expect(findBondLinkProblem(m, link)).resolves.toBeNull();
    expect(query.mock.calls[0][0]).toMatch(/FROM bond_programs WHERE id = \$1/);
    expect(query.mock.calls[0][1]).toEqual(["p1"]);
  });

  it("refuses a program that does not exist", async () => {
    await expect(
      findBondLinkProblem(manager([]).manager, link),
    ).resolves.toEqual({ code: "PROGRAM_NOT_FOUND" });
  });

  it("refuses a security that is not of type BOND", async () => {
    const { manager: m } = manager([{ currency_code: "PLN" }]);
    await expect(
      findBondLinkProblem(m, { ...link, securityType: "STOCK" }),
    ).resolves.toEqual({ code: "NOT_BOND_TYPE" });
    await expect(
      findBondLinkProblem(m, { ...link, securityType: null }),
    ).resolves.toEqual({ code: "NOT_BOND_TYPE" });
  });

  it("refuses a security recorded in another currency than the program's (INV-PRICE-001)", async () => {
    const { manager: m } = manager([{ currency_code: "PLN" }]);
    await expect(
      findBondLinkProblem(m, { ...link, currencyCode: "EUR" }),
    ).resolves.toEqual({
      code: "CURRENCY_MISMATCH",
      instrumentCurrency: "PLN",
    });
  });
});

/**
 * A manager answering the two statements of the band check: the program row (to
 * name the template) and the trades read against the band.
 */
const bandManager = (opts: {
  program?: {
    issuer_country_code: string;
    issuer_code: string;
    program_code: string;
  } | null;
  offenders?: Array<{
    id: string;
    price: string;
    face: string;
    cash_price?: boolean;
  }>;
}) => {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (/FROM bond_programs/.test(sql)) {
      return opts.program === null
        ? []
        : [
            opts.program ?? {
              issuer_country_code: "PL",
              issuer_code: "PL_MF",
              program_code: "EDO",
            },
          ];
    }
    return opts.offenders ?? [];
  });
  return { manager: { query } as unknown as EntityManager, query };
};

describe("hasQuantitiesThatAreNotBonds (the price band across the series of a program)", () => {
  it("reads each row against the face value of the series it will be read as, never skipping one", async () => {
    const { manager: m, query } = bandManager({
      offenders: [{ id: "t1", price: "1.0000", face: "100.00" }],
    });
    await expect(
      hasQuantitiesThatAreNotBonds(m, "u1", "s1", "p1"),
    ).resolves.toBe(true);
    const [sql, params] = query.mock.calls[1];
    // The template face value of the program is the fallback (EDO: 100.00).
    expect(params).toEqual(["s1", "u1", "p1", "100.00", null, 1, false]);
    // The series the row is read as: its stored series when that is in the NEW
    // program ...
    expect(sql).toMatch(/i\.bond_program_id = \$3::uuid/);
    expect(sql).toMatch(/i\.id = t\.bond_instrument_id/);
    // ... else (none stored, or one of another program) the series on sale on
    // its date under the new program ...
    expect(sql).toMatch(
      /NOT EXISTS \(SELECT 1 FROM bond_instruments o\s+WHERE o\.id = t\.bond_instrument_id\s+AND o\.bond_program_id = \$3::uuid\)/,
    );
    expect(sql).toMatch(/i\.id IN \(/);
    expect(sql).toMatch(/saleWindow/);
    // ... and when none is on sale, the program's newest series.
    expect(sql).toMatch(/NOT EXISTS \(SELECT s\.id/);
    expect(sql).toMatch(
      /ORDER BY \(nv\.terms -> 'saleWindow' ->> 'from'\) DESC NULLS LAST,\s+n\.series_code DESC\s+LIMIT 1/,
    );
    // The face value is the newest terms version's, per series, and a row whose
    // program has no series at all is read against the template's (an outer
    // join, never a row dropped for lack of a series).
    expect(sql).toMatch(/ORDER BY version DESC\s+LIMIT 1/);
    expect(sql).toMatch(/\) r ON true/);
    expect(sql).toMatch(/\) f ON true/);
    expect(sql).not.toMatch(/CROSS JOIN LATERAL \(\s+SELECT i\.id/);
    expect(sql).toContain(
      `COALESCE(f.face, $4::numeric) * ${BOND_UNIT_PRICE_BAND.min}::numeric`,
    );
    expect(sql).toContain(
      `COALESCE(f.face, $4::numeric) * ${BOND_UNIT_PRICE_BAND.max}::numeric`,
    );
    expect(sql).toMatch(/t\.status != 'VOID'/);
    // Acquisitions only: a SELL or REDEEM of a long-held bond may be worth
    // more than twice its face value, and a removal in currency units is
    // refused by the lot derivation.
    expect(sql).toMatch(
      /t\.action IN \('BUY', 'REINVEST', 'REINVEST_INTEREST'/,
    );
    expect(sql).not.toMatch(/'SELL'/);
    expect(sql).not.toMatch(/'REDEEM'/);
  });

  it("is false when no row is outside the band", async () => {
    await expect(
      hasQuantitiesThatAreNotBonds(bandManager({}).manager, "u1", "s1", "p1"),
    ).resolves.toBe(false);
  });

  it("with an EMPTY catalog (no stored series) still reads the rows, against the program template's face value (INV-BOND-005)", async () => {
    // The statement is an outer join: no series is no row dropped. The mock
    // stands for the database, which then answers the template-face offender.
    const { manager: m, query } = bandManager({
      offenders: [
        { id: "t1", price: "1.0000", face: "100.00", cash_price: false },
      ],
    });
    const found = await findQuantitiesNotBonds(m, "u1", "s1", "p1");
    expect(found).toEqual([
      { rowId: "t1", price: "1.0000", faceValue: "100.00", cashPrice: false },
    ]);
    expect((query.mock.calls[1][1] as unknown[])[3]).toBe("100.00");
  });

  it("passes no template face for a program no installed adapter declares: such a row has nothing to be read against", async () => {
    const { manager: m, query } = bandManager({
      program: {
        issuer_country_code: "XX",
        issuer_code: "XX_MF",
        program_code: "ZZZ",
      },
    });
    await findQuantitiesNotBonds(m, "u1", "s1", "p1");
    expect((query.mock.calls[1][1] as unknown[])[3]).toBeNull();
    const missing = bandManager({ program: null });
    await findQuantitiesNotBonds(missing.manager, "u1", "s1", "p1");
    expect((missing.query.mock.calls[1][1] as unknown[])[3]).toBeNull();
  });

  it("narrows the read to the rows a write stored when asked", async () => {
    const { manager: m, query } = bandManager({});
    await findQuantitiesNotBonds(m, "u1", "s1", "p1", {
      onlyRowIds: ["t1", "t2"],
    });
    expect((query.mock.calls[1][1] as unknown[])[4]).toEqual(["t1", "t2"]);
    expect((query.mock.calls[1][1] as unknown[])[5]).toBeNull();
    expect(query.mock.calls[1][0]).toMatch(
      /\$5::uuid\[\] IS NULL OR t\.id = ANY/,
    );
  });

  it("pins the band the spec names: [0.5, 2] x face", () => {
    expect(BOND_UNIT_PRICE_BAND).toEqual({ min: "0.5", max: "2" });
  });

  it("pins the band of a cash-priced series (a marketable coupon series): (0, 5] x face", () => {
    expect(BOND_CASH_PRICE_BAND).toEqual({ min: "0", max: "5" });
  });

  it("reads a marketable coupon series against the cash-price band, by its stored terms and by its template", async () => {
    const { manager: m, query } = bandManager({
      program: {
        issuer_country_code: "US",
        issuer_code: "US_TREASURY",
        program_code: "TIPS",
      },
      offenders: [
        { id: "t1", price: "612.5000", face: "100", cash_price: true },
      ],
    });
    const found = await findQuantitiesNotBonds(m, "u1", "s1", "p1");
    expect(found).toEqual([
      { rowId: "t1", price: "612.5000", faceValue: "100", cashPrice: true },
    ]);
    const [sql, params] = query.mock.calls[1];
    // The template of the US TIPS program says its price is a cash price (the
    // seventh parameter) when the row has no stored series ...
    expect((params as unknown[])[6]).toBe(true);
    // ... and a stored series says so by its own terms.
    expect(sql).toContain(
      `terms -> 'instrument' ->> 'marketability' = 'MARKETABLE'`,
    );
    expect(sql).toContain(
      `terms -> 'rateRule' ->> 'type' <> 'ZERO_COUPON_DISCOUNT'`,
    );
    expect(sql).toContain("COALESCE(f.cash, $7::boolean)");
    expect(sql).toContain(
      `COALESCE(f.face, $4::numeric) * ${BOND_CASH_PRICE_BAND.max}::numeric`,
    );
  });

  it("keeps the par band for a retail program and a discount one (the template says not cash-priced)", async () => {
    for (const program of [
      {
        issuer_country_code: "PL",
        issuer_code: "PL_MF",
        program_code: "EDO",
      },
      {
        issuer_country_code: "US",
        issuer_code: "US_TREASURY",
        program_code: "BILL",
      },
    ]) {
      const { manager: m, query } = bandManager({ program });
      await findQuantitiesNotBonds(m, "u1", "s1", "p1");
      expect((query.mock.calls[1][1] as unknown[])[6]).toBe(false);
    }
  });
});
