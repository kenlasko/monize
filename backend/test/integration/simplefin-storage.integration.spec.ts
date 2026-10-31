import { BankSyncConnection } from "@/bank-sync/entities/bank-sync-connection.entity";
import { ConfigService } from "@nestjs/config";
import { BankSyncCredentialsService } from "@/bank-sync/bank-sync-credentials.service";
import { BankSyncProviderRegistry } from "@/bank-sync/providers/bank-sync-provider.registry";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { BankSyncCredential } from "@/bank-sync/entities/bank-sync-credential.entity";
import { SimplefinCredentialsService } from "@/bank-sync/simplefin-credentials.service";
import { SimplefinRequestBudgetService } from "@/bank-sync/simplefin-request-budget.service";
import {
  simplefinAccessUrl,
  testEncryption,
} from "@/bank-sync/bank-sync-testing";
import {
  createEnforcedIntegrationModule,
  createTestUserDirect,
  type EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import { waitForLockWaiters } from "../helpers/race";

describe("SimpleFIN storage and quota under real PostgreSQL/RLS", () => {
  jest.setTimeout(180000);
  let harness: EnforcedIntegrationHarness;
  let service: SimplefinCredentialsService;
  let budget: SimplefinRequestBudgetService;
  let credentials: BankSyncCredentialsService;
  const resolve = (userId: string) =>
    credentials.resolveCredentials(userId, "simplefin");
  let alice: string;
  let bob: string;
  let credentialId: string;
  const accessWith = (secret: string) =>
    simplefinAccessUrl(
      "https://beta-bridge.simplefin.org/simplefin/test",
      "demo-user",
      secret,
    );
  const access = accessWith("demo-opaque");
  const rotatedAccess = accessWith("new-opaque");
  const otherAccess = accessWith("other-opaque");
  const scoped = <T>(userId: string, fn: () => Promise<T>) =>
    withUserContext(userId, fn);

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([]);
    budget = new SimplefinRequestBudgetService(harness.app);
    credentials = new BankSyncCredentialsService(
      harness.app,
      testEncryption(),
      new ConfigService(),
      {} as BankSyncProviderRegistry,
    );
    service = new SimplefinCredentialsService(
      harness.app,
      testEncryption(),
      budget,
    );
    alice = (
      await createTestUserDirect(harness.owner, {
        email: "simplefin-alice@example.com",
      })
    ).id;
    bob = (
      await createTestUserDirect(harness.owner, {
        email: "simplefin-bob@example.com",
      })
    ).id;
  });
  afterAll(async () => {
    if (harness) await harness.close();
  });
  beforeEach(async () => {
    await harness.owner.query("DELETE FROM bank_sync_connections");
    await harness.owner.query("DELETE FROM bank_sync_provider_requests");
    await harness.owner.query("DELETE FROM bank_sync_credentials");
    await scoped(alice, () => service.storeClaimedAccessUrl(alice, access));
    credentialId = (await scoped(alice, () => resolve(alice))).credentialId;
  });

  it("actually enforces RLS outside any scoped transaction", async () => {
    await scoped(alice, () => budget.reserve(alice, credentialId));
    expect(
      (await harness.owner.query("SELECT id FROM bank_sync_provider_requests"))
        .length,
    ).toBe(1);
    expect(
      await scoped(bob, () =>
        withScopedDb(harness.app, (m) =>
          m.query("SELECT id FROM bank_sync_provider_requests"),
        ),
      ),
    ).toEqual([]);
    expect(
      await harness.app.query("SELECT id FROM bank_sync_credentials"),
    ).toEqual([]);
    expect(
      await harness.app.query("SELECT id FROM bank_sync_provider_requests"),
    ).toEqual([]);
  });
  it("stores ciphertext and refuses another owner's read or request reservation", async () => {
    const rows = await harness.owner.query(
      "SELECT access_url_enc, private_key_enc, application_id FROM bank_sync_credentials WHERE id=$1",
      [credentialId],
    );
    expect(rows[0].access_url_enc).not.toContain("demo-opaque");
    expect(rows[0].private_key_enc).toBeNull();
    expect(rows[0].application_id).toBeNull();
    await expect(scoped(bob, () => resolve(alice))).rejects.toThrow();
    await expect(
      scoped(bob, () => budget.reserve(bob, credentialId)),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("allows exactly one of two workers to spend the final request slot", async () => {
    await harness.owner.query(
      "INSERT INTO bank_sync_provider_requests (user_id,credential_id) SELECT $1,$2 FROM generate_series(1,23)",
      [alice, credentialId],
    );
    const results = await Promise.all([
      scoped(alice, () => budget.reserve(alice, credentialId)),
      scoped(alice, () => budget.reserve(alice, credentialId)),
    ]);
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(results.every((result) => result.remaining === 0)).toBe(true);
    const rows = await harness.owner.query(
      "SELECT count(*)::int AS total FROM bank_sync_provider_requests WHERE credential_id=$1",
      [credentialId],
    );
    expect(rows[0].total).toBe(24);
  });
  it("replenishes expired reservations without using an application clock", async () => {
    await harness.owner.query(
      "INSERT INTO bank_sync_provider_requests (user_id,credential_id,requested_at) SELECT $1,$2,clock_timestamp()-INTERVAL '25 hours' FROM generate_series(1,24)",
      [alice, credentialId],
    );
    expect(
      await scoped(alice, () => budget.reserve(alice, credentialId)),
    ).toMatchObject({ allowed: true, remaining: 23, nextEligibleAt: null });
  });
  it("locks the owner before the credential, the order discovery takes them", async () => {
    // Discovery reconciles under users FOR UPDATE, then the credential FOR
    // UPDATE. A reservation that locked the credential first and reached the
    // users row only through its INSERT's foreign key closed a cycle with it
    // (40P01 on one side, seen in simplefin-discovery's concurrent case).
    const discovery = new Client({
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      user: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
    });
    await discovery.connect();
    try {
      await discovery.query("BEGIN");
      await discovery.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        alice,
      ]);
      const reservation = scoped(alice, () =>
        budget.reserve(alice, credentialId),
      );
      reservation.catch(() => undefined);
      await waitForLockWaiters(harness.owner, 1);
      await discovery.query(
        "SELECT id FROM bank_sync_credentials WHERE id=$1 FOR UPDATE",
        [credentialId],
      );
      await discovery.query("COMMIT");
      await expect(reservation).resolves.toMatchObject({ allowed: true });
    } finally {
      await discovery.query("ROLLBACK").catch(() => undefined);
      await discovery.end();
    }
  });
  it("refuses reservations in an outer transaction so HTTP cannot precede commit", async () => {
    await expect(
      scoped(alice, () =>
        withScopedDb(harness.app, () => budget.reserve(alice, credentialId)),
      ),
    ).rejects.toThrow("outside an active");
  });
  it("keeps the old credential when replacement was not confirmed", async () => {
    await expect(
      scoped(alice, () => service.storeClaimedAccessUrl(alice, rotatedAccess)),
    ).rejects.toMatchObject({ status: 409 });
    expect((await scoped(alice, () => resolve(alice))).accessUrl).toBe(access);
  });
  it("preserves the credential ID and spent budget across confirmed replacement", async () => {
    await scoped(alice, () => budget.reserve(alice, credentialId));
    await scoped(alice, () =>
      service.storeClaimedAccessUrl(alice, rotatedAccess, true),
    );
    expect((await scoped(alice, () => resolve(alice))).credentialId).toBe(
      credentialId,
    );
    expect(
      (await scoped(alice, () => service.status(alice))).quota?.remaining,
    ).toBe(23);
  });
  it("rejects a forged request owner even through the table-owner connection", async () => {
    await expect(
      harness.owner.query(
        "INSERT INTO bank_sync_provider_requests (user_id,credential_id) VALUES ($1,$2)",
        [bob, credentialId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("requires the correct credential shape in the database", async () => {
    await expect(
      harness.owner.query(
        "UPDATE bank_sync_credentials SET private_key_enc='not-a-simplefin-field' WHERE id=$1",
        [credentialId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (await scoped(alice, () => service.status(alice))).credentialSet,
    ).toBe(true);
  });
  it("removal cascades request state without deleting another provider's credentials", async () => {
    const connection = await harness.owner
      .getRepository(BankSyncConnection)
      .save({
        userId: alice,
        provider: "simplefin",
        institutionName: "Demo Bank",
        institutionCountry: "US",
        status: "active",
        autoSync: true,
        externalSessionId: "CON-DEMO",
      });
    await scoped(alice, () => budget.reserve(alice, credentialId));
    await harness.owner.query(
      "INSERT INTO bank_sync_credentials (user_id,provider,application_id,private_key_enc) VALUES ($1,'enable_banking','legacy-app','legacy-ciphertext')",
      [alice],
    );
    await scoped(alice, () => service.remove(alice));
    const kept = await harness.owner
      .getRepository(BankSyncConnection)
      .findOneByOrFail({ id: connection.id });
    expect(kept.autoSync).toBe(false);
    expect(kept.status).toBe("failed");
    expect(kept.externalSessionId).toBe("CON-DEMO");
    expect(
      (await scoped(alice, () => service.status(alice))).credentialSet,
    ).toBe(false);
    expect(
      await harness.owner.query("SELECT id FROM bank_sync_provider_requests"),
    ).toEqual([]);
    expect(
      await harness.owner.query("SELECT provider FROM bank_sync_credentials"),
    ).toEqual([{ provider: "enable_banking" }]);
  });
  it("prevents concurrent unconfirmed first saves from overwriting each other", async () => {
    await harness.owner
      .getRepository(BankSyncCredential)
      .delete({ userId: bob });
    const results = await Promise.allSettled([
      scoped(bob, () => service.storeClaimedAccessUrl(bob, access)),
      scoped(bob, () => service.storeClaimedAccessUrl(bob, otherAccess)),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  it("upgrades a legacy schema twice while retaining the existing Enable Banking ciphertext", async () => {
    const migrations = join(__dirname, "../../../database/migrations");
    const migration = readFileSync(
      join(
        migrations,
        readdirSync(migrations).find((file) =>
          file.endsWith("_simplefin_provider_credentials.sql"),
        )!,
      ),
      "utf8",
    );
    const old = readFileSync(
      join(
        migrations,
        readdirSync(migrations).find((file) =>
          file.endsWith("_bank_sync.sql"),
        )!,
      ),
      "utf8",
    );
    const ddl = (table: string) => {
      const match = new RegExp(
        "CREATE TABLE (?:IF NOT EXISTS )?" + table + "\\s*\\([\\s\\S]*?\\n\\);",
      ).exec(old);
      if (!match) throw new Error("Missing legacy table");
      return match[0];
    };
    const client = new Client({
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      user: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
    });
    await client.connect();
    try {
      await client.query("CREATE SCHEMA simplefin_upgrade_test");
      await client.query("SET search_path TO simplefin_upgrade_test,public");
      await client.query("CREATE TABLE users(id UUID PRIMARY KEY)");
      await client.query(ddl("bank_sync_credentials"));
      await client.query(ddl("bank_sync_connections"));
      await client.query("INSERT INTO users(id) VALUES ($1)", [alice]);
      await client.query(
        "INSERT INTO bank_sync_credentials(user_id,provider,application_id,private_key_enc) VALUES ($1,'enable_banking','legacy','unchanged-ciphertext')",
        [alice],
      );
      await client.query(migration);
      await client.query(migration);
      expect(
        (
          await client.query(
            "SELECT provider,application_id,private_key_enc,access_url_enc FROM bank_sync_credentials",
          )
        ).rows,
      ).toEqual([
        {
          provider: "enable_banking",
          application_id: "legacy",
          private_key_enc: "unchanged-ciphertext",
          access_url_enc: null,
        },
      ]);
    } finally {
      await client.query("SET search_path TO public");
      await client.query(
        "DROP SCHEMA IF EXISTS simplefin_upgrade_test CASCADE",
      );
      await client.end();
    }
  });
  it("admits complete multi-request reads atomically and prunes only expired quota", async () => {
    await harness.owner.query(
      "INSERT INTO bank_sync_provider_requests(user_id,credential_id) SELECT $1,$2 FROM generate_series(1,20)",
      [alice, credentialId],
    );
    const results = await Promise.all([
      scoped(alice, () => budget.reserve(alice, credentialId, 3)),
      scoped(alice, () => budget.reserve(alice, credentialId, 3)),
    ]);
    expect(results.filter((x) => x.allowed)).toHaveLength(1);
    expect(
      (
        await harness.owner.query(
          "SELECT COUNT(*)::int AS n FROM bank_sync_provider_requests WHERE credential_id=$1",
          [credentialId],
        )
      )[0].n,
    ).toBe(23);
    await harness.owner.query(
      "INSERT INTO bank_sync_provider_requests(user_id,credential_id,requested_at) VALUES($1,$2,clock_timestamp()-INTERVAL '25 hours')",
      [alice, credentialId],
    );
    await scoped(alice, () => budget.reserve(alice, credentialId));
    expect(
      (
        await harness.owner.query(
          "SELECT COUNT(*)::int AS n FROM bank_sync_provider_requests WHERE credential_id=$1",
          [credentialId],
        )
      )[0].n,
    ).toBe(24);
  });
  it("does not wait for a spending credential lock when polling status", async () => {
    const runner = harness.owner.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        "SELECT id FROM bank_sync_credentials WHERE id=$1 FOR UPDATE",
        [credentialId],
      );
      await expect(
        scoped(alice, () => budget.status(alice, credentialId)),
      ).resolves.toMatchObject({ remaining: 24 });
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
