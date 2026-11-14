import { Test, TestingModule } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { AuthAttemptCounterService } from "@/auth/auth-attempt-counter.service";
import { StepUpAuthService } from "@/auth/step-up/step-up.service";
import { TokenService } from "@/auth/token.service";
import {
  TWO_FACTOR_LOCK_SCOPE,
  TwoFactorService,
} from "@/auth/two-factor.service";
import { withSystemContext } from "@/common/db/with-context";
import { User } from "@/users/entities/user.entity";
import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * Per-user TOTP and step-up attempt budgets hold under concurrency (A26-L08).
 *
 * The budgets were peek-then-verify: every request read the count before any
 * concurrent failure was recorded, so K simultaneous guesses from K client
 * addresses (the per-IP throttle does not bind across addresses) were all
 * checked. Each attempt now reserves its slot with the counter's single
 * INSERT ... ON CONFLICT ... RETURNING before the code is checked, so at most
 * the cap reaches the verifier, whatever the interleaving.
 *
 * Real `auth_attempt_counters` table; the verifier is a spy that always says
 * "wrong" after a short delay, which is what widens the window a burst races
 * through.
 */
describe("2FA and step-up attempt budgets under concurrency (integration)", () => {
  const SECRET =
    process.env.JWT_SECRET || "test_secret_for_attempt_budgets_32ch";
  const BURST = 20;
  const MAX_USER_2FA_ATTEMPTS = 10;
  const MAX_STEP_UP_ATTEMPTS = 10;

  let module: TestingModule;
  let dataSource: DataSource;
  let jwt: JwtService;
  let counters: AuthAttemptCounterService;
  let twoFactor: TwoFactorService;
  let stepUp: StepUpAuthService;
  let user: User;

  const slowWrong = <T>(value: T) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), 25));

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
      providers: [TokenService, AuthAttemptCounterService],
    }).compile();

    dataSource = module.get(DataSource);
    await applyRlsPolicies(dataSource);
    jwt = module.get(JwtService);
    counters = module.get(AuthAttemptCounterService);
    const config = module.get(ConfigService);

    twoFactor = new TwoFactorService(
      jwt,
      config,
      dataSource,
      module.get(TokenService),
      counters,
      {} as never,
    );
    stepUp = new StepUpAuthService(
      dataSource,
      twoFactor,
      jwt,
      config,
      {} as never,
      counters,
    );
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await dataSource.query(`DELETE FROM auth_attempt_counters`);
    await cleanTables(dataSource, ["user_preferences", "users"]);
    user = await createTestUserDirect(dataSource);
    await dataSource.query(
      `UPDATE users SET two_factor_secret = 'not-a-real-secret' WHERE id = $1`,
      [user.id],
    );
    await dataSource.query(
      `INSERT INTO user_preferences (user_id, two_factor_enabled)
       VALUES ($1, true)`,
      [user.id],
    );
  });

  it("login 2FA: a burst of wrong codes across many temp tokens reaches the verifier at most the per-user cap", async () => {
    const checks = jest
      .spyOn(twoFactor as never, "checkTotpCode")
      .mockImplementation((() => ({
        valid: false,
        reEncrypted: null,
      })) as never);
    // Different temp tokens, so the per-token cap (3) never binds and the
    // per-user budget is the control under test.
    const tokens = Array.from({ length: BURST }, (_, i) =>
      jwt.sign(
        { sub: user.id, type: "2fa_pending", n: i },
        { expiresIn: "5m" },
      ),
    );
    // Widen the window between the budget decision and the verifier.
    const realScoped = (
      twoFactor as never as {
        scoped: (...args: unknown[]) => Promise<unknown>;
      }
    ).scoped;
    jest
      .spyOn(twoFactor as never, "scoped")
      .mockImplementation((async (...args: unknown[]) =>
        slowWrong(await realScoped.apply(twoFactor, args))) as never);

    await Promise.allSettled(
      tokens.map((t) =>
        withSystemContext(() => twoFactor.verify2FA(t, "123456")),
      ),
    );

    expect(checks.mock.calls.length).toBeLessThanOrEqual(MAX_USER_2FA_ATTEMPTS);
    expect(checks.mock.calls.length).toBeGreaterThan(0);
  });

  it("the 2FA lock marks itself and never shortens a longer password lock (#2181)", async () => {
    const lock = (n: number) =>
      withSystemContext(() =>
        (
          twoFactor as never as {
            lockIfUserTotpBudgetSpent(id: string, count: number): Promise<void>;
          }
        ).lockIfUserTotpBudgetSpent(user.id, n),
      );
    const secondsLeft = async () => {
      const [row] = await dataSource.query(
        `SELECT EXTRACT(EPOCH FROM locked_until - CURRENT_TIMESTAMP) AS secs
           FROM users WHERE id = $1`,
        [user.id],
      );
      return Number(row.secs);
    };

    await lock(MAX_USER_2FA_ATTEMPTS);
    expect(await secondsLeft()).toBeGreaterThan(29 * 60);
    expect(await secondsLeft()).toBeLessThanOrEqual(30 * 60);
    expect(
      await withSystemContext(() =>
        counters.peek(TWO_FACTOR_LOCK_SCOPE, user.id),
      ),
    ).toBe(1);

    // A known login device reached 2FA under a 4-hour password lock.
    await dataSource.query(
      `UPDATE users SET locked_until = CURRENT_TIMESTAMP + INTERVAL '4 hours'
        WHERE id = $1`,
      [user.id],
    );
    await lock(MAX_USER_2FA_ATTEMPTS);
    expect(await secondsLeft()).toBeGreaterThan(3.9 * 60 * 60);
  });

  it("step-up: a burst of wrong TOTP codes reaches the verifier at most the cap", async () => {
    const verify = jest
      .spyOn(twoFactor, "verifyTotpForUser")
      .mockImplementation(() => slowWrong(false));

    await Promise.allSettled(
      Array.from({ length: BURST }, () =>
        withSystemContext(() =>
          stepUp.verifyAndIssue(user.id, "personal-access-token", {
            totpCode: "123456",
          }),
        ),
      ),
    );

    expect(verify.mock.calls.length).toBeLessThanOrEqual(MAX_STEP_UP_ATTEMPTS);
    expect(verify.mock.calls.length).toBeGreaterThan(0);
  });

  it("step-up: a correct code after nine failures still passes, and resets the budget", async () => {
    let calls = 0;
    jest
      .spyOn(twoFactor, "verifyTotpForUser")
      .mockImplementation(() => Promise.resolve(++calls === 10));

    for (let i = 0; i < 9; i++) {
      await expect(
        withSystemContext(() =>
          stepUp.verifyAndIssue(user.id, "personal-access-token", {
            totpCode: "123456",
          }),
        ),
      ).rejects.toThrow();
    }
    await expect(
      withSystemContext(() =>
        stepUp.verifyAndIssue(user.id, "personal-access-token", {
          totpCode: "123456",
        }),
      ),
    ).resolves.toMatchObject({ stepUpToken: expect.any(String) });

    const rows: unknown[] = await dataSource.query(
      `SELECT 1 FROM auth_attempt_counters WHERE key = $1`,
      [`${user.id}:personal-access-token`],
    );
    expect(rows).toHaveLength(0);
  });
});
