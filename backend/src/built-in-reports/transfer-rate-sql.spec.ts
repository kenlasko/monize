import { transferLegAliases, transferRateSql } from "./transfer-rate-sql";

describe("transferRateSql", () => {
  const norm = (sql: string) => sql.replace(/\s+/g, " ");

  it("reads a whole leg's mirror leg, or the split line linking back, on the reader's ledger", () => {
    const sql = norm(transferRateSql("$4::text", { transactionAlias: "t" }));

    expect(sql).toContain('WHEN "t".is_transfer AND "t".is_split IS NOT TRUE');
    expect(sql).toContain('"t".currency_code <> $4::text');
    expect(sql).toContain('SELECT ABS("t".amount) / ABS(fx_cp.amount)');
    // The mirror leg must point back, and only the reader's own rows answer.
    expect(sql).toContain('fx_leg.id = "t".linked_transaction_id');
    expect(sql).toContain('fx_leg.user_id = "t".user_id');
    expect(sql).toContain('fx_leg.linked_transaction_id = "t".id');
    // A split parent answers with its own line, never its whole amount.
    expect(sql).toContain('fx_line.linked_transaction_id = "t".id');
    expect(sql).toContain("fx_line.transfer_account_id IS NOT NULL");
    expect(sql).toContain("fx_cp.currency_code = $4::text");
    expect(sql).toContain('SIGN(fx_cp.amount) <> SIGN("t".amount)');
  });

  it("reads a split's transfer line at its counterpart row", () => {
    const sql = norm(
      transferRateSql(":fx", { transactionAlias: "t", splitAlias: "ts" }),
    );

    expect(sql).toContain('WHEN "ts".transfer_account_id IS NOT NULL');
    expect(sql).toContain('SELECT ABS("ts".amount) / ABS(fx_cp.amount)');
    expect(sql).toContain('fx_cp.id = "ts".linked_transaction_id');
    expect(sql).toContain('fx_cp.user_id = "t".user_id');
    expect(sql).toContain('fx_cp.linked_transaction_id = "t".id');
    expect(sql).toContain("fx_cp.currency_code = :fx");
  });

  it("names the aliases a read's legs sit on", () => {
    expect(transferLegAliases("t", "rows")).toEqual({ transactionAlias: "t" });
    expect(transferLegAliases("t", { splitAlias: "ts" })).toEqual({
      transactionAlias: "t",
      splitAlias: "ts",
    });
  });
});
