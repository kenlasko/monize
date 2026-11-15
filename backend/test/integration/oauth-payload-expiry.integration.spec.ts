import { DataSource } from "typeorm";

import {
  OAUTH_CLIENT_IDLE_TTL_SECONDS,
  PostgresAdapter,
  sweepOAuthPayloads,
} from "@/oauth/postgres.adapter";

import { INTEGRATION_TYPEORM_OPTIONS } from "../helpers/integration-setup";

/**
 * `oauth_payloads` no longer grows without bound (#2177).
 *
 * Against a real PostgreSQL because `expires_at` is a `TIMESTAMP` without zone
 * and the sweep and the client renewal compare it with a bound `Date`: a mock
 * proves the call, not that the comparison selects the rows it claims to
 * (`docs/verification-contract.md`).
 */
describe("oauth_payloads expiry (real PostgreSQL)", () => {
  let dataSource: DataSource;

  const expiryOf = async (id: string, model: string): Promise<Date | null> => {
    const rows: Array<{ expires_at: Date | null }> = await dataSource.query(
      "SELECT expires_at FROM oauth_payloads WHERE id = $1 AND model = $2",
      [id, model],
    );
    return rows[0]?.expires_at ?? null;
  };

  const setExpiry = (id: string, model: string, at: Date | null) =>
    dataSource.query(
      "UPDATE oauth_payloads SET expires_at = $3 WHERE id = $1 AND model = $2",
      [id, model, at],
    );

  beforeAll(async () => {
    dataSource = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query("DELETE FROM oauth_payloads");
  });

  it("stores a registered client with an expiry, and a later grant slides it forward", async () => {
    const clients = new PostgresAdapter("Client", dataSource);
    const tokens = new PostgresAdapter("RefreshToken", dataSource);

    // How oidc-provider registers a client: no expiresIn at all.
    await clients.upsert(
      "client-a",
      { client_id: "client-a" },
      undefined as never,
    );
    const registered = await expiryOf("client-a", "Client");
    expect(registered).not.toBeNull();

    // Close to expiring, then used.
    await setExpiry("client-a", "Client", new Date(Date.now() + 86_400_000));
    await tokens.upsert("rt-0", { clientId: "client-a" }, 3600);

    const renewed = await expiryOf("client-a", "Client");
    expect(renewed!.getTime()).toBeGreaterThan(
      Date.now() + (OAUTH_CLIENT_IDLE_TTL_SECONDS - 60) * 1000,
    );
    await expect(clients.find("client-a")).resolves.toMatchObject({
      client_id: "client-a",
    });
  });

  it("does not revive an expired client, nor rewrite a fresh one on every token", async () => {
    const clients = new PostgresAdapter("Client", dataSource);
    const tokens = new PostgresAdapter("RefreshToken", dataSource);
    await clients.upsert("expired", {}, undefined as never);
    await clients.upsert("fresh", {}, undefined as never);
    const past = new Date(Date.now() - 60_000);
    await setExpiry("expired", "Client", past);
    const freshExpiry = await expiryOf("fresh", "Client");

    await tokens.upsert("rt-1", { clientId: "expired" }, 3600);
    await tokens.upsert("rt-2", { clientId: "fresh" }, 3600);

    expect((await expiryOf("expired", "Client"))!.getTime()).toBe(
      past.getTime(),
    );
    await expect(clients.find("expired")).resolves.toBeUndefined();
    // Less than a day short of a full TTL: left as it was.
    expect((await expiryOf("fresh", "Client"))!.getTime()).toBe(
      freshExpiry!.getTime(),
    );
  });

  it("an interaction alone does not keep a client alive", async () => {
    const clients = new PostgresAdapter("Client", dataSource);
    const interactions = new PostgresAdapter("Interaction", dataSource);
    await clients.upsert("client-b", {}, undefined as never);
    const soon = new Date(Date.now() + 60_000);
    await setExpiry("client-b", "Client", soon);

    await interactions.upsert("int-1", { clientId: "client-b" }, 600);

    expect((await expiryOf("client-b", "Client"))!.getTime()).toBe(
      soon.getTime(),
    );
  });

  it("the sweep deletes exactly the rows find() already treats as gone", async () => {
    const interactions = new PostgresAdapter("Interaction", dataSource);
    const clients = new PostgresAdapter("Client", dataSource);
    await interactions.upsert("dead-int", {}, 600);
    await interactions.upsert("live-int", {}, 600);
    await clients.upsert("dead-client", {}, undefined as never);
    await clients.upsert("live-client", {}, undefined as never);
    const past = new Date(Date.now() - 1000);
    await setExpiry("dead-int", "Interaction", past);
    await setExpiry("dead-client", "Client", past);

    await expect(interactions.find("dead-int")).resolves.toBeUndefined();
    await expect(sweepOAuthPayloads(dataSource)).resolves.toEqual({
      adopted: 0,
      deleted: 2,
    });

    const left: Array<{ id: string }> = await dataSource.query(
      "SELECT id FROM oauth_payloads ORDER BY id",
    );
    expect(left.map((r) => r.id)).toEqual(["live-client", "live-int"]);
    // Idempotent: a second replica firing the same cron changes nothing.
    await expect(sweepOAuthPayloads(dataSource)).resolves.toEqual({
      adopted: 0,
      deleted: 0,
    });
  });

  it("gives a client stored before #2177 an expiry, which its next token then slides", async () => {
    // Every client registered before this change has expires_at NULL; without
    // adoption the clients a flood already left would never be swept.
    const clients = new PostgresAdapter("Client", dataSource);
    const grants = new PostgresAdapter("Grant", dataSource);
    await clients.upsert("legacy-idle", {}, undefined as never);
    await clients.upsert("legacy-used", {}, undefined as never);
    await setExpiry("legacy-idle", "Client", null);
    await setExpiry("legacy-used", "Client", null);

    await expect(sweepOAuthPayloads(dataSource)).resolves.toEqual({
      adopted: 2,
      deleted: 0,
    });
    const adopted = await expiryOf("legacy-idle", "Client");
    expect(adopted!.getTime()).toBeGreaterThan(
      Date.now() + (OAUTH_CLIENT_IDLE_TTL_SECONDS - 60) * 1000,
    );
    await expect(clients.find("legacy-used")).resolves.toBeDefined();

    // Thirty days on, the idle one is gone and the used one is not.
    await setExpiry("legacy-idle", "Client", new Date(Date.now() - 1000));
    await setExpiry("legacy-used", "Client", new Date(Date.now() + 3_600_000));
    await grants.upsert("grant-9", { clientId: "legacy-used" }, 3600);
    await expect(sweepOAuthPayloads(dataSource)).resolves.toEqual({
      adopted: 0,
      deleted: 1,
    });
    await expect(clients.find("legacy-used")).resolves.toBeDefined();
  });
});
