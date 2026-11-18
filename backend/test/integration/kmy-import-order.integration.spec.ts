import { DataSource } from "typeorm";
import { useKmyImportHarness } from "../helpers/kmy-import-harness";
import {
  kmyAccount,
  kmyFile,
  kmySecurity,
  kmySplit,
  kmyTransaction,
  kmyTxId,
  toKmyBytes,
} from "@/import/kmy/__fixtures__/kmy-xml-builders";

/**
 * S1: rows one import writes share `created_at`, so the canonical replay
 * (`INVESTMENT_REPLAY_ORDER`: date, created_at, id) breaks a same-day tie on
 * the row id. A same-day stock split and buy fold to different positions in
 * the two orders (100 shares, split 2:1, buy 10: 210; buy then split: 220),
 * so the ids must put the rows in KMyMoney's own order -- post date, then
 * transaction id (`MyMoneyTransaction::uniqueSortKey`) -- not in file order
 * and not in random order.
 */
describe("kmy import: same-day investment rows replay in KMyMoney's order (integration)", () => {
  const h = useKmyImportHarness();
  let dataSource: DataSource;
  let userId: string;

  beforeAll(() => {
    ({ dataSource, userId } = h);
  });

  // Ten holdings, so a random tie-break gets every one right with a chance
  // of 1 in 1024: the case is deterministic in practice before the fix.
  const HOLDINGS = 10;

  it("folds a same-day split and buy split first, by transaction id, whatever the file order", async () => {
    const stockId = (i: number) => `A${String(100 + i).padStart(6, "0")}`;
    const securityId = (i: number) => `E${String(i + 1).padStart(6, "0")}`;
    const accounts = [
      kmyAccount({ id: "A000001", name: "Brokerage Cash", type: 1 }),
      kmyAccount(
        { id: "A000002", name: "Broker", type: 7 },
        {
          subaccounts: Array.from({ length: HOLDINGS }, (_, i) => stockId(i)),
        },
      ),
      ...Array.from({ length: HOLDINGS }, (_, i) =>
        kmyAccount({
          id: stockId(i),
          name: `Stock ${i}`,
          type: 15,
          parentaccount: "A000002",
          currency: securityId(i),
        }),
      ),
    ];
    const securities = Array.from({ length: HOLDINGS }, (_, i) =>
      kmySecurity({
        id: securityId(i),
        name: `Stock ${i}`,
        symbol: `S${i}`,
      }),
    );
    const trade = (id: number, stock: string, date: string, shares: string) =>
      kmyTransaction(
        [
          kmySplit({
            id: "S0001",
            account: "A000001",
            value: `-${shares}/1`,
            shares: `-${shares}/1`,
          }),
          kmySplit({
            id: "S0002",
            account: stock,
            action: "Buy",
            value: `${shares}/1`,
            shares: `${shares}/1`,
            price: "1/1",
          }),
        ],
        { id: kmyTxId(id), postdate: date },
      );
    const split = (id: number, stock: string, date: string) =>
      kmyTransaction(
        [
          kmySplit({
            id: "S0001",
            account: stock,
            action: "Split",
            value: "0/1",
            shares: "2/1",
          }),
        ],
        { id: kmyTxId(id), postdate: date },
      );

    const transactions = Array.from({ length: HOLDINGS }, (_, i) => [
      trade(1000 + i, stockId(i), "2024-01-02", "100"),
      // In the file the buy comes first, but its id is the larger: KMyMoney
      // orders the split (smaller id) first.
      trade(3000 + i, stockId(i), "2024-03-01", "10"),
      split(2000 + i, stockId(i), "2024-03-01"),
    ]).flat();

    const job = await h.runKmy(
      toKmyBytes(kmyFile({ accounts, securities, transactions }), "gzip"),
    );
    expect(job.status).toBe("completed");

    const held: { symbol: string; quantity: string }[] = await dataSource.query(
      `SELECT s.symbol, h.quantity FROM holdings h
         JOIN securities s ON s.id = h.security_id
         JOIN accounts a ON a.id = h.account_id
        WHERE a.user_id = $1 ORDER BY s.symbol`,
      [userId],
    );
    expect(held.map((row) => [row.symbol, Number(row.quantity)])).toEqual(
      Array.from({ length: HOLDINGS }, (_, i) => [`S${i}`, 210]),
    );
    // The file side, the mapped replay and the database all agree.
    expect(job.result!.holdings).toHaveLength(HOLDINGS);
    for (const line of job.result!.holdings) {
      expect([line.symbol, line.lotQuantity, line.importedQuantity]).toEqual([
        line.symbol,
        210,
        210,
      ]);
    }
    expect(job.result!.warnings.map((warning) => warning.code)).not.toContain(
      "holdingsReplayDiffers",
    );
  });
});
