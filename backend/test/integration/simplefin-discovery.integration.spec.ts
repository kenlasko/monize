import { createTestAccount } from "../helpers/test-factories";
import { ConfigService } from "@nestjs/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BankSyncCredentialsService } from "@/bank-sync/bank-sync-credentials.service";
import { BankSyncProviderRegistry } from "@/bank-sync/providers/bank-sync-provider.registry";
import { SimplefinCredentialsService } from "@/bank-sync/simplefin-credentials.service";
import { SimplefinRequestBudgetService } from "@/bank-sync/simplefin-request-budget.service";
import { SimplefinDiscoveryService } from "@/bank-sync/simplefin-discovery.service";
import { SimplefinClient } from "@/bank-sync/providers/simplefin/simplefin.client";
import { SimplefinTransportError } from "@/bank-sync/providers/simplefin/simplefin.transport";
import {
  simplefinAccessUrl,
  testEncryption,
} from "@/bank-sync/bank-sync-testing";
import { withUserContext } from "@/common/db/with-context";
import { getActiveScopedManager } from "@/common/db/scoped-db";
import {
  createEnforcedIntegrationModule,
  createTestUserDirect,
  type EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

type Demo = {
  accounts: Array<Record<string, unknown>>;
  connections: Array<Record<string, unknown>>;
  errlist: unknown[];
};
const demo = (): Demo =>
  JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        "src/bank-sync/providers/simplefin/fixtures/bridge-demo-v2.json",
      ),
      "utf8",
    ),
  ) as Demo;

describe("SimpleFIN discovery on PostgreSQL with enforced RLS", () => {
  let harness: EnforcedIntegrationHarness;
  let alice: string;
  let bob: string;
  let storage: SimplefinCredentialsService;
  let budget: SimplefinRequestBudgetService;
  let credentials: BankSyncCredentialsService;
  let service: SimplefinDiscoveryService;
  const client: jest.Mocked<Pick<SimplefinClient, "accounts">> = {
    accounts: jest.fn(),
  };
  const accessWith = (secret: string) =>
    simplefinAccessUrl(
      "https://bridge.simplefin.org/simplefin/test",
      "discovery-user",
      secret,
    );
  const access = accessWith("discovery-password");
  const rotatedAccess = accessWith("rotated-password");
  const replacementAccess = accessWith("new-password");
  const scoped = <T>(id: string, fn: () => Promise<T>) =>
    withUserContext(id, fn);
  const discover = () => scoped(alice, () => service.discover(alice));
  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([]);
    alice = (
      await createTestUserDirect(harness.owner, {
        email: "sf-discovery-alice@example.com",
      })
    ).id;
    bob = (
      await createTestUserDirect(harness.owner, {
        email: "sf-discovery-bob@example.com",
      })
    ).id;
    budget = new SimplefinRequestBudgetService(harness.app);
    storage = new SimplefinCredentialsService(
      harness.app,
      testEncryption(),
      budget,
    );
    credentials = new BankSyncCredentialsService(
      harness.app,
      testEncryption(),
      new ConfigService(),
      {} as BankSyncProviderRegistry,
    );
    service = new SimplefinDiscoveryService(
      harness.app,
      credentials,
      budget,
      client as unknown as SimplefinClient,
    );
  });
  afterAll(async () => {
    if (harness) await harness.close();
  });
  beforeEach(async () => {
    client.accounts.mockReset().mockResolvedValue(demo());
    await harness.owner.query("DELETE FROM bank_sync_connections");
    await harness.owner.query("DELETE FROM bank_sync_credentials");
    await scoped(alice, () => storage.storeClaimedAccessUrl(alice, access));
  });

  it("discovers the public demo without enabling sync or inventing account mappings", async () => {
    const result = await discover();
    expect(result.ok).toBe(true);
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].accounts).toHaveLength(3);
    expect(result.connections[0].accounts[0].balanceAt).toMatch(/^20/);
    const connections = await harness.owner.query(
      "SELECT * FROM bank_sync_connections WHERE user_id=$1",
      [alice],
    );
    expect(connections[0]).toMatchObject({
      provider: "simplefin",
      status: "active",
      auto_sync: false,
      valid_until: null,
      auth_state_hash: null,
      institution_country: "",
    });
    const accounts = await harness.owner.query(
      "SELECT account_id, sync_from_date FROM bank_sync_accounts WHERE user_id=$1",
      [alice],
    );
    expect(
      accounts.every(
        (row: { account_id: unknown; sync_from_date: unknown }) =>
          row.account_id === null && row.sync_from_date === null,
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("discovery-password");
    expect(JSON.stringify(result)).not.toContain("externalSessionId");
  });

  it("preserves local IDs, cut-offs and history on repeat discovery", async () => {
    const first = await discover();
    const id = first.connections[0].accounts[0].id;
    await harness.owner.query(
      "UPDATE bank_sync_accounts SET sync_from_date='2026-01-01', last_imported_count=7 WHERE id=$1",
      [id],
    );
    const second = await discover();
    expect(second.connections[0].id).toBe(first.connections[0].id);
    expect(second.connections[0].accounts.map((row) => row.id)).toEqual(
      first.connections[0].accounts.map((row) => row.id),
    );
    const rows = await harness.owner.query(
      "SELECT sync_from_date::text, last_imported_count FROM bank_sync_accounts WHERE id=$1",
      [id],
    );
    expect(rows[0]).toMatchObject({
      sync_from_date: "2026-01-01",
      last_imported_count: 7,
    });
  });

  it("preserves an actual linked Monize account through token rotation", async () => {
    const first = await discover();
    const bankId = first.connections[0].accounts[0].id;
    const local = await createTestAccount(harness.owner, alice, {
      currencyCode: "USD",
    });
    await harness.owner.query(
      "UPDATE bank_sync_accounts SET account_id=$1, sync_from_date='2026-01-01' WHERE id=$2",
      [local.id, bankId],
    );
    await scoped(alice, () =>
      storage.storeClaimedAccessUrl(alice, rotatedAccess, true),
    );
    const result = await discover();
    expect(result.connections[0].accounts[0].id).toBe(bankId);
    const rows = await harness.owner.query(
      "SELECT account_id, sync_from_date::text FROM bank_sync_accounts WHERE id=$1",
      [bankId],
    );
    expect(rows[0]).toMatchObject({
      account_id: local.id,
      sync_from_date: "2026-01-01",
    });
  });

  it("flags a linked account currency change and keeps the local mapping", async () => {
    const first = await discover();
    const bankId = first.connections[0].accounts[0].id;
    const local = await createTestAccount(harness.owner, alice, {
      currencyCode: "USD",
    });
    await harness.owner.query(
      "UPDATE bank_sync_accounts SET account_id=$1, sync_from_date='2026-01-01' WHERE id=$2",
      [local.id, bankId],
    );
    const payload = demo();
    payload.accounts[0].currency = "EUR";
    client.accounts.mockResolvedValue(payload);
    expect(await discover()).toMatchObject({
      ok: false,
      reviewRequired: true,
      errors: ["identity_review"],
    });
    const rows = await harness.owner.query(
      "SELECT account_id FROM bank_sync_accounts WHERE id=$1",
      [bankId],
    );
    expect(rows[0].account_id).toBe(local.id);
  });

  it("keeps another Bridge origin separate during reconnect", async () => {
    const first = await discover();
    await scoped(alice, () =>
      storage.storeClaimedAccessUrl(
        alice,
        access.replace("bridge.simplefin.org", "beta-bridge.simplefin.org"),
        true,
      ),
    );
    const result = await discover();
    expect(result).toMatchObject({ ok: false, reviewRequired: true });
    expect(result.connections[0].id).not.toBe(first.connections[0].id);
    expect(
      await harness.owner.query(
        "SELECT id FROM bank_sync_connections WHERE user_id=$1",
        [alice],
      ),
    ).toHaveLength(2);
  });

  it("serializes two concurrent discoveries without duplicate institutions or accounts", async () => {
    await Promise.all([discover(), discover()]);
    expect(
      await harness.owner.query(
        "SELECT id FROM bank_sync_connections WHERE user_id=$1",
        [alice],
      ),
    ).toHaveLength(1);
    expect(
      await harness.owner.query(
        "SELECT id FROM bank_sync_accounts WHERE user_id=$1",
        [alice],
      ),
    ).toHaveLength(3);
  });

  it("requires review when a provider identity changes and retains the old row", async () => {
    const first = await discover();
    const payload = demo();
    payload.accounts[0].id = "CHANGED-ID";
    client.accounts.mockResolvedValue(payload);
    const result = await discover();
    expect(result).toMatchObject({
      ok: false,
      reviewRequired: true,
      errors: expect.arrayContaining(["identity_review"]),
    });
    const rows = await harness.owner.query(
      "SELECT id, account_id FROM bank_sync_accounts WHERE user_id=$1",
      [alice],
    );
    expect(rows).toHaveLength(4);
    expect(
      rows.some(
        (row: { id: string }) => row.id === first.connections[0].accounts[0].id,
      ),
    ).toBe(true);
  });

  it("retains missing institutions and disables their automatic sync", async () => {
    await discover();
    client.accounts.mockResolvedValue({
      connections: [],
      accounts: [],
      errlist: [],
    });
    expect(await discover()).toMatchObject({ ok: false, reviewRequired: true });
    const rows = await harness.owner.query(
      "SELECT status, auto_sync FROM bank_sync_connections WHERE user_id=$1",
      [alice],
    );
    expect(rows[0]).toMatchObject({ status: "failed", auto_sync: false });
  });

  it("commits quota before network access and never keeps a transaction open during HTTP", async () => {
    client.accounts.mockImplementation(async () => {
      expect(getActiveScopedManager()).toBeUndefined();
      expect(
        await harness.owner.query(
          "SELECT id FROM bank_sync_provider_requests WHERE user_id=$1",
          [alice],
        ),
      ).toHaveLength(1);
      return demo();
    });
    await discover();
  });

  it.each([
    [401, "unauthorized"],
    [402, "payment_required"],
    [429, "rate_limited"],
    [503, "unavailable"],
  ] as const)(
    "reports HTTP %s safely and still spends its quota",
    async (status, expected) => {
      client.accounts.mockRejectedValue(
        new SimplefinTransportError("http", status),
      );
      expect(await discover()).toMatchObject({ ok: false, errors: [expected] });
      expect(
        await harness.owner.query(
          "SELECT id FROM bank_sync_provider_requests WHERE user_id=$1",
          [alice],
        ),
      ).toHaveLength(1);
    },
  );

  it("refuses further HTTP when rolling quota is exhausted", async () => {
    const credential = await scoped(alice, () =>
      credentials.resolveCredentials(alice, "simplefin"),
    );
    for (let i = 0; i < 24; i++)
      await scoped(alice, () => budget.reserve(alice, credential.credentialId));
    expect(await discover()).toMatchObject({
      ok: false,
      errors: ["rate_limited"],
    });
    expect(client.accounts).not.toHaveBeenCalled();
  });

  it("does not apply an old response after credential replacement", async () => {
    client.accounts.mockImplementation(async () => {
      await storage.storeClaimedAccessUrl(alice, replacementAccess, true);
      return demo();
    });
    expect(await discover()).toMatchObject({
      ok: false,
      errors: ["identity_review"],
    });
    expect(
      await harness.owner.query(
        "SELECT id FROM bank_sync_connections WHERE user_id=$1",
        [alice],
      ),
    ).toHaveLength(0);
  });

  it("does not resurrect connections after local credential removal during HTTP", async () => {
    client.accounts.mockImplementation(async () => {
      await storage.remove(alice);
      return demo();
    });
    expect(await discover()).toMatchObject({
      ok: false,
      errors: ["identity_review"],
    });
    expect(
      await harness.owner.query(
        "SELECT id FROM bank_sync_connections WHERE user_id=$1",
        [alice],
      ),
    ).toHaveLength(0);
  });

  it("never reads another owner's credential or spends their quota", async () => {
    await expect(
      scoped(bob, () => service.discover(bob)),
    ).rejects.toMatchObject({ status: 400 });
    expect(client.accounts).not.toHaveBeenCalled();
    expect(
      await harness.owner.query("SELECT id FROM bank_sync_provider_requests"),
    ).toHaveLength(0);
  });

  it("redacts credentials echoed in account and institution display names", async () => {
    const payload = demo();
    payload.accounts[0].name = "Echo discovery-password";
    payload.connections[0].name = "Echo discovery-user";
    client.accounts.mockResolvedValue(payload);
    const result = await discover();
    expect(JSON.stringify(result)).not.toContain("discovery-password");
    expect(JSON.stringify(result)).not.toContain("discovery-user");
    expect(result.connections[0].name).toContain("[redacted]");
  });

  it("refuses malformed and partial provider data without reporting an empty success", async () => {
    client.accounts.mockResolvedValue({ accounts: [], errors: [] });
    expect(await discover()).toMatchObject({
      ok: false,
      errors: ["invalid_response"],
    });
    const payload = demo();
    payload.errlist = [
      { code: "unknown.failure", message: "discovery-password" },
    ];
    client.accounts.mockResolvedValue(payload);
    expect(await discover()).toMatchObject({
      ok: false,
      errors: ["partial_data"],
    });
  });
  it("preserves an explicit stop through refresh, token rotation and absence", async () => {
    const first = await discover();
    const id = first.connections[0].id;
    await harness.owner.query(
      "UPDATE bank_sync_connections SET status='revoked',auto_sync=false WHERE id=$1",
      [id],
    );
    await discover();
    await scoped(alice, () =>
      storage.storeClaimedAccessUrl(alice, replacementAccess, true),
    );
    await discover();
    client.accounts.mockResolvedValue({
      connections: [],
      accounts: [],
      errlist: [],
    });
    await discover();
    expect(
      (
        await harness.owner.query(
          "SELECT status,auto_sync FROM bank_sync_connections WHERE id=$1",
          [id],
        )
      )[0],
    ).toMatchObject({ status: "revoked", auto_sync: false });
  });
  it.each([true, false])(
    "preserves desired daily sync %s through a transient error and recovery",
    async (desired) => {
      const first = await discover();
      const id = first.connections[0].id;
      await harness.owner.query(
        "UPDATE bank_sync_connections SET auto_sync=$1 WHERE id=$2",
        [desired, id],
      );
      const failed = demo();
      failed.errlist = [
        {
          code: "act.failed",
          account_id: failed.accounts[0].id,
          conn_id: failed.accounts[0].conn_id,
        },
      ];
      client.accounts.mockResolvedValue(failed);
      await discover();
      expect(
        (
          await harness.owner.query(
            "SELECT status,auto_sync FROM bank_sync_connections WHERE id=$1",
            [id],
          )
        )[0],
      ).toMatchObject({ status: "failed", auto_sync: desired });
      expect(
        await harness.owner.query(
          "SELECT id FROM bank_sync_connections WHERE id=$1 AND status='active' AND auto_sync=true",
          [id],
        ),
      ).toHaveLength(0);
      client.accounts.mockResolvedValue(demo());
      await discover();
      expect(
        (
          await harness.owner.query(
            "SELECT status,auto_sync FROM bank_sync_connections WHERE id=$1",
            [id],
          )
        )[0],
      ).toMatchObject({ status: "active", auto_sync: desired });
    },
  );
  it("keeps currency review blocked across three discoveries and withholds the foreign balance", async () => {
    const first = await discover();
    const id = first.connections[0].accounts[0].id;
    const local = await createTestAccount(harness.owner, alice, {
      currencyCode: "USD",
    });
    await harness.owner.query(
      "UPDATE bank_sync_accounts SET account_id=$1,sync_from_date='2026-01-01' WHERE id=$2",
      [local.id, id],
    );
    await harness.owner.query(
      "UPDATE bank_sync_connections SET auto_sync=true WHERE id=$1",
      [first.connections[0].id],
    );
    const changed = demo();
    changed.accounts[0].currency = "EUR";
    client.accounts.mockResolvedValue(changed);
    for (let n = 0; n < 3; n++) {
      expect(await discover()).toMatchObject({
        ok: false,
        reviewRequired: true,
      });
      expect(
        (
          await harness.owner.query(
            "SELECT currency_code,bank_balance FROM bank_sync_accounts WHERE id=$1",
            [id],
          )
        )[0],
      ).toMatchObject({ currency_code: "USD", bank_balance: null });
    }
    // Explicit unlink/review accepts fresh remote metadata without reusing the former mapping.
    await harness.owner.query(
      "UPDATE bank_sync_accounts SET account_id=NULL,sync_from_date=NULL WHERE id=$1",
      [id],
    );
    expect(await discover()).toMatchObject({ ok: true });
    expect(
      (
        await harness.owner.query(
          "SELECT currency_code FROM bank_sync_accounts WHERE id=$1",
          [id],
        )
      )[0].currency_code,
    ).toBe("EUR");
  });
});
