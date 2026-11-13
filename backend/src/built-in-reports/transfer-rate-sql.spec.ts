import { requestContextStorage } from "../common/request-context";
import {
  ownTransferLegs,
  transferRateReader,
  transferRateSql,
} from "./transfer-rate-sql";

const OWNER = "00000000-0000-4000-8000-000000000001";
const DELEGATE = "00000000-0000-4000-8000-000000000002";

describe("transferRateSql", () => {
  const norm = (sql: string) => sql.replace(/\s+/g, " ");

  it("reads a whole leg's mirror leg, or the split line linking back, on the reader's own legs", () => {
    const sql = norm(transferRateSql("$4::text", "t", { readerParam: "$1" }));

    expect(sql).toContain('WHEN "t".is_transfer AND "t".is_split IS NOT TRUE');
    expect(sql).toContain('"t".user_id = $1');
    expect(sql).toContain('"t".currency_code <> $4::text');
    // Exactly one other side answers; two are ambiguous and answer nothing.
    expect(sql).toContain(
      'WHEN COUNT(*) = 1 THEN ABS("t".amount) / ABS(MIN(fx_cp.amount))',
    );
    // The mirror leg must point back, and only the same ledger answers.
    expect(sql).toContain('fx_leg.id = "t".linked_transaction_id');
    expect(sql).toContain('fx_leg.user_id = "t".user_id');
    expect(sql).toContain('OR fx_leg.linked_transaction_id = "t".id');
    // A split parent answers with its own line, never its whole amount.
    expect(sql).toContain('fx_line.linked_transaction_id = "t".id');
    expect(sql).toContain("fx_line.transfer_account_id IS NOT NULL");
    expect(sql).toContain("fx_leg.currency_code = $4::text");
    expect(sql).toContain('SIGN(fx_cp.amount) <> SIGN("t".amount)');
  });

  it("reads a split's transfer line at its counterpart row", () => {
    const sql = norm(
      transferRateSql(":fx", "t", { readerParam: ":reader", splitAlias: "ts" }),
    );

    expect(sql).toContain('WHEN "ts".transfer_account_id IS NOT NULL');
    expect(sql).toContain('"t".user_id = :reader');
    expect(sql).toContain('SELECT ABS("ts".amount) / ABS(fx_cp.amount)');
    expect(sql).toContain('fx_cp.id = "ts".linked_transaction_id');
    expect(sql).toContain('fx_cp.user_id = "t".user_id');
    expect(sql).toContain('fx_cp.linked_transaction_id = "t".id');
    expect(sql).toContain("fx_cp.currency_code = :fx");
  });
});

describe("the transfer rate's reader", () => {
  it("is the authenticated person, a delegate's own id while acting", () => {
    expect(transferRateReader()).toBeUndefined();
    requestContextStorage.run({ userId: OWNER }, () => {
      expect(transferRateReader()).toBe(OWNER);
    });
    requestContextStorage.run({ userId: OWNER, realUserId: DELEGATE }, () => {
      expect(transferRateReader()).toBe(DELEGATE);
    });
    requestContextStorage.run({ system: true }, () => {
      expect(transferRateReader()).toBeUndefined();
    });
  });

  it("reads a raw read's transfer legs only on the reader's own ledger", () => {
    requestContextStorage.run({ userId: OWNER }, () => {
      expect(ownTransferLegs(OWNER, "$1")).toEqual({ readerParam: "$1" });
      expect(ownTransferLegs(OWNER, "$1", "ts")).toEqual({
        readerParam: "$1",
        splitAlias: "ts",
      });
    });
    // A delegate reading the owner's ledger keeps the market rate.
    requestContextStorage.run({ userId: OWNER, realUserId: DELEGATE }, () => {
      expect(ownTransferLegs(OWNER, "$1")).toBeUndefined();
    });
  });
});
