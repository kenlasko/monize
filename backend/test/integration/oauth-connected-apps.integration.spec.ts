import { DataSource } from "typeorm";

import {
  PostgresAdapter,
  findGrantsForAccount,
  revokeGrantForAccount,
} from "@/oauth/postgres.adapter";

import { INTEGRATION_TYPEORM_OPTIONS } from "../helpers/integration-setup";

/**
 * Settings > Connected apps reads and revokes one account's OAuth grants
 * (GHSA-vmgq-326p-fprx).
 *
 * Against a real PostgreSQL because both queries select by a JSON path in
 * `payload` and an ownership `EXISTS`: a mock proves the call, not that the
 * predicate keeps another account's grant out of the list and out of reach of
 * the revoke (`docs/verification-contract.md`).
 */
describe("Connected apps over oauth_payloads (real PostgreSQL)", () => {
  let dataSource: DataSource;

  const ALICE = "11111111-1111-1111-1111-111111111111";
  const BOB = "22222222-2222-2222-2222-222222222222";
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  const count = async (where: string, params: unknown[]): Promise<number> => {
    const rows: Array<{ n: string }> = await dataSource.query(
      `SELECT COUNT(*)::text AS n FROM oauth_payloads WHERE ${where}`,
      params,
    );
    return Number(rows[0].n);
  };

  /** A grant with an access token and a refresh token minted under it. */
  const seedGrant = async (
    grantId: string,
    accountId: string,
    opts: { iat?: number; tokenIat?: number; ttl?: number } = {},
  ) => {
    const iat = opts.iat ?? nowSeconds() - 3600;
    await new PostgresAdapter("Grant", dataSource).upsert(
      grantId,
      { accountId, clientId: `client-${grantId}`, iat, kind: "Grant" },
      opts.ttl ?? 3600,
    );
    for (const model of ["AccessToken", "RefreshToken"]) {
      await new PostgresAdapter(model, dataSource).upsert(
        `${model}-${grantId}`,
        {
          accountId,
          grantId,
          clientId: `client-${grantId}`,
          iat: opts.tokenIat ?? iat,
        },
        3600,
      );
    }
  };

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

  it("lists only the account's own live grants, newest first, with when each was last used", async () => {
    const used = nowSeconds() - 60;
    await seedGrant("alice-old", ALICE, { iat: nowSeconds() - 7200 });
    await seedGrant("alice-new", ALICE, {
      iat: nowSeconds() - 600,
      tokenIat: used,
    });
    await seedGrant("bob", BOB);
    await seedGrant("alice-expired", ALICE);
    await dataSource.query(
      "UPDATE oauth_payloads SET expires_at = $1 WHERE id = 'alice-expired' AND model = 'Grant'",
      [new Date(Date.now() - 60_000)],
    );

    const grants = await findGrantsForAccount(dataSource, ALICE);

    expect(grants.map((g) => g.id)).toEqual(["alice-new", "alice-old"]);
    expect(grants[0].payload).toMatchObject({
      accountId: ALICE,
      clientId: "client-alice-new",
    });
    expect(grants[0].lastUsedAt?.getTime()).toBe(used * 1000);
    expect(grants[0].expiresAt).toBeInstanceOf(Date);
    await expect(findGrantsForAccount(dataSource, BOB)).resolves.toHaveLength(
      1,
    );
  });

  it("reports no last use for a grant whose tokens are gone", async () => {
    await seedGrant("alice", ALICE);
    await dataSource.query(
      "DELETE FROM oauth_payloads WHERE grant_id = 'alice'",
    );

    const [grant] = await findGrantsForAccount(dataSource, ALICE);
    expect(grant.id).toBe("alice");
    expect(grant.lastUsedAt).toBeNull();
  });

  it("revokes the grant and every token minted under it", async () => {
    await seedGrant("alice", ALICE);
    await seedGrant("alice-other", ALICE);

    await expect(
      revokeGrantForAccount(dataSource, ALICE, "alice"),
    ).resolves.toBe(true);

    expect(await count("id = 'alice' AND model = 'Grant'", [])).toBe(0);
    expect(await count("grant_id = 'alice'", [])).toBe(0);
    // The account's other connection is untouched.
    expect(await count("grant_id = 'alice-other'", [])).toBe(2);
    await expect(
      new PostgresAdapter("AccessToken", dataSource).find("AccessToken-alice"),
    ).resolves.toBeUndefined();
  });

  it("deletes nothing when the grant belongs to another account", async () => {
    await seedGrant("bob", BOB);

    await expect(revokeGrantForAccount(dataSource, ALICE, "bob")).resolves.toBe(
      false,
    );

    expect(await count("id = 'bob' AND model = 'Grant'", [])).toBe(1);
    expect(await count("grant_id = 'bob'", [])).toBe(2);
  });

  it("answers false for a grant id that does not exist", async () => {
    await expect(
      revokeGrantForAccount(dataSource, ALICE, "missing"),
    ).resolves.toBe(false);
  });
});
