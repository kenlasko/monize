import { Test, TestingModule } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { AuthService } from "@/auth/auth.service";
import { TokenService } from "@/auth/token.service";
import { hashToken } from "@/auth/crypto.util";
import { lockTokenFamily } from "@/common/db/locks";
import { UsersService } from "@/users/users.service";
import { AdminService } from "@/admin/admin.service";
import { DelegationService } from "@/delegation/delegation.service";
import { withSystemContext, withUserContext } from "@/common/db/with-context";
import { User } from "@/users/entities/user.entity";
import { AuthAttemptCounterService } from "@/auth/auth-attempt-counter.service";
import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * Credential writes are atomic with the state they change (A26-M01, A26-M02,
 * A26-L07; INV-AUTH-002, INV-AUTH-004, INV-AUTH-005), against real PostgreSQL.
 *
 * - A successful login leaves the failed-login counter at zero. A whole-entity
 *   save of the snapshot read before bcrypt used to write the old count back
 *   over the SQL reset.
 * - A password change, an admin reset or disable, and an owner's reset of a
 *   delegate leave no refresh token live even while a rotation runs beside
 *   them. One blanket UPDATE misses the successor a concurrent rotation
 *   inserts after the statement's snapshot.
 * - An admin or owner-of-delegate reset whose PAT revocation fails leaves the
 *   password unchanged: both are one transaction.
 *
 * The services are built by hand with the collaborators these paths never
 * reach stubbed out; every database statement is the real one.
 */
describe("credential writes are atomic (integration)", () => {
  const PASSWORD = "TestPassword123!";
  const ADMIN_ID = "00000000-0000-4000-8000-00000000a0a0";
  const SECRET =
    process.env.JWT_SECRET || "test_secret_for_credential_writes_32";

  let module: TestingModule;
  let dataSource: DataSource;
  let tokens: TokenService;
  let auth: AuthService;
  let users: UsersService;
  let admin: AdminService;
  let delegation: DelegationService;
  let user: User;

  const noop = () => Promise.resolve(0);
  const oauthStub = { revokeAllForUser: jest.fn(noop) };
  const moduleRefStub = {
    get: jest.fn(() => ({
      revokeAllForUser: jest.fn(noop),
      rewrapBackupKey: jest.fn(() => Promise.resolve()),
    })),
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [() => ({ JWT_SECRET: SECRET })],
        }),
        JwtModule.register({ secret: SECRET }),
        TypeOrmModule.forRoot(INTEGRATION_TYPEORM_OPTIONS),
      ],
      providers: [TokenService],
    }).compile();

    dataSource = module.get(DataSource);
    await applyRlsPolicies(dataSource);
    tokens = module.get(TokenService);
    const config = module.get(ConfigService);

    auth = new AuthService(
      module.get(JwtService),
      config,
      dataSource,
      { isBreached: jest.fn(() => Promise.resolve(false)) } as never,
      {} as never,
      tokens,
      {
        validateTrustedDevice: jest.fn(() => Promise.resolve(true)),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      moduleRefStub as never,
      new AuthAttemptCounterService(dataSource),
    );
    users = new UsersService(
      dataSource,
      { isBreached: jest.fn(() => Promise.resolve(false)) } as never,
      moduleRefStub as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: (_key: string, fallback?: unknown) => fallback } as never,
    );
    admin = new AdminService(
      oauthStub as never,
      users,
      dataSource,
      config,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    delegation = new DelegationService(
      {} as never,
      config,
      dataSource,
      {} as never,
      moduleRefStub as never,
    );
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await dropFailpoint();
    await cleanTables(dataSource, [
      "auth_attempt_counters",
      "refresh_tokens",
      "personal_access_tokens",
      "trusted_devices",
      "account_delegates",
      "user_preferences",
      "users",
    ]);
    user = await createTestUserDirect(dataSource);
  });

  afterEach(async () => {
    await dropFailpoint();
  });

  async function counters(id: string) {
    const rows: { attempts: number; locked: boolean }[] =
      await dataSource.query(
        `SELECT failed_login_attempts AS attempts,
                locked_until IS NOT NULL AS locked
           FROM users WHERE id = $1`,
        [id],
      );
    return { attempts: Number(rows[0].attempts), locked: rows[0].locked };
  }

  async function liveTokens(id: string): Promise<number> {
    const rows: { n: number }[] = await dataSource.query(
      `SELECT count(*)::int AS n FROM refresh_tokens
        WHERE user_id = $1 AND is_revoked = false`,
      [id],
    );
    return rows[0].n;
  }

  async function passwordHash(id: string): Promise<string> {
    const rows: { password_hash: string }[] = await dataSource.query(
      `SELECT password_hash FROM users WHERE id = $1`,
      [id],
    );
    return rows[0].password_hash;
  }

  async function installFailpoint(): Promise<void> {
    // Statement-level, so it fires even when no PAT row matches.
    await dataSource.query(
      `CREATE OR REPLACE FUNCTION test_fail_pat_revoke() RETURNS trigger
         LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'failpoint: PAT revoke blocked';
       END;
       $$;`,
    );
    await dataSource.query(
      `CREATE TRIGGER test_fail_pat_revoke
         BEFORE UPDATE ON personal_access_tokens
         FOR EACH STATEMENT EXECUTE FUNCTION test_fail_pat_revoke();`,
    );
  }

  async function dropFailpoint(): Promise<void> {
    await dataSource.query(
      `DROP TRIGGER IF EXISTS test_fail_pat_revoke ON personal_access_tokens;`,
    );
    await dataSource.query(`DROP FUNCTION IF EXISTS test_fail_pat_revoke();`);
  }

  /** A delegate-only user whose password `owner` may reset. */
  async function seedDelegate(owner: User) {
    const delegate = await createTestUserDirect(dataSource);
    await dataSource.query(
      `UPDATE users SET is_delegate_only = true WHERE id = $1`,
      [delegate.id],
    );
    const rows: { id: string }[] = await dataSource.query(
      `INSERT INTO account_delegates (owner_user_id, delegate_user_id, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [owner.id, delegate.id],
    );
    return { delegate, delegationId: rows[0].id };
  }

  describe("successful login (A26-M01, INV-AUTH-002)", () => {
    const login = () =>
      auth.login({ email: user.email, password: PASSWORD } as never);

    it("leaves the failed-login counter at zero, so one later typo does not lock", async () => {
      await dataSource.query(
        `UPDATE users SET failed_login_attempts = 4 WHERE id = $1`,
        [user.id],
      );

      await expect(login()).resolves.toMatchObject({
        accessToken: expect.any(String),
      });
      expect(await counters(user.id)).toEqual({ attempts: 0, locked: false });

      await expect(
        auth.login({ email: user.email, password: "wrong" } as never),
      ).rejects.toThrow();
      expect(await counters(user.id)).toEqual({ attempts: 1, locked: false });
    });

    it("leaves the counter at zero on the trusted-device 2FA path too", async () => {
      await dataSource.query(
        `UPDATE users SET failed_login_attempts = 4, two_factor_secret = 'secret'
          WHERE id = $1`,
        [user.id],
      );
      await dataSource.query(
        `INSERT INTO user_preferences (user_id, two_factor_enabled)
         VALUES ($1, true)`,
        [user.id],
      );

      await expect(
        auth.login(
          { email: user.email, password: PASSWORD } as never,
          "trusted-ref",
        ),
      ).resolves.toMatchObject({ accessToken: expect.any(String) });
      expect(await counters(user.id)).toEqual({ attempts: 0, locked: false });
    });
  });

  describe("known login device under a password lock (#2181, INV-AUTH-002)", () => {
    const lockLikeStrangers = () =>
      dataSource.query(
        `UPDATE users
            SET failed_login_attempts = 7,
                locked_until = CURRENT_TIMESTAMP + INTERVAL '1 hour'
          WHERE id = $1`,
        [user.id],
      );
    async function knownDeviceJar(): Promise<Record<string, string>> {
      const cookie = await auth.issueLoginDeviceCookie(user.id);
      return { [cookie!.name]: cookie!.value };
    }
    const statusOf = (r: PromiseSettledResult<unknown>) =>
      r.status === "rejected"
        ? (r.reason as { getStatus(): number }).getStatus()
        : 200;

    it("lets the owner in from a known device without clearing the strangers' lock", async () => {
      const jar = await knownDeviceJar();
      await lockLikeStrangers();

      await expect(
        auth.login({ email: user.email, password: PASSWORD } as never),
      ).rejects.toThrow(/temporarily locked/);
      await expect(
        auth.login(
          { email: user.email, password: PASSWORD } as never,
          undefined,
          undefined,
          jar,
        ),
      ).resolves.toMatchObject({ accessToken: expect.any(String) });
      expect(await counters(user.id)).toEqual({ attempts: 7, locked: true });
    });

    it("lets no more concurrent guesses through on one device cookie than its budget", async () => {
      const jar = await knownDeviceJar();
      await lockLikeStrangers();

      const results = await Promise.allSettled(
        Array.from({ length: 15 }, () =>
          auth.login(
            { email: user.email, password: "wrong" } as never,
            undefined,
            undefined,
            jar,
          ),
        ),
      );
      const statuses = results.map(statusOf);

      expect(statuses.filter((s) => s === 401)).toHaveLength(10);
      expect(statuses.filter((s) => s === 403)).toHaveLength(5);
      // The device's failures never fed the account counter.
      expect(await counters(user.id)).toEqual({ attempts: 7, locked: true });
      await expect(
        auth.login(
          { email: user.email, password: PASSWORD } as never,
          undefined,
          undefined,
          jar,
        ),
      ).rejects.toThrow(/temporarily locked/);
    });

    it("stops honouring the cookie once the password is replaced", async () => {
      const jar = await knownDeviceJar();
      await dataSource.query(
        `UPDATE users SET password_hash = password_hash || 'x' WHERE id = $1`,
        [user.id],
      );
      await lockLikeStrangers();

      await expect(
        auth.login(
          { email: user.email, password: PASSWORD } as never,
          undefined,
          undefined,
          jar,
        ),
      ).rejects.toThrow(/temporarily locked/);
    });
  });

  describe("session revocation under a concurrent rotation (A26-M02, INV-AUTH-005)", () => {
    /**
     * Run `path` while a rotation of `target`'s session is in flight, with the
     * interleaving forced rather than hoped for: a second connection takes the
     * family lock and the row lock a rotation takes, waits until the path's
     * revoking UPDATE is blocked on that row, then revokes the old token,
     * inserts its successor and commits. A single `UPDATE ... WHERE user_id = ?
     * AND is_revoked = false` resumes with its old snapshot and never sees the
     * successor; the converging revocation after the commit does.
     */
    async function liveAfterInterleavedRotation(
      target: User,
      path: () => Promise<unknown>,
    ): Promise<number> {
      const { refreshToken: t0 } = await withSystemContext(() =>
        tokens.generateTokenPair(target, false),
      );
      const [{ family_id: familyId }]: { family_id: string }[] =
        await dataSource.query(
          `SELECT family_id FROM refresh_tokens WHERE token_hash = $1`,
          [hashToken(t0)],
        );

      const rotation = dataSource.createQueryRunner();
      await rotation.connect();
      await rotation.startTransaction();
      try {
        await lockTokenFamily(rotation.manager, familyId);
        await rotation.query(
          `SELECT id FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
          [hashToken(t0)],
        );

        const pending = path();
        pending.catch(() => undefined);
        await waitForBlockedRevoke();

        await rotation.query(
          `UPDATE refresh_tokens SET is_revoked = true, replaced_by_hash = $2
            WHERE token_hash = $1`,
          [hashToken(t0), hashToken(`${t0}-successor`)],
        );
        await rotation.query(
          `INSERT INTO refresh_tokens
             (user_id, token_hash, family_id, is_revoked, expires_at)
           VALUES ($1, $2, $3, false, now() + interval '1 day')`,
          [target.id, hashToken(`${t0}-successor`), familyId],
        );
        await rotation.commitTransaction();
        await pending;
      } finally {
        if (rotation.isTransactionActive) await rotation.rollbackTransaction();
        await rotation.release();
      }
      return liveTokens(target.id);
    }

    /** Until some backend waits on a row lock inside an UPDATE of refresh_tokens. */
    async function waitForBlockedRevoke(): Promise<void> {
      for (let i = 0; i < 200; i++) {
        const rows: { n: number }[] = await dataSource.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock'
              AND query ILIKE 'UPDATE "refresh_tokens"%'`,
        );
        if (rows[0].n > 0) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("the revoking UPDATE never blocked on the rotation");
    }

    it("change password", async () => {
      const live = await liveAfterInterleavedRotation(user, () =>
        withUserContext(user.id, () =>
          users.changePassword(user.id, {
            currentPassword: PASSWORD,
            newPassword: `${PASSWORD}-next`,
          } as never),
        ),
      );
      expect(live).toBe(0);
    });

    it("admin reset", async () => {
      const live = await liveAfterInterleavedRotation(user, () =>
        admin.resetUserPassword(ADMIN_ID, user.id),
      );
      expect(live).toBe(0);
    });

    it("admin disable", async () => {
      const live = await liveAfterInterleavedRotation(user, () =>
        admin.updateUserStatus(ADMIN_ID, user.id, false),
      );
      expect(live).toBe(0);
    });

    it("owner-of-delegate reset", async () => {
      const { delegate, delegationId } = await seedDelegate(user);
      const live = await liveAfterInterleavedRotation(delegate, () =>
        withUserContext(user.id, () =>
          delegation.resetDelegatePassword(user.id, delegationId),
        ),
      );
      expect(live).toBe(0);
    });
  });

  describe("password and standing credentials in one transaction (A26-L07, INV-AUTH-005)", () => {
    it("an admin reset whose PAT revocation fails leaves the password unchanged", async () => {
      const before = await passwordHash(user.id);
      await installFailpoint();

      await expect(admin.resetUserPassword(ADMIN_ID, user.id)).rejects.toThrow(
        /failpoint: PAT revoke blocked/,
      );

      expect(await passwordHash(user.id)).toBe(before);
    });

    it("an owner's reset of a delegate whose PAT revocation fails leaves the password unchanged", async () => {
      const { delegate, delegationId } = await seedDelegate(user);
      const before = await passwordHash(delegate.id);
      await installFailpoint();

      await expect(
        withUserContext(user.id, () =>
          delegation.resetDelegatePassword(user.id, delegationId),
        ),
      ).rejects.toThrow(/failpoint: PAT revoke blocked/);

      expect(await passwordHash(delegate.id)).toBe(before);
    });

    it("an admin disable whose PAT revocation fails leaves the account active", async () => {
      await installFailpoint();

      await expect(
        admin.updateUserStatus(ADMIN_ID, user.id, false),
      ).rejects.toThrow(/failpoint: PAT revoke blocked/);

      const rows: { is_active: boolean }[] = await dataSource.query(
        `SELECT is_active FROM users WHERE id = $1`,
        [user.id],
      );
      expect(rows[0].is_active).toBe(true);
    });

    it("control: without the failpoint an admin reset replaces the password", async () => {
      const before = await passwordHash(user.id);

      await admin.resetUserPassword(ADMIN_ID, user.id);

      expect(await passwordHash(user.id)).not.toBe(before);
    });
  });
});
