import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import {
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { DataSource, In } from "typeorm";
import bcrypt from "bcryptjs";
import * as otplib from "otplib";
import * as QRCode from "qrcode";
import { AuthService } from "./auth.service";
import { TokenService } from "./token.service";
import { TwoFactorService } from "./two-factor.service";
import { AuthEmailService } from "./auth-email.service";
import { DelegationService } from "../delegation/delegation.service";
import { I18nService, I18nContext } from "nestjs-i18n";
import { BackupEncryptionService } from "../backup/backup-encryption.service";
import { loginPasswordRef } from "../backup/backup-key-wrap";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { PersonalAccessToken } from "./entities/personal-access-token.entity";
import { OAUTH_GRANT_REVOKER } from "./credential-revocation";
import { RefreshToken } from "./entities/refresh-token.entity";
import { encrypt, derivePurposeKey } from "./crypto.util";
import { PasswordBreachService } from "./password-breach.service";
import { EmailService } from "../notifications/email.service";
import { getRequestContext } from "../common/request-context";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  createUserPreferenceRepoMock,
  type UserPreferenceRepoMock,
} from "../test-helpers/user-preference-testing";
import { authAttemptCounterProvider } from "../test-helpers/auth-attempt-counter-testing";
import {
  issueLoginDeviceCookie,
  loginDeviceCookieName,
  verifyLoginDeviceCookie,
} from "./login-device";
import { singleUseTokenProvider } from "../test-helpers/single-use-token-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const TEST_JWT_SECRET = "test-jwt-secret-minimum-32-chars-long";
const TEST_TOTP_KEY = derivePurposeKey(TEST_JWT_SECRET, "totp-encryption");

jest.mock("otplib", () => ({
  verifySync: jest.fn(),
  generateSecret: jest.fn().mockReturnValue("TESTSECRET"),
  generateURI: jest
    .fn()
    .mockReturnValue(
      "otpauth://totp/Monize:test@example.com?secret=TESTSECRET&issuer=Monize",
    ),
}));

jest.mock("qrcode", () => ({
  toDataURL: jest.fn().mockResolvedValue("data:image/png;base64,mockqrcode"),
}));

describe("AuthService", () => {
  let service: AuthService;
  let scopedManager: Record<string, jest.Mock>;
  let stageOneTokenFamily: () => void;
  let usersRepository: Record<string, jest.Mock>;
  let preferencesRepository: Record<string, jest.Mock>;
  let preferencesRow: UserPreferenceRepoMock;
  let trustedDevicesRepository: Record<string, jest.Mock>;
  let refreshTokensRepository: Record<string, jest.Mock>;
  let patRepository: Record<string, jest.Mock>;
  let oauthProviderService: { revokeAllForUser: jest.Mock };
  let jwtService: Partial<JwtService>;
  let configService: { get: jest.Mock };
  let delegationService: {
    isDelegateUser: jest.Mock;
    isFullAccount: jest.Mock;
  };
  let dataSource: Record<string, jest.Mock>;
  let passwordBreachService: { isBreached: jest.Mock };
  let emailService: { sendMail: jest.Mock; getStatus: jest.Mock };
  let backupEncryptionService: { rewrapBackupKey: jest.Mock };

  const mockUser = {
    id: "user-1",
    email: "test@example.com",
    firstName: "Test",
    lastName: "User",
    passwordHash: "$2a$10$hashedpassword",
    authProvider: "local",
    role: "user",
    isActive: true,
    emailVerified: true,
    twoFactorSecret: null,
    resetToken: null,
    resetTokenExpiry: null,
    lastLogin: null,
    oidcSubject: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    usersRepository = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn(),
      // The login path no longer uses a query builder: the failed-attempt
      // increment/lockout and the success reset are both raw guarded SQL on the
      // scoped manager now (findings 1/2/6). The delegated resetPassword
      // (AuthEmailService) and verify2FA lockout (TwoFactorService) paths still
      // build their UPDATEs, and those describe blocks override this mock.
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      })),
    };

    // Behaves like the row: the 2FA flag is now written as a targeted patch,
    // materializing the row when absent.
    preferencesRow = createUserPreferenceRepoMock(null);
    preferencesRepository = preferencesRow.repo;

    trustedDevicesRepository = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      delete: jest.fn(),
      remove: jest.fn(),
    };

    refreshTokensRepository = {
      create: jest.fn().mockImplementation((data) => data),
      save: jest.fn().mockImplementation((data) => ({ ...data, id: "rt-1" })),
      findOne: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    patRepository = { update: jest.fn() };
    oauthProviderService = { revokeAllForUser: jest.fn().mockResolvedValue(0) };

    jwtService = {
      sign: jest.fn().mockReturnValue("mock-jwt-token"),
      verify: jest.fn(),
    };

    // Every read/write now goes through `withScopedDb`, which the harness maps
    // onto `dataSource.transaction` with the per-entity repository mocks routed
    // through `manager.getRepository`.
    const scoped = createScopedDbMocks([
      [User, usersRepository as never],
      [UserPreference, preferencesRepository as never],
      [TrustedDevice, trustedDevicesRepository as never],
      // The spec provides a real TokenService, whose refresh-token writes now
      // go through the same scoped manager.
      [RefreshToken, refreshTokensRepository as never],
      [PersonalAccessToken, patRepository as never],
    ]);
    scopedManager = scoped.manager;
    // Two statements now reach the manager directly on ordinary paths: the SQL
    // failed-attempt increment and the family-discovery SELECT in
    // revokeAllUserRefreshTokens. Both are happy with an empty result unless a
    // spec says otherwise.
    scopedManager.query.mockResolvedValue([]);

    /**
     * `revokeAllUserRefreshTokens` discovers the user's families, locks them in
     * ascending order, revokes, and repeats until a pass revokes nothing -- one
     * bulk UPDATE cannot see a replacement a concurrent rotation inserted after
     * its statement snapshot (audit P4-011). So a spec that expects the revoke to
     * happen has to give it a family to find.
     */
    stageOneTokenFamily = () => {
      let pass = 0;
      scopedManager.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes("pg_advisory_xact_lock")) return [];
        if (!String(sql).includes("DISTINCT family_id")) return [];
        return pass++ === 0 ? [{ family_id: "family-1" }] : [];
      });
      refreshTokensRepository.update
        .mockResolvedValueOnce({ affected: 1 })
        .mockResolvedValue({ affected: 0 });
    };
    dataSource = scoped.dataSource as unknown as Record<string, jest.Mock>;

    passwordBreachService = {
      isBreached: jest.fn().mockResolvedValue(false),
    };

    emailService = {
      sendMail: jest.fn().mockResolvedValue(undefined),
      getStatus: jest.fn().mockReturnValue({ configured: false }),
    };

    backupEncryptionService = {
      rewrapBackupKey: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        TokenService,
        TwoFactorService,
        authAttemptCounterProvider(),
        singleUseTokenProvider(),
        AuthEmailService,
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: {
            get: jest
              .fn()
              .mockImplementation((key: string, defaultValue?: string) => {
                if (key === "JWT_SECRET")
                  return "test-jwt-secret-minimum-32-chars-long";
                if (key === "FORCE_2FA") return defaultValue || "false";
                return defaultValue || undefined;
              }),
          },
        },
        { provide: DataSource, useValue: dataSource },
        { provide: OAUTH_GRANT_REVOKER, useValue: oauthProviderService },
        { provide: PasswordBreachService, useValue: passwordBreachService },
        { provide: EmailService, useValue: emailService },
        {
          provide: BackupEncryptionService,
          useValue: backupEncryptionService,
        },
        {
          provide: DelegationService,
          useValue: {
            isDelegateUser: jest.fn().mockResolvedValue(false),
            isFullAccount: jest.fn().mockResolvedValue(false),
          },
        },
        {
          provide: I18nService,
          useValue: {
            translate: (key: string, opts?: { defaultValue?: string }) =>
              opts?.defaultValue ?? key,
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    configService = module.get(ConfigService);
    delegationService = module.get(DelegationService);

    // Spy on logger for security event logging tests (C2+C3)
    jest.spyOn((service as any).logger, "warn").mockImplementation();
    jest.spyOn((service as any).logger, "log").mockImplementation();

    // Spy on delegated service loggers so tests asserting on log messages still pass
    const twoFactorSvc = module.get<TwoFactorService>(TwoFactorService);
    jest
      .spyOn((twoFactorSvc as any).logger, "warn")
      .mockImplementation((...args: any[]) =>
        (service as any).logger.warn(...args),
      );
    jest
      .spyOn((twoFactorSvc as any).logger, "log")
      .mockImplementation((...args: any[]) =>
        (service as any).logger.log(...args),
      );
  });

  /**
   * Install a `dataSource.transaction` stub for a spec that drives the
   * transaction body directly. It accepts both call shapes -- registration asks
   * for SERIALIZABLE and so arrives as `transaction(isolation, cb)`, while every
   * other scoped call is `transaction(cb)` -- and gives the supplied manager a
   * `getRepository` routed at the same per-entity mocks, so unrelated scoped
   * reads inside the same flow still resolve.
   */

  /**
   * Make only the SERIALIZABLE user-creation transaction reject; every other
   * scoped read still runs normally against the harness manager. Before the
   * refactor those reads went through injected repositories and so were
   * unaffected by a blanket `transaction.mockRejectedValue`.
   */
  function failCreateTransaction(error: unknown) {
    dataSource.transaction.mockImplementation(async (...args: any[]) => {
      if (typeof args[0] === "string") throw error;
      return args[0](scopedManager);
    });
  }

  function installTransactionMock(txManager: Record<string, any>) {
    // The family advisory lock goes through the manager, and it is taken before
    // any row lock so rotation and revocation cannot deadlock (audit P4-011).
    txManager.query ??= jest.fn().mockResolvedValue([]);
    txManager.getRepository ??= jest.fn((entity: unknown) => {
      if (entity === User) return usersRepository;
      if (entity === UserPreference) return preferencesRepository;
      if (entity === TrustedDevice) return trustedDevicesRepository;
      if (entity === RefreshToken) return refreshTokensRepository;
      return {
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((d: unknown) => d),
        save: jest.fn().mockImplementation((d: unknown) => d),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        delete: jest.fn().mockResolvedValue({ affected: 0 }),
      };
    });
    dataSource.transaction.mockImplementation(async (...args: any[]) => {
      const cb = typeof args[0] === "function" ? args[0] : args[1];
      return cb(txManager);
    });
    return txManager;
  }

  describe("register", () => {
    /**
     * Helper: set up dataSource.transaction mock for register()'s
     * SERIALIZABLE transaction pattern: dataSource.transaction("SERIALIZABLE", async (manager) => {...})
     */
    function setupRegisterTransactionMock(userCount: number) {
      const txManager = {
        count: jest.fn().mockResolvedValue(userCount),
        create: jest.fn().mockImplementation((_entity, data) => ({
          ...data,
          id: "new-user",
        })),
        save: jest.fn().mockImplementation((user) => ({
          ...user,
          id: user.id || "new-user",
        })),
      };
      return installTransactionMock(txManager);
    }

    it("creates a new user and returns token pair", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      setupRegisterTransactionMock(1); // not first user

      const result = await service.register({
        email: "new@example.com",
        password: "StrongPass123!",
        firstName: "New",
        lastName: "User",
      });

      expect(result.user).toBeDefined();
      expect(result.user.email).toBe("new@example.com");
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.user).not.toHaveProperty("passwordHash");
    });

    it("wraps the backup key under the new password, bound to the hash it created", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const txManager = setupRegisterTransactionMock(1);

      await service.register({
        email: "new@example.com",
        password: "StrongPass123!",
      });

      const createdHash = txManager.save.mock.calls[0][0].passwordHash;
      expect(backupEncryptionService.rewrapBackupKey).toHaveBeenCalledWith(
        "new-user",
        "StrongPass123!",
        createdHash,
      );
    });

    it("makes first user an admin", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const txManager = setupRegisterTransactionMock(0); // first user

      await service.register({
        email: "admin@example.com",
        password: "StrongPass123!",
      });

      const createdUser = txManager.save.mock.calls[0][0];
      expect(createdUser.role).toBe("admin");
    });

    it("creates default preferences for the new user", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const txManager = setupRegisterTransactionMock(1);

      await service.register({
        email: "new@example.com",
        password: "StrongPass123!",
      });

      // First save is the user, second is the preferences row.
      const savedPrefs = txManager.save.mock.calls[1][0];
      expect(savedPrefs.userId).toBe("new-user");
      expect(savedPrefs.language).toBe("en");
    });

    it("seeds the new user's language from the request locale", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const txManager = setupRegisterTransactionMock(1);
      const spy = jest
        .spyOn(I18nContext, "current")
        .mockReturnValue({ lang: "pl" } as never);

      await service.register({
        email: "polish@example.com",
        password: "StrongPass123!",
      });

      const savedPrefs = txManager.save.mock.calls[1][0];
      expect(savedPrefs.language).toBe("pl");
      spy.mockRestore();
    });

    it("throws for duplicate email", async () => {
      usersRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.register({
          email: "test@example.com",
          password: "StrongPass123!",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("refuses to claim an invited (passwordless) delegate through /register", async () => {
      // An invited row carries only an emailed invite token. Letting
      // /register set its password would hand the row -- verified email and
      // a session included -- to anyone who knows the address, without ever
      // proving control of the mailbox. The invite link is the only way in.
      const expiry = new Date(Date.now() + 60_000);
      const invitedDelegate = {
        id: "deleg-1",
        email: "shared@example.com",
        authProvider: "local",
        passwordHash: null,
        emailVerified: true,
        isDelegateOnly: true,
        resetToken: "tok",
        resetTokenExpiry: expiry,
      };
      usersRepository.findOne.mockResolvedValue(invitedDelegate);
      delegationService.isDelegateUser.mockResolvedValue(true);
      delegationService.isFullAccount.mockResolvedValue(false);
      passwordBreachService.isBreached.mockResolvedValue(false);
      usersRepository.save.mockImplementation(async (u: any) => u);

      const attempt = service.register({
        email: "shared@example.com",
        password: "StrongPass123!",
        firstName: "Attacker",
      });

      // The same generic refusal a non-claimable row gets, so the response
      // discloses nothing more than it did before.
      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow("Unable to complete registration");
      expect(usersRepository.save).not.toHaveBeenCalled();
      expect(invitedDelegate.passwordHash).toBeNull();
      expect(invitedDelegate.resetToken).toBe("tok");
      expect(invitedDelegate.resetTokenExpiry).toBe(expiry);
      expect(invitedDelegate.isDelegateOnly).toBe(true);
      // Nor does it fall through to creating a duplicate account.
      expect(
        dataSource.transaction.mock.calls.some(
          (call) => call[0] === "SERIALIZABLE",
        ),
      ).toBe(false);
    });

    it("claims a delegate with a temp password when the correct currentPassword is supplied", async () => {
      const tempPwHash = await bcrypt.hash("Temp-Pw-9!aB", 4);
      const tempDelegate = {
        id: "deleg-3",
        email: "shared3@example.com",
        authProvider: "local",
        passwordHash: tempPwHash,
        mustChangePassword: true,
        failedLoginAttempts: 2,
        lockedUntil: null,
        resetToken: null,
        resetTokenExpiry: null,
      };
      usersRepository.findOne.mockResolvedValue(tempDelegate);
      delegationService.isDelegateUser.mockResolvedValue(true);
      delegationService.isFullAccount.mockResolvedValue(false);
      passwordBreachService.isBreached.mockResolvedValue(false);
      usersRepository.save.mockImplementation(async (u: any) => u);

      const result = await service.register({
        email: "shared3@example.com",
        password: "StrongPass123!",
        currentPassword: "Temp-Pw-9!aB",
      });

      expect(delegationService.isDelegateUser).toHaveBeenCalledWith("deleg-3");
      expect(delegationService.isFullAccount).toHaveBeenCalledWith("deleg-3");
      // The temp password hash is replaced by the new one.
      expect(tempDelegate.passwordHash).not.toBe(tempPwHash);
      // Bootstrap markers are cleared so the new owner has a clean state.
      expect(tempDelegate.mustChangePassword).toBe(false);
      expect(tempDelegate.failedLoginAttempts).toBe(0);
      expect(tempDelegate.lockedUntil).toBeNull();
      expect(result.accessToken).toBeDefined();
      expect(result.user).not.toHaveProperty("passwordHash");
      // The claim path reuses the existing row: no SERIALIZABLE create
      // transaction is opened (every other scoped read is transaction(cb)).
      expect(
        dataSource.transaction.mock.calls.some(
          (call) => call[0] === "SERIALIZABLE",
        ),
      ).toBe(false);
    });

    it("claims a delegate when the new account password happens to match the delegate's password (no currentPassword needed)", async () => {
      const sharedPwHash = await bcrypt.hash("Temp-Pw-9!aB", 4);
      const tempDelegate = {
        id: "deleg-match",
        email: "shared-match@example.com",
        authProvider: "local",
        passwordHash: sharedPwHash,
        mustChangePassword: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
        resetToken: null,
        resetTokenExpiry: null,
      };
      usersRepository.findOne.mockResolvedValue(tempDelegate);
      delegationService.isDelegateUser.mockResolvedValue(true);
      delegationService.isFullAccount.mockResolvedValue(false);
      passwordBreachService.isBreached.mockResolvedValue(false);
      usersRepository.save.mockImplementation(async (u: any) => u);

      const result = await service.register({
        email: "shared-match@example.com",
        // No currentPassword: the front end skipped the second prompt
        // because the new-account password already matches the delegate.
        password: "Temp-Pw-9!aB",
      });

      expect(tempDelegate.mustChangePassword).toBe(false);
      expect(result.user).not.toHaveProperty("passwordHash");
      expect(result.accessToken).toBeDefined();
    });

    it("rejects a delegate claim when the currentPassword is wrong or missing", async () => {
      const tempPwHash = await bcrypt.hash("Temp-Pw-9!aB", 4);
      usersRepository.findOne.mockResolvedValue({
        id: "deleg-4",
        email: "shared4@example.com",
        authProvider: "local",
        passwordHash: tempPwHash,
      });
      delegationService.isDelegateUser.mockResolvedValue(true);
      delegationService.isFullAccount.mockResolvedValue(false);

      await expect(
        service.register({
          email: "shared4@example.com",
          password: "StrongPass123!",
        }),
      ).rejects.toThrow(/temporary password/i);

      await expect(
        service.register({
          email: "shared4@example.com",
          password: "StrongPass123!",
          currentPassword: "WrongPassword!",
        }),
      ).rejects.toThrow(/temporary password/i);
    });

    describe("delegate claim hardening", () => {
      const claimRow = async (extra: Record<string, unknown> = {}) => {
        const row = {
          id: "deleg-guard",
          email: "shared-guard@example.com",
          authProvider: "local",
          passwordHash: await bcrypt.hash("Temp-Pw-9!aB", 4),
          failedLoginAttempts: 0,
          lockedUntil: null,
          ...extra,
        };
        usersRepository.findOne.mockResolvedValue(row);
        delegationService.isDelegateUser.mockResolvedValue(true);
        delegationService.isFullAccount.mockResolvedValue(false);
        passwordBreachService.isBreached.mockResolvedValue(false);
        usersRepository.save.mockImplementation(async (u: any) => u);
        return row;
      };
      const claim = (currentPassword = "Temp-Pw-9!aB") =>
        service.register({
          email: "shared-guard@example.com",
          password: "StrongPass123!",
          currentPassword,
        });
      const failedAttemptWrites = () =>
        scopedManager.query.mock.calls.filter(
          (c) =>
            String(c[0]).includes("failed_login_attempts") &&
            String(c[0]).includes("RETURNING"),
        );

      it("refuses a locked delegate row without issuing tokens", async () => {
        await claimRow({ lockedUntil: new Date(Date.now() + 60_000) });

        await expect(claim()).rejects.toThrow(ForbiddenException);
        expect(usersRepository.save).not.toHaveBeenCalled();
        expect(refreshTokensRepository.save).not.toHaveBeenCalled();
      });

      it("counts a wrong claim password as a failed attempt", async () => {
        await claimRow();

        await expect(claim("WrongPassword!")).rejects.toThrow(
          UnauthorizedException,
        );
        expect(failedAttemptWrites()).toHaveLength(1);
        expect(failedAttemptWrites()[0][1][0]).toBe("deleg-guard");
      });

      it("refuses a claim on a delegate with active 2FA, with no tokens and no save", async () => {
        await claimRow({ twoFactorSecret: "encrypted-secret" });
        preferencesRepository.findOne.mockResolvedValue({
          twoFactorEnabled: true,
        });

        await expect(claim()).rejects.toThrow(
          /two-factor authentication.*Sign in/i,
        );
        expect(usersRepository.save).not.toHaveBeenCalled();
        expect(refreshTokensRepository.save).not.toHaveBeenCalled();
      });
    });

    it("never claims a row that already owns data (full account)", async () => {
      usersRepository.findOne.mockResolvedValue({
        id: "full-1",
        email: "owner@example.com",
        authProvider: "local",
        passwordHash: "some-hash",
      });
      // A delegate row that has since become a full account: isDelegateUser
      // may still be true, but isFullAccount must veto the claim path.
      delegationService.isDelegateUser.mockResolvedValue(true);
      delegationService.isFullAccount.mockResolvedValue(true);

      await expect(
        service.register({
          email: "owner@example.com",
          password: "StrongPass123!",
          currentPassword: "anything",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("rejects breached password during registration", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      passwordBreachService.isBreached.mockResolvedValue(true);

      await expect(
        service.register({
          email: "new@example.com",
          password: "BreachedPass123!",
        }),
      ).rejects.toThrow("found in a data breach");
    });

    it("requires email verification (no tokens) when SMTP is configured and not the first user", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      emailService.getStatus.mockReturnValue({ configured: true });
      const txManager = setupRegisterTransactionMock(1); // not first user

      const result = await service.register({
        email: "verify@example.com",
        password: "StrongPass123!",
      });

      expect(result.verificationRequired).toBe(true);
      expect(result.verificationToken).toBeDefined();
      // No session is issued until the email is verified.
      expect(result.accessToken).toBeUndefined();
      expect(result.refreshToken).toBeUndefined();

      // The persisted row starts unverified with a hashed (not raw) token.
      const created = txManager.create.mock.calls[0][1];
      expect(created.emailVerified).toBe(false);
      expect(created.emailVerificationToken).toBeDefined();
      expect(created.emailVerificationToken).not.toBe(result.verificationToken);
      expect(created.emailVerificationTokenExpiry).toBeInstanceOf(Date);
    });

    it("auto-verifies the first user even when SMTP is configured", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      emailService.getStatus.mockReturnValue({ configured: true });
      const txManager = setupRegisterTransactionMock(0); // first user

      const result = await service.register({
        email: "admin@example.com",
        password: "StrongPass123!",
      });

      expect(result.verificationRequired).toBeUndefined();
      expect(result.accessToken).toBeDefined();
      const created = txManager.create.mock.calls[0][1];
      expect(created.role).toBe("admin");
      expect(created.emailVerified).toBe(true);
      expect(created.emailVerificationToken).toBeNull();
    });

    it("creates a verified account (immediate login) when SMTP is not configured", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      emailService.getStatus.mockReturnValue({ configured: false });
      const txManager = setupRegisterTransactionMock(1);

      const result = await service.register({
        email: "nosmtp@example.com",
        password: "StrongPass123!",
      });

      expect(result.accessToken).toBeDefined();
      expect(result.verificationRequired).toBeUndefined();
      expect(txManager.create.mock.calls[0][1].emailVerified).toBe(true);
    });

    it("marks a claimed delegate as email-verified", async () => {
      const tempPwHash = await bcrypt.hash("Temp-Pw-9!aB", 4);
      const tempDelegate = {
        id: "deleg-verify",
        email: "shared-verify@example.com",
        authProvider: "local",
        passwordHash: tempPwHash,
        emailVerified: false,
        resetToken: null,
        resetTokenExpiry: null,
      };
      usersRepository.findOne.mockResolvedValue(tempDelegate);
      delegationService.isDelegateUser.mockResolvedValue(true);
      delegationService.isFullAccount.mockResolvedValue(false);
      usersRepository.save.mockImplementation(async (u: any) => u);

      await service.register({
        email: "shared-verify@example.com",
        password: "StrongPass123!",
        currentPassword: "Temp-Pw-9!aB",
      });

      expect(tempDelegate.emailVerified).toBe(true);
    });
  });

  describe("login", () => {
    /**
     * Stage what the single guarded failed-attempt CTE UPDATE committed.
     *
     * `recordFailedAttempt` runs ONE statement that increments the counter and,
     * in the same UPDATE, applies the lockout when the increment crosses the
     * threshold (findings 1 and 2) -- there is no second lockout write. It
     * returns, in the driver's `[rows, rowCount]` tuple, the post-update count
     * plus the pre- and post-update `locked_until`, and the service derives
     * `justLocked` from old-vs-new: true only for the write that moved the row
     * from not-locked to locked, so the lockout email fires once per transition
     * rather than once per attempt above the threshold (finding 6).
     *
     * Matched on `failed_login_attempts` + `RETURNING`, which distinguishes the
     * CTE increment from the success reset (`SET failed_login_attempts = 0`, no
     * RETURNING). The old count arithmetic (`user.failedLoginAttempts + 1`)
     * across a ~100ms bcrypt comparison let parallel attempts all write `1` and
     * never lock (audit P4-012); the count now comes from the database.
     */
    function stageFailedAttempt(opts: {
      attempts: number;
      oldLockedUntil?: Date | null;
      newLockedUntil?: Date | null;
    }) {
      scopedManager.query.mockImplementation(async (sql: string) => {
        const text = String(sql);
        if (
          text.includes("failed_login_attempts") &&
          text.includes("RETURNING")
        ) {
          return [
            [
              {
                attempts: opts.attempts,
                new_locked_until: opts.newLockedUntil ?? null,
                old_locked_until: opts.oldLockedUntil ?? null,
              },
            ],
            1,
          ];
        }
        return [];
      });
    }

    /** The single failed-attempt CTE UPDATE the login emitted, if any. */
    function failedAttemptCall() {
      return scopedManager.query.mock.calls.find(
        (c) =>
          String(c[0]).includes("failed_login_attempts") &&
          String(c[0]).includes("RETURNING"),
      );
    }

    it("returns token pair for valid credentials", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      const user = { ...mockUser, passwordHash: hashedPassword };
      usersRepository.findOne.mockResolvedValue(user);
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.save.mockResolvedValue(user);

      const result = await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      expect(result.user).toBeDefined();
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect((service as any).logger.log).toHaveBeenCalledWith(
        expect.stringContaining("Login successful for user"),
      );
    });

    it("stamps last_login alone, never saving the pre-bcrypt snapshot over the counter reset", async () => {
      // A whole-entity save wrote failed_login_attempts = 4 back over the SQL
      // reset to 0 (A26-M01); test/integration/credential-writes-atomic holds
      // the stored state.
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      const user = {
        ...mockUser,
        passwordHash: hashedPassword,
        failedLoginAttempts: 4,
        lockedUntil: new Date(Date.now() - 60_000),
      };
      usersRepository.findOne.mockResolvedValue(user);
      preferencesRepository.findOne.mockResolvedValue(null);

      await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      expect(usersRepository.save).not.toHaveBeenCalled();
      expect(usersRepository.update).toHaveBeenCalledWith(
        { id: user.id },
        { lastLogin: expect.any(Date) },
      );
      expect(user.failedLoginAttempts).toBe(0);
      expect(user.lockedUntil).toBeNull();
    });

    it("re-wraps the backup key so automatic backups can be encrypted", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      const user = { ...mockUser, passwordHash: hashedPassword };
      usersRepository.findOne.mockResolvedValue(user);
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.save.mockResolvedValue(user);

      await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      // Signing in is the only moment the server holds the plaintext, and the
      // user is never asked to configure backup encryption. The hash it was
      // verified against goes with it, so the wrap is bound to that hash.
      expect(backupEncryptionService.rewrapBackupKey).toHaveBeenCalledWith(
        user.id,
        "ValidPass123!",
        hashedPassword,
      );
    });

    it("re-wraps the backup key before the 2FA challenge", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      const user = {
        ...mockUser,
        passwordHash: hashedPassword,
        twoFactorSecret: "secret",
      };
      usersRepository.findOne.mockResolvedValue(user);
      preferencesRepository.findOne.mockResolvedValue({
        twoFactorEnabled: true,
      });

      const result = await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      // The password is already proven correct here, and this exit returns
      // without reaching the code below it.
      expect(result.requires2FA).toBe(true);
      expect(backupEncryptionService.rewrapBackupKey).toHaveBeenCalledWith(
        user.id,
        "ValidPass123!",
        hashedPassword,
      );
    });

    it("captures nothing when the password is wrong", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await expect(
        service.login({ email: "test@example.com", password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);
      expect(backupEncryptionService.rewrapBackupKey).not.toHaveBeenCalled();
    });

    it("signs in even when the backup key cannot be wrapped", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      const user = { ...mockUser, passwordHash: hashedPassword };
      usersRepository.findOne.mockResolvedValue(user);
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.save.mockResolvedValue(user);
      backupEncryptionService.rewrapBackupKey.mockRejectedValue(
        new Error("db down"),
      );

      const result = await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      expect(result.accessToken).toBeDefined();
    });

    it("refuses password login for an SSO account that kept a local password hash", async () => {
      // A link clears passwordHash, but one made before that (or a hash set
      // since) must never sign in with no second factor: the OIDC login strips
      // the TOTP secret.
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: hashedPassword,
      });
      const compare = jest.spyOn(bcrypt, "compare");
      compare.mockClear();

      await expect(
        service.login({ email: "test@example.com", password: "ValidPass123!" }),
      ).rejects.toThrow(/Invalid credentials/);
      expect(compare).not.toHaveBeenCalled();
      expect(usersRepository.save).not.toHaveBeenCalled();
      expect(refreshTokensRepository.save).not.toHaveBeenCalled();
    });

    it("with OIDC_ALLOW_PASSWORD_LOGIN signs an SSO account in with its password", async () => {
      (service as any).oidcPasswordLogin = true;
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: hashedPassword,
      });

      const result = await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      expect(result.accessToken).toBeDefined();
    });

    it("with OIDC_ALLOW_PASSWORD_LOGIN still challenges an SSO account that has TOTP", async () => {
      (service as any).oidcPasswordLogin = true;
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: hashedPassword,
        twoFactorSecret: "encrypted-secret",
      });
      preferencesRepository.findOne.mockResolvedValue({
        twoFactorEnabled: true,
      });

      const result = await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      expect(result.requires2FA).toBe(true);
      expect(result).not.toHaveProperty("accessToken");
    });

    it("with OIDC_ALLOW_PASSWORD_LOGIN still refuses a wrong password for an SSO account", async () => {
      (service as any).oidcPasswordLogin = true;
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: await bcrypt.hash("ValidPass123!", 10),
      });

      await expect(
        service.login({ email: "test@example.com", password: "wrong" }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("throws for non-existent user", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.login({ email: "nobody@example.com", password: "pass" }),
      ).rejects.toThrow(UnauthorizedException);
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Login failed: no matching account"),
      );
    });

    it("throws for wrong password", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await expect(
        service.login({ email: "test@example.com", password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Login failed: invalid password"),
      );
    });

    it("throws for inactive user", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        isActive: false,
      });

      await expect(
        service.login({ email: "test@example.com", password: "ValidPass123!" }),
      ).rejects.toThrow("Account is deactivated");
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Login failed: account deactivated"),
      );
    });

    it("returns 2FA required when enabled", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        twoFactorSecret: "encrypted-secret",
      });
      preferencesRepository.findOne.mockResolvedValue({
        twoFactorEnabled: true,
      });

      const result = await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      expect(result.requires2FA).toBe(true);
      expect(result.tempToken).toBeDefined();
      expect(result).not.toHaveProperty("accessToken");
      expect((service as any).logger.log).toHaveBeenCalledWith(
        expect.stringContaining("Login requires 2FA"),
      );
    });

    it("does not ask for a code when the flag is on but no secret is stored", async () => {
      // Sign-in, status and preferences all read 2FA through
      // `isTwoFactorActive`; a flag left over a cleared secret admits the
      // password alone, and the other two surfaces now report it that way.
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      const user = {
        ...mockUser,
        passwordHash: hashedPassword,
        twoFactorSecret: null,
      };
      usersRepository.findOne.mockResolvedValue(user);
      usersRepository.save.mockResolvedValue(user);
      preferencesRepository.findOne.mockResolvedValue({
        twoFactorEnabled: true,
      });

      const result = await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      expect(result).not.toHaveProperty("requires2FA");
      expect(result.accessToken).toBeDefined();
    });

    it("rejects login when account is locked", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        lockedUntil: new Date(Date.now() + 60000),
      });

      await expect(
        service.login({ email: "test@example.com", password: "any" }),
      ).rejects.toThrow(ForbiddenException);
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("account locked"),
      );
    });

    describe("known login device (#2181)", () => {
      const PASSWORD = "CorrectPass";
      let hash: string;
      beforeAll(async () => {
        hash = await bcrypt.hash(PASSWORD, 4);
      });
      const lockedUser = () => ({
        ...mockUser,
        passwordHash: hash,
        failedLoginAttempts: 7,
        lockedUntil: new Date(Date.now() + 60 * 60 * 1000),
      });
      const deviceKey = () => (service as any).loginDeviceKey as string;
      /** The cookie jar of a browser that signed in as `userId` under `pwHash`. */
      const jar = (
        userId: string,
        pwHash: string,
        now: number = Date.now(),
      ) => ({
        [loginDeviceCookieName(deviceKey(), userId)]: issueLoginDeviceCookie(
          deviceKey(),
          userId,
          pwHash,
          now,
        ),
      });
      const attempt = (password: string, cookies?: Record<string, unknown>) =>
        service.login(
          { email: "test@example.com", password },
          undefined,
          undefined,
          cookies,
        );
      const counters = () => (service as any).attemptCounters;
      const accountResetCall = () =>
        scopedManager.query.mock.calls.find((c) =>
          String(c[0]).includes("SET failed_login_attempts = 0"),
        );

      it("issues a cookie bound to the current password, and none to an account that cannot use one", async () => {
        usersRepository.findOne.mockResolvedValueOnce({
          ...mockUser,
          passwordHash: hash,
        });
        const cookie = await service.issueLoginDeviceCookie(mockUser.id);
        expect(cookie?.name).toBe(
          loginDeviceCookieName(deviceKey(), mockUser.id),
        );
        expect(
          verifyLoginDeviceCookie(
            deviceKey(),
            mockUser.id,
            hash,
            cookie?.value,
          ),
        ).toBe(true);

        usersRepository.findOne.mockResolvedValueOnce({
          ...mockUser,
          passwordHash: null,
        });
        await expect(
          service.issueLoginDeviceCookie(mockUser.id),
        ).resolves.toBeNull();

        // SSO account without OIDC_ALLOW_PASSWORD_LOGIN: password sign-in is
        // refused, so there is no password lock to be spared.
        usersRepository.findOne.mockResolvedValueOnce({
          ...mockUser,
          authProvider: "oidc",
          passwordHash: hash,
        });
        await expect(
          service.issueLoginDeviceCookie(mockUser.id),
        ).resolves.toBeNull();
      });

      it("feeds the per-account lockout from every source while the account is unlocked", async () => {
        // Guesses spread over many IPs all land on the one account counter; a
        // cookie changes nothing and writes nothing before the lock.
        usersRepository.findOne.mockResolvedValue({
          ...mockUser,
          passwordHash: hash,
        });
        stageFailedAttempt({ attempts: 1 });

        await expect(attempt("Wrong", jar(mockUser.id, hash))).rejects.toThrow(
          UnauthorizedException,
        );

        expect(failedAttemptCall()).toBeDefined();
        expect(counters().increment).not.toHaveBeenCalled();
      });

      it("refuses every login under the lock that lacks this account's live cookie", async () => {
        usersRepository.findOne.mockResolvedValue(lockedUser());
        const otherAccount = jar("another-user", hash);
        const supersededHash = jar(mockUser.id, await bcrypt.hash("Old", 4));
        const expired = jar(
          mockUser.id,
          hash,
          Date.now() - 181 * 24 * 60 * 60 * 1000,
        );
        const misfiled = {
          [loginDeviceCookieName(deviceKey(), mockUser.id)]:
            Object.values(otherAccount)[0],
        };
        const forged = {
          [loginDeviceCookieName(deviceKey(), mockUser.id)]: "abc.def.ghi",
        };

        for (const cookies of [
          undefined,
          otherAccount,
          supersededHash,
          expired,
          misfiled,
          forged,
        ]) {
          await expect(attempt(PASSWORD, cookies)).rejects.toThrow(
            ForbiddenException,
          );
        }
      });

      it("lets the owner in from a known device while strangers keep the account locked", async () => {
        usersRepository.findOne.mockResolvedValue(lockedUser());
        preferencesRepository.findOne.mockResolvedValue(null);

        const result = await attempt(PASSWORD, jar(mockUser.id, hash));

        expect(result.accessToken).toBeDefined();
        // The strangers' lock and count stand; clearing them would hand them a
        // fresh allowance every time the owner signs in.
        expect(accountResetCall()).toBeUndefined();
        expect(counters().reset).toHaveBeenCalledWith(
          "login-device",
          expect.any(String),
        );
      });

      it("hands a 2FA account on a known device to the second factor, not to the lock", async () => {
        usersRepository.findOne.mockResolvedValue({
          ...lockedUser(),
          twoFactorSecret: "secret",
        });
        preferencesRepository.findOne.mockResolvedValue({
          twoFactorEnabled: true,
        });

        const result = await attempt(PASSWORD, jar(mockUser.id, hash));

        expect(result.requires2FA).toBe(true);
        expect(accountResetCall()).toBeUndefined();
      });

      it("does not spare a known device a lock the 2FA budget set", async () => {
        usersRepository.findOne.mockResolvedValue(lockedUser());
        counters().rows.set(`2fa-lock\u0000${mockUser.id}`, {
          count: 1,
          windowExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
        });

        await expect(attempt(PASSWORD, jar(mockUser.id, hash))).rejects.toThrow(
          ForbiddenException,
        );
      });

      it("counts a known device's failures on its own budget, then locks it out too", async () => {
        usersRepository.findOne.mockResolvedValue(lockedUser());
        const cookies = jar(mockUser.id, hash);

        for (let i = 0; i < 10; i++) {
          await expect(attempt("Wrong", cookies)).rejects.toThrow(
            UnauthorizedException,
          );
        }
        expect(failedAttemptCall()).toBeUndefined();

        await expect(attempt(PASSWORD, cookies)).rejects.toThrow(
          ForbiddenException,
        );
      });
    });

    it("allows login when lock has expired", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        lockedUntil: new Date(Date.now() - 1000),
        failedLoginAttempts: 5,
      });
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.save.mockResolvedValue(mockUser);

      const result = await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      expect(result.user).toBeDefined();
      expect(result.accessToken).toBeDefined();
    });

    it("increments failed attempts in one guarded SQL statement on wrong password", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      stageFailedAttempt({
        attempts: 3,
        oldLockedUntil: null,
        newLockedUntil: null,
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        failedLoginAttempts: 2,
      });

      await expect(
        service.login({ email: "test@example.com", password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);

      // The counter is incremented by the database in a single statement, not by
      // writing an absolute value derived from the pre-bcrypt read. Its params
      // carry the id, the threshold, and the base lockout window.
      const increment = failedAttemptCall();
      expect(increment).toBeDefined();
      // Threshold, base window, the cap on doublings (4 hours at most) and the
      // decay window after which an expired lock's escalation is forgotten.
      expect(increment![1]).toEqual([
        mockUser.id,
        5,
        30 * 60 * 1000,
        3,
        24 * 60 * 60 * 1000,
      ]);
      // The lockout is folded into that same UPDATE (a CASE on the threshold),
      // so no separate query-builder lockout write remains in the login path.
      expect(usersRepository.createQueryBuilder).not.toHaveBeenCalled();
      // Below the threshold, so no lockout email.
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("locks out on the count the database committed, not the one it read", async () => {
      // The regression guard for P4-012. The entity says 0 attempts; four other
      // parallel requests have since committed theirs, so the increment returns
      // 5 and the same statement writes a future locked_until. Deriving the
      // decision from the snapshot would read 1 and never lock -- exactly how a
      // parallel guessing attack stayed unblocked.
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      stageFailedAttempt({
        attempts: 5,
        oldLockedUntil: null,
        newLockedUntil: new Date(Date.now() + 60 * 60 * 1000),
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        failedLoginAttempts: 0,
      });

      await expect(
        service.login({ email: "test@example.com", password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);

      // The lockout transition (and its email) fire off the committed count of
      // 5, not the snapshot's 0 -- and via one guarded statement, never a
      // snapshot-derived absolute write.
      expect(emailService.sendMail).toHaveBeenCalledWith(
        "test@example.com",
        "Account Temporarily Locked",
        expect.stringContaining("temporarily locked"),
      );
      expect(failedAttemptCall()).toBeDefined();
      expect(usersRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("locks the account and emails on the not-locked -> locked transition", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      stageFailedAttempt({
        attempts: 5,
        oldLockedUntil: null,
        newLockedUntil: new Date(Date.now() + 60 * 60 * 1000),
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        failedLoginAttempts: 4,
      });

      await expect(
        service.login({ email: "test@example.com", password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);

      // A fresh lock (old locked_until null -> future) is a transition, so the
      // lockout email fires exactly once for it (finding 6).
      expect(emailService.sendMail).toHaveBeenCalledWith(
        "test@example.com",
        "Account Temporarily Locked",
        expect.stringContaining("temporarily locked"),
      );
      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    });

    it("does not email again when the account was already locked (finding 6)", async () => {
      // A later failure that commits a count still >= MAX but finds the row
      // already locked (old locked_until already in the future) is not a
      // transition. The old per-attempt model mailed the victim on every failure
      // above the threshold; only the crossing may.
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      const future = new Date(Date.now() + 60 * 60 * 1000);
      stageFailedAttempt({
        attempts: 6,
        oldLockedUntil: future,
        newLockedUntil: future,
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        failedLoginAttempts: 5,
      });

      await expect(
        service.login({ email: "test@example.com", password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("emails only the failure that crosses into locked, not both concurrent ones (finding 6)", async () => {
      // Two parallel failures both commit a count >= MAX. The old per-attempt
      // model mailed the victim twice for one lockout. Now the CTE returns
      // old/new locked_until and only the write that moved not-locked -> locked
      // reports justLocked: a transitioning row on the first failure, an
      // already-locked row on the second.
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      const future = new Date(Date.now() + 60 * 60 * 1000);
      let call = 0;
      scopedManager.query.mockImplementation(async (sql: string) => {
        const text = String(sql);
        if (
          text.includes("failed_login_attempts") &&
          text.includes("RETURNING")
        ) {
          call += 1;
          return call === 1
            ? [
                [
                  {
                    attempts: 5,
                    old_locked_until: null,
                    new_locked_until: future,
                  },
                ],
                1,
              ]
            : [
                [
                  {
                    attempts: 6,
                    old_locked_until: future,
                    new_locked_until: future,
                  },
                ],
                1,
              ];
        }
        return [];
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        failedLoginAttempts: 4,
      });

      await expect(
        service.login({ email: "test@example.com", password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.login({ email: "test@example.com", password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);

      // One lockout, one email.
      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    });

    it("does not send lockout email for users without email", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      // A genuine transition, but no address to send to.
      stageFailedAttempt({
        attempts: 5,
        oldLockedUntil: null,
        newLockedUntil: new Date(Date.now() + 60 * 60 * 1000),
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        email: null,
        passwordHash: hashedPassword,
        failedLoginAttempts: 4,
      });

      await expect(
        service.login({ email: "test@example.com", password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("resets failed attempts on successful login", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        failedLoginAttempts: 3,
      });
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.save.mockResolvedValue(mockUser);

      await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      // Unconditional raw SQL, guarded by a WHERE rather than by the snapshot: a
      // failure that committed between the read and here would otherwise leave
      // the counter standing after a proven-correct password, and the predicate
      // keeps it a no-op when there is nothing to clear.
      const reset = scopedManager.query.mock.calls.find((c) =>
        String(c[0]).includes("SET failed_login_attempts = 0"),
      );
      expect(reset).toBeDefined();
      expect(String(reset![0])).toContain("locked_until = NULL");
      expect(String(reset![0])).toContain(
        "(failed_login_attempts <> 0 OR locked_until IS NOT NULL)",
      );
      expect(reset![1]).toEqual([mockUser.id]);
    });

    it("emits the exponential-backoff lockout shape in the failed-attempt SQL", async () => {
      // The progressive duration (BASE * 2^(floor(attempts / MAX) - 1)) is now
      // computed by Postgres inside the guarded UPDATE, so it matches the count
      // the same statement committed. A mocked-query unit test cannot observe the
      // interval a real database would compute, so assert the statement carries
      // the backoff shape; a live DB exercises the actual duration.
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      stageFailedAttempt({
        attempts: 10, // 2nd lockout tier
        oldLockedUntil: null,
        newLockedUntil: new Date(Date.now() + 2 * 60 * 60 * 1000),
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        failedLoginAttempts: 9,
      });

      await expect(
        service.login({ email: "test@example.com", password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);

      const increment = failedAttemptCall();
      expect(increment).toBeDefined();
      const sql = String(increment![0]);
      // The backoff shape: an exponent via power(2, ...) over a tier via
      // floor(attempts / MAX). (The SQL wraps arguments across lines, so match
      // the function names, not `power(2,` verbatim.)
      expect(sql).toContain("power(");
      expect(sql).toContain("floor(");
      // The window is added to CURRENT_TIMESTAMP inside the same statement.
      expect(sql).toContain("CURRENT_TIMESTAMP");
    });

    it("blocks login (no tokens) when the email is not verified", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        emailVerified: false,
      });

      const result = await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      expect(result.emailNotVerified).toBe(true);
      expect(result).not.toHaveProperty("accessToken");
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("email not verified"),
      );
    });
  });

  describe("verify2FA", () => {
    it("throws for invalid temp token", async () => {
      (jwtService.verify as jest.Mock).mockImplementation(() => {
        throw new Error("invalid token");
      });

      await expect(service.verify2FA("bad-token", "123456")).rejects.toThrow(
        UnauthorizedException,
      );
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        "2FA verification failed: invalid or expired token",
      );
    });

    it("throws for wrong token type", async () => {
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "access",
      });

      await expect(service.verify2FA("token", "123456")).rejects.toThrow(
        "Invalid token type",
      );
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("2FA verification failed: invalid token type"),
      );
    });
  });

  describe("findOrCreateOidcUser OIDC_REQUIRE_VERIFIED_EMAIL", () => {
    const oidcProfile = {
      sub: "oidc-sub-123",
      email: "User@Example.com",
      email_verified: false,
      name: "Test User",
    };

    it("by default does not trust an unverified email (falls through to registration, which is gated)", async () => {
      // No oidcSubject match; email not verified and verification is required,
      // so the email-merge path is skipped and it reaches the disabled
      // registration guard.
      usersRepository.findOne.mockResolvedValueOnce(null);
      await expect(
        service.findOrCreateOidcUser(oidcProfile, false),
      ).rejects.toThrow("New account registration is disabled.");
    });

    it("merges directly into an account that is already SSO and kept its password (no confirmation email)", async () => {
      const existing: any = {
        id: "u1",
        email: "user@example.com",
        passwordHash: "hash",
        authProvider: "oidc",
        oidcSubject: "old-sub",
      };
      usersRepository.findOne
        .mockResolvedValueOnce(null) // by oidcSubject
        .mockResolvedValueOnce(existing); // by email
      usersRepository.save.mockImplementation(async (u: any) => u);
      const sendSpy = jest
        .spyOn(service as any, "sendOidcLinkEmail")
        .mockResolvedValue(undefined);

      const result = await service.findOrCreateOidcUser(
        { ...oidcProfile, email_verified: true },
        false,
      );

      expect(result.linkPending).toBeFalsy();
      expect(existing.oidcSubject).toBe("oidc-sub-123");
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("with OIDC_REQUIRE_VERIFIED_EMAIL=false merges directly into a matching password account (no confirmation email)", async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === "JWT_SECRET")
          return "test-jwt-secret-minimum-32-chars-long";
        if (key === "OIDC_REQUIRE_VERIFIED_EMAIL") return "false";
        return undefined;
      });
      const existing: any = {
        id: "u1",
        email: "user@example.com",
        passwordHash: "hash",
        authProvider: "local",
      };
      usersRepository.findOne
        .mockResolvedValueOnce(null) // by oidcSubject
        .mockResolvedValueOnce(existing); // by email
      usersRepository.save.mockImplementation(async (u: any) => u);
      const sendSpy = jest
        .spyOn(service as any, "sendOidcLinkEmail")
        .mockResolvedValue(undefined);

      const result = await service.findOrCreateOidcUser(oidcProfile, false);

      expect(result.linkPending).toBeFalsy();
      expect(result.user).toBe(existing);
      expect(existing.oidcSubject).toBe("oidc-sub-123");
      expect(existing.authProvider).toBe("oidc");
      // The password stays; the credentials issued under the old method end
      // with the change, as on the confirmed link (INV-AUTH-005).
      expect(existing.passwordHash).toBe("hash");
      expect(patRepository.update).toHaveBeenCalledWith(
        { userId: "u1", isRevoked: false },
        { isRevoked: true },
      );
      expect(oauthProviderService.revokeAllForUser).toHaveBeenCalledWith("u1");
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("with OIDC_REQUIRE_VERIFIED_EMAIL=false also merges directly on the duplicate-email (23505) catch path", async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === "JWT_SECRET")
          return "test-jwt-secret-minimum-32-chars-long";
        if (key === "OIDC_REQUIRE_VERIFIED_EMAIL") return "false";
        return undefined;
      });
      const existing: any = {
        id: "u1",
        email: "user@example.com",
        passwordHash: "hash",
        authProvider: "local",
      };
      usersRepository.findOne
        .mockResolvedValueOnce(null) // by oidcSubject
        .mockResolvedValueOnce(null) // primary by-email lookup misses -> create
        .mockResolvedValueOnce(existing); // catch path re-lookup by email
      // Force the create INSERT to fail with a unique-violation so we exercise
      // the duplicate-email catch path (not the primary merge path).
      failCreateTransaction({ code: "23505" });
      usersRepository.save.mockImplementation(async (u: any) => u);
      const sendSpy = jest
        .spyOn(service as any, "sendOidcLinkEmail")
        .mockResolvedValue(undefined);

      const result = await service.findOrCreateOidcUser(oidcProfile, true);

      expect(result.linkPending).toBeFalsy();
      expect(result.user).toBe(existing);
      expect(existing.oidcSubject).toBe("oidc-sub-123");
      expect(existing.authProvider).toBe("oidc");
      expect(existing.passwordHash).toBe("hash");
      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  describe("sanitizeUser", () => {
    it("strips sensitive fields from user", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const txManager = {
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockImplementation((_entity, data) => ({
          ...data,
          id: "user-1",
          passwordHash: "$2a$10$hash",
          resetToken: "reset",
          resetTokenExpiry: new Date(),
          twoFactorSecret: "secret",
        })),
        save: jest.fn().mockImplementation((user) => user),
      };
      installTransactionMock(txManager);

      const result = await service.register({
        email: "test@example.com",
        password: "StrongPass123!",
      });

      expect(result.user).not.toHaveProperty("passwordHash");
      expect(result.user).not.toHaveProperty("resetToken");
      expect(result.user).not.toHaveProperty("resetTokenExpiry");
      expect(result.user).not.toHaveProperty("twoFactorSecret");
      expect(result.user).not.toHaveProperty("failedLoginAttempts");
      expect(result.user).not.toHaveProperty("lockedUntil");
      expect(result.user).toHaveProperty("hasPassword");
    });
  });

  describe("resetPassword", () => {
    function mockQueryBuilder(executeResult: { affected: number; raw: any[] }) {
      const builder = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(executeResult),
      };
      usersRepository.createQueryBuilder.mockReturnValue(builder);
      return builder;
    }

    it("throws for invalid token", async () => {
      mockQueryBuilder({ affected: 0, raw: [] });

      await expect(
        service.resetPassword("invalid-token", "NewPass123!"),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws for expired token", async () => {
      mockQueryBuilder({ affected: 0, raw: [] });

      await expect(
        service.resetPassword("expired-token", "NewPass123!"),
      ).rejects.toThrow(BadRequestException);
    });

    it("revokes all refresh tokens after password reset", async () => {
      mockQueryBuilder({ affected: 1, raw: [{ id: mockUser.id }] });
      refreshTokensRepository.update.mockResolvedValue({ affected: 1 });

      stageOneTokenFamily();
      await service.resetPassword("valid-token", "NewPass123!");

      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: mockUser.id, familyId: In(["family-1"]), isRevoked: false },
        { isRevoked: true },
      );
    });

    it("rejects breached password during reset", async () => {
      passwordBreachService.isBreached.mockResolvedValue(true);

      await expect(
        service.resetPassword("valid-token", "BreachedPass123!"),
      ).rejects.toThrow("found in a data breach");
    });
  });

  describe("revokeRefreshToken", () => {
    it("does nothing for empty token", async () => {
      await service.revokeRefreshToken("");
      expect(refreshTokensRepository.findOne).not.toHaveBeenCalled();
    });

    it("revokes entire family when token found", async () => {
      refreshTokensRepository.findOne.mockResolvedValue({
        familyId: "family-1",
      });
      refreshTokensRepository.update.mockResolvedValue({ affected: 1 });

      await service.revokeRefreshToken("some-token");

      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { familyId: "family-1" },
        { isRevoked: true },
      );
    });
  });

  describe("revokeAllUserRefreshTokens", () => {
    it("revokes all non-revoked tokens for user", async () => {
      refreshTokensRepository.update.mockResolvedValue({ affected: 3 });

      stageOneTokenFamily();
      await service.revokeAllUserRefreshTokens("user-1");

      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: "user-1", familyId: In(["family-1"]), isRevoked: false },
        { isRevoked: true },
      );
    });
  });

  describe("generateTokenPair", () => {
    it("returns access and refresh tokens", async () => {
      const result = await service.generateTokenPair(mockUser as any);

      expect(result).toHaveProperty("accessToken");
      expect(result).toHaveProperty("refreshToken");
      expect(result.accessToken).toBe("mock-jwt-token");
      expect(result.refreshToken).toBeTruthy();
      expect(refreshTokensRepository.save).toHaveBeenCalled();
    });

    it("stores hashed refresh token in DB", async () => {
      await service.generateTokenPair(mockUser as any);

      const savedEntity = refreshTokensRepository.save.mock.calls[0][0];
      expect(savedEntity.tokenHash).toBeTruthy();
      expect(savedEntity.familyId).toBeTruthy();
      expect(savedEntity.isRevoked).toBe(false);
      expect(savedEntity.userId).toBe(mockUser.id);
    });
  });

  // ---------------------------------------------------------------
  // setup2FA
  // ---------------------------------------------------------------

  describe("setup2FA", () => {
    it("generates secret, QR code, and stores encrypted secret", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });
      usersRepository.save.mockImplementation((u) => u);
      jest.spyOn(bcrypt, "compare").mockResolvedValueOnce(true as never);

      const result = await service.setup2FA("user-1", "correct-password");

      expect(result.secret).toBe("TESTSECRET");
      expect(result.qrCodeDataUrl).toBe("data:image/png;base64,mockqrcode");
      expect(result.otpauthUrl).toContain("otpauth://");
      expect(otplib.generateSecret).toHaveBeenCalled();
      expect(otplib.generateURI).toHaveBeenCalledWith(
        expect.objectContaining({
          secret: "TESTSECRET",
          issuer: "Monize",
          label: mockUser.email,
        }),
      );
      expect(QRCode.toDataURL).toHaveBeenCalled();

      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.pendingTwoFactorSecret).toBeTruthy();
      expect(savedUser.pendingTwoFactorSecret).not.toBe("TESTSECRET"); // should be encrypted
    });

    it("throws NotFoundException when user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(service.setup2FA("nonexistent", "pw")).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.setup2FA("nonexistent", "pw")).rejects.toThrow(
        "User not found",
      );
    });

    it("throws BadRequestException for SSO users", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
      });

      await expect(service.setup2FA("user-1", "pw")).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.setup2FA("user-1", "pw")).rejects.toThrow(
        "Two-factor authentication is not available for SSO accounts",
      );
    });

    it("rejects when current password does not match", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });
      jest.spyOn(bcrypt, "compare").mockResolvedValueOnce(false as never);

      await expect(service.setup2FA("user-1", "wrong")).rejects.toThrow(
        "Current password is incorrect",
      );
      expect(usersRepository.save).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // confirmSetup2FA
  // ---------------------------------------------------------------

  describe("confirmSetup2FA", () => {
    it("validates code and enables 2FA in preferences", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        pendingTwoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      usersRepository.save.mockImplementation((u) => u);
      preferencesRow.seed({ userId: "user-1", twoFactorEnabled: false });

      const result = await service.confirmSetup2FA("user-1", "123456");

      expect(result.message).toContain("enabled successfully");
      expect(otplib.verifySync).toHaveBeenCalledWith(
        expect.objectContaining({ token: "123456", secret: "TESTSECRET" }),
      );
      // H5: pending secret promoted to active, pending cleared
      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.twoFactorSecret).toBe(encryptedSecret);
      expect(savedUser.pendingTwoFactorSecret).toBeNull();
      expect(preferencesRow.row()!.twoFactorEnabled).toBe(true);
    });

    it("creates preferences if they do not exist yet", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        pendingTwoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      usersRepository.save.mockImplementation((u) => u);
      preferencesRow.seed(null);

      await service.confirmSetup2FA("user-1", "123456");

      expect(preferencesRow.insertAttempts()[0]).toEqual(
        expect.objectContaining({ userId: "user-1" }),
      );
      expect(preferencesRow.row()!.twoFactorEnabled).toBe(true);
    });

    it("throws for invalid verification code", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        pendingTwoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(service.confirmSetup2FA("user-1", "000000")).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.confirmSetup2FA("user-1", "000000")).rejects.toThrow(
        "Invalid verification code",
      );
    });

    it("throws when 2FA setup not initiated (no user)", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(service.confirmSetup2FA("user-1", "123456")).rejects.toThrow(
        "2FA setup not initiated",
      );
    });

    it("throws when 2FA setup not initiated (no secret)", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        pendingTwoFactorSecret: null,
      });

      await expect(service.confirmSetup2FA("user-1", "123456")).rejects.toThrow(
        "2FA setup not initiated",
      );
    });
  });

  // ---------------------------------------------------------------
  // disable2FA
  // ---------------------------------------------------------------

  describe("reset2FA", () => {
    it("hands the whole request to TwoFactorService, the session to keep included", async () => {
      const twoFactor = (service as any).twoFactorService as TwoFactorService;
      const reset = jest
        .spyOn(twoFactor, "reset2FA")
        .mockResolvedValue({ message: "ok" });

      await expect(
        service.reset2FA("user-1", "pw", "abcd-ef01", "current-refresh"),
      ).resolves.toEqual({ message: "ok" });
      expect(reset).toHaveBeenCalledWith(
        "user-1",
        "pw",
        "abcd-ef01",
        "current-refresh",
      );
    });
  });

  describe("disable2FA", () => {
    it("validates code, clears secret, disables preferences, revokes trusted devices", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      usersRepository.save.mockImplementation((u) => u);
      preferencesRow.seed({ userId: "user-1", twoFactorEnabled: true });
      trustedDevicesRepository.delete.mockResolvedValue({ affected: 2 });

      const result = await service.disable2FA("user-1", "123456");

      expect(result.message).toContain("disabled successfully");

      // Secret should be cleared
      expect(usersRepository.update).toHaveBeenCalledWith(
        { id: "user-1" },
        { twoFactorSecret: null, backupCodes: null },
      );

      // Preferences should be disabled
      expect(preferencesRow.row()!.twoFactorEnabled).toBe(false);

      // Trusted devices should be revoked
      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: "user-1",
      });
    });

    it("throws ForbiddenException when FORCE_2FA is enabled", async () => {
      configService.get.mockImplementation(
        (key: string, defaultValue?: string) => {
          if (key === "JWT_SECRET")
            return "test-jwt-secret-minimum-32-chars-long";
          if (key === "FORCE_2FA") return "true";
          return defaultValue || undefined;
        },
      );

      await expect(service.disable2FA("user-1", "123456")).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.disable2FA("user-1", "123456")).rejects.toThrow(
        "required by the administrator",
      );
    });

    it("throws for invalid verification code", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(service.disable2FA("user-1", "000000")).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.disable2FA("user-1", "000000")).rejects.toThrow(
        "Invalid verification code",
      );
    });

    it("throws when 2FA is not enabled", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: null,
      });

      await expect(service.disable2FA("user-1", "123456")).rejects.toThrow(
        "2FA is not enabled",
      );
    });

    it("throws when user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(service.disable2FA("user-1", "123456")).rejects.toThrow(
        "2FA is not enabled",
      );
    });

    it("clears the flag even when no preferences row exists yet", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      usersRepository.save.mockImplementation((u) => u);
      preferencesRow.seed(null);
      trustedDevicesRepository.delete.mockResolvedValue({ affected: 0 });

      const result = await service.disable2FA("user-1", "123456");

      expect(result.message).toContain("disabled successfully");
      // Previously the write was skipped entirely when no row existed, so a user
      // whose preferences had never materialized stayed flagged as 2FA-enabled.
      expect(preferencesRow.row()!.twoFactorEnabled).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // verify2FA - success path
  // ---------------------------------------------------------------

  describe("verify2FA - success path", () => {
    it("returns tokens on valid code", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.verify2FA("valid-temp-token", "123456");

      expect(result.user).toBeDefined();
      expect(result.accessToken).toBe("mock-jwt-token");
      expect(result.refreshToken).toBeTruthy();
      expect(result.trustedDeviceRef).toBeUndefined();
    });

    it("creates trusted device token when rememberDevice is true", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      usersRepository.save.mockImplementation((u) => u);
      trustedDevicesRepository.create.mockImplementation((data) => data);
      trustedDevicesRepository.save.mockResolvedValue({});

      const result = await service.verify2FA(
        "valid-temp-token",
        "123456",
        true,
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "192.168.1.1",
      );

      expect(result.trustedDeviceRef).toBeTruthy();
      expect(trustedDevicesRepository.save).toHaveBeenCalled();
    });

    it("throws for invalid code during verification", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(
        service.verify2FA("valid-temp-token", "000000"),
      ).rejects.toThrow("Invalid verification code");
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("2FA verification failed: invalid code"),
      );
    });

    it("throws for missing user or secret", async () => {
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.verify2FA("valid-temp-token", "123456"),
      ).rejects.toThrow("Invalid verification state");
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("2FA verification failed: invalid state"),
      );
    });

    it("throws for user with no twoFactorSecret", async () => {
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: null,
      });

      await expect(
        service.verify2FA("valid-temp-token", "123456"),
      ).rejects.toThrow("Invalid verification state");
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("2FA verification failed: invalid state"),
      );
    });

    it("updates lastLogin on successful verification", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      await service.verify2FA("valid-temp-token", "123456");

      expect(usersRepository.update).toHaveBeenCalledWith(
        { id: mockUser.id },
        { lastLogin: expect.any(Date) },
      );
      expect((service as any).logger.log).toHaveBeenCalledWith(
        expect.stringContaining("2FA verification successful"),
      );
    });
  });

  // ---------------------------------------------------------------
  // findOrCreateOidcUser
  // ---------------------------------------------------------------

  describe("findOrCreateOidcUser", () => {
    /**
     * Helper: set up dataSource.transaction mock for findOrCreateOidcUser's
     * SERIALIZABLE transaction: dataSource.transaction("SERIALIZABLE", async (manager) => {...})
     */
    function setupOidcTransactionMock(
      userCount: number,
      overrides: Record<string, jest.Mock> = {},
    ) {
      const txManager = {
        count: jest.fn().mockResolvedValue(userCount),
        create: jest.fn().mockImplementation((_entity, data) => ({
          ...data,
          id: "oidc-new",
        })),
        save: jest.fn().mockImplementation((user) => user),
        findOne: jest.fn(),
        ...overrides,
      };
      return installTransactionMock(txManager);
    }

    it("creates new user with verified email", async () => {
      usersRepository.findOne
        .mockResolvedValueOnce(null) // no existing by oidcSubject
        .mockResolvedValueOnce(null); // no existing by email
      const txManager = setupOidcTransactionMock(1); // not first user
      txManager.create.mockImplementation((_entity, data) => ({
        ...data,
        id: "oidc-user-1",
      }));
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-123",
        email: "oidc@example.com",
        email_verified: true,
        given_name: "OIDC",
        family_name: "User",
      });

      expect(result.user.email).toBe("oidc@example.com");
      expect(result.user.oidcSubject).toBe("oidc-sub-123");
      expect(result.user.authProvider).toBe("oidc");
      expect(result.user.firstName).toBe("OIDC");
      expect(result.user.lastName).toBe("User");
      // Drives the callback's first-run language/currency step.
      expect(result.isNewUser).toBe(true);
    });

    it("keeps the local password an SSO account holds on its next OIDC login", async () => {
      const existing: any = {
        id: "oidc-existing",
        email: "oidc@example.com",
        oidcSubject: "oidc-sub-123",
        authProvider: "oidc",
        passwordHash: "linked-before-1858",
        resetToken: "pending-reset",
      };
      usersRepository.findOne.mockResolvedValueOnce(existing);
      usersRepository.save.mockImplementation((u) => u);

      await service.findOrCreateOidcUser({
        sub: "oidc-sub-123",
        email: "oidc@example.com",
        email_verified: true,
      });

      expect(existing.passwordHash).toBe("linked-before-1858");
      expect(existing.resetToken).toBe("pending-reset");
      expect(existing.oidcSubject).toBe("oidc-sub-123");
      expect(usersRepository.save).toHaveBeenCalledWith(existing);
    });

    it("with OIDC_ALLOW_PASSWORD_LOGIN keeps the password and the TOTP secret on an OIDC login", async () => {
      (service as any).oidcPasswordLogin = true;
      const existing: any = {
        id: "oidc-existing",
        email: "oidc@example.com",
        oidcSubject: "oidc-sub-123",
        authProvider: "oidc",
        passwordHash: "kept-hash",
        resetToken: "pending-reset",
        twoFactorSecret: "totp-secret",
        backupCodes: "[]",
      };
      usersRepository.findOne.mockResolvedValueOnce(existing);
      usersRepository.save.mockImplementation((u) => u);

      await service.findOrCreateOidcUser({
        sub: "oidc-sub-123",
        email: "oidc@example.com",
        email_verified: true,
      });

      expect(existing.passwordHash).toBe("kept-hash");
      expect(existing.resetToken).toBe("pending-reset");
      expect(existing.twoFactorSecret).toBe("totp-secret");
      expect(existing.backupCodes).toBe("[]");
    });

    it("clears the TOTP secret of an SSO account on an OIDC login by default", async () => {
      const existing: any = {
        id: "oidc-existing",
        email: "oidc@example.com",
        oidcSubject: "oidc-sub-123",
        authProvider: "oidc",
        twoFactorSecret: "totp-secret",
      };
      usersRepository.findOne.mockResolvedValueOnce(existing);
      usersRepository.save.mockImplementation((u) => u);

      await service.findOrCreateOidcUser({
        sub: "oidc-sub-123",
        email: "oidc@example.com",
        email_verified: true,
      });

      expect(existing.twoFactorSecret).toBeNull();
    });

    it("does not flag a returning OIDC user as new", async () => {
      const existing = {
        id: "oidc-existing",
        email: "oidc@example.com",
        oidcSubject: "oidc-sub-123",
        authProvider: "oidc",
      };
      usersRepository.findOne.mockResolvedValueOnce(existing);
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-123",
        email: "oidc@example.com",
        email_verified: true,
      });

      expect(result.user.id).toBe("oidc-existing");
      expect(result.isNewUser).toBe(false);
    });

    it("does not flag an account the OIDC identity merely linked to as new", async () => {
      const existing = {
        id: "local-existing",
        email: "oidc@example.com",
        passwordHash: null,
        oidcSubject: null,
        authProvider: "local",
      };
      usersRepository.findOne
        .mockResolvedValueOnce(null) // no match by oidcSubject
        .mockResolvedValueOnce(existing); // matched by verified email
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-123",
        email: "oidc@example.com",
        email_verified: true,
      });

      expect(result.user.id).toBe("local-existing");
      expect(result.isNewUser).toBe(false);
    });

    it("seeds preferences with the request locale for a new OIDC user", async () => {
      usersRepository.findOne
        .mockResolvedValueOnce(null) // no existing by oidcSubject
        .mockResolvedValueOnce(null); // no existing by email
      const txManager = setupOidcTransactionMock(1);
      txManager.create.mockImplementation((_entity, data) => ({
        ...data,
        id: "oidc-user-1",
      }));
      usersRepository.save.mockImplementation((u) => u);
      const spy = jest
        .spyOn(I18nContext, "current")
        .mockReturnValue({ lang: "fr" } as never);

      await service.findOrCreateOidcUser({
        sub: "oidc-sub-fr",
        email: "fr@example.com",
        email_verified: true,
      });

      const savedPrefs = txManager.save.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as { language?: string })?.language !== undefined,
      )?.[0];
      expect(savedPrefs).toBeDefined();
      expect(savedPrefs.userId).toBe("oidc-user-1");
      expect(savedPrefs.language).toBe("fr");
      spy.mockRestore();
    });

    it("creates new user with unverified email (email stored but not linked)", async () => {
      usersRepository.findOne.mockResolvedValue(null); // no existing by subject
      const txManager = setupOidcTransactionMock(1);
      txManager.create.mockImplementation((_entity, data) => ({
        ...data,
        id: "oidc-user-2",
      }));
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-456",
        email: "unverified@example.com",
        email_verified: false,
      });

      // Unverified email should still be stored
      expect(result.user.email).toBe("unverified@example.com");
      // Should NOT have looked up by email (only 1 findOne call for oidcSubject)
      expect(usersRepository.findOne).toHaveBeenCalledTimes(1);
    });

    it("initiates pending link for local account with verified email (M6)", async () => {
      const existingLocal = {
        ...mockUser,
        id: "existing-user",
        authProvider: "local",
        oidcSubject: null,
        passwordHash: "$2a$10$somehash",
        oidcLinkPending: false,
        oidcLinkToken: null,
        oidcLinkExpiresAt: null,
        pendingOidcSubject: null,
      };
      usersRepository.findOne
        .mockResolvedValueOnce(null) // no existing by oidcSubject
        .mockResolvedValueOnce(existingLocal); // found by email
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-link",
        email: "test@example.com",
        email_verified: true,
      });

      expect(result.linkPending).toBe(true);
      expect(result.user.id).toBe("existing-user");
      // M6: Should initiate pending link, NOT direct link
      expect(existingLocal.oidcLinkPending).toBe(true);
      expect(existingLocal.pendingOidcSubject).toBe("oidc-sub-link");
      // oidcSubject should NOT be directly set
      expect(existingLocal.oidcSubject).toBeNull();
    });

    it("directly links OIDC-only accounts without confirmation", async () => {
      const existingOidcOnly = {
        ...mockUser,
        id: "oidc-only-user",
        authProvider: "local",
        oidcSubject: null,
        passwordHash: null, // No password = OIDC-only account
      };
      usersRepository.findOne
        .mockResolvedValueOnce(null) // no existing by oidcSubject
        .mockResolvedValueOnce(existingOidcOnly); // found by email
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-direct",
        email: "test@example.com",
        email_verified: true,
      });

      expect(result.user.id).toBe("oidc-only-user");
      expect(result.user.oidcSubject).toBe("oidc-sub-direct");
      expect(result.user.authProvider).toBe("oidc");
    });

    describe("an existing SSO account found by email", () => {
      const ssoByEmail = (): any => ({
        ...mockUser,
        id: "sso-user",
        authProvider: "oidc",
        oidcSubject: null,
        passwordHash: "kept-hash",
        mustChangePassword: true,
        resetToken: "reset-before-link",
        resetTokenExpiry: new Date(),
      });
      const login = () =>
        service.findOrCreateOidcUser({
          sub: "oidc-sub-merge",
          email: "test@example.com",
          email_verified: true,
        });

      beforeEach(() => {
        usersRepository.save.mockImplementation((u) => u);
      });

      it("merges directly, revokes nothing and clears reset state and the forced change with the flag off", async () => {
        stageOneTokenFamily();
        const existing = ssoByEmail();
        usersRepository.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(existing);

        const result = await login();

        expect(result.linkPending).toBeFalsy();
        expect(existing.oidcSubject).toBe("oidc-sub-merge");
        expect(existing.passwordHash).toBe("kept-hash");
        expect(existing.resetToken).toBeNull();
        expect(existing.resetTokenExpiry).toBeNull();
        expect(existing.mustChangePassword).toBe(false);
        expect(refreshTokensRepository.update).not.toHaveBeenCalled();
      });

      it("asks for link confirmation with the flag on and a password kept", async () => {
        (service as any).oidcPasswordLogin = true;
        const existing = ssoByEmail();
        usersRepository.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(existing);

        const result = await login();

        expect(result.linkPending).toBe(true);
        expect(existing.oidcSubject).toBeNull();
      });
    });

    it("does NOT link to existing user when email is unverified", async () => {
      usersRepository.findOne.mockResolvedValue(null); // no existing by oidcSubject
      const txManager = setupOidcTransactionMock(1);
      txManager.create.mockImplementation((_entity, data) => ({
        ...data,
        id: "new-oidc",
      }));
      usersRepository.save.mockImplementation((u) => u);

      await service.findOrCreateOidcUser({
        sub: "oidc-sub-nolink",
        email: "test@example.com",
        email_verified: false,
      });

      // Only 1 findOne (for oidcSubject), not 2 (no email lookup)
      expect(usersRepository.findOne).toHaveBeenCalledTimes(1);
    });

    it("updates existing user info when changed", async () => {
      const existingOidcUser = {
        ...mockUser,
        id: "oidc-existing",
        oidcSubject: "oidc-sub-existing",
        authProvider: "oidc",
        firstName: "Old",
        lastName: "Name",
      };
      usersRepository.findOne.mockResolvedValue(existingOidcUser);
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-existing",
        email: "newemail@example.com",
        email_verified: true,
        given_name: "New",
        family_name: "Name",
      });

      expect(result.user.email).toBe("newemail@example.com");
      expect(result.user.firstName).toBe("New");
    });

    it("does not update when info has not changed", async () => {
      const existingOidcUser = {
        ...mockUser,
        id: "oidc-existing",
        oidcSubject: "oidc-sub-same",
        authProvider: "oidc",
        // An SSO account holds no local password; one would be cleared (#1858).
        passwordHash: null,
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
      };
      usersRepository.findOne.mockResolvedValue(existingOidcUser);
      usersRepository.save.mockImplementation((u) => u);

      await service.findOrCreateOidcUser({
        sub: "oidc-sub-same",
        email: "test@example.com",
        email_verified: true,
        given_name: "Test",
        family_name: "User",
      });

      // save called once for lastLogin update only (not for field updates)
      expect(usersRepository.save).toHaveBeenCalledTimes(1);
    });

    it("throws ForbiddenException when registration is disabled", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findOrCreateOidcUser(
          { sub: "oidc-new", email: "new@example.com", email_verified: true },
          false, // registrationEnabled = false
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("handles duplicate email constraint error (code 23505) with passwordless account", async () => {
      const duplicateError = new Error("duplicate key") as any;
      duplicateError.code = "23505";

      const existingUser = {
        ...mockUser,
        id: "existing-dup",
        passwordHash: null,
        authProvider: "oidc",
        oidcSubject: null,
      };

      usersRepository.findOne
        .mockResolvedValueOnce(null) // no existing by oidcSubject
        .mockResolvedValueOnce(null) // no existing by email (race condition)
        .mockResolvedValueOnce(existingUser); // found after duplicate error

      // C9: transaction throws duplicate error
      failCreateTransaction(duplicateError);

      usersRepository.save.mockImplementation((u) => u); // subsequent saves succeed

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-dup",
        email: "test@example.com",
        email_verified: true,
      });

      expect(result.user.id).toBe("existing-dup");
      expect(result.user.oidcSubject).toBe("oidc-sub-dup");
    });

    it("initiates OIDC link confirmation in catch path for local account with password", async () => {
      const duplicateError = new Error("duplicate key") as any;
      duplicateError.code = "23505";

      const existingLocal = {
        ...mockUser,
        id: "existing-local-catch",
        passwordHash: "$2a$10$hashedpassword",
        authProvider: "local",
        oidcSubject: null,
      };

      usersRepository.findOne
        .mockResolvedValueOnce(null) // no existing by oidcSubject
        .mockResolvedValueOnce(null) // no existing by email (race condition)
        .mockResolvedValueOnce(existingLocal); // found after duplicate error

      failCreateTransaction(duplicateError);
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-catch-link",
        email: "test@example.com",
        email_verified: true,
      });

      // Should return existing user without completing the link
      expect(result.linkPending).toBe(true);
      expect(result.user.id).toBe("existing-local-catch");
      expect(result.user.oidcSubject).toBeNull(); // Link not completed
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("OIDC link pending confirmation (catch path)"),
      );
    });

    it("re-throws duplicate email error when email is unverified", async () => {
      const duplicateError = new Error("duplicate key") as any;
      duplicateError.code = "23505";

      usersRepository.findOne.mockResolvedValue(null);

      // C9: transaction throws duplicate error
      failCreateTransaction(duplicateError);

      await expect(
        service.findOrCreateOidcUser({
          sub: "oidc-sub-dup2",
          email: "test@example.com",
          email_verified: false,
        }),
      ).rejects.toThrow("duplicate key");
    });

    it("first OIDC user becomes admin", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const txManager = setupOidcTransactionMock(0); // first user
      txManager.create.mockImplementation((_entity, data) => ({
        ...data,
        id: "first-oidc",
      }));
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-admin",
        email: "admin-oidc@example.com",
        email_verified: true,
      });

      expect(result.user.role).toBe("admin");
    });

    it("throws for missing subject identifier", async () => {
      await expect(
        service.findOrCreateOidcUser({
          email: "no-sub@example.com",
          email_verified: true,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("uses preferred_username as firstName fallback", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const txManager = setupOidcTransactionMock(1);
      txManager.create.mockImplementation((_entity, data) => ({
        ...data,
        id: "oidc-pref",
      }));
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-pref",
        preferred_username: "johndoe",
        email_verified: false,
      });

      expect(result.user.firstName).toBe("johndoe");
    });

    it("uses full name split for firstName/lastName when specific claims absent", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const txManager = setupOidcTransactionMock(1);
      txManager.create.mockImplementation((_entity, data) => ({
        ...data,
        id: "oidc-name",
      }));
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-name",
        name: "John Michael Doe",
        email_verified: false,
      });

      expect(result.user.firstName).toBe("John");
      expect(result.user.lastName).toBe("Michael Doe");
    });

    it("clears 2FA config for SSO users who have it", async () => {
      const userWith2FA = {
        ...mockUser,
        id: "oidc-2fa",
        oidcSubject: "oidc-sub-2fa",
        authProvider: "oidc",
        twoFactorSecret: "encrypted-secret",
        pendingTwoFactorSecret: "pending-secret",
        backupCodes: '["code1","code2"]',
      };
      usersRepository.findOne.mockResolvedValue(userWith2FA);
      usersRepository.save.mockImplementation((u) => u);
      preferencesRepository.findOne.mockResolvedValue({
        userId: "oidc-2fa",
        twoFactorEnabled: true,
      });
      preferencesRepository.save.mockImplementation((p) => p);
      trustedDevicesRepository.delete.mockResolvedValue({ affected: 2 });

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-2fa",
        email: "test@example.com",
        email_verified: true,
      });

      expect(result.user.twoFactorSecret).toBeNull();
      expect(result.user.pendingTwoFactorSecret).toBeNull();
      expect(result.user.backupCodes).toBeNull();
      expect(preferencesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ twoFactorEnabled: false }),
      );
      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: "oidc-2fa",
      });
    });

    it("does not clear 2FA config when SSO user has no 2FA", async () => {
      const userWithout2FA = {
        ...mockUser,
        id: "oidc-no2fa",
        oidcSubject: "oidc-sub-no2fa",
        authProvider: "oidc",
        twoFactorSecret: null,
        pendingTwoFactorSecret: null,
        backupCodes: null,
      };
      usersRepository.findOne.mockResolvedValue(userWithout2FA);
      usersRepository.save.mockImplementation((u) => u);

      await service.findOrCreateOidcUser({
        sub: "oidc-sub-no2fa",
        email: "test@example.com",
        email_verified: true,
      });

      // preferencesRepository.findOne should NOT be called for 2FA cleanup
      // (only the lastLogin save should happen)
      expect(trustedDevicesRepository.delete).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // validateOidcUser
  // ---------------------------------------------------------------

  describe("validateOidcUser", () => {
    it("delegates to findOrCreateOidcUser and sanitizes", async () => {
      usersRepository.findOne
        .mockResolvedValueOnce(null) // no existing by oidcSubject
        .mockResolvedValueOnce(null); // no existing by email
      const txManager = {
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockImplementation((_entity, data) => ({
          ...data,
          id: "oidc-val",
          passwordHash: "$2a$10$hash",
          resetToken: "reset",
          resetTokenExpiry: new Date(),
          twoFactorSecret: "secret",
        })),
        save: jest.fn().mockImplementation((user) => user),
        findOne: jest.fn(),
      };
      installTransactionMock(txManager);
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.validateOidcUser({
        sub: "oidc-sub-validate",
        email: "val@example.com",
        email_verified: true,
      });

      expect(result).not.toHaveProperty("passwordHash");
      expect(result).not.toHaveProperty("resetToken");
      expect(result).not.toHaveProperty("twoFactorSecret");
      expect(result).toHaveProperty("hasPassword");
    });
  });

  // ---------------------------------------------------------------
  // refreshTokens
  // ---------------------------------------------------------------

  describe("refreshTokens", () => {
    function setupTransactionMock(managerOverrides = {}) {
      const manager = {
        findOne: jest.fn(),
        save: jest.fn().mockImplementation((data) => data),
        update: jest.fn(),
        create: jest.fn().mockImplementation((_entity, data) => data),
        ...managerOverrides,
      };
      return installTransactionMock(manager);
    }

    it("rotates token successfully", async () => {
      const existingToken = {
        id: "rt-1",
        userId: "user-1",
        tokenHash: "old-hash",
        familyId: "family-1",
        isRevoked: false,
        expiresAt: new Date(Date.now() + 3600000),
        replacedByHash: null,
      };
      const manager = setupTransactionMock();
      manager.findOne
        // Two token reads: the unlocked probe that learns the family id,
        // then the locked re-read once the family lock is held (P4-011).
        .mockResolvedValueOnce(existingToken)
        .mockResolvedValueOnce(existingToken)
        .mockResolvedValueOnce({ ...mockUser }); // User lookup

      const result = await service.refreshTokens("raw-refresh-token");

      expect(result.accessToken).toBe("mock-jwt-token");
      expect(result.refreshToken).toBeTruthy();
      // Old token should be marked as revoked with replacedByHash
      expect(manager.save).toHaveBeenCalled();
      const savedOldToken = manager.save.mock.calls[0][0];
      expect(savedOldToken.isRevoked).toBe(true);
      expect(savedOldToken.replacedByHash).toBeTruthy();
    });

    // RLS (task C1): refresh is a public, pre-identity path (no req.user), so
    // AuthService.refreshTokens wraps the delegated token flow in a system
    // context. Assert the ambient context at the moment the DB is touched.
    it("runs the token flow under a system context", async () => {
      let ctx: ReturnType<typeof getRequestContext>;
      const manager = setupTransactionMock();
      manager.findOne.mockImplementation(() => {
        ctx = getRequestContext();
        return Promise.resolve({
          id: "rt-1",
          userId: "user-1",
          tokenHash: "old-hash",
          familyId: "family-1",
          isRevoked: false,
          expiresAt: new Date(Date.now() + 3600000),
          replacedByHash: null,
        });
      });

      await service.refreshTokens("raw-refresh-token").catch(() => undefined);

      expect(ctx).toEqual({ system: true });
    });

    it("detects replay and revokes entire family", async () => {
      const revokedToken = {
        id: "rt-revoked",
        userId: "user-1",
        tokenHash: "revoked-hash",
        familyId: "family-replay",
        isRevoked: true, // already revoked = replay
        expiresAt: new Date(Date.now() + 3600000),
      };
      const manager = setupTransactionMock();
      // Two token reads: the unlocked probe that learns the family id,
      // then the locked re-read once the family lock is held (P4-011).
      manager.findOne
        .mockResolvedValueOnce(revokedToken)
        .mockResolvedValueOnce(revokedToken);

      await expect(
        service.refreshTokens("reused-refresh-token"),
      ).rejects.toThrow("Refresh token reuse detected");

      expect(manager.update).toHaveBeenCalledWith(
        RefreshToken,
        { familyId: "family-replay" },
        { isRevoked: true },
      );
    });

    it("throws for expired refresh token", async () => {
      const expiredToken = {
        id: "rt-expired",
        userId: "user-1",
        tokenHash: "expired-hash",
        familyId: "family-expired",
        isRevoked: false,
        expiresAt: new Date(Date.now() - 1000), // expired
      };
      const manager = setupTransactionMock();
      // Two token reads: the unlocked probe that learns the family id,
      // then the locked re-read once the family lock is held (P4-011).
      manager.findOne
        .mockResolvedValueOnce(expiredToken)
        .mockResolvedValueOnce(expiredToken);

      await expect(
        service.refreshTokens("expired-refresh-token"),
      ).rejects.toThrow("Refresh token expired");

      // Token should be revoked
      const savedToken = manager.save.mock.calls[0][0];
      expect(savedToken.isRevoked).toBe(true);
    });

    it("throws for inactive user and revokes family", async () => {
      const validToken = {
        id: "rt-valid",
        userId: "user-1",
        tokenHash: "valid-hash",
        familyId: "family-inactive",
        isRevoked: false,
        expiresAt: new Date(Date.now() + 3600000),
      };
      const manager = setupTransactionMock();
      manager.findOne
        // Two token reads: the unlocked probe that learns the family id,
        // then the locked re-read once the family lock is held (P4-011).
        .mockResolvedValueOnce(validToken)
        .mockResolvedValueOnce(validToken)
        .mockResolvedValueOnce({ ...mockUser, isActive: false });

      await expect(
        service.refreshTokens("valid-token-inactive-user"),
      ).rejects.toThrow("User not found or inactive");

      expect(manager.update).toHaveBeenCalledWith(
        RefreshToken,
        { familyId: "family-inactive" },
        { isRevoked: true },
      );
    });

    it("throws for unknown refresh token", async () => {
      const manager = setupTransactionMock();
      // Two token reads: the unlocked probe that learns the family id,
      // then the locked re-read once the family lock is held (P4-011).
      manager.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      await expect(
        service.refreshTokens("unknown-refresh-token"),
      ).rejects.toThrow("Invalid refresh token");
    });

    it("throws when user not found and revokes family", async () => {
      const validToken = {
        id: "rt-valid",
        userId: "user-gone",
        tokenHash: "valid-hash",
        familyId: "family-gone",
        isRevoked: false,
        expiresAt: new Date(Date.now() + 3600000),
      };
      const manager = setupTransactionMock();
      manager.findOne
        // Two token reads: the unlocked probe that learns the family id,
        // then the locked re-read once the family lock is held (P4-011).
        .mockResolvedValueOnce(validToken)
        .mockResolvedValueOnce(validToken)
        .mockResolvedValueOnce(null); // user not found

      await expect(service.refreshTokens("token-no-user")).rejects.toThrow(
        "User not found or inactive",
      );

      expect(manager.update).toHaveBeenCalledWith(
        RefreshToken,
        { familyId: "family-gone" },
        { isRevoked: true },
      );
    });

    it("new token uses same familyId for rotation tracking", async () => {
      const existingToken = {
        id: "rt-1",
        userId: "user-1",
        tokenHash: "old-hash",
        familyId: "family-track",
        isRevoked: false,
        expiresAt: new Date(Date.now() + 3600000),
        replacedByHash: null,
      };
      const manager = setupTransactionMock();
      manager.findOne
        // Two token reads: the unlocked probe that learns the family id,
        // then the locked re-read once the family lock is held (P4-011).
        .mockResolvedValueOnce(existingToken)
        .mockResolvedValueOnce(existingToken)
        .mockResolvedValueOnce({ ...mockUser });

      await service.refreshTokens("raw-token");

      const newTokenCreated = manager.create.mock.calls[0][1];
      expect(newTokenCreated.familyId).toBe("family-track");
      expect(newTokenCreated.isRevoked).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // purgeExpiredRefreshTokens
  // ---------------------------------------------------------------

  describe("purgeExpiredRefreshTokens", () => {
    it("deletes only expired tokens, keeping revoked rows for reuse detection", async () => {
      refreshTokensRepository.delete.mockResolvedValue({ affected: 5 });

      await service.purgeExpiredRefreshTokens();

      expect(refreshTokensRepository.delete).toHaveBeenCalledTimes(1);
      expect(refreshTokensRepository.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: expect.anything(),
        }),
      );
    });

    it("does not log when no tokens purged", async () => {
      refreshTokensRepository.delete.mockResolvedValue({ affected: 0 });

      await service.purgeExpiredRefreshTokens();

      expect(refreshTokensRepository.delete).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------
  // generateResetToken
  // ---------------------------------------------------------------

  describe("generateResetToken", () => {
    it("generates token, stores hashed version, sets expiry", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: "$2a$10$hash",
      });
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.generateResetToken("test@example.com");

      expect(result).not.toBeNull();
      expect(result!.token).toBeTruthy();
      expect(result!.user.email).toBe("test@example.com");

      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.resetToken).toBeTruthy();
      // Token should be hashed (not the raw token)
      expect(savedUser.resetToken).not.toBe(result!.token);
      expect(savedUser.resetTokenExpiry).toBeInstanceOf(Date);
      expect(savedUser.resetTokenExpiry.getTime()).toBeGreaterThan(Date.now());
    });

    it("returns null for non-existent user", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      const result = await service.generateResetToken("nobody@example.com");

      expect(result).toBeNull();
    });

    it("returns null for user without password (OIDC only)", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: null,
      });

      const result = await service.generateResetToken("oidc@example.com");

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // resetPassword - success path
  // ---------------------------------------------------------------

  describe("resetPassword - success path", () => {
    it("updates password hash, clears token, revokes all refresh tokens", async () => {
      const rawToken = "test-reset-token-hex-value";
      stageOneTokenFamily();

      const mockExecute = jest.fn().mockResolvedValue({
        affected: 1,
        raw: [{ id: mockUser.id }],
      });
      const builder = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: mockExecute,
      };
      usersRepository.createQueryBuilder.mockReturnValue(builder);
      refreshTokensRepository.update.mockResolvedValue({ affected: 2 });

      await service.resetPassword(rawToken, "NewSecurePass123!");

      // The query builder should have been used to update the user
      expect(usersRepository.createQueryBuilder).toHaveBeenCalled();
      expect(builder.update).toHaveBeenCalled();

      // Password hash should have been set (not plaintext)
      const setArg = builder.set.mock.calls[0][0];
      expect(setArg.passwordHash).toBeTruthy();
      expect(setArg.passwordHash).not.toBe("NewSecurePass123!");
      const isPasswordValid = await bcrypt.compare(
        "NewSecurePass123!",
        setArg.passwordHash,
      );
      expect(isPasswordValid).toBe(true);

      // Token fields should be cleared
      expect(setArg.resetToken).toBeNull();
      expect(setArg.resetTokenExpiry).toBeNull();

      // All refresh tokens should be revoked using the userId from the result
      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: mockUser.id, familyId: In(["family-1"]), isRevoked: false },
        { isRevoked: true },
      );
    });
  });

  // ---------------------------------------------------------------
  // createTrustedDevice
  // ---------------------------------------------------------------

  describe("createTrustedDevice", () => {
    it("creates device with hashed token and parsed device name", async () => {
      trustedDevicesRepository.create.mockImplementation((data) => ({
        ...data,
        id: "device-1",
      }));
      trustedDevicesRepository.save.mockResolvedValue({ id: "device-1" });

      const token = await service.createTrustedDevice(
        "user-1",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "192.168.1.100",
      );

      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");

      const createdDevice = trustedDevicesRepository.create.mock.calls[0][0];
      expect(createdDevice.userId).toBe("user-1");
      expect(createdDevice.tokenHash).toBeTruthy();
      expect(createdDevice.deviceName).toContain("Chrome");
      expect(createdDevice.ipAddress).toBe("192.168.1.100");
      expect(createdDevice.expiresAt).toBeInstanceOf(Date);
      expect(createdDevice.lastUsedAt).toBeInstanceOf(Date);
    });

    it("stores hashed token, not raw token", async () => {
      trustedDevicesRepository.create.mockImplementation((data) => ({
        ...data,
        id: "device-2",
      }));
      trustedDevicesRepository.save.mockResolvedValue({ id: "device-2" });

      const rawToken = await service.createTrustedDevice(
        "user-1",
        "Unknown Device",
      );

      const createdDevice = trustedDevicesRepository.create.mock.calls[0][0];
      // The stored hash should not equal the raw token
      expect(createdDevice.tokenHash).not.toBe(rawToken);
      expect(createdDevice.tokenHash.length).toBe(64); // SHA-256 hex length
    });

    it("handles Unknown Device user agent", async () => {
      trustedDevicesRepository.create.mockImplementation((data) => ({
        ...data,
        id: "device-3",
      }));
      trustedDevicesRepository.save.mockResolvedValue({ id: "device-3" });

      await service.createTrustedDevice("user-1", "Unknown Device");

      const createdDevice = trustedDevicesRepository.create.mock.calls[0][0];
      expect(createdDevice.deviceName).toBe("Unknown Device");
    });

    it("sets null for ipAddress when not provided", async () => {
      trustedDevicesRepository.create.mockImplementation((data) => ({
        ...data,
        id: "device-4",
      }));
      trustedDevicesRepository.save.mockResolvedValue({ id: "device-4" });

      await service.createTrustedDevice("user-1", "SomeAgent");

      const createdDevice = trustedDevicesRepository.create.mock.calls[0][0];
      expect(createdDevice.ipAddress).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // validateTrustedDevice
  // ---------------------------------------------------------------

  describe("validateTrustedDevice", () => {
    it("returns true and updates lastUsedAt for valid device", async () => {
      const oldDate = new Date("2025-01-01T00:00:00Z");
      const device = {
        id: "device-1",
        userId: "user-1",
        tokenHash: "some-hash",
        expiresAt: new Date(Date.now() + 86400000), // future
        lastUsedAt: oldDate,
      };
      trustedDevicesRepository.findOne.mockResolvedValue(device);
      trustedDevicesRepository.save.mockImplementation((d) => d);

      const result = await service.validateTrustedDevice(
        "user-1",
        "device-token",
      );

      expect(result).toBe(true);
      const savedDevice = trustedDevicesRepository.save.mock.calls[0][0];
      expect(savedDevice.lastUsedAt).toBeInstanceOf(Date);
      expect(savedDevice.lastUsedAt.getTime()).toBeGreaterThan(
        oldDate.getTime(),
      );
    });

    it("removes expired device and returns false", async () => {
      const expiredDevice = {
        id: "device-expired",
        userId: "user-1",
        tokenHash: "expired-hash",
        expiresAt: new Date(Date.now() - 1000), // expired
        lastUsedAt: new Date(),
      };
      trustedDevicesRepository.findOne.mockResolvedValue(expiredDevice);
      trustedDevicesRepository.remove.mockResolvedValue(expiredDevice);

      const result = await service.validateTrustedDevice(
        "user-1",
        "expired-device-token",
      );

      expect(result).toBe(false);
      expect(trustedDevicesRepository.remove).toHaveBeenCalledWith(
        expiredDevice,
      );
    });

    it("returns false for unknown device", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue(null);

      const result = await service.validateTrustedDevice(
        "user-1",
        "unknown-device-token",
      );

      expect(result).toBe(false);
      expect(trustedDevicesRepository.remove).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // getTrustedDevices
  // ---------------------------------------------------------------

  describe("getTrustedDevices", () => {
    it("cleans expired devices and returns sorted by lastUsedAt", async () => {
      const devices = [
        { id: "d1", lastUsedAt: new Date("2026-01-02") },
        { id: "d2", lastUsedAt: new Date("2026-01-01") },
      ];
      trustedDevicesRepository.delete.mockResolvedValue({ affected: 1 });
      trustedDevicesRepository.find.mockResolvedValue(devices);

      const result = await service.getTrustedDevices("user-1");

      // Should first delete expired devices
      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          expiresAt: expect.anything(),
        }),
      );

      // Should return results sorted by lastUsedAt DESC
      expect(trustedDevicesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-1" },
          order: { lastUsedAt: "DESC" },
        }),
      );

      expect(result).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------
  // revokeTrustedDevice
  // ---------------------------------------------------------------

  describe("revokeTrustedDevice", () => {
    it("removes the device", async () => {
      const device = { id: "device-1", userId: "user-1" };
      trustedDevicesRepository.findOne.mockResolvedValue(device);
      trustedDevicesRepository.remove.mockResolvedValue(device);

      await service.revokeTrustedDevice("user-1", "device-1");

      expect(trustedDevicesRepository.findOne).toHaveBeenCalledWith({
        where: { id: "device-1", userId: "user-1" },
      });
      expect(trustedDevicesRepository.remove).toHaveBeenCalledWith(device);
    });

    it("throws NotFoundException when device not found", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.revokeTrustedDevice("user-1", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.revokeTrustedDevice("user-1", "nonexistent"),
      ).rejects.toThrow("Device not found");
    });
  });

  // ---------------------------------------------------------------
  // revokeAllTrustedDevices
  // ---------------------------------------------------------------

  describe("revokeAllTrustedDevices", () => {
    it("returns affected count", async () => {
      trustedDevicesRepository.delete.mockResolvedValue({ affected: 3 });

      const result = await service.revokeAllTrustedDevices("user-1");

      expect(result).toBe(3);
      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: "user-1",
      });
    });

    it("returns 0 when no devices exist", async () => {
      trustedDevicesRepository.delete.mockResolvedValue({ affected: 0 });

      const result = await service.revokeAllTrustedDevices("user-1");

      expect(result).toBe(0);
    });

    it("returns 0 when affected is undefined", async () => {
      trustedDevicesRepository.delete.mockResolvedValue({});

      const result = await service.revokeAllTrustedDevices("user-1");

      expect(result).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // findTrustedDeviceByToken
  // ---------------------------------------------------------------

  describe("findTrustedDeviceByToken", () => {
    it("returns device id when found", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue({
        id: "device-found",
        userId: "user-1",
      });

      const result = await service.findTrustedDeviceByToken(
        "user-1",
        "device-token",
      );

      expect(result).toBe("device-found");
    });

    it("returns null when device not found", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue(null);

      const result = await service.findTrustedDeviceByToken(
        "user-1",
        "unknown-token",
      );

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // login with trusted device
  // ---------------------------------------------------------------

  describe("login with trusted device bypassing 2FA", () => {
    it("bypasses 2FA when trustedDeviceRef is valid", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);

      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);

      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        twoFactorSecret: encryptedSecret,
      });
      preferencesRepository.findOne.mockResolvedValue({
        twoFactorEnabled: true,
      });

      // Mock validateTrustedDevice to return true
      trustedDevicesRepository.findOne.mockResolvedValue({
        id: "trusted-device-1",
        userId: "user-1",
        expiresAt: new Date(Date.now() + 86400000),
        lastUsedAt: new Date(),
      });
      trustedDevicesRepository.save.mockImplementation((d) => d);
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.login(
        { email: "test@example.com", password: "ValidPass123!" },
        "trusted-device-token",
      );

      // Should return full auth response, not 2FA required
      expect(result.requires2FA).toBeUndefined();
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.user).toBeDefined();
      expect((service as any).logger.log).toHaveBeenCalledWith(
        expect.stringContaining("Login successful (trusted device)"),
      );
    });

    it("falls back to 2FA when trusted device is invalid", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);

      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);

      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        twoFactorSecret: encryptedSecret,
      });
      preferencesRepository.findOne.mockResolvedValue({
        twoFactorEnabled: true,
      });

      // Mock validateTrustedDevice to return false (unknown device)
      trustedDevicesRepository.findOne.mockResolvedValue(null);

      const result = await service.login(
        { email: "test@example.com", password: "ValidPass123!" },
        "invalid-device-token",
      );

      // Should require 2FA
      expect(result.requires2FA).toBe(true);
      expect(result.tempToken).toBeDefined();
    });

    it("does not check trusted device when no token provided", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);

      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);

      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        twoFactorSecret: encryptedSecret,
      });
      preferencesRepository.findOne.mockResolvedValue({
        twoFactorEnabled: true,
      });

      const result = await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      // Should require 2FA, no trusted device check
      expect(result.requires2FA).toBe(true);
      expect(trustedDevicesRepository.findOne).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // M4: 2FA attempt tracking
  // ---------------------------------------------------------------

  describe("verify2FA - attempt tracking (M4)", () => {
    beforeEach(() => {
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
    });

    it("blocks after 3 failed attempts on the same temp token", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      // 3 failed attempts
      for (let i = 0; i < 3; i++) {
        await expect(
          service.verify2FA("same-temp-token", "000000"),
        ).rejects.toThrow("Invalid verification code");
      }

      // 4th attempt should be blocked before even checking the code
      await expect(
        service.verify2FA("same-temp-token", "000000"),
      ).rejects.toThrow("Too many verification attempts");
    });

    it("allows attempts on different temp tokens independently", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      // 2 failures on token-A
      await expect(service.verify2FA("token-A", "000000")).rejects.toThrow(
        "Invalid verification code",
      );
      await expect(service.verify2FA("token-A", "000000")).rejects.toThrow(
        "Invalid verification code",
      );

      // 1 failure on token-B
      await expect(service.verify2FA("token-B", "000000")).rejects.toThrow(
        "Invalid verification code",
      );

      // token-B should still have attempts remaining
      await expect(service.verify2FA("token-B", "000000")).rejects.toThrow(
        "Invalid verification code",
      );
    });

    it("clears attempt counter on successful verification", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      usersRepository.save.mockImplementation((u) => u);

      // 2 failed attempts
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });
      await expect(
        service.verify2FA("clearable-token", "000000"),
      ).rejects.toThrow("Invalid verification code");
      await expect(
        service.verify2FA("clearable-token", "000000"),
      ).rejects.toThrow("Invalid verification code");

      // Successful attempt
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      const result = await service.verify2FA("clearable-token", "123456");
      expect(result.user).toBeDefined();
    });
  });

  // ---------------------------------------------------------------
  // M5: Trusted device lifetime (14 days)
  // ---------------------------------------------------------------

  describe("createTrustedDevice - M5: 14-day expiry", () => {
    it("creates device with 14-day expiry", async () => {
      trustedDevicesRepository.create.mockImplementation((data) => data);
      trustedDevicesRepository.save.mockResolvedValue({});

      const beforeCreate = Date.now();
      await service.createTrustedDevice("user-1", "Mozilla/5.0", "1.2.3.4");

      const savedDevice = trustedDevicesRepository.create.mock.calls[0][0];
      const expiryMs = savedDevice.expiresAt.getTime() - beforeCreate;
      const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;

      // Expiry should be about 14 days (within 5 seconds tolerance)
      expect(expiryMs).toBeGreaterThan(fourteenDaysMs - 5000);
      expect(expiryMs).toBeLessThanOrEqual(fourteenDaysMs + 5000);
    });
  });

  // ---------------------------------------------------------------
  // M7: Per-email rate limiting for forgot-password
  // ---------------------------------------------------------------

  describe("checkForgotPasswordEmailLimit (M7)", () => {
    const check = (email: string) =>
      service.checkForgotPasswordEmailLimit(email);

    it("allows first 3 requests for an email", async () => {
      await expect(check("test@example.com")).resolves.toBe(true);
      await expect(check("test@example.com")).resolves.toBe(true);
      await expect(check("test@example.com")).resolves.toBe(true);
    });

    it("blocks the 4th request for the same email within the window", async () => {
      await expect(check("block@example.com")).resolves.toBe(true);
      await expect(check("block@example.com")).resolves.toBe(true);
      await expect(check("block@example.com")).resolves.toBe(true);
      await expect(check("block@example.com")).resolves.toBe(false);
    });

    it("normalizes email case", async () => {
      await expect(check("UPPER@Example.COM")).resolves.toBe(true);
      await expect(check("upper@example.com")).resolves.toBe(true);
      await expect(check("Upper@EXAMPLE.com")).resolves.toBe(true);
      await expect(check("upper@example.com")).resolves.toBe(false);
    });

    it("tracks different emails independently", async () => {
      await expect(check("a@test.com")).resolves.toBe(true);
      await expect(check("a@test.com")).resolves.toBe(true);
      await expect(check("a@test.com")).resolves.toBe(true);
      await expect(check("b@test.com")).resolves.toBe(true); // different email
    });
  });

  // ---------------------------------------------------------------
  // M6: OIDC link confirmation
  // ---------------------------------------------------------------

  describe("OIDC link confirmation (M6)", () => {
    it("initiateOidcLink stores pending link data", async () => {
      const existingUser = {
        ...mockUser,
        oidcLinkPending: false,
        oidcLinkToken: null,
        oidcLinkExpiresAt: null,
        pendingOidcSubject: null,
      };
      usersRepository.save.mockImplementation((u) => u);

      const token = await service.initiateOidcLink(
        existingUser as any,
        "oidc-sub-new",
      );

      expect(token).toBeTruthy();
      expect(existingUser.oidcLinkPending).toBe(true);
      expect(existingUser.pendingOidcSubject).toBe("oidc-sub-new");
      expect(existingUser.oidcLinkToken).toBeTruthy();
      expect(existingUser.oidcLinkExpiresAt).toBeInstanceOf(Date);
    });

    it("confirmOidcLink completes the link with valid token", async () => {
      const futureDate = new Date(Date.now() + 3600000);
      const pendingUser = {
        ...mockUser,
        oidcLinkPending: true,
        oidcLinkExpiresAt: futureDate,
        pendingOidcSubject: "oidc-sub-confirmed",
      };
      usersRepository.findOne.mockResolvedValue(pendingUser);
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.confirmOidcLink("some-token");

      expect(result.oidcSubject).toBe("oidc-sub-confirmed");
      expect(result.authProvider).toBe("oidc");
      expect(result.oidcLinkPending).toBe(false);
      expect(result.oidcLinkToken).toBeNull();
      expect(result.pendingOidcSubject).toBeNull();
      // The link keeps the local password; OIDC_ALLOW_PASSWORD_LOGIN decides
      // whether it may sign in.
      expect(result.passwordHash).toBe(mockUser.passwordHash);
    });

    it("confirmOidcLink leaves the backup key and its password ref alone", async () => {
      const ref = loginPasswordRef(mockUser.passwordHash);
      const pendingUser = {
        ...mockUser,
        oidcLinkPending: true,
        oidcLinkExpiresAt: new Date(Date.now() + 3600000),
        pendingOidcSubject: "oidc-sub-confirmed",
        backupEncryptionEnabled: true,
        backupKeyEnc: "enc",
        backupKeyWrap: "wrap",
        backupKeyPasswordRef: ref,
      };
      usersRepository.findOne.mockResolvedValue(pendingUser);
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.confirmOidcLink("some-token");

      expect(result.backupKeyPasswordRef).toBe(ref);
      expect(result.backupKeyEnc).toBe("enc");
      expect(result.backupKeyWrap).toBe("wrap");
      expect(result.backupEncryptionEnabled).toBe(true);
    });

    it("confirmOidcLink ends every credential the local password stood behind", async () => {
      // The account now signs in through the identity provider; a PAT, a
      // trusted device, a session or an MCP client's OAuth grant issued on the
      // strength of the local password must not survive the switch.
      stageOneTokenFamily();
      const pendingUser = {
        ...mockUser,
        oidcLinkPending: true,
        oidcLinkExpiresAt: new Date(Date.now() + 3600000),
        pendingOidcSubject: "oidc-sub-confirmed",
      };
      usersRepository.findOne.mockResolvedValue(pendingUser);
      usersRepository.save.mockImplementation((u) => u);

      await service.confirmOidcLink("some-token");

      expect(patRepository.update).toHaveBeenCalledWith(
        { userId: mockUser.id, isRevoked: false },
        { isRevoked: true },
      );
      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: mockUser.id,
      });
      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ userId: mockUser.id, isRevoked: false }),
        { isRevoked: true },
      );
      expect(oauthProviderService.revokeAllForUser).toHaveBeenCalledWith(
        mockUser.id,
      );
    });

    it("confirmOidcLink revokes nothing for an expired link", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        oidcLinkPending: true,
        oidcLinkExpiresAt: new Date(Date.now() - 3600000),
        pendingOidcSubject: "oidc-sub-expired",
      });
      usersRepository.save.mockImplementation((u) => u);

      await expect(service.confirmOidcLink("expired-token")).rejects.toThrow();

      expect(patRepository.update).not.toHaveBeenCalled();
      expect(oauthProviderService.revokeAllForUser).not.toHaveBeenCalled();
    });

    it("confirmOidcLink throws for expired token", async () => {
      const pastDate = new Date(Date.now() - 3600000);
      const expiredUser = {
        ...mockUser,
        oidcLinkPending: true,
        oidcLinkExpiresAt: pastDate,
        pendingOidcSubject: "oidc-sub-expired",
      };
      usersRepository.findOne.mockResolvedValue(expiredUser);
      usersRepository.save.mockImplementation((u) => u);

      await expect(service.confirmOidcLink("expired-token")).rejects.toThrow(
        "Link token has expired",
      );
    });

    it("confirmOidcLink throws for invalid token", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(service.confirmOidcLink("invalid-token")).rejects.toThrow(
        "Invalid or expired link token",
      );
    });

    it("findOrCreateOidcUser initiates link instead of direct linking for local accounts", async () => {
      const existingLocal = {
        ...mockUser,
        id: "local-user",
        authProvider: "local",
        oidcSubject: null,
        passwordHash: "$2a$10$somehash",
        oidcLinkPending: false,
        oidcLinkToken: null,
        oidcLinkExpiresAt: null,
        pendingOidcSubject: null,
      };

      usersRepository.findOne
        .mockResolvedValueOnce(null) // no user by oidcSubject
        .mockResolvedValueOnce(existingLocal); // found by email
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-link",
        email: "test@example.com",
        email_verified: true,
      });

      expect(result.linkPending).toBe(true);
      expect(result.user.id).toBe("local-user");
      // Should have set oidcLinkPending to true
      expect(existingLocal.oidcLinkPending).toBe(true);
      expect(existingLocal.pendingOidcSubject).toBe("oidc-sub-link");
      // oidcSubject should NOT be directly set
      expect(existingLocal.oidcSubject).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // L5: Backup codes
  // ---------------------------------------------------------------

  describe("generateBackupCodes (L5)", () => {
    it("generates 12 backup codes", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      usersRepository.save.mockImplementation((u) => u);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      const codes = await service.generateBackupCodes("user-1", "123456");

      expect(codes).toHaveLength(12);
      codes.forEach((code) => {
        expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
      });
    });

    it("stores hashed codes in user entity", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      usersRepository.save.mockImplementation((u) => u);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      await service.generateBackupCodes("user-1", "123456");

      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.backupCodes).toBeTruthy();
      const hashedCodes = JSON.parse(savedUser.backupCodes);
      expect(hashedCodes).toHaveLength(12);
      // Hashed codes should be bcrypt hashes
      hashedCodes.forEach((hash: string) => {
        expect(hash).toMatch(/^\$2[ab]\$\d+\$/);
      });
    });

    it("throws if user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.generateBackupCodes("nonexistent", "123456"),
      ).rejects.toThrow("User not found");
    });

    it("throws if 2FA is not enabled", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: null,
      });

      await expect(
        service.generateBackupCodes("user-1", "123456"),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.generateBackupCodes("user-1", "123456"),
      ).rejects.toThrow("2FA is not enabled");
    });

    it("throws on invalid verification code", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(
        service.generateBackupCodes("user-1", "000000"),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.generateBackupCodes("user-1", "000000"),
      ).rejects.toThrow("Invalid verification code");
    });
  });

  describe("verify2FA with backup code (L5)", () => {
    function setupBackupCodeQueryRunner(backupCodes: string) {
      const mockSetFn = jest.fn().mockReturnThis();
      const mockQRManager = {
        findOne: jest.fn().mockResolvedValue({
          ...mockUser,
          backupCodes,
        }),
        createQueryBuilder: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnThis(),
          set: mockSetFn,
          where: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        }),
      };
      installTransactionMock(mockQRManager);
      return { mockQRManager, mockSetFn };
    }

    it("accepts a valid backup code", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      // Generate real backup codes
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      usersRepository.save.mockImplementation((u) => u);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      const codes = await service.generateBackupCodes("user-1", "123456");

      // Now set up user with backup codes for verify2FA
      const savedUser = usersRepository.save.mock.calls[0][0];
      const userWithCodes = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: savedUser.backupCodes,
      };

      setupBackupCodeQueryRunner(savedUser.backupCodes);

      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue(userWithCodes);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      const result = await service.verify2FA("backup-token", codes[0]);

      expect(result.user).toBeDefined();
      expect(result.accessToken).toBeDefined();
    });

    it("removes used backup code after verification", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      usersRepository.save.mockImplementation((u) => u);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      const codes = await service.generateBackupCodes("user-1", "123456");

      const savedUser = usersRepository.save.mock.calls[0][0];
      const userWithCodes = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: savedUser.backupCodes,
      };

      const { mockSetFn } = setupBackupCodeQueryRunner(savedUser.backupCodes);

      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue(userWithCodes);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await service.verify2FA("backup-used-token", codes[0]);

      // After using the code, the atomic update should save 11 remaining codes
      const savedBackupCodes = mockSetFn.mock.calls[0][0].backupCodes;
      const updatedCodes = JSON.parse(savedBackupCodes);
      expect(updatedCodes).toHaveLength(11);
    });

    it("rejects invalid backup code", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      const hashedCodes = [await bcrypt.hash("abcd-1234", 10)];
      const userWithCodes = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: JSON.stringify(hashedCodes),
      };

      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue(userWithCodes);

      await expect(
        service.verify2FA("bad-backup-token", "dead-beef"),
      ).rejects.toThrow("Invalid verification code");
    });

    it("does not call otplib.verifySync for backup codes", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      usersRepository.save.mockImplementation((u) => u);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      const codes = await service.generateBackupCodes("user-1", "123456");

      const savedUser = usersRepository.save.mock.calls[0][0];
      const userWithCodes = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: savedUser.backupCodes,
      };

      setupBackupCodeQueryRunner(savedUser.backupCodes);

      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue(userWithCodes);
      (otplib.verifySync as jest.Mock).mockClear();

      await service.verify2FA("backup-routing-token", codes[0]);

      expect(otplib.verifySync).not.toHaveBeenCalled();
    });

    it("does not try backup codes for 6-digit TOTP codes", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      const userWithCodes = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: JSON.stringify(["some-hash"]),
      };

      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue(userWithCodes);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      const result = await service.verify2FA("totp-routing-token", "123456");

      expect(otplib.verifySync).toHaveBeenCalled();
      expect(result.user).toBeDefined();
    });

    it("rejects non-6-digit code when user has no backup codes", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      const userWithNoCodes = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      };

      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue(userWithNoCodes);

      await expect(
        service.verify2FA("no-backup-token", "abcd-ef12"),
      ).rejects.toThrow("Invalid verification code");
    });
  });

  // ---------------------------------------------------------------
  // M8: Legacy TOTP migration
  // ---------------------------------------------------------------

  describe("migrateLegacyTotpSecrets (M8)", () => {
    it("migrates legacy encrypted secrets to new format", async () => {
      const mockQB = {
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      usersRepository.createQueryBuilder = jest.fn().mockReturnValue(mockQB);

      const count = await service.migrateLegacyTotpSecrets();
      expect(count).toBe(0);
      expect(usersRepository.createQueryBuilder).toHaveBeenCalledWith("user");
    });

    it("counts migrated users correctly", async () => {
      // Use a properly encrypted secret in new format (4-part, with derived key)
      const alreadyMigrated = encrypt("TESTSECRET", TEST_TOTP_KEY);
      const mockQB = {
        where: jest.fn().mockReturnThis(),
        getMany: jest
          .fn()
          .mockResolvedValue([
            { ...mockUser, twoFactorSecret: alreadyMigrated },
          ]),
      };
      usersRepository.createQueryBuilder = jest.fn().mockReturnValue(mockQB);
      usersRepository.save.mockImplementation((u) => u);

      const count = await service.migrateLegacyTotpSecrets();
      // Already encrypted with the derived key, so no migration needed
      expect(count).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // sanitizeUser strips new fields
  // ---------------------------------------------------------------

  describe("sanitizeUser - new fields stripped", () => {
    it("strips backupCodes and OIDC link fields", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const txManager = {
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockImplementation((_entity, data) => ({
          ...data,
          id: "user-1",
          passwordHash: "$2a$10$hash",
          resetToken: "reset",
          resetTokenExpiry: new Date(),
          twoFactorSecret: "secret",
          pendingTwoFactorSecret: "pending-secret",
          backupCodes: '["hash1","hash2"]',
          oidcLinkPending: true,
          oidcLinkToken: "token",
          oidcLinkExpiresAt: new Date(),
          pendingOidcSubject: "sub",
        })),
        save: jest.fn().mockImplementation((user) => user),
      };
      installTransactionMock(txManager);

      const result = await service.register({
        email: "test@example.com",
        password: "StrongPass123!",
      });

      expect(result.user).not.toHaveProperty("pendingTwoFactorSecret");
      expect(result.user).not.toHaveProperty("backupCodes");
      expect(result.user).not.toHaveProperty("oidcLinkPending");
      expect(result.user).not.toHaveProperty("oidcLinkToken");
      expect(result.user).not.toHaveProperty("oidcLinkExpiresAt");
      expect(result.user).not.toHaveProperty("pendingOidcSubject");
    });
  });

  // ---------------------------------------------------------------
  // Per-user 2FA rate limiting and account lockout
  // ---------------------------------------------------------------

  describe("verify2FA - per-user attempt tracking", () => {
    beforeEach(() => {
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
    });

    it("blocks after 10 failed attempts across different temp tokens", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      const mockQB = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      usersRepository.createQueryBuilder.mockReturnValue(mockQB);

      // 10 failed attempts on unique temp tokens (3 per token, 4 tokens needed)
      for (let i = 0; i < 10; i++) {
        await expect(service.verify2FA(`token-${i}`, "000000")).rejects.toThrow(
          "Invalid verification code",
        );
      }

      // 11th attempt should be blocked by per-user limit
      await expect(service.verify2FA("token-new", "000000")).rejects.toThrow(
        "Too many verification attempts",
      );
    });

    it("locks user account after reaching per-user threshold", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      const mockQB = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      usersRepository.createQueryBuilder.mockReturnValue(mockQB);

      // Exhaust per-user limit
      for (let i = 0; i < 10; i++) {
        await expect(
          service.verify2FA(`lockout-token-${i}`, "000000"),
        ).rejects.toThrow("Invalid verification code");
      }

      // Verify that lockedUntil was set via QueryBuilder
      expect(mockQB.update).toHaveBeenCalled();
      expect(mockQB.set).toHaveBeenCalledWith(
        expect.objectContaining({
          // GREATEST(...) on the database clock: never shortens a longer lock.
          lockedUntil: expect.any(Function),
        }),
      );
    });

    it("resets per-user counter on successful verification", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      usersRepository.save.mockImplementation((u) => u);

      // Accumulate some failures
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });
      for (let i = 0; i < 5; i++) {
        await expect(
          service.verify2FA(`reset-token-${i}`, "000000"),
        ).rejects.toThrow("Invalid verification code");
      }

      // Succeed
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      const result = await service.verify2FA("reset-token-final", "123456");
      expect(result.user).toBeDefined();

      // After success, per-user counter should be cleared; 10 more failures should be needed
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });
      usersRepository.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      for (let i = 0; i < 10; i++) {
        await expect(
          service.verify2FA(`post-reset-token-${i}`, "000000"),
        ).rejects.toThrow("Invalid verification code");
      }
      // 11th should trigger per-user block
      await expect(
        service.verify2FA("post-reset-overflow", "000000"),
      ).rejects.toThrow("Too many verification attempts");
    });
  });

  // ---------------------------------------------------------------
  // Atomic backup code consumption
  // ---------------------------------------------------------------

  describe("is2FAEnabled", () => {
    it("returns true when the flag is on and a secret is stored", async () => {
      preferencesRepository.findOne.mockResolvedValue({
        userId: "u1",
        twoFactorEnabled: true,
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        id: "u1",
        twoFactorSecret: "encrypted-secret",
      });
      await expect(service.is2FAEnabled("u1")).resolves.toBe(true);
      expect(preferencesRepository.findOne).toHaveBeenCalledWith({
        where: { userId: "u1" },
      });
      expect(usersRepository.findOne).toHaveBeenCalledWith({
        where: { id: "u1" },
      });
    });

    it("returns false when the flag is on but no secret is stored", async () => {
      // The state issue #1429's reporter was left in: sign-in no longer asked
      // for a code, while Settings, reading the flag alone, still said enabled
      // and offered no way to enroll again. Status answers what sign-in does.
      preferencesRepository.findOne.mockResolvedValue({
        userId: "u1",
        twoFactorEnabled: true,
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        id: "u1",
        twoFactorSecret: null,
      });
      await expect(service.is2FAEnabled("u1")).resolves.toBe(false);
    });

    it("returns false when preferences are missing or 2FA is disabled", async () => {
      preferencesRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.is2FAEnabled("u1")).resolves.toBe(false);

      preferencesRepository.findOne.mockResolvedValueOnce({
        userId: "u1",
        twoFactorEnabled: false,
      });
      await expect(service.is2FAEnabled("u1")).resolves.toBe(false);
    });
  });

  describe("verify2FA - atomic backup code consumption", () => {
    it("uses QueryRunner transaction for backup code removal", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);

      // Generate backup codes
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      usersRepository.save.mockImplementation((u) => u);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      const codes = await service.generateBackupCodes("user-1", "123456");
      const savedUser = usersRepository.save.mock.calls[0][0];

      // Set up QueryRunner mock
      const mockQRManager = {
        findOne: jest.fn().mockResolvedValue({
          ...mockUser,
          twoFactorSecret: encryptedSecret,
          backupCodes: savedUser.backupCodes,
        }),
        createQueryBuilder: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        }),
      };
      installTransactionMock(mockQRManager);

      // Set up verify2FA context
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: savedUser.backupCodes,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      const result = await service.verify2FA("atomic-backup-token", codes[0]);

      expect(result.user).toBeDefined();
      // The consumption now runs in one withScopedDb transaction; what matters
      // is that the read still takes the pessimistic lock.
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(mockQRManager.findOne).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          lock: { mode: "pessimistic_write" },
        }),
      );
    });

    it("rolls back transaction if backup code was already consumed", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      const hashedCodes = [await bcrypt.hash("abcd-1234", 10)];

      // QueryRunner returns user with no backup codes (already consumed)
      const mockQRManager = {
        findOne: jest.fn().mockResolvedValue({
          ...mockUser,
          backupCodes: null,
        }),
      };
      installTransactionMock(mockQRManager);

      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: JSON.stringify(hashedCodes),
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(
        service.verify2FA("consumed-backup-token", "abcd-1234"),
      ).rejects.toThrow("Invalid verification code");

      // The consumption block returns early without writing, so its
      // transaction commits empty -- same net effect as the old rollback.
      expect(dataSource.transaction).toHaveBeenCalled();
    });
  });

  describe("confirmEmailChange", () => {
    // The link is followed signed out, so the service seeds its own identity
    // around the token lookup, the same way verifyEmail does.
    it("hands the token to AuthEmailService", async () => {
      const authEmail = (
        service as unknown as { authEmailService: AuthEmailService }
      ).authEmailService;
      const confirm = jest
        .spyOn(authEmail, "confirmEmailChange")
        .mockResolvedValue(undefined);

      await service.confirmEmailChange("change-token");

      expect(confirm).toHaveBeenCalledWith("change-token");
    });
  });
});
