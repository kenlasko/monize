import type { DataSource } from "typeorm";
import { SimplefinProvider } from "./simplefin.provider";
import { SimplefinClient } from "./simplefin.client";
import { SimplefinTransportError } from "./simplefin.transport";
import { SimplefinRequestBudgetService } from "../../simplefin-request-budget.service";
import { simplefinAccountId } from "./simplefin.identity";
import { planBankImport } from "../../bank-transaction-planner";
import { createScopedDbMocks } from "../../../test-helpers/scoped-db-testing";
import { simplefinAccessUrl } from "../../bank-sync-testing";

jest.mock("../../../common/db/scoped-db", () =>
  jest
    .requireActual("../../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const origin = "https://bridge.simplefin.org";
const creds = {
  provider: "simplefin" as const,
  credentialId: "credential",
  accessUrl: simplefinAccessUrl(`${origin}/simplefin`, "user", "password"),
};
const range = { dateFrom: "2026-10-01", dateTo: "2026-10-19" };
const id = (account: string) => simplefinAccountId(origin, "con", account);
const tx = (over: Record<string, unknown> = {}) => ({
  id: "same-id",
  posted: Date.parse("2026-10-15T12:00:00Z") / 1000,
  amount: "-12.3456",
  description: "A purchase",
  ...over,
});
const payload = () => ({
  connections: [{ conn_id: "con", org_id: "org", name: "Bank" }],
  accounts: ["a", "b"].map((name) => ({
    id: name,
    conn_id: "con",
    name,
    currency: "USD",
    balance: "-50.2500",
    "balance-date": Date.parse("2026-10-19T12:00:00Z") / 1000,
    transactions: [tx()],
  })),
  errlist: [] as Array<Record<string, unknown>>,
});

describe("SimpleFIN operation-scoped batch reader", () => {
  const { dataSource, manager } = createScopedDbMocks();
  const budget: jest.Mocked<Pick<SimplefinRequestBudgetService, "reserve">> = {
    reserve: jest.fn(),
  };
  const client: jest.Mocked<Pick<SimplefinClient, "accounts">> = {
    accounts: jest.fn(),
  };
  const service = () =>
    new SimplefinProvider(
      dataSource as unknown as DataSource,
      budget as unknown as SimplefinRequestBudgetService,
      client as unknown as SimplefinClient,
    );
  beforeEach(() => {
    jest.clearAllMocks();
    client.accounts.mockReset();
    budget.reserve.mockReset();
    manager.query.mockResolvedValue([]);
    budget.reserve.mockResolvedValue({
      allowed: true,
      remaining: 23,
      nextEligibleAt: null,
    });
    client.accounts.mockResolvedValue(payload());
  });
  it("reads transactions and signed balance together with one quota reservation", async () => {
    const result = await service().readAccount("owner", creds, id("a"), range);
    expect(result.balance?.amount).toBe("-50.2500");
    expect(result.transactions[0]).toMatchObject({
      amount: "12.3456",
      direction: "debit",
    });
    expect(client.accounts).toHaveBeenCalledTimes(1);
    expect(budget.reserve).toHaveBeenCalledTimes(1);
  });
  it("shares one account set across accounts in the same operation", async () => {
    const reader = service();
    await reader.withReadContext("owner", [], async () => {
      await reader.readAccount("owner", creds, id("a"), range);
      await reader.readAccount("owner", creds, id("b"), range);
    });
    expect(client.accounts).toHaveBeenCalledTimes(1);
  });
  it("does not retain provider data between operations", async () => {
    const reader = service();
    await reader.readAccount("owner", creds, id("a"), range);
    await reader.readAccount("owner", creds, id("a"), range);
    expect(client.accounts).toHaveBeenCalledTimes(2);
  });
  it("does not share cached data after credential rotation", async () => {
    const reader = service();
    await reader.withReadContext("owner", [], async () => {
      await reader.readAccount("owner", creds, id("a"), range);
      await reader.readAccount(
        "owner",
        {
          ...creds,
          accessUrl: simplefinAccessUrl(
            `${origin}/simplefin`,
            "user",
            "rotated",
          ),
        },
        id("a"),
        range,
      );
    });
    expect(client.accounts).toHaveBeenCalledTimes(2);
  });
  it("refuses owner changes within an operation", async () => {
    const reader = service();
    await expect(
      reader.withReadContext("owner", [], () =>
        reader.readAccount("other", creds, id("a"), range),
      ),
    ).rejects.toThrow("owner changed");
    expect(client.accounts).not.toHaveBeenCalled();
  });
  it("completes all 45-day windows and refuses a later HTTP failure before returning any rows", async () => {
    client.accounts
      .mockResolvedValueOnce(payload())
      .mockRejectedValueOnce(new SimplefinTransportError("http", 503));
    await expect(
      service().readAccount("owner", creds, id("a"), {
        dateFrom: "2026-01-01",
        dateTo: "2026-04-01",
      }),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(client.accounts).toHaveBeenCalledTimes(2);
    for (const [, window] of client.accounts.mock.calls)
      expect(window!.endDate - window!.startDate).toBeLessThanOrEqual(
        45 * 86400,
      );
  });
  it("refuses exhausted quota before HTTP", async () => {
    budget.reserve.mockResolvedValue({
      allowed: false,
      remaining: 0,
      nextEligibleAt: null,
    });
    await expect(
      service().readAccount("owner", creds, id("a"), range),
    ).rejects.toMatchObject({ kind: "rate_limited" });
    expect(client.accounts).not.toHaveBeenCalled();
  });
  it("shares a failed read without automatically retrying it for another account", async () => {
    client.accounts.mockRejectedValue(new SimplefinTransportError("transport"));
    const reader = service();
    await reader.withReadContext("owner", [], async () => {
      await expect(
        reader.readAccount("owner", creds, id("a"), range),
      ).rejects.toThrow();
      await expect(
        reader.readAccount("owner", creds, id("b"), range),
      ).rejects.toThrow();
    });
    expect(client.accounts).toHaveBeenCalledTimes(1);
  });
  it("refuses missing transaction arrays but isolates malformed booked rows", async () => {
    const data = payload();
    (data.accounts[0] as Record<string, unknown>).transactions = undefined;
    client.accounts.mockResolvedValue(data);
    await expect(
      service().readAccount("owner", creds, id("a"), range),
    ).rejects.toMatchObject({ kind: "invalid_response" });
    data.accounts[0].transactions = [tx(), tx({ id: "" })];
    const read = await service().readAccount("owner", creds, id("a"), range);
    const plan = planBankImport(read.transactions, {
      accountCurrencyCode: "USD",
      syncFromDate: range.dateFrom,
      today: range.dateTo,
    });
    expect(plan.planned).toHaveLength(1);
    expect(plan.refused.missing_identity).toBe(1);
  });
  it("blocks only the affected account for a scoped provider error", async () => {
    const data = payload();
    data.errlist = [
      {
        code: "act.failed",
        conn_id: "con",
        account_id: "a",
        msg: "provider error",
      },
    ];
    client.accounts.mockResolvedValue(data);
    const reader = service();
    await reader.withReadContext("owner", [], async () => {
      await expect(
        reader.readAccount("owner", creds, id("a"), range),
      ).rejects.toThrow();
      await expect(
        reader.readAccount("owner", creds, id("b"), range),
      ).resolves.toMatchObject({ transactions: expect.any(Array) });
    });
  });
  it("refuses unknown global errors even with an empty account set", async () => {
    client.accounts.mockResolvedValue({
      connections: [],
      accounts: [],
      errlist: [{ code: "gen.unknown", msg: "secret-password" }],
    });
    await expect(
      service().readAccount("owner", creds, id("a"), range),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it("never returns missing account identities as empty success", async () => {
    await expect(
      service().readAccount("owner", creds, id("missing"), range),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it("keeps the provider key through the existing planner, scoped to its remote account", async () => {
    const reader = service();
    const a = await reader.readAccount("owner", creds, id("a"), range);
    const b = await reader.readAccount("owner", creds, id("b"), range);
    const context = {
      accountCurrencyCode: "USD",
      syncFromDate: range.dateFrom,
      today: range.dateTo,
    };
    const first = planBankImport(a.transactions, context).planned[0];
    expect(first.externalKey).toBe(a.transactions[0].externalKey);
    expect(first.externalKey).toMatch(/^simplefin:v1:[a-f0-9]{64}$/);
    expect(first.externalKey).not.toBe(
      planBankImport(b.transactions, context).planned[0].externalKey,
    );
    expect(first.amount).toBe(-12.3456);
  });
  it("counts pending rows without converting them into ledger transactions", async () => {
    const data = payload();
    data.accounts[0].transactions.push(tx({ pending: true }));
    client.accounts.mockResolvedValue(data);
    const result = await service().readAccount("owner", creds, id("a"), range);
    expect(result.pending).toBe(1);
    expect(result.transactions).toHaveLength(1);
  });
  it("shares a union window for accounts with different cutoffs and filters each account's rows", async () => {
    manager.query.mockResolvedValue([
      {
        sync_from_date: "2026-10-01",
        last_success_at: new Date("2026-10-10T12:00:00Z"),
      },
    ]);
    const reader = service();
    await reader.withReadContext("owner", ["one", "two"], async () => {
      const a = await reader.readAccount("owner", creds, id("a"), {
        dateFrom: "2026-10-10",
        dateTo: "2026-10-19",
      });
      const b = await reader.readAccount("owner", creds, id("b"), {
        dateFrom: "2026-10-16",
        dateTo: "2026-10-19",
      });
      expect(a.transactions).toHaveLength(1);
      expect(b.transactions).toHaveLength(0);
    });
    expect(client.accounts).toHaveBeenCalledTimes(1);
  });
  it("counts dated refusals only inside each account window, retaining undatable refusals", async () => {
    const data = payload();
    const rows = [
      tx({
        id: "early-refusal",
        amount: "bad",
        posted: Date.parse("2026-10-12T12:00:00Z") / 1000,
      }),
      tx({
        id: "inside-refusal",
        amount: "bad",
        posted: Date.parse("2026-10-17T12:00:00Z") / 1000,
      }),
      tx({ id: "undated-refusal", posted: 0 }),
      tx({
        id: "padded-refusal",
        amount: "bad",
        posted: Date.parse("2026-10-20T12:00:00Z") / 1000,
      }),
      tx({
        id: "inside-good",
        posted: Date.parse("2026-10-18T12:00:00Z") / 1000,
      }),
    ];
    data.accounts.forEach((account) => {
      account.transactions = rows;
    });
    client.accounts.mockResolvedValue(data);
    const reader = service();
    await reader.withReadContext("owner", ["one", "two"], async () => {
      const earlier = await reader.readAccount("owner", creds, id("a"), {
        dateFrom: "2026-10-10",
        dateTo: "2026-10-19",
      });
      const later = await reader.readAccount("owner", creds, id("b"), {
        dateFrom: "2026-10-16",
        dateTo: "2026-10-19",
      });
      expect(earlier.transactions).toHaveLength(4);
      expect(later.transactions).toHaveLength(3);
      expect(
        later.transactions.filter((row) => row.refusalReason !== undefined),
      ).toHaveLength(2);
      const next = await reader.readAccount("owner", creds, id("b"), {
        dateFrom: "2026-10-20",
        dateTo: "2026-10-21",
      });
      expect(
        next.transactions.filter(
          (row) => row.refusalReason === "invalid_amount",
        ),
      ).toHaveLength(1);
    });
  });
  it("redacts credentials echoed in transaction descriptions before preview or writing", async () => {
    const data = payload();
    data.accounts[0].transactions[0].description = "Echo " + creds.accessUrl;
    client.accounts.mockResolvedValue(data);
    const result = await service().readAccount("owner", creds, id("a"), range);
    expect(JSON.stringify(result.transactions)).not.toContain("password");
    expect(result.transactions[0].remittance[0]).toContain("[redacted]");
  });
  it("refuses amounts the number-based writer cannot preserve at four decimals", async () => {
    const data = payload();
    data.accounts[0].transactions[0].amount = "9999999999999999.9999";
    client.accounts.mockResolvedValue(data);
    const read = await service().readAccount("owner", creds, id("a"), range);
    const plan = planBankImport(read.transactions, {
      accountCurrencyCode: "USD",
      syncFromDate: range.dateFrom,
      today: range.dateTo,
    });
    expect(plan.planned).toHaveLength(0);
    expect(plan.refused.invalid_amount).toBe(1);
  });
});
