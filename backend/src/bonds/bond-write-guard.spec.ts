import {
  BadRequestException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { EntityManager } from "typeorm";
import {
  beginBondWriteGuard,
  createBondWriteGuard,
  currentLotsRefusal,
  lotsRefusalException,
} from "./bond-write-guard";

const USER = "user-1";
const SEC = "sec-1";
const PROGRAM = "prog-1";
const EDO = "11111111-1111-5111-8111-111111111111";
const COI = "22222222-2222-5222-8222-222222222222";

type Row = {
  id: string;
  action: string;
  tx_date: string;
  quantity: string;
  bond_instrument_id: string | null;
};

const row = (over: Partial<Row> & { id: string }): Row => ({
  action: "BUY",
  tx_date: "2026-01-10",
  quantity: "10",
  bond_instrument_id: EDO,
  ...over,
});

/**
 * A manager answering the guard's statements: the program lookup, the ledger's
 * security read and the ledger rows. `ledgers` are the successive ledger reads.
 */
function world(opts: {
  linked?: boolean;
  ledgers: Row[][];
  /** Successive answers of the price band read (rows outside it); last repeats. */
  band?: Array<
    Array<{ id: string; price: string; face: string; cash_price?: boolean }>
  >;
}) {
  let reads = 0;
  let bandReads = 0;
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("FROM bond_programs WHERE id")) {
      return [
        {
          issuer_country_code: "PL",
          issuer_code: "PL_MF",
          program_code: "EDO",
        },
      ];
    }
    if (sql.includes("t.price IS NOT NULL")) {
      const all = opts.band ?? [[]];
      const rows = all[Math.min(bandReads, all.length - 1)];
      bandReads += 1;
      return rows;
    }
    if (sql.includes("s.bond_program_id AS id")) {
      return [
        opts.linked === false
          ? { id: null, program_code: null }
          : { id: PROGRAM, program_code: "EDO" },
      ];
    }
    if (sql.includes("bond_auto_fetch")) {
      return [
        {
          id: SEC,
          user_id: USER,
          symbol: "EDO",
          currency_code: "PLN",
          bond_program_id: opts.linked === false ? null : PROGRAM,
          bond_auto_fetch: false,
        },
      ];
    }
    if (sql.includes("counterpart_account_id")) {
      const rows = opts.ledgers[Math.min(reads, opts.ledgers.length - 1)];
      reads += 1;
      return rows.map((r) => ({
        ...r,
        status: "UNRECONCILED",
        account_id: "acc-1",
        counterpart_account_id: null,
      }));
    }
    return [];
  });
  return { manager: { query } as unknown as EntityManager, query };
}

const refusalCode = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as {
      errorCode: string;
      message: string;
    };
  }
  return null;
};

describe("BondWriteGuard (INV-BOND-007: a removal is checked at write time)", () => {
  it("throws OVER_REMOVAL when the lots were derivable before the write and a removal is not covered after it", async () => {
    const buy = row({ id: "b1", quantity: "5" });
    const sell = row({
      id: "w1",
      action: "SELL",
      quantity: "9",
      bond_instrument_id: null,
    });
    const { manager } = world({ ledgers: [[buy], [buy, sell]] });
    const guard = await beginBondWriteGuard(manager, USER, [SEC]);
    const body = await refusalCode(guard.verify(["w1"]));
    expect(body?.errorCode).toBe("OVER_REMOVAL");
    expect(body?.message).toContain("2026-01-10");
  });

  it("throws REMOVAL_EXCEEDS_SERIES for a removal naming a series the account holds too little of, though it holds enough of another", async () => {
    const buyEdo = row({ id: "b1", quantity: "5" });
    const buyCoi = row({ id: "b2", quantity: "50", bond_instrument_id: COI });
    const sell = row({
      id: "w1",
      action: "SELL",
      quantity: "9",
      tx_date: "2026-02-01",
    });
    const { manager } = world({
      ledgers: [
        [buyEdo, buyCoi],
        [buyEdo, buyCoi, sell],
      ],
    });
    const guard = await beginBondWriteGuard(manager, USER, [SEC]);
    expect((await refusalCode(guard.verify(["w1"])))?.errorCode).toBe(
      "REMOVAL_EXCEEDS_SERIES",
    );
  });

  it("also refuses when the written row made ANOTHER row's removal uncovered (an edit that shrinks a purchase)", async () => {
    const buy = row({ id: "b1", quantity: "10" });
    const sell = row({ id: "s1", action: "SELL", quantity: "8" });
    const { manager } = world({
      ledgers: [
        [buy, sell],
        [{ ...buy, quantity: "5" }, sell],
      ],
    });
    const guard = await beginBondWriteGuard(manager, USER, [SEC]);
    expect((await refusalCode(guard.verify(["b1"])))?.errorCode).toBe(
      "REMOVAL_EXCEEDS_SERIES",
    );
  });

  it("does not block an unrelated edit while an older refusal about another row stands", async () => {
    const buy = row({ id: "b1", quantity: "5" });
    const old = row({
      id: "old",
      action: "SELL",
      quantity: "9",
      bond_instrument_id: null,
    });
    const { manager } = world({
      ledgers: [
        [buy, old],
        [buy, old],
      ],
    });
    const guard = await beginBondWriteGuard(manager, USER, [SEC]);
    await expect(guard.verify(["unrelated"])).resolves.toBeUndefined();
  });

  it("blocks a write whose own row is the one refused, even though the ledger was refused before", async () => {
    const buy = row({ id: "b1", quantity: "5" });
    const old = row({
      id: "old",
      action: "SELL",
      quantity: "9",
      bond_instrument_id: null,
    });
    const written = row({
      id: "w1",
      action: "SELL",
      quantity: "9",
      tx_date: "2026-01-20",
      bond_instrument_id: null,
    });
    const { manager } = world({
      ledgers: [
        [buy, old],
        [buy, written, old],
      ],
    });
    const guard = await beginBondWriteGuard(manager, USER, [SEC]);
    expect((await refusalCode(guard.verify(["w1"])))?.errorCode).toBe(
      "OVER_REMOVAL",
    );
  });

  it("is silent when the lots are still derivable", async () => {
    const buy = row({ id: "b1", quantity: "10" });
    const { manager } = world({ ledgers: [[buy], [buy]] });
    const guard = await beginBondWriteGuard(manager, USER, [SEC]);
    await expect(guard.verify(["b1"])).resolves.toBeUndefined();
  });

  it("leaves the other refusals to the ledger: a row with no series, a split, a fractional quantity never block a write", async () => {
    const noSeries = row({
      id: "w1",
      bond_instrument_id: null,
      action: "ADD_SHARES",
    });
    const fractional = row({ id: "w2", quantity: "1.5" });
    for (const after of [[noSeries], [fractional]]) {
      const { manager } = world({ ledgers: [[], after] });
      const guard = await beginBondWriteGuard(manager, USER, [SEC]);
      await expect(guard.verify(["w1", "w2"])).resolves.toBeUndefined();
    }
  });

  it("tracks nothing for a security that is not linked, an absent id, or a repeated one", async () => {
    const unlinked = world({ linked: false, ledgers: [[]] });
    const guard = await beginBondWriteGuard(unlinked.manager, USER, [
      SEC,
      null,
      undefined,
    ]);
    await expect(guard.verify(["x"])).resolves.toBeUndefined();
    expect(
      unlinked.query.mock.calls.some(([sql]) =>
        String(sql).includes("counterpart_account_id"),
      ),
    ).toBe(false);

    const linked = world({ ledgers: [[]] });
    const twice = createBondWriteGuard(linked.manager, USER);
    await twice.track([SEC, SEC]);
    await twice.track([SEC]);
    expect(
      linked.query.mock.calls.filter(([sql]) =>
        String(sql).includes("counterpart_account_id"),
      ),
    ).toHaveLength(1);
  });

  it("checks the old and the new security of an edit that moves a row between securities", async () => {
    const buy = row({ id: "b1", quantity: "5" });
    const sell = row({
      id: "w1",
      action: "SELL",
      quantity: "9",
      bond_instrument_id: null,
    });
    const { manager } = world({ ledgers: [[buy], [buy, sell]] });
    const guard = await beginBondWriteGuard(manager, USER, ["other", SEC]);
    await expect(guard.verify(["w1"])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("BondWriteGuard (INV-BOND-005: a quantity of a linked security is a count of bonds, on every write)", () => {
  const buy = row({ id: "b1" });
  const outOfBand = (id: string, price = "1.0000") => ({
    id,
    price,
    face: "100.00",
  });

  it("refuses a written trade priced below the band (BUY 1000 @ 1.00 against a face value of 100) with the price and the face value in the message", async () => {
    const { manager } = world({
      ledgers: [[], [buy]],
      band: [[], [outOfBand("b1")]],
    });
    const guard = await beginBondWriteGuard(manager, USER, [SEC]);
    const body = await refusalCode(guard.verify(["b1"]));
    expect(body?.errorCode).toBe("QUANTITY_NOT_BONDS");
    expect(body?.message).toContain("100.00");
    expect(body?.message).toContain("1.0000");
  });

  it("names the cash-price band for a trade of a marketable coupon series: more than five times the face value", async () => {
    const { manager } = world({
      ledgers: [[], [buy]],
      band: [
        [],
        [{ id: "b1", price: "612.5000", face: "100", cash_price: true }],
      ],
    });
    const guard = await beginBondWriteGuard(manager, USER, [SEC]);
    const body = await refusalCode(guard.verify(["b1"]));
    expect(body?.errorCode).toBe("QUANTITY_NOT_BONDS");
    expect(body?.message).toContain("more than five times the face value");
    expect(body?.message).toContain("612.5000");
  });

  it("refuses one priced above the band too", async () => {
    const { manager } = world({
      ledgers: [[], [buy]],
      band: [[], [outOfBand("b1", "250.0000")]],
    });
    const guard = await beginBondWriteGuard(manager, USER, [SEC]);
    expect((await refusalCode(guard.verify(["b1"])))?.errorCode).toBe(
      "QUANTITY_NOT_BONDS",
    );
  });

  it("is silent for a trade in the band (the read finds nothing out of it)", async () => {
    const { manager } = world({ ledgers: [[], [buy]], band: [[], []] });
    const guard = await beginBondWriteGuard(manager, USER, [SEC]);
    await expect(guard.verify(["b1"])).resolves.toBeUndefined();
  });

  it("reads a row with no series against the program's template face value (an empty catalog does not pass)", async () => {
    const { manager, query } = world({ ledgers: [[], [buy]] });
    const guard = await beginBondWriteGuard(manager, USER, [SEC]);
    await guard.verify(["b1"]);
    const bandReads = query.mock.calls.filter(([sql]) =>
      String(sql).includes("t.price IS NOT NULL"),
    );
    expect(bandReads.length).toBeGreaterThanOrEqual(2);
    for (const [, params] of bandReads) {
      expect((params as unknown[])[3]).toBe("100.00");
    }
  });

  it("refuses a written row even when it was out of band before (an edit that keeps a legacy price is still a write)", async () => {
    const { manager } = world({
      ledgers: [[buy], [buy]],
      band: [[outOfBand("b1")], [outOfBand("b1")]],
    });
    const guard = await beginBondWriteGuard(manager, USER, [SEC]);
    expect((await refusalCode(guard.verify(["b1"])))?.errorCode).toBe(
      "QUANTITY_NOT_BONDS",
    );
  });

  it("does not block an unrelated write or a delete because of a legacy row that was already out of band", async () => {
    const { manager } = world({
      ledgers: [[buy], [buy]],
      band: [[outOfBand("old")], [outOfBand("old")]],
    });
    const guard = await beginBondWriteGuard(manager, USER, [SEC]);
    await expect(guard.verify(["unrelated"])).resolves.toBeUndefined();
    await expect(guard.verify()).resolves.toBeUndefined();
  });

  it("covers a write that names no ids (a file import): a row out of band that was not before is refused", async () => {
    const { manager } = world({
      ledgers: [[], [buy]],
      band: [[], [outOfBand("imported-1")]],
    });
    const guard = await beginBondWriteGuard(manager, USER, [SEC]);
    expect((await refusalCode(guard.verify()))?.errorCode).toBe(
      "QUANTITY_NOT_BONDS",
    );
  });

  it("reads nothing of the band for a security that is not linked", async () => {
    const { manager, query } = world({ linked: false, ledgers: [[]] });
    const guard = await beginBondWriteGuard(manager, USER, [SEC]);
    await expect(guard.verify(["b1"])).resolves.toBeUndefined();
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("t.price IS NOT NULL"),
      ),
    ).toBe(false);
  });
});

describe("currentLotsRefusal", () => {
  it("is undefined for an unlinked security, null for derivable lots, the refusal otherwise", async () => {
    await expect(
      currentLotsRefusal(
        world({ linked: false, ledgers: [[]] }).manager,
        USER,
        SEC,
      ),
    ).resolves.toBeUndefined();
    await expect(
      currentLotsRefusal(
        world({ ledgers: [[row({ id: "b1" })]] }).manager,
        USER,
        SEC,
      ),
    ).resolves.toBeNull();
    const refusal = await currentLotsRefusal(
      world({
        ledgers: [
          [row({ id: "s1", action: "SELL", bond_instrument_id: null })],
        ],
      }).manager,
      USER,
      SEC,
    );
    expect(refusal).toMatchObject({ code: "OVER_REMOVAL", rowId: "s1" });
  });
});

describe("lotsRefusalException", () => {
  const refusal = (code: string) =>
    ({
      code,
      params: { action: "SELL", date: "2026-02-01", quantity: "9.00000000" },
      detail: "English for the logs",
    }) as never;

  it("is a 400 for a write and a 422 for a read, with the refusal code as errorCode", () => {
    const write = lotsRefusalException(refusal("OVER_REMOVAL"), "write");
    expect(write).toBeInstanceOf(BadRequestException);
    expect(write.getResponse()).toMatchObject({ errorCode: "OVER_REMOVAL" });
    const read = lotsRefusalException(refusal("SPLIT"), "read");
    expect(read).toBeInstanceOf(UnprocessableEntityException);
    expect(read.getResponse()).toMatchObject({ errorCode: "SPLIT" });
  });

  it("names the row's date and never the English log text", () => {
    const body = lotsRefusalException(
      refusal("REMOVAL_EXCEEDS_SERIES"),
      "write",
    ).getResponse() as { message: string };
    expect(body.message).toContain("2026-02-01");
    expect(body.message).not.toContain("English for the logs");
  });
});
