import { randomUUID } from "crypto";
import { BadRequestException } from "@nestjs/common";
import { withUserContext } from "@/common/db/with-context";
import { CurrenciesService } from "@/currencies/currencies.service";
import { OAUTH_GRANT_REVOKER } from "@/auth/credential-revocation";
import { SharedExpensesModule } from "@/shared-expenses/shared-expenses.module";
import { SharedGroupsService } from "@/shared-expenses/shared-groups.service";
import { SharedInvitationsService } from "@/shared-expenses/shared-invitations.service";
import { UsersService } from "@/users/users.service";
import {
  EnforcedIntegrationHarness,
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * Self-service account deletion (`UsersService.deleteAccount`) against real
 * PostgreSQL with RLS enforced. `shared_groups.owner_user_id` and
 * `shared_memberships.user_id` are ON DELETE RESTRICT, and under enforcement
 * the departing user's own identity cannot delete another member's rows or see
 * their integrations, so the delete must run in system context like the admin
 * path does.
 */
describe("self-service account deletion with shared expenses under enforced RLS", () => {
  jest.setTimeout(180000);
  const PASSWORD = "TestPassword123!";
  let h: EnforcedIntegrationHarness;
  let groups: SharedGroupsService;
  let invitations: SharedInvitationsService;
  let users: UsersService;
  const revokeAllForUser = jest.fn().mockResolvedValue(0);

  const as = <T>(id: string, body: () => Promise<T>) =>
    withUserContext(id, body);
  const command = (expectedRevision = 0) => ({
    operationId: randomUUID(),
    expectedRevision,
  });

  const previousEncryptionKey = process.env.ENCRYPTION_KEY;
  const previousJwtSecret = process.env.JWT_SECRET;
  beforeAll(async () => {
    process.env.JWT_SECRET = "self-delete-shared-jwt-secret-for-tests-only";
    process.env.ENCRYPTION_KEY = "self-delete-shared-integration-key-32-chars";
    h = await createEnforcedIntegrationModule([SharedExpensesModule]);
    groups = h.module.get(SharedGroupsService);
    invitations = h.module.get(SharedInvitationsService);
    await h.owner.query(
      "INSERT INTO currencies (code,name,symbol,decimal_places) VALUES ('PLN','Polish zloty','PLN',2) ON CONFLICT (code) DO NOTHING",
    );
    const moduleRef = {
      get: (token: unknown) => {
        if (token === CurrenciesService) {
          return {
            lockCurrenciesCreatedBy: () => Promise.resolve([]),
            removeUnreferencedCurrencies: () => Promise.resolve(),
          };
        }
        if (token === OAUTH_GRANT_REVOKER) return { revokeAllForUser };
        throw new Error("unexpected module lookup");
      },
    };
    users = new UsersService(
      h.app,
      {} as never,
      moduleRef as never,
      { isDemo: false } as never,
      {} as never,
      {} as never,
      {} as never,
      { get: (_key: string, fallback?: unknown) => fallback } as never,
    );
  });
  afterAll(async () => {
    if (h) await h.close();
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
  });

  let owner: string, guest: string, groupId: string;
  beforeEach(async () => {
    revokeAllForUser.mockClear();
    await cleanTables(h.owner, ["shared_groups", "users"]);
    owner = (await createTestUserDirect(h.owner)).id;
    guest = (await createTestUserDirect(h.owner)).id;
    groupId = (
      await as(owner, () =>
        groups.create(owner, {
          operationId: randomUUID(),
          name: "Trip",
          myName: "Owner alias",
          currencyCode: "PLN",
          participants: [{ name: "Anna alias" }],
        }),
      )
    ).id;
  });

  async function guestJoins() {
    const group = await as(owner, () => groups.detail(owner, groupId));
    const anna = group.participants.find((p) => p.name === "Anna alias")!.id;
    const invite = await as(owner, () =>
      invitations.create(owner, groupId, {
        ...command(group.revision),
        participantId: anna,
        role: "EDITOR",
      }),
    );
    await as(guest, () => invitations.claim(guest, invite.token));
  }

  async function seedTokens(userId: string) {
    await h.owner.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, is_revoked, expires_at)
       VALUES ($1, $2, gen_random_uuid(), false, now() + interval '1 day')`,
      [userId, randomUUID().replace(/-/g, "").padEnd(64, "0")],
    );
    await h.owner.query(
      `INSERT INTO personal_access_tokens (user_id, name, token_prefix, token_hash, scopes, is_revoked)
       VALUES ($1, 'pat', 'abcd1234', $2, 'read', false)`,
      [userId, randomUUID().replace(/-/g, "").padEnd(64, "0")],
    );
  }

  const del = (id: string) =>
    as(id, () => users.deleteAccount(id, { password: PASSWORD }));

  it("deletes a member of another user's group and removes the membership", async () => {
    await guestJoins();

    await expect(del(guest)).resolves.toEqual({ downgraded: false });

    expect(
      await h.owner.query("SELECT 1 FROM users WHERE id = $1", [guest]),
    ).toHaveLength(0);
    expect(
      await h.owner.query(
        "SELECT 1 FROM shared_memberships WHERE user_id = $1",
        [guest],
      ),
    ).toHaveLength(0);
    expect(
      await h.owner.query("SELECT 1 FROM shared_groups WHERE id = $1", [
        groupId,
      ]),
    ).toHaveLength(1);
    expect(revokeAllForUser).toHaveBeenCalledWith(guest);
  });

  // Without withSystemContext in purgeForDowngrade, eraseSharedUser runs as the
  // departing member: shared_memberships_delete lets only the group owner delete
  // memberships, so the member's own row matches 0 rows and survives, and the
  // membership assertion below fails.
  it("downgrades a delegate who is a group member and removes only their membership", async () => {
    await guestJoins();
    await h.owner.query(
      `INSERT INTO account_delegates (owner_user_id, delegate_user_id, status)
       VALUES ($1, $2, 'active')`,
      [owner, guest],
    );

    await expect(del(guest)).resolves.toEqual({ downgraded: true });

    expect(
      await h.owner.query("SELECT 1 FROM users WHERE id = $1", [guest]),
    ).toHaveLength(1);
    expect(
      await h.owner.query(
        "SELECT 1 FROM shared_memberships WHERE user_id = $1",
        [guest],
      ),
    ).toHaveLength(0);
    expect(
      await h.owner.query("SELECT 1 FROM shared_groups WHERE id = $1", [
        groupId,
      ]),
    ).toHaveLength(1);
    expect(
      await h.owner.query(
        "SELECT 1 FROM shared_memberships WHERE user_id = $1",
        [owner],
      ),
    ).toHaveLength(1);
    expect(revokeAllForUser).toHaveBeenCalledWith(guest);
  });

  it("deletes an owner whose group has no other members and removes the group", async () => {
    await expect(del(owner)).resolves.toEqual({ downgraded: false });

    expect(
      await h.owner.query("SELECT 1 FROM users WHERE id = $1", [owner]),
    ).toHaveLength(0);
    expect(
      await h.owner.query("SELECT 1 FROM shared_groups WHERE id = $1", [
        groupId,
      ]),
    ).toHaveLength(0);
  });

  it("refuses an owner whose group another user joined, before revoking any token", async () => {
    await guestJoins();
    await seedTokens(owner);

    await expect(del(owner)).rejects.toBeInstanceOf(BadRequestException);

    expect(
      await h.owner.query("SELECT 1 FROM users WHERE id = $1", [owner]),
    ).toHaveLength(1);
    expect(
      await h.owner.query(
        "SELECT 1 FROM refresh_tokens WHERE user_id = $1 AND is_revoked = false",
        [owner],
      ),
    ).toHaveLength(1);
    expect(
      await h.owner.query(
        "SELECT 1 FROM personal_access_tokens WHERE user_id = $1 AND is_revoked = false",
        [owner],
      ),
    ).toHaveLength(1);
    expect(revokeAllForUser).not.toHaveBeenCalled();
  });
});
