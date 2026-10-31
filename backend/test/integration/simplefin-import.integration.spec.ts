import {
  requestContextStorage,
  getRequestTimezone,
} from "@/common/request-context";
import { BankSyncConnectionsService } from "@/bank-sync/bank-sync-connections.service";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { BankSyncModule } from "@/bank-sync/bank-sync.module";
import { BankSyncService } from "@/bank-sync/bank-sync.service";
import { BankSyncCronService } from "@/bank-sync/bank-sync-cron.service";
import { SimplefinDiscoveryService } from "@/bank-sync/simplefin-discovery.service";
import { SimplefinCredentialsService } from "@/bank-sync/simplefin-credentials.service";
import { SimplefinClient } from "@/bank-sync/providers/simplefin/simplefin.client";
import { SimplefinTransportError } from "@/bank-sync/providers/simplefin/simplefin.transport";
import { AccountType } from "@/accounts/entities/account.entity";
import { withUserContext } from "@/common/db/with-context";
import { addDaysYMD, todayYMD } from "@/common/date-utils";
import { simplefinAccessUrl } from "@/bank-sync/bank-sync-testing";
import { createTestAccount } from "../helpers/test-factories";
import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  type EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

describe("SimpleFIN through the real preview, planner, writer and scheduler", () => {
  jest.setTimeout(180000);
  let harness: EnforcedIntegrationHarness;
  let sync: BankSyncService;
  let discovery: SimplefinDiscoveryService;
  let storage: SimplefinCredentialsService;
  let client: SimplefinClient;
  let userId: string;
  let localId: string;
  let bankId: string;
  let connectionId: string;
  let oldKey: string | undefined;
  const today = todayYMD();
  const date = addDaysYMD(today, -1);
  const scope = <T>(run: () => Promise<T>) => withUserContext(userId, run);
  const accessWith = (secret: string) =>
    simplefinAccessUrl(
      "https://bridge.simplefin.org/simplefin/test",
      "writer-user",
      secret,
    );
  const access = accessWith("writer-opaque");
  const rotatedAccess = accessWith("rotated");
  const payload = () => ({
    connections: [{ conn_id: "bank", org_id: "org", name: "US Bank" }],
    accounts: ["checking", "card"].map((id) => ({
      id,
      conn_id: "bank",
      name: id,
      currency: "USD",
      balance: id === "card" ? "-60.0000" : "1200.5000",
      "balance-date": Date.parse(today + "T12:00:00Z") / 1000,
      transactions: [
        {
          id: "shared-id",
          posted: Date.parse(date + "T12:00:00Z") / 1000,
          amount: id === "card" ? "-60.0000" : "12.3456",
          description: id + " posted",
        },
        {
          id: "pending-id",
          pending: true,
          posted: 0,
          amount: "-5.00",
          description: "Pending",
        },
      ],
    })),
    errlist: [] as Array<Record<string, unknown>>,
  });
  const confirm = async (id = bankId) => {
    const preview = await scope(() => sync.previewAccount(userId, id, null));
    return scope(() =>
      sync.syncAccount(userId, id, null, preview.planFingerprint),
    );
  };
  const count = async (table: string) =>
    Number(
      (await harness.owner.query("SELECT COUNT(*)::int AS n FROM " + table))[0]
        .n,
    );
  beforeAll(async () => {
    oldKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "simplefin-writer-integration-key-0123456789";
    harness = await createEnforcedIntegrationModule([BankSyncModule]);
    sync = harness.module.get(BankSyncService);
    discovery = harness.module.get(SimplefinDiscoveryService);
    storage = harness.module.get(SimplefinCredentialsService);
    client = harness.module.get(SimplefinClient);
  });
  afterAll(async () => {
    if (harness) await harness.close();
    if (oldKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = oldKey;
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    jest
      .spyOn(
        harness.module.get(NetWorthService, { strict: false }),
        "triggerDebouncedRecalc",
      )
      .mockImplementation(() => {});
    await cleanTables(harness.owner, [
      "bank_sync_imported_transactions",
      "bank_sync_accounts",
      "bank_sync_connections",
      "bank_sync_provider_requests",
      "bank_sync_credentials",
      "job_claims",
      "transaction_rule_applications",
      "transaction_rules",
      "transaction_tags",
      "tags",
      "action_history",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await harness.owner.query(
      "INSERT INTO currencies(code,name,symbol,decimal_places) VALUES('USD','US Dollar','$',2),('EUR','Euro','E',2) ON CONFLICT DO NOTHING",
    );
    userId = (
      await createTestUserDirect(harness.owner, {
        email: "sf-writer@example.com",
      })
    ).id;
    localId = (
      await createTestAccount(harness.owner, userId, {
        currencyCode: "USD",
        openingBalance: 100,
        currentBalance: 100,
      })
    ).id;
    jest.spyOn(client, "accounts").mockImplementation(async () => payload());
    await scope(() => storage.storeClaimedAccessUrl(userId, access));
    const found = await scope(() => discovery.discover(userId));
    connectionId = found.connections[0].id;
    bankId = found.connections[0].accounts.find(
      (a) => a.name === "checking",
    )!.id;
    await scope(() =>
      sync.linkAccount(userId, bankId, {
        accountId: localId,
        syncFromDate: addDaysYMD(today, -30),
      }),
    );
  });

  it("previews before writing, imports the confirmed plan, then imports zero duplicates", async () => {
    const preview = await scope(() =>
      sync.previewAccount(userId, bankId, null),
    );
    expect(preview.summary).toMatchObject({ new: 1, pending: 1 });
    expect(await count("transactions")).toBe(0);
    expect(preview.rows.find((r) => r.outcome === "new")?.externalKey).toMatch(
      /^simplefin:v1:[a-f0-9]{64}$/,
    );
    expect(
      await scope(() =>
        sync.syncAccount(userId, bankId, null, preview.planFingerprint),
      ),
    ).toMatchObject({ imported: 1, pending: 1 });
    expect(
      await scope(() => sync.syncAccount(userId, bankId, null)),
    ).toMatchObject({ imported: 0, skipped: 1 });
    const [row] = await harness.owner.query(
      "SELECT amount::text FROM transactions WHERE account_id=$1",
      [localId],
    );
    expect(Number(row.amount)).toBe(12.3456);
    expect(await count("bank_sync_imported_transactions")).toBe(1);
  });

  it("persists the source balance timestamp through discovery, import and later connection reads", async () => {
    const connections = harness.module.get(BankSyncConnectionsService);
    const sourceTime = today + "T12:00:00.000Z";
    const read = async () =>
      (await scope(() => connections.list(userId)))
        .find((connection) => connection.id === connectionId)!
        .accounts.find((account) => account.id === bankId)!;
    expect((await read()).bankBalanceAt).toBe(sourceTime);
    await harness.owner.query(
      "UPDATE bank_sync_accounts SET bank_balance_at=NULL WHERE id=$1",
      [bankId],
    );
    await confirm();
    expect((await read()).bankBalanceAt).toBe(sourceTime);
    const [stored] = await harness.owner.query(
      "SELECT bank_balance_at FROM bank_sync_accounts WHERE id=$1",
      [bankId],
    );
    expect(stored.bank_balance_at.toISOString()).toBe(sourceTime);
  });

  it("refuses first import without the required preview confirmation", async () => {
    await expect(
      scope(() => sync.syncAccount(userId, bankId, null)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("transactions")).toBe(0);
  });

  it("shares a single daily read across checking and card accounts after their first previews", async () => {
    const found = await scope(() => discovery.discover(userId));
    const card = found.connections[0].accounts.find((a) => a.name === "card")!;
    const localCard = await createTestAccount(harness.owner, userId, {
      accountType: AccountType.CREDIT_CARD,
      currencyCode: "USD",
      openingBalance: 0,
      currentBalance: 0,
    });
    await scope(() =>
      sync.linkAccount(userId, card.id, {
        accountId: localCard.id,
        syncFromDate: addDaysYMD(today, -30),
      }),
    );
    await confirm();
    await confirm(card.id);
    await harness.owner.query(
      "UPDATE bank_sync_connections SET auto_sync=true WHERE id=$1",
      [connectionId],
    );
    jest.mocked(client.accounts).mockClear();
    await harness.module.get(BankSyncCronService).handleDailySync();
    expect(client.accounts).toHaveBeenCalledTimes(1);
    const [row] = await harness.owner.query(
      "SELECT current_balance::text FROM accounts WHERE id=$1",
      [localCard.id],
    );
    expect(Number(row.current_balance)).toBe(-60);
    expect(await count("bank_sync_imported_transactions")).toBe(2);
  });

  it("does not import any partial backfill or advance success when a later window fails", async () => {
    const localScope = <T>(run: () => Promise<T>) =>
      scope(() =>
        requestContextStorage.run({ userId, timezone: "America/Toronto" }, run),
      );
    await localScope(() =>
      sync.linkAccount(userId, bankId, {
        accountId: localId,
        syncFromDate: addDaysYMD(today, -120),
      }),
    );
    const preview = await localScope(() =>
      sync.previewAccount(userId, bankId, null),
    );
    jest
      .mocked(client.accounts)
      .mockReset()
      .mockResolvedValueOnce(payload())
      .mockRejectedValueOnce(new SimplefinTransportError("http", 503));
    await expect(
      localScope(() =>
        sync.syncAccount(userId, bankId, null, preview.planFingerprint),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(await count("transactions")).toBe(0);
    const [row] = await harness.owner.query(
      "SELECT last_success_at FROM bank_sync_accounts WHERE id=$1",
      [bankId],
    );
    expect(row.last_success_at).toBeNull();
  });

  it("keeps ledger identity across token rotation and changed transaction descriptions", async () => {
    await confirm();
    await scope(() =>
      storage.storeClaimedAccessUrl(userId, rotatedAccess, true),
    );
    jest.mocked(client.accounts).mockImplementation(async () => {
      const data = payload();
      data.accounts[0].transactions[0].description = "Description changed";
      return data;
    });
    expect(
      await scope(() => sync.syncAccount(userId, bankId, null)),
    ).toMatchObject({ imported: 0, skipped: 1 });
    expect(await count("transactions")).toBe(1);
  });

  it("keeps a removed ledger transaction tombstone from being reimported", async () => {
    await confirm();
    await harness.owner.query("DELETE FROM transactions WHERE account_id=$1", [
      localId,
    ]);
    expect(
      await scope(() => sync.syncAccount(userId, bankId, null)),
    ).toMatchObject({ imported: 0, skipped: 1 });
    expect(await count("transactions")).toBe(0);
  });

  it("refuses a currency mismatch before linking an account", async () => {
    const euro = await createTestAccount(harness.owner, userId, {
      currencyCode: "EUR",
    });
    await expect(
      scope(() => sync.linkAccount(userId, bankId, { accountId: euro.id })),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("refuses a changed plan after preview without writing anything", async () => {
    const view = await scope(() => sync.previewAccount(userId, bankId, null));
    jest.mocked(client.accounts).mockImplementation(async () => {
      const data = payload();
      data.accounts[0].transactions[0].amount = "99.0000";
      return data;
    });
    await expect(
      scope(() => sync.syncAccount(userId, bankId, null, view.planFingerprint)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("transactions")).toBe(0);
  });

  it("lets only one concurrent confirmation write a ledger row", async () => {
    const view = await scope(() => sync.previewAccount(userId, bankId, null));
    const attempts = await Promise.allSettled([
      scope(() => sync.syncAccount(userId, bankId, null, view.planFingerprint)),
      scope(() => sync.syncAccount(userId, bankId, null, view.planFingerprint)),
    ]);
    expect(attempts.some((a) => a.status === "fulfilled")).toBe(true);
    expect(await count("transactions")).toBe(1);
    expect(await count("bank_sync_imported_transactions")).toBe(1);
  });
  it("does not advance success when Bridge changes the linked account currency", async () => {
    await confirm();
    const [before] = await harness.owner.query(
      "SELECT last_success_at FROM bank_sync_accounts WHERE id=$1",
      [bankId],
    );
    jest.mocked(client.accounts).mockImplementation(async () => {
      const data = payload();
      data.accounts[0].currency = "EUR";
      return data;
    });
    await expect(
      scope(() => sync.syncAccount(userId, bankId, null)),
    ).rejects.toMatchObject({ status: 400 });
    const [after] = await harness.owner.query(
      "SELECT last_success_at FROM bank_sync_accounts WHERE id=$1",
      [bankId],
    );
    expect(after.last_success_at).toEqual(before.last_success_at);
    expect(await count("transactions")).toBe(1);
  });
  it("stops an institution without deleting mappings, history or the import ledger", async () => {
    await confirm();
    jest.mocked(client.accounts).mockClear();
    await scope(() =>
      harness.module
        .get(BankSyncConnectionsService)
        .disconnect(userId, connectionId),
    );
    expect(client.accounts).not.toHaveBeenCalled();
    expect(await count("bank_sync_accounts")).toBe(2);
    expect(await count("bank_sync_imported_transactions")).toBe(1);
    expect(await count("transactions")).toBe(1);
    const [row] = await harness.owner.query(
      "SELECT status,auto_sync FROM bank_sync_connections WHERE id=$1",
      [connectionId],
    );
    expect(row).toMatchObject({ status: "revoked", auto_sync: false });
  });
  it("imports good rows around bad rows and keeps refusal counts visible and fingerprinted", async () => {
    const data = payload();
    data.accounts[0].transactions.push(
      { id: "bad-date", posted: 0, amount: "5.00", description: "bad date" },
      {
        id: "bad-precision",
        posted: Date.parse(date + "T12:00:00Z") / 1000,
        amount: "5.12345",
        description: "bad precision",
      },
      {
        id: "",
        posted: Date.parse(date + "T12:00:00Z") / 1000,
        amount: "5.00",
        description: "bad identity",
      },
    );
    jest.mocked(client.accounts).mockResolvedValue(data);
    const preview = await scope(() =>
      sync.previewAccount(userId, bankId, null),
    );
    expect(preview.summary).toMatchObject({
      new: 1,
      refused: 3,
      refusedByReason: {
        missing_date: 1,
        invalid_amount: 1,
        missing_identity: 1,
      },
    });
    const result = await scope(() =>
      sync.syncAccount(userId, bankId, null, preview.planFingerprint),
    );
    expect(result).toMatchObject({
      imported: 1,
      refused: { missing_date: 1, invalid_amount: 1, missing_identity: 1 },
    });
    expect((await confirm()).imported).toBe(0);
    data.accounts[0].transactions.pop();
    const changed = await scope(() =>
      sync.previewAccount(userId, bankId, null),
    );
    data.accounts[0].transactions.pop();
    await expect(
      scope(() =>
        sync.syncAccount(userId, bankId, null, changed.planFingerprint),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("refuses confirmation if the history cursor changes during the provider read", async () => {
    await scope(() =>
      sync.linkAccount(userId, bankId, {
        accountId: localId,
        syncFromDate: addDaysYMD(today, -100),
      }),
    );
    const preview = await scope(() =>
      sync.previewAccount(userId, bankId, null),
    );
    const newerCursor = preview.history!.dateTo;
    jest.mocked(client.accounts).mockImplementationOnce(async () => {
      await harness.owner.query(
        "UPDATE bank_sync_accounts SET backfill_through=$2 WHERE id=$1",
        [bankId, newerCursor],
      );
      return payload();
    });
    await expect(
      scope(() =>
        sync.syncAccount(userId, bankId, null, preview.planFingerprint),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("transactions")).toBe(0);
    expect(await count("bank_sync_imported_transactions")).toBe(0);
    const [row] = await harness.owner.query(
      "SELECT backfill_through::text,last_success_at FROM bank_sync_accounts WHERE id=$1",
      [bankId],
    );
    expect(row.backfill_through).toBe(newerCursor);
    expect(row.last_success_at).toBeNull();
  });
  it("resumes two year-long histories after quota replenishes without restarting committed batches", async () => {
    const start = addDaysYMD(today, -365);
    const data = payload();
    for (const remote of data.accounts)
      remote.transactions = Array.from({ length: 366 }, (_, n) => ({
        id: "history-" + n,
        posted: Date.parse(addDaysYMD(start, n) + "T12:00:00Z") / 1000,
        amount: "1.0000",
        description: "History row",
      }));
    jest.mocked(client.accounts).mockResolvedValue(data);
    const card = (
      await harness.owner.query(
        "SELECT id FROM bank_sync_accounts WHERE connection_id=$1 AND id<>$2",
        [connectionId, bankId],
      )
    )[0].id;
    const cardLocal = await createTestAccount(harness.owner, userId, {
      currencyCode: "USD",
    });
    await scope(() =>
      sync.linkAccount(userId, card, {
        accountId: cardLocal.id,
        syncFromDate: start,
      }),
    );
    await scope(() =>
      sync.linkAccount(userId, bankId, {
        accountId: localId,
        syncFromDate: start,
      }),
    );
    let replenishments = 0;
    for (const id of [bankId, card]) {
      for (let batch = 0; batch < 9; batch++) {
        const before = (
          await harness.owner.query(
            "SELECT backfill_through::text,last_success_at FROM bank_sync_accounts WHERE id=$1",
            [id],
          )
        )[0];
        let preview;
        try {
          preview = await scope(() => sync.previewAccount(userId, id, null));
        } catch {
          expect(
            (
              await harness.owner.query(
                "SELECT backfill_through::text FROM bank_sync_accounts WHERE id=$1",
                [id],
              )
            )[0].backfill_through,
          ).toBe(before.backfill_through);
          await harness.owner.query(
            "UPDATE bank_sync_provider_requests SET requested_at=clock_timestamp()-INTERVAL '25 hours' WHERE user_id=$1",
            [userId],
          );
          replenishments++;
          preview = await scope(() => sync.previewAccount(userId, id, null));
        }
        expect(preview.history?.remaining).toBe(batch < 8);
        try {
          await scope(() =>
            sync.syncAccount(userId, id, null, preview.planFingerprint),
          );
        } catch (error) {
          expect(error).toMatchObject({ status: 429 });
          expect(
            (
              await harness.owner.query(
                "SELECT backfill_through::text FROM bank_sync_accounts WHERE id=$1",
                [id],
              )
            )[0].backfill_through,
          ).toBe(before.backfill_through);
          await harness.owner.query(
            "UPDATE bank_sync_provider_requests SET requested_at=clock_timestamp()-INTERVAL '25 hours' WHERE user_id=$1",
            [userId],
          );
          replenishments++;
          await scope(() =>
            sync.syncAccount(userId, id, null, preview.planFingerprint),
          );
        }
        const row = (
          await harness.owner.query(
            "SELECT backfill_through::text,last_success_at FROM bank_sync_accounts WHERE id=$1",
            [id],
          )
        )[0];
        if (batch < 8) {
          expect(row.last_success_at).toBeNull();
          expect(row.backfill_through).toBe(preview.history!.dateTo);
        } else {
          expect(row.backfill_through).toBeNull();
          expect(row.last_success_at).not.toBeNull();
        }
      }
    }
    expect(replenishments).toBeGreaterThan(0);
    expect(await count("bank_sync_imported_transactions")).toBe(732);
    expect(await count("transactions")).toBe(732);
  });
  it("explicitly resumes a stopped institution without re-enabling daily sync", async () => {
    const connections = harness.module.get(BankSyncConnectionsService);
    await scope(() => connections.disconnect(userId, connectionId));
    await scope(() => discovery.discover(userId));
    expect(
      (
        await harness.owner.query(
          "SELECT status FROM bank_sync_connections WHERE id=$1",
          [connectionId],
        )
      )[0].status,
    ).toBe("revoked");
    await scope(() =>
      connections.updateConnection(userId, connectionId, { resume: true }),
    );
    expect(
      (
        await harness.owner.query(
          "SELECT status,auto_sync FROM bank_sync_connections WHERE id=$1",
          [connectionId],
        )
      )[0],
    ).toMatchObject({ status: "active", auto_sync: false });
  });
  it.each([true, false])(
    "cron honors preserved daily-sync preference %s after provider recovery",
    async (desired) => {
      await confirm();
      await harness.owner.query(
        "UPDATE bank_sync_connections SET auto_sync=$1 WHERE id=$2",
        [desired, connectionId],
      );
      const failed = payload();
      failed.errlist = [
        { code: "act.failed", conn_id: "bank", account_id: "checking" },
      ];
      jest.mocked(client.accounts).mockResolvedValue(failed);
      await scope(() => discovery.discover(userId));
      jest.mocked(client.accounts).mockClear();
      await harness.module.get(BankSyncCronService).handleDailySync();
      expect(client.accounts).not.toHaveBeenCalled();
      jest.mocked(client.accounts).mockResolvedValue(payload());
      await scope(() => discovery.discover(userId));
      jest.mocked(client.accounts).mockClear();
      await harness.module.get(BankSyncCronService).handleDailySync();
      expect(jest.mocked(client.accounts).mock.calls.length > 0).toBe(desired);
    },
  );
  it("uses the same stored financial timezone in manual and scheduled reads", async () => {
    await harness.owner.query(
      "INSERT INTO user_preferences(user_id,timezone,language) VALUES($1,'America/Toronto','de') ON CONFLICT(user_id) DO UPDATE SET timezone='America/Toronto',language='de'",
      [userId],
    );
    const zones: Array<string | undefined> = [];
    jest.mocked(client.accounts).mockImplementation(async () => {
      zones.push(getRequestTimezone());
      return payload();
    });
    const local = () =>
      requestContextStorage.run(
        { userId, timezone: "America/Toronto" },
        async () => {
          const preview = await sync.previewAccount(userId, bankId, null);
          await sync.syncAccount(userId, bankId, null, preview.planFingerprint);
        },
      );
    await local();
    await harness.owner.query(
      "UPDATE bank_sync_connections SET auto_sync=true WHERE id=$1",
      [connectionId],
    );
    await harness.module.get(BankSyncCronService).handleDailySync();
    expect(zones.length).toBeGreaterThan(2);
    expect(zones.every((zone) => zone === "America/Toronto")).toBe(true);
  });
});
