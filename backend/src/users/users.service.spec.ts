import { Test, TestingModule } from "@nestjs/testing";
import {
  NotFoundException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import * as bcrypt from "bcryptjs";
import { UsersService } from "./users.service";
import { User } from "./entities/user.entity";
import { UserPreference } from "./entities/user-preference.entity";
import { TrustedDevice } from "./entities/trusted-device.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { PersonalAccessToken } from "../auth/entities/personal-access-token.entity";
import { PasswordBreachService } from "../auth/password-breach.service";
import { ModuleRef } from "@nestjs/core";
import { OAUTH_GRANT_REVOKER } from "../auth/credential-revocation";
import { I18nContext } from "nestjs-i18n";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { CurrenciesService } from "../currencies/currencies.service";
import { BackupEncryptionService } from "../backup/backup-encryption.service";
import { DemoModeService } from "../common/demo-mode.service";
import { OidcReauthService } from "../auth/oidc/oidc-reauth.service";
import { ConfigService } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { QueryFailedError } from "typeorm";
import { EmailService } from "../notifications/email.service";
import { EmailChangeService } from "./email-change.service";
import { hashToken } from "../auth/crypto.util";
import {
  createUserMaintenanceMock,
  userMaintenanceProvider,
  type UserMaintenanceMock,
} from "../test-helpers/job-claim-testing";
import {
  createScopedDbMocks,
  withStepUpClaimLedger,
} from "../test-helpers/scoped-db-testing";
import {
  createUserPreferenceRepoMock,
  type UserPreferenceRepoMock,
} from "../test-helpers/user-preference-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("UsersService", () => {
  let service: UsersService;
  let usersRepository: Record<string, jest.Mock>;
  let preferencesRepository: Record<string, jest.Mock>;
  let preferencesRow: UserPreferenceRepoMock;
  let refreshTokensRepository: Record<string, jest.Mock>;
  let patRepository: Record<string, jest.Mock>;
  let trustedDevicesRepository: Record<string, jest.Mock>;
  let passwordBreachService: { isBreached: jest.Mock };
  let demoModeService: { isDemo: boolean };
  let maintenance: UserMaintenanceMock;
  let exchangeRateService: { refreshAllRates: jest.Mock };
  let currenciesService: jest.Mocked<
    Pick<
      CurrenciesService,
      | "ensureCurrencyForUser"
      | "lockCurrenciesCreatedBy"
      | "removeUnreferencedCurrencies"
    >
  >;
  let backupEncryptionService: { rewrapBackupKey: jest.Mock };
  let moduleRef: { get: jest.Mock };
  let emailService: { getStatus: jest.Mock; sendMail: jest.Mock };
  let oauthProviderService: { revokeAllForUser: jest.Mock };
  let mockQueryRunner: Record<string, jest.Mock>;
  let mockDataSource: Record<string, jest.Mock>;

  const mockUser = {
    id: "user-1",
    email: "test@example.com",
    firstName: "Test",
    lastName: "User",
    passwordHash: "$2a$10$hashedpassword",
    authProvider: "local",
    role: "user",
    isActive: true,
    twoFactorSecret: null,
    resetToken: null,
    resetTokenExpiry: null,
    mustChangePassword: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPreferences = {
    userId: "user-1",
    defaultCurrency: "USD",
    dateFormat: "browser",
    numberFormat: "browser",
    theme: "system",
    timezone: "browser",
    notificationEmail: true,
    twoFactorEnabled: false,
    gettingStartedDismissed: false,
    favouriteReportIds: [],
    preferredExchanges: [],
  };

  beforeEach(async () => {
    usersRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn().mockImplementation((data) => data),
      remove: jest.fn(),
      count: jest.fn(),
    };

    // A double that behaves like the row rather than recording `save` calls: the
    // writers now insert-if-absent then patch named columns, and a call-recording
    // mock cannot tell a targeted patch from a whole-entity overwrite.
    preferencesRow = createUserPreferenceRepoMock(null);
    preferencesRepository = preferencesRow.repo;

    refreshTokensRepository = {
      update: jest.fn(),
      delete: jest.fn(),
    };

    patRepository = {
      update: jest.fn(),
      delete: jest.fn(),
    };

    trustedDevicesRepository = {
      delete: jest.fn(),
    };

    passwordBreachService = {
      isBreached: jest.fn().mockResolvedValue(false),
    };

    exchangeRateService = {
      refreshAllRates: jest.fn().mockResolvedValue({
        totalPairs: 0,
        updated: 0,
        failed: 0,
        results: [],
        lastUpdated: new Date(),
      }),
    };

    backupEncryptionService = {
      rewrapBackupKey: jest.fn().mockResolvedValue(undefined),
    };

    currenciesService = {
      ensureCurrencyForUser: jest.fn().mockResolvedValue(undefined),
      lockCurrenciesCreatedBy: jest.fn().mockResolvedValue([]),
      removeUnreferencedCurrencies: jest.fn().mockResolvedValue(undefined),
    };

    // SMTP off by default: the email-change tests that need a confirmation
    // link switch it on.
    emailService = {
      getStatus: jest.fn().mockReturnValue({ configured: false }),
      sendMail: jest.fn().mockResolvedValue(undefined),
    };
    oauthProviderService = { revokeAllForUser: jest.fn().mockResolvedValue(0) };

    moduleRef = {
      get: jest.fn((token) => {
        if (token === EmailService) return emailService;
        if (token === ExchangeRateService) return exchangeRateService;
        if (token === BackupEncryptionService) return backupEncryptionService;
        if (token === CurrenciesService) return currenciesService;
        if (token === OAUTH_GRANT_REVOKER) return oauthProviderService;
        return undefined;
      }),
    };

    demoModeService = { isDemo: false };
    maintenance = createUserMaintenanceMock();

    mockQueryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn().mockResolvedValue([null, 0]),
    };

    // The delete/downgrade blocks are now single `withScopedDb` transactions,
    // so the former queryRunner's raw SQL lands on the transaction manager.
    const scoped = createScopedDbMocks([
      [User, usersRepository as never],
      [UserPreference, preferencesRepository as never],
      [RefreshToken, refreshTokensRepository as never],
      [PersonalAccessToken, patRepository as never],
      [TrustedDevice, trustedDevicesRepository as never],
    ]);
    // Raw DELETEs return [rows, count]; isActingDelegate reads rows.length, so
    // the shared default must be an empty result set, not a 2-tuple.
    scoped.manager.query.mockResolvedValue([]);
    // The real OidcReauthService below spends each artifact's jti in the
    // oidc_step_up_claims ledger; answer those statements like the table does.
    withStepUpClaimLedger(scoped.manager.query);
    mockQueryRunner.query = scoped.manager.query;
    scoped.dataSource.query = scoped.manager.query;
    mockDataSource = scoped.dataSource as unknown as Record<string, jest.Mock>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: PasswordBreachService, useValue: passwordBreachService },
        { provide: ModuleRef, useValue: moduleRef },
        { provide: DemoModeService, useValue: demoModeService },
        // Real instance, not a double: its whole job is cryptographic
        // verification, and a mock that always says yes would make every
        // re-authentication assertion below vacuous -- which is how the
        // sentinel survived (P2-005).
        OidcReauthService,
        userMaintenanceProvider(maintenance),
        // Real instance: the staging, the token hashing and the two sends are
        // what the email-change tests below assert.
        EmailChangeService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((_key: string, fallback?: string) => fallback),
          },
        },
        {
          provide: I18nService,
          useValue: {
            translate: jest.fn(
              (_key: string, opts: { defaultValue: string }) =>
                opts.defaultValue,
            ),
          },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  // Signing key for the artifacts below. The service reads it fresh from the
  // environment, so a spec that mints one has to supply it.
  const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = "spec-jwt-secret-of-at-least-32-characters";
  });

  afterAll(() => {
    if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  });

  /**
   * A genuine re-authentication artifact, minted the way the OIDC callback does.
   *
   * Deliberately not a fixture string: the point of P2-005 is that the old code
   * accepted any non-empty value, and a spec that hands the service a literal
   * would keep passing if the verification were removed again.
   */
  function oidcArtifact(
    purpose: Parameters<OidcReauthService["issue"]>[1],
    forUser = "user-1",
  ): string {
    // `issue` only signs; the DataSource is only touched by `consume`.
    return new OidcReauthService(undefined as never).issue(forUser, purpose);
  }

  describe("findById", () => {
    it("returns user when found", async () => {
      usersRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.findById("user-1");

      expect(result).toEqual(mockUser);
      expect(usersRepository.findOne).toHaveBeenCalledWith({
        where: { id: "user-1" },
      });
    });

    it("returns null when not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      const result = await service.findById("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("findByEmail", () => {
    it("returns user when found", async () => {
      usersRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.findByEmail("test@example.com");

      expect(result).toEqual(mockUser);
      expect(usersRepository.findOne).toHaveBeenCalledWith({
        where: { email: "test@example.com" },
      });
    });

    it("returns null when not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      const result = await service.findByEmail("nobody@example.com");

      expect(result).toBeNull();
    });
  });

  describe("findAll", () => {
    it("returns all users", async () => {
      usersRepository.find.mockResolvedValue([mockUser]);

      const result = await service.findAll();

      expect(result).toHaveLength(1);
      expect(usersRepository.find).toHaveBeenCalled();
    });
  });

  describe("updateProfile", () => {
    it("updates first and last name", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });
      usersRepository.save.mockImplementation((user) => user);

      const result = await service.updateProfile("user-1", {
        firstName: "Updated",
        lastName: "Name",
      });

      expect(result.firstName).toBe("Updated");
      expect(result.lastName).toBe("Name");
    });

    it("without SMTP, applies the change on the password check alone", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne
        .mockResolvedValueOnce({ ...mockUser, passwordHash: hashedPassword }) // find user
        .mockResolvedValueOnce(null); // email not taken
      usersRepository.save.mockImplementation((user) => user);

      const result = await service.updateProfile("user-1", {
        email: "new@example.com",
        currentPassword: "CorrectPass123!",
      });

      expect(result.email).toBe("new@example.com");
    });

    it("throws BadRequestException when changing email without password", async () => {
      usersRepository.findOne.mockResolvedValueOnce({ ...mockUser });

      await expect(
        service.updateProfile("user-1", { email: "new@example.com" }),
      ).rejects.toThrow("Current password is required to change email address");
    });

    it("throws BadRequestException when changing email with wrong password", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValueOnce({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await expect(
        service.updateProfile("user-1", {
          email: "new@example.com",
          currentPassword: "WrongPassword!",
        }),
      ).rejects.toThrow("Current password is incorrect");
    });

    it("throws ConflictException when email is already taken", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne
        .mockResolvedValueOnce({ ...mockUser, passwordHash: hashedPassword }) // find user
        .mockResolvedValueOnce({ id: "other-user" }); // email taken

      await expect(
        service.updateProfile("user-1", {
          email: "taken@example.com",
          currentPassword: "CorrectPass123!",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("throws NotFoundException when user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateProfile("nonexistent", { firstName: "Test" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("strips sensitive fields from result", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });
      usersRepository.save.mockImplementation((user) => user);

      const result = await service.updateProfile("user-1", {
        firstName: "Updated",
      });

      expect(result).not.toHaveProperty("passwordHash");
      expect(result).not.toHaveProperty("resetToken");
      expect(result).not.toHaveProperty("resetTokenExpiry");
      expect(result).not.toHaveProperty("twoFactorSecret");
      expect(result).toHaveProperty("hasPassword", true);
    });

    it("sets hasPassword to false when no password hash", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: null,
      });
      usersRepository.save.mockImplementation((user) => user);

      const result = await service.updateProfile("user-1", {
        firstName: "Updated",
      });

      expect(result.hasPassword).toBe(false);
    });

    it("rejects email change for accounts without a local password", async () => {
      usersRepository.findOne.mockResolvedValueOnce({
        ...mockUser,
        passwordHash: null,
      });

      await expect(
        service.updateProfile("user-1", {
          email: "new@example.com",
          currentPassword: "anything",
        }),
      ).rejects.toThrow(
        "Cannot change email for accounts without a local password",
      );
    });

    it("rejects email change for an SSO account while password login is off", async () => {
      usersRepository.findOne.mockResolvedValueOnce({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: "some-hash",
      });

      await expect(
        service.updateProfile("user-1", {
          email: "new@example.com",
          currentPassword: "anything",
        }),
      ).rejects.toThrow(
        "Cannot change email for accounts without a local password",
      );
    });

    describe("email change with SMTP configured", () => {
      let hashedPassword: string;

      beforeAll(async () => {
        hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      });

      beforeEach(() => {
        emailService.getStatus.mockReturnValue({ configured: true });
        usersRepository.findOne
          .mockResolvedValueOnce({ ...mockUser, passwordHash: hashedPassword })
          .mockResolvedValueOnce(null);
        usersRepository.save.mockImplementation((user) => user);
      });

      const request = () =>
        service.updateProfile("user-1", {
          email: "  New.Person@Example.COM ",
          currentPassword: "CorrectPass123!",
        });

      it("does not change the live email until the link is followed", async () => {
        const result = await request();

        expect(result.email).toBe("test@example.com");
        expect(result.pendingEmail).toBe("new.person@example.com");
        const saved = usersRepository.save.mock.calls[0][0];
        expect(saved.email).toBe("test@example.com");
      });

      it("normalizes the new address the way registration does", async () => {
        await request();

        expect(usersRepository.findOne).toHaveBeenNthCalledWith(2, {
          where: { email: "new.person@example.com" },
        });
        const saved = usersRepository.save.mock.calls[0][0];
        expect(saved.pendingEmail).toBe("new.person@example.com");
      });

      it("stores only the hash of an expiring token and emails the raw one", async () => {
        await request();

        const saved = usersRepository.save.mock.calls[0][0];
        const [to, , html] = emailService.sendMail.mock.calls[0];
        expect(to).toBe("new.person@example.com");
        const token = /confirm-email-change\?token=([0-9a-f]{64})/.exec(
          html,
        )?.[1];
        expect(token).toBeDefined();
        expect(saved.emailChangeToken).toBe(hashToken(token!));
        expect(saved.emailChangeToken).not.toBe(token);
        const ttl = saved.emailChangeTokenExpiry.getTime() - Date.now();
        expect(ttl).toBeGreaterThan(23 * 60 * 60 * 1000);
        expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
      });

      it("notifies the current address, naming the requested one", async () => {
        await request();

        expect(emailService.sendMail).toHaveBeenCalledTimes(2);
        const [to, subject, html] = emailService.sendMail.mock.calls[1];
        expect(to).toBe("test@example.com");
        expect(subject).toBe("Monize email change requested");
        expect(html).toContain("new.person@example.com");
        expect(html).not.toContain("confirm-email-change");
      });

      it("sends nothing when the request is refused", async () => {
        usersRepository.findOne.mockReset();
        usersRepository.findOne.mockResolvedValueOnce({
          ...mockUser,
          passwordHash: hashedPassword,
        });

        await expect(
          service.updateProfile("user-1", {
            email: "new@example.com",
            currentPassword: "WrongPassword!",
          }),
        ).rejects.toThrow("Current password is incorrect");
        expect(usersRepository.save).not.toHaveBeenCalled();
        expect(emailService.sendMail).not.toHaveBeenCalled();
      });

      it("still answers the request when a send fails", async () => {
        emailService.sendMail.mockRejectedValue(new Error("smtp down"));

        const result = await request();

        expect(result.pendingEmail).toBe("new.person@example.com");
      });
    });

    it("answers a unique-index race on an immediate change with 409", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne
        .mockResolvedValueOnce({ ...mockUser, passwordHash: hashedPassword })
        .mockResolvedValueOnce(null);
      usersRepository.save.mockRejectedValue(
        new QueryFailedError("UPDATE users", [], {
          code: "23505",
        } as unknown as Error),
      );

      await expect(
        service.updateProfile("user-1", {
          email: "new@example.com",
          currentPassword: "CorrectPass123!",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("treats a case-only difference from the current email as unchanged", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });
      usersRepository.save.mockImplementation((user) => user);

      const result = await service.updateProfile("user-1", {
        email: "TEST@example.com",
      });

      expect(result.email).toBe("test@example.com");
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("does not require password when email is unchanged", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        email: "same@example.com",
      });
      usersRepository.save.mockImplementation((user) => user);

      const result = await service.updateProfile("user-1", {
        email: "same@example.com",
        firstName: "Bob",
      });

      expect(result.firstName).toBe("Bob");
    });
  });

  describe("getPreferences", () => {
    it("returns existing preferences", async () => {
      preferencesRepository.findOne.mockResolvedValue(mockPreferences);

      const result = await service.getPreferences("user-1");

      expect(result).toEqual(mockPreferences);
    });

    it("creates default preferences when none exist", async () => {
      preferencesRow.seed(null);

      const result = await service.getPreferences("user-1");

      // Materialized with `INSERT ... ON CONFLICT DO NOTHING`, not a read-then-
      // save: the first page load fires several requests at once and two of them
      // both finding no row used to mean one got a unique violation.
      expect(preferencesRow.insertAttempts()).toHaveLength(1);
      expect(result.userId).toBe("user-1");
      expect(result.defaultCurrency).toBe("USD");
      expect(result.dateFormat).toBe("browser");
      expect(result.theme).toBe("system");
      expect(result.favouriteReportIds).toEqual([]);
    });

    it("reports 2FA as enabled only when a secret is stored under the flag", async () => {
      preferencesRow.seed({ ...mockPreferences, twoFactorEnabled: true });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: "encrypted-secret",
      });

      const result = await service.getPreferences("user-1");

      expect(result.twoFactorEnabled).toBe(true);
      expect(result).toBeInstanceOf(UserPreference);
    });

    it("reports 2FA as off when the flag is on but no secret is stored", async () => {
      // Sign-in does not ask for a code in this state, so Settings must not
      // say 2FA is on: that hid the Enable button and left the user no way to
      // enroll again. The stored column is left as it is; disabling or
      // resetting 2FA is what clears it.
      preferencesRow.seed({ ...mockPreferences, twoFactorEnabled: true });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: null,
      });

      const result = await service.getPreferences("user-1");

      expect(result.twoFactorEnabled).toBe(false);
      // Still a UserPreference, so the serializer keeps its @Exclude() columns
      // out of the response.
      expect(result).toBeInstanceOf(UserPreference);
      expect(preferencesRow.row()!.twoFactorEnabled).toBe(true);
      expect(preferencesRow.patches()).toHaveLength(0);
    });
  });

  describe("updatePreferences -- writes only what was asked for", () => {
    it("reports 2FA the way sign-in enforces it in the saved preferences", async () => {
      // The client replaces its preferences with this response, so reading the
      // raw flag here would put the stale "enabled" straight back after any
      // Settings save.
      preferencesRow.seed({ ...mockPreferences, twoFactorEnabled: true });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: null,
      });

      const result = await service.updatePreferences("user-1", {
        theme: "dark",
      });

      expect(result.twoFactorEnabled).toBe(false);
      expect(result.theme).toBe("dark");
    });

    it("sends exactly the supplied columns to the database", async () => {
      // The regression: this used to mutate a loaded entity and `repo.save` it,
      // which writes back every column that differs from what the entity holds.
      // `tour_progress`, `last_seen_version` and `dismissed_update_version` are
      // written by other endpoints on the same row, so a Settings save could
      // quietly undo a tour the user had just dismissed in another tab.
      preferencesRow.seed(mockPreferences);

      await service.updatePreferences("user-1", {
        theme: "dark",
        weekStartsOn: 1,
      });

      expect(preferencesRow.patches()).toHaveLength(1);
      expect(Object.keys(preferencesRow.patches()[0]).sort()).toEqual([
        "theme",
        "weekStartsOn",
      ]);
      expect(preferencesRepository.save).not.toHaveBeenCalled();
    });

    it("leaves a column another request changed alone", async () => {
      preferencesRow.seed({
        ...mockPreferences,
        tourProgress: { a: 1 } as never,
      });

      await service.updatePreferences("user-1", { theme: "dark" });

      expect(preferencesRow.row()!.tourProgress).toEqual({ a: 1 });
      expect(preferencesRow.row()!.theme).toBe("dark");
    });

    it("writes nothing when the request carries no recognised field", async () => {
      // An empty patch must not become `UPDATE ... SET` with no assignments, and
      // must not fall back to writing the whole row either.
      preferencesRow.seed(mockPreferences);

      await service.updatePreferences("user-1", {});

      expect(preferencesRow.patches()).toHaveLength(0);
      expect(preferencesRepository.save).not.toHaveBeenCalled();
    });

    it("omits the language in demo mode without dropping the rest", async () => {
      demoModeService.isDemo = true;
      preferencesRow.seed({ ...mockPreferences, language: "en" });

      await service.updatePreferences("user-1", {
        language: "pl",
        theme: "dark",
      });

      expect(Object.keys(preferencesRow.patches()[0])).toEqual(["theme"]);
      expect(preferencesRow.row()!.language).toBe("en");
    });
  });

  describe("updatePreferences", () => {
    it("updates only provided fields", async () => {
      preferencesRow.seed(mockPreferences);

      await service.updatePreferences("user-1", { theme: "dark" });

      const savedData = preferencesRow.row()!;
      expect(savedData.theme).toBe("dark");
      expect(savedData.defaultCurrency).toBe("USD"); // unchanged
    });

    it("persists the language when not in demo mode", async () => {
      demoModeService.isDemo = false;
      preferencesRow.seed(mockPreferences);

      await service.updatePreferences("user-1", { language: "pl" });

      const savedData = preferencesRow.row()!;
      expect(savedData.language).toBe("pl");
    });

    it("does not persist the language in demo mode (shared account)", async () => {
      demoModeService.isDemo = true;
      preferencesRow.seed({
        ...mockPreferences,
        language: "en",
      });

      await service.updatePreferences("user-1", {
        language: "pl",
        theme: "dark",
      });

      const savedData = preferencesRow.row()!;
      // Language stays as the shared account had it; other fields still apply.
      expect(savedData.language).toBe("en");
      expect(savedData.theme).toBe("dark");
    });

    it("creates defaults first if preferences do not exist", async () => {
      preferencesRow.seed(null);

      await service.updatePreferences("user-1", {
        defaultCurrency: "EUR",
      });

      // The row is materialized from the shared defaults and then patched.
      expect(preferencesRow.insertAttempts()).toHaveLength(1);
      expect(preferencesRow.row()!.defaultCurrency).toBe("EUR");
    });

    it("ensures the chosen default currency for the user, before the preference is written", async () => {
      preferencesRow.seed(mockPreferences);
      let patchesWhenEnsured = -1;
      currenciesService.ensureCurrencyForUser.mockImplementation(async () => {
        patchesWhenEnsured = preferencesRow.patches().length;
      });

      await service.updatePreferences("user-1", { defaultCurrency: "EUR" });

      expect(currenciesService.ensureCurrencyForUser).toHaveBeenCalledWith(
        "user-1",
        "EUR",
      );
      expect(patchesWhenEnsured).toBe(0);
      expect(preferencesRow.row()!.defaultCurrency).toBe("EUR");
    });

    it("fails the request, writing nothing, when the currency cannot be ensured", async () => {
      preferencesRow.seed(mockPreferences);
      currenciesService.ensureCurrencyForUser.mockRejectedValue(
        new Error("refused"),
      );

      await expect(
        service.updatePreferences("user-1", { defaultCurrency: "EUR" }),
      ).rejects.toThrow("refused");

      expect(preferencesRow.patches()).toHaveLength(0);
    });

    it("does not ensure a currency when the default is unchanged", async () => {
      preferencesRow.seed(mockPreferences);

      await service.updatePreferences("user-1", { defaultCurrency: "USD" });

      expect(currenciesService.ensureCurrencyForUser).not.toHaveBeenCalled();
    });

    it("updates multiple fields at once", async () => {
      preferencesRow.seed(mockPreferences);

      await service.updatePreferences("user-1", {
        defaultCurrency: "CAD",
        theme: "dark",
        notificationEmail: false,
        gettingStartedDismissed: true,
      });

      const savedData = preferencesRow.row()!;
      expect(savedData.defaultCurrency).toBe("CAD");
      expect(savedData.theme).toBe("dark");
      expect(savedData.notificationEmail).toBe(false);
      expect(savedData.gettingStartedDismissed).toBe(true);
    });

    it("updates the showWhatsNew preference", async () => {
      preferencesRow.seed(mockPreferences);

      await service.updatePreferences("user-1", { showWhatsNew: false });

      const savedData = preferencesRow.row()!;
      expect(savedData.showWhatsNew).toBe(false);
    });

    it("updates favouriteReportIds", async () => {
      preferencesRow.seed(mockPreferences);

      await service.updatePreferences("user-1", {
        favouriteReportIds: ["spending-by-category", "net-worth"],
      });

      const savedData = preferencesRow.row()!;
      expect(savedData.favouriteReportIds).toEqual([
        "spending-by-category",
        "net-worth",
      ]);
    });

    it("updates dashboardWidgets", async () => {
      preferencesRow.seed(mockPreferences);

      await service.updatePreferences("user-1", {
        dashboardWidgets: ["upcoming-bills", "favourite-accounts"],
      });

      const savedData = preferencesRow.row()!;
      expect(savedData.dashboardWidgets).toEqual([
        "upcoming-bills",
        "favourite-accounts",
      ]);
    });

    it("updates dashboardWidgetConfig", async () => {
      preferencesRow.seed(mockPreferences);

      await service.updatePreferences("user-1", {
        dashboardWidgetConfig: {
          "spending-by-payee": { range: "6m" },
        },
      });

      const savedData = preferencesRow.row()!;
      expect(savedData.dashboardWidgetConfig).toEqual({
        "spending-by-payee": { range: "6m" },
      });
    });

    it("updates hiddenTableColumns", async () => {
      preferencesRow.seed(mockPreferences);

      await service.updatePreferences("user-1", {
        hiddenTableColumns: {
          transactions: ["refNumber", "attachments"],
          investmentRegister: ["status"],
        },
      });

      const savedData = preferencesRow.row()!;
      expect(savedData.hiddenTableColumns).toEqual({
        transactions: ["refNumber", "attachments"],
        investmentRegister: ["status"],
      });
    });

    it("merges hiddenTableColumns by table kind, keeping kinds it was not sent", async () => {
      // Another device set the holdings default; this save, from a screen that
      // never saw it, sends only the kind it changed.
      preferencesRow.seed({
        ...mockPreferences,
        hiddenTableColumns: {
          transactions: ["tags"],
          investmentHoldings: ["avgCost"],
        },
      });

      await service.updatePreferences("user-1", {
        hiddenTableColumns: { transactions: [] },
      });

      expect(preferencesRow.row()!.hiddenTableColumns).toEqual({
        transactions: [],
        investmentHoldings: ["avgCost"],
      });
    });

    it("leaves hiddenTableColumns untouched when not provided", async () => {
      preferencesRow.seed({
        ...mockPreferences,
        hiddenTableColumns: { transactions: ["tags"] },
      });

      await service.updatePreferences("user-1", { timeFormat: "24h" });

      const savedData = preferencesRow.row()!;
      expect(savedData.hiddenTableColumns).toEqual({ transactions: ["tags"] });
    });

    it("updates viewDefaults", async () => {
      preferencesRow.seed({ ...mockPreferences, viewDefaults: {} });

      await service.updatePreferences("user-1", {
        viewDefaults: {
          density: "compact",
          chartCollapsed: true,
          accountOpenTarget: "dashboard",
        },
      });

      const savedData = preferencesRow.row()!;
      expect(savedData.viewDefaults).toEqual({
        density: "compact",
        chartCollapsed: true,
        accountOpenTarget: "dashboard",
      });
    });

    it("merges viewDefaults into the stored map, keeping keys it was not sent", async () => {
      // Another device set density; this save, from a screen that never saw
      // it, sends only the key it changed.
      preferencesRow.seed({
        ...mockPreferences,
        viewDefaults: { density: "compact", chartCollapsed: false },
      });

      await service.updatePreferences("user-1", {
        viewDefaults: { chartCollapsed: true },
      });

      expect(preferencesRow.row()!.viewDefaults).toEqual({
        density: "compact",
        chartCollapsed: true,
      });
    });

    it("leaves viewDefaults untouched when not provided", async () => {
      preferencesRow.seed({
        ...mockPreferences,
        viewDefaults: { widgetsCollapsed: true },
      });

      await service.updatePreferences("user-1", { timeFormat: "24h" });

      const savedData = preferencesRow.row()!;
      expect(savedData.viewDefaults).toEqual({ widgetsCollapsed: true });
    });

    it("updates preferredExchanges", async () => {
      preferencesRow.seed(mockPreferences);

      await service.updatePreferences("user-1", {
        preferredExchanges: ["LSE", "ASX", "TSX"],
      });

      const savedData = preferencesRow.row()!;
      expect(savedData.preferredExchanges).toEqual(["LSE", "ASX", "TSX"]);
    });

    it("clears preferredExchanges with empty array", async () => {
      preferencesRow.seed({
        ...mockPreferences,
        preferredExchanges: ["LSE"],
      });

      await service.updatePreferences("user-1", {
        preferredExchanges: [],
      });

      const savedData = preferencesRow.row()!;
      expect(savedData.preferredExchanges).toEqual([]);
    });

    it.each([
      ["dateFormat", "MM/DD/YYYY"],
      ["numberFormat", "en-CA"],
      ["timezone", "Europe/London"],
      ["weekStartsOn", 1],
      ["budgetDigestEnabled", true],
      ["budgetDigestDay", 5],
      ["showCreatedAt", true],
      ["timeFormat", "24h"],
      ["defaultQuoteProvider", "yahoo"],
      ["defaultMapProvider", "google"],
      ["recentTransactionsLimit", 25],
      ["language", "fr"],
      ["colorTheme", "latte"],
    ])(
      "updates the %s field when provided",
      async (field: string, value: any) => {
        preferencesRow.seed(mockPreferences);

        await service.updatePreferences("user-1", { [field]: value } as any);

        const savedData = preferencesRow.row()!;
        expect(savedData[field]).toEqual(value);
      },
    );

    it("leaves colorTheme untouched when not provided", async () => {
      preferencesRow.seed({
        ...mockPreferences,
        colorTheme: "nord",
      });

      await service.updatePreferences("user-1", { theme: "dark" });

      const savedData = preferencesRow.row()!;
      expect(savedData.colorTheme).toBe("nord");
    });

    it("seeds language='en' when creating default preferences", async () => {
      preferencesRow.seed(null);

      const result = await service.getPreferences("user-1");

      expect(result.language).toBe("en");
    });

    it("seeds language from the request locale when creating default preferences", async () => {
      preferencesRow.seed(null);
      const spy = jest
        .spyOn(I18nContext, "current")
        .mockReturnValue({ lang: "pl" } as never);

      const result = await service.getPreferences("user-1");

      expect(result.language).toBe("pl");
      spy.mockRestore();
    });
  });

  describe("changePassword", () => {
    it("changes password with valid current password", async () => {
      const hashedPassword = await bcrypt.hash("OldPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.changePassword("user-1", {
        currentPassword: "OldPass123!",
        newPassword: "NewPass456!",
      });

      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.mustChangePassword).toBe(false);
      // Verify new password was hashed (not stored as plaintext)
      const isNewHash = await bcrypt.compare(
        "NewPass456!",
        savedUser.passwordHash,
      );
      expect(isNewHash).toBe(true);
    });

    it("revokes all refresh tokens after password change", async () => {
      const hashedPassword = await bcrypt.hash("OldPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.changePassword("user-1", {
        currentPassword: "OldPass123!",
        newPassword: "NewPass456!",
      });

      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: "user-1", isRevoked: false },
        { isRevoked: true },
      );
    });

    it("re-wraps the backup key under the new login password", async () => {
      const hashedPassword = await bcrypt.hash("OldPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.changePassword("user-1", {
        currentPassword: "OldPass123!",
        newPassword: "NewPass456!",
      });

      // Bound to the hash just written, so the wrap is recorded against the
      // password it was made under.
      const [, , boundHash] =
        backupEncryptionService.rewrapBackupKey.mock.calls[0];
      expect(backupEncryptionService.rewrapBackupKey).toHaveBeenCalledWith(
        "user-1",
        "NewPass456!",
        expect.any(String),
      );
      expect(boundHash).not.toBe(hashedPassword);
      expect(await bcrypt.compare("NewPass456!", boundHash)).toBe(true);
    });

    it("password change still succeeds when backup-password sync fails", async () => {
      const hashedPassword = await bcrypt.hash("OldPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });
      backupEncryptionService.rewrapBackupKey.mockRejectedValue(
        new Error("sync failed"),
      );

      await expect(
        service.changePassword("user-1", {
          currentPassword: "OldPass123!",
          newPassword: "NewPass456!",
        }),
      ).resolves.not.toThrow();
      // The save still happened so the new hash is persisted.
      expect(usersRepository.save).toHaveBeenCalled();
    });

    it("revokes all PATs on password change", async () => {
      const hashedPassword = await bcrypt.hash("OldPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.changePassword("user-1", {
        currentPassword: "OldPass123!",
        newPassword: "NewPass456!",
      });

      expect(patRepository.update).toHaveBeenCalledWith(
        { userId: "user-1", isRevoked: false },
        { isRevoked: true },
      );
    });

    it("revokes trusted devices and every OAuth grant on password change", async () => {
      // A connected MCP client's OAuth grant outlived a password change, so
      // whoever the user was rotating the password against kept API access.
      const hashedPassword = await bcrypt.hash("OldPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.changePassword("user-1", {
        currentPassword: "OldPass123!",
        newPassword: "NewPass456!",
      });

      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: "user-1",
      });
      expect(oauthProviderService.revokeAllForUser).toHaveBeenCalledWith(
        "user-1",
      );
    });

    it("converges the refresh sessions after the password commit", async () => {
      // The in-transaction blanket UPDATE misses a successor a concurrent
      // rotation inserts after its snapshot (A26-M02); the converging revoke
      // runs after the commit, in its own transactions.
      const hashedPassword = await bcrypt.hash("OldPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });
      const order: string[] = [];
      const runTransaction =
        mockDataSource.transaction.getMockImplementation()!;
      mockDataSource.transaction.mockImplementation(async (...args: any[]) => {
        order.push("begin");
        const result = await runTransaction(...args);
        order.push("commit");
        return result;
      });
      usersRepository.save.mockImplementation(async (u: unknown) => {
        order.push("save");
        return u;
      });
      const answer = mockQueryRunner.query.getMockImplementation();
      mockQueryRunner.query.mockImplementation(
        async (sql: unknown, params?: unknown[]) => {
          if (String(sql).includes("SELECT DISTINCT family_id")) {
            order.push("converge");
            expect(params).toEqual(["user-1", null]);
            return [];
          }
          return answer ? answer(sql, params) : [];
        },
      );

      await service.changePassword("user-1", {
        currentPassword: "OldPass123!",
        newPassword: "NewPass456!",
      });

      const write = order.lastIndexOf("save");
      expect(order.slice(write - 1, write + 5)).toEqual([
        "begin",
        "save",
        "commit",
        "begin",
        "converge",
        "commit",
      ]);
    });

    it("writes the password and the row revocations in one transaction", async () => {
      const hashedPassword = await bcrypt.hash("OldPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });
      const order: string[] = [];
      const runTransaction =
        mockDataSource.transaction.getMockImplementation()!;
      mockDataSource.transaction.mockImplementation(async (...args: any[]) => {
        order.push("begin");
        const result = await runTransaction(...args);
        order.push("commit");
        return result;
      });
      usersRepository.save.mockImplementation(async (u: unknown) => {
        order.push("save");
        return u;
      });
      patRepository.update.mockImplementation(async () => {
        order.push("pats");
      });
      oauthProviderService.revokeAllForUser.mockImplementation(async () => {
        order.push("oauth");
        return 0;
      });

      await service.changePassword("user-1", {
        currentPassword: "OldPass123!",
        newPassword: "NewPass456!",
      });

      // The read of the user is its own short transaction; the write and the
      // PAT revocation share the next one, and the OAuth sweep follows commit.
      const write = order.lastIndexOf("save");
      expect(order.slice(write - 1, write + 3)).toEqual([
        "begin",
        "save",
        "pats",
        "commit",
      ]);
      expect(order[order.length - 1]).toBe("oauth");
    });

    it("throws when current password is incorrect", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await expect(
        service.changePassword("user-1", {
          currentPassword: "WrongPass",
          newPassword: "NewPass456!",
        }),
      ).rejects.toThrow("Current password is incorrect");
    });

    it("throws when no password is set", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: null,
      });

      await expect(
        service.changePassword("user-1", {
          currentPassword: "anything",
          newPassword: "NewPass456!",
        }),
      ).rejects.toThrow("No password set for this account");
    });

    it("refuses an SSO account that kept its password while SSO password sign-in is off", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: await bcrypt.hash("OldPass123!", 10),
      });

      await expect(
        service.changePassword("user-1", {
          currentPassword: "OldPass123!",
          newPassword: "NewPass456!",
        }),
      ).rejects.toThrow("No password set for this account");
      expect(usersRepository.save).not.toHaveBeenCalled();
    });

    it("throws when user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.changePassword("nonexistent", {
          currentPassword: "pass",
          newPassword: "NewPass456!",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("rejects breached password during change", async () => {
      const hashedPassword = await bcrypt.hash("OldPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });
      passwordBreachService.isBreached.mockResolvedValue(true);

      await expect(
        service.changePassword("user-1", {
          currentPassword: "OldPass123!",
          newPassword: "BreachedPass123!",
        }),
      ).rejects.toThrow("found in a data breach");
    });
  });

  describe("deleteAccount", () => {
    it("requires password for local auth users", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });

      await expect(service.deleteAccount("user-1", {})).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("rejects invalid password", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await expect(
        service.deleteAccount("user-1", { password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("deletes preferences, revokes tokens, then deletes user", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.deleteAccount("user-1", { password: "CorrectPass123!" });

      expect(preferencesRepository.delete).toHaveBeenCalledWith({
        userId: "user-1",
      });
      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: "user-1", isRevoked: false },
        { isRevoked: true },
      );
      expect(usersRepository.remove).toHaveBeenCalled();
    });

    it("locks the user's custom currencies, then removes the unreferenced ones after the user row", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });
      currenciesService.lockCurrenciesCreatedBy.mockResolvedValue(["PTS"]);

      await service.deleteAccount("user-1", { password: "CorrectPass123!" });

      expect(currenciesService.lockCurrenciesCreatedBy).toHaveBeenCalledWith(
        expect.anything(),
        "user-1",
      );
      expect(
        currenciesService.removeUnreferencedCurrencies,
      ).toHaveBeenCalledWith(expect.anything(), ["PTS"]);
      expect(
        currenciesService.lockCurrenciesCreatedBy.mock.invocationCallOrder[0],
      ).toBeLessThan(usersRepository.remove.mock.invocationCallOrder[0]);
      expect(usersRepository.remove.mock.invocationCallOrder[0]).toBeLessThan(
        currenciesService.removeUnreferencedCurrencies.mock
          .invocationCallOrder[0],
      );
    });

    it("deletes sessions and tokens so a non-cascading FK cannot block the delete", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.deleteAccount("user-1", { password: "CorrectPass123!" });

      expect(refreshTokensRepository.delete).toHaveBeenCalledWith({
        userId: "user-1",
      });
      expect(refreshTokensRepository.delete).toHaveBeenCalledWith({
        actingAsUserId: "user-1",
      });
      expect(patRepository.delete).toHaveBeenCalledWith({ userId: "user-1" });
    });

    it("revokes all PATs before deletion", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.deleteAccount("user-1", { password: "CorrectPass123!" });

      expect(patRepository.update).toHaveBeenCalledWith(
        { userId: "user-1", isRevoked: false },
        { isRevoked: true },
      );
    });

    it("throws when user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.deleteAccount("nonexistent", { password: "pass" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("demotes a delegate to a pure delegate instead of deleting", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });
      // isActingDelegate -> account_delegates lookup returns a row.
      mockDataSource.query.mockImplementation(async (sql: string) =>
        sql.includes("FROM account_delegates") &&
        sql.trimStart().startsWith("SELECT")
          ? [{ "?column?": 1 }]
          : [],
      );

      const result = await service.deleteAccount("user-1", {
        password: "CorrectPass123!",
      });

      // Sessions revoked, but the login and incoming delegations stay.
      expect(refreshTokensRepository.update).toHaveBeenCalled();
      expect(patRepository.update).toHaveBeenCalled();
      expect(preferencesRepository.delete).not.toHaveBeenCalled();
      expect(usersRepository.remove).not.toHaveBeenCalled();
      // Owned data + owner-side delegations are purged in a transaction,
      // and the row is flipped back to is_delegate_only so admin User
      // Management hides it again.
      expect(mockDataSource.transaction).toHaveBeenCalled();
      const queries = mockQueryRunner.query.mock.calls.map((c) => c[0]);
      expect(
        queries.some((q: string) =>
          q.includes("DELETE FROM account_delegates WHERE owner_user_id"),
        ),
      ).toBe(true);
      expect(
        queries.some((q: string) =>
          q.includes("UPDATE users SET is_delegate_only = true"),
        ),
      ).toBe(true);
      expect(result).toEqual({ downgraded: true });
    });

    it("prevents the last admin from self-deleting", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        role: "admin",
        passwordHash: hashedPassword,
      });
      usersRepository.count.mockResolvedValue(1);

      await expect(
        service.deleteAccount("user-1", { password: "CorrectPass123!" }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("allows admin self-deletion when other admins exist", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        role: "admin",
        passwordHash: hashedPassword,
      });
      usersRepository.count.mockResolvedValue(2);

      await service.deleteAccount("user-1", { password: "CorrectPass123!" });

      expect(usersRepository.remove).toHaveBeenCalled();
    });

    it("refuses under the admin lock even when the pre-flight count allowed it", async () => {
      // The real race: two admins self-delete at the same instant, both count
      // two, both proceed, and the instance ends up with no administrator. The
      // pre-flight count is deliberately permissive here; only the locked read in
      // the delete transaction can refuse.
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        role: "admin",
        passwordHash: hashedPassword,
      });
      usersRepository.count.mockResolvedValue(2);
      // Same jest.fn as the scoped manager's `query` (wired in beforeEach).
      mockQueryRunner.query.mockImplementation((sql: unknown) =>
        Promise.resolve(
          /FOR UPDATE/.test(String(sql)) ? [{ id: "user-1" }] : [],
        ),
      );

      await expect(
        service.deleteAccount("user-1", { password: "CorrectPass123!" }),
      ).rejects.toThrow(ForbiddenException);
      expect(usersRepository.remove).not.toHaveBeenCalled();
    });

    it("accepts OIDC token for OIDC-only users", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
      });

      await service.deleteAccount("user-1", {
        oidcIdToken: oidcArtifact("delete-account"),
      });

      expect(usersRepository.remove).toHaveBeenCalled();
    });

    it("requires OIDC token for OIDC-only users", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
      });

      await expect(service.deleteAccount("user-1", {})).rejects.toThrow(
        UnauthorizedException,
      );
    });

    // P2-005. Each of these used to be accepted, because the check was only
    // whether the field was non-empty.
    it.each([
      ["the sentinel the client used to send", "oidc-session-confirmed"],
      ["any non-empty string", "x"],
    ])("refuses %s as re-authentication", async (_label, token) => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
      });

      await expect(
        service.deleteAccount("user-1", { oidcIdToken: token }),
      ).rejects.toThrow(UnauthorizedException);
      expect(usersRepository.remove).not.toHaveBeenCalled();
    });

    it("refuses an artifact minted for a different action", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
      });

      await expect(
        service.deleteAccount("user-1", {
          oidcIdToken: oidcArtifact("restore-backup"),
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("refuses an artifact minted for a different user", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
      });

      await expect(
        service.deleteAccount("user-1", {
          oidcIdToken: oidcArtifact("delete-account", "someone-else"),
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    // The third branch: a local account with no password fell off the end of the
    // else-if and was required to prove nothing at all.
    it("refuses a local account that has no password to check", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "local",
        passwordHash: null,
      });

      await expect(service.deleteAccount("user-1", {})).rejects.toThrow(
        UnauthorizedException,
      );
      expect(usersRepository.remove).not.toHaveBeenCalled();
    });

    it("accepts OIDC token for OIDC users who also have a password", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: hashedPassword,
      });

      await service.deleteAccount("user-1", {
        oidcIdToken: oidcArtifact("delete-account"),
      });

      expect(usersRepository.remove).toHaveBeenCalled();
    });
  });

  describe("deleteData", () => {
    it("holds the maintenance lease for a user-initiated wipe", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.deleteData("user-1", { password: "CorrectPass123!" });

      expect(maintenance.withMaintenanceLease).toHaveBeenCalledWith(
        "user-1",
        expect.any(String),
        expect.any(Function),
      );
    });

    it("deletes nothing when another operation is already replacing the data", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });
      maintenance.withMaintenanceLease.mockRejectedValue(
        new ConflictException("busy"),
      );

      await expect(
        service.deleteData("user-1", { password: "CorrectPass123!" }),
      ).rejects.toThrow(ConflictException);

      const deletes = mockQueryRunner.query.mock.calls.filter(
        (call: string[]) => String(call[0]).includes("DELETE FROM"),
      );
      expect(deletes).toHaveLength(0);
    });

    it("skips the lease for the .mny importer's own wipe", async () => {
      // The importer already holds the user's single import slot, and that slot
      // is what excludes a second wipe. Taking the lease here would have
      // `withMaintenanceLease` refuse on the importer's own in-flight job.
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.deleteData(
        "user-1",
        { password: "CorrectPass123!" },
        "import-wipe",
        "mny-import",
      );

      expect(maintenance.withMaintenanceLease).not.toHaveBeenCalled();
      expect(
        mockQueryRunner.query.mock.calls.some((call: string[]) =>
          String(call[0]).includes("DELETE FROM"),
        ),
      ).toBe(true);
    });

    it("requires password for local auth users", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });

      await expect(service.deleteData("user-1", {})).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("rejects invalid password", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await expect(
        service.deleteData("user-1", { password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("deletes transaction data with valid password", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      const result = await service.deleteData("user-1", {
        password: "CorrectPass123!",
      });

      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(result).toHaveProperty("deleted");
    });

    it("deletes optional data when flags are set", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.deleteData("user-1", {
        password: "CorrectPass123!",
        deleteAccounts: true,
        deleteCategories: true,
        deletePayees: true,
        deleteExchangeRates: true,
      });

      // Verify queries were made for optional deletions
      const queries = mockQueryRunner.query.mock.calls.map((c) => c[0]);
      expect(
        queries.some((q: string) => q.includes("DELETE FROM accounts")),
      ).toBe(true);
      expect(
        queries.some((q: string) => q.includes("DELETE FROM categories")),
      ).toBe(true);
      expect(
        queries.some((q: string) => q.includes("DELETE FROM payees WHERE")),
      ).toBe(true);
      expect(
        queries.some((q: string) =>
          q.includes("DELETE FROM user_currency_preferences"),
        ),
      ).toBe(true);
    });

    it("resets account balances when accounts are not deleted", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.deleteData("user-1", {
        password: "CorrectPass123!",
        deleteAccounts: false,
      });

      const queries = mockQueryRunner.query.mock.calls.map((c) => c[0]);
      expect(
        queries.some((q: string) =>
          q.includes("UPDATE accounts SET current_balance = opening_balance"),
        ),
      ).toBe(true);
    });

    it("rolls back transaction on error", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });
      mockQueryRunner.query.mockRejectedValueOnce(new Error("DB error"));

      await expect(
        service.deleteData("user-1", { password: "CorrectPass123!" }),
      ).rejects.toThrow("DB error");

      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("accepts OIDC token for OIDC-only users", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
      });

      const result = await service.deleteData("user-1", {
        oidcIdToken: oidcArtifact("delete-data"),
      });

      expect(result).toHaveProperty("deleted");
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("requires OIDC token for OIDC-only users", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
      });

      await expect(service.deleteData("user-1", {})).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("accepts OIDC token for OIDC users who also have a password", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: hashedPassword,
      });

      const result = await service.deleteData("user-1", {
        oidcIdToken: oidcArtifact("delete-data"),
      });

      expect(result).toHaveProperty("deleted");
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("throws when user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.deleteData("nonexistent", { password: "pass" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("deletes core financial data (transactions, investments, budgets)", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.deleteData("user-1", {
        password: "CorrectPass123!",
      });

      const queries = mockQueryRunner.query.mock.calls.map(
        (c: unknown[]) => c[0],
      );
      expect(
        queries.some((q: string) =>
          q.includes("DELETE FROM investment_transactions"),
        ),
      ).toBe(true);
      expect(
        queries.some((q: string) => q.includes("DELETE FROM holdings")),
      ).toBe(true);
      expect(
        queries.some((q: string) => q.includes("DELETE FROM security_prices")),
      ).toBe(true);
      expect(
        queries.some((q: string) => q.includes("DELETE FROM securities")),
      ).toBe(true);
      expect(
        queries.some((q: string) => q.includes("DELETE FROM notifications")),
      ).toBe(true);
      // A reminder is a template the cron re-emits; left behind, it would keep
      // writing (and pushing) fresh notifications after "delete my data". The
      // account survives, so no CASCADE reaches it -- and it goes BEFORE the
      // notifications delete, which would otherwise SET NULL its source link.
      const reminders = queries.findIndex((q: string) =>
        q.includes("DELETE FROM notification_reminders"),
      );
      const notifications = queries.findIndex((q: string) =>
        q.includes("DELETE FROM notifications"),
      );
      expect(reminders).toBeGreaterThanOrEqual(0);
      expect(reminders).toBeLessThan(notifications);
      // Preferences are settings, not data: the matrix survives like user_preferences.
      expect(
        queries.some((q: string) =>
          q.includes("DELETE FROM notification_preferences"),
        ),
      ).toBe(false);
      // The account survives this flow, so nothing cascades: a device left
      // behind keeps its endpoint and both encryption keys, and anything a
      // producer sends still arrives on the phone of somebody who asked for
      // their data to be gone.
      expect(
        queries.some((q: string) =>
          q.includes("DELETE FROM push_subscriptions"),
        ),
      ).toBe(true);
      expect(
        queries.some((q: string) => q.includes("DELETE FROM budgets")),
      ).toBe(true);
      expect(
        queries.some((q: string) => q.includes("DELETE FROM transaction_tags")),
      ).toBe(true);
      expect(
        queries.some((q: string) =>
          q.includes("DELETE FROM transaction_splits"),
        ),
      ).toBe(true);
      expect(
        queries.some((q: string) => q.includes("DELETE FROM transactions")),
      ).toBe(true);
      // A warranty's transaction link is ON DELETE SET NULL and the account
      // survives, so nothing cascades to it: without its own delete every
      // warranty and claim outlives "delete my data".
      const claims = queries.findIndex((q: string) =>
        q.includes("DELETE FROM warranty_claims"),
      );
      const warranties = queries.findIndex((q: string) =>
        q.includes("DELETE FROM warranties"),
      );
      expect(claims).toBeGreaterThanOrEqual(0);
      expect(claims).toBeLessThan(warranties);
      expect(
        queries.some((q: string) =>
          q.includes("DELETE FROM scheduled_transactions"),
        ),
      ).toBe(true);
      expect(
        queries.some((q: string) =>
          q.includes("DELETE FROM monthly_account_balances"),
        ),
      ).toBe(true);
      expect(
        queries.some((q: string) => q.includes("DELETE FROM custom_reports")),
      ).toBe(true);
      expect(queries.some((q: string) => q.includes("DELETE FROM tags"))).toBe(
        true,
      );
      expect(
        queries.some((q: string) => q.includes("DELETE FROM action_history")),
      ).toBe(true);
    });

    it("does not delete optional data when flags are false", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.deleteData("user-1", {
        password: "CorrectPass123!",
        deleteAccounts: false,
        deleteCategories: false,
        deletePayees: false,
        deleteExchangeRates: false,
      });

      const queries = mockQueryRunner.query.mock.calls.map(
        (c: unknown[]) => c[0],
      );
      expect(
        queries.some(
          (q: string) => q === "DELETE FROM accounts WHERE user_id = $1",
        ),
      ).toBe(false);
      expect(
        queries.some(
          (q: string) => q === "DELETE FROM categories WHERE user_id = $1",
        ),
      ).toBe(false);
      expect(
        queries.some(
          (q: string) => q === "DELETE FROM payees WHERE user_id = $1",
        ),
      ).toBe(false);
      expect(
        queries.some(
          (q: string) =>
            q === "DELETE FROM user_currency_preferences WHERE user_id = $1",
        ),
      ).toBe(false);
    });

    it("clears FK references before deleting categories", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.deleteData("user-1", {
        password: "CorrectPass123!",
        deleteCategories: true,
      });

      const queries = mockQueryRunner.query.mock.calls.map(
        (c: unknown[]) => c[0],
      );
      expect(
        queries.some((q: string) =>
          q.includes("UPDATE payees SET default_category_id = NULL"),
        ),
      ).toBe(true);
      expect(
        queries.some((q: string) =>
          q.includes("UPDATE accounts SET principal_category_id = NULL"),
        ),
      ).toBe(true);
    });

    it("deletes payee_aliases when deleting payees", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.deleteData("user-1", {
        password: "CorrectPass123!",
        deletePayees: true,
      });

      const queries = mockQueryRunner.query.mock.calls.map(
        (c: unknown[]) => c[0],
      );
      expect(
        queries.some((q: string) => q.includes("DELETE FROM payee_aliases")),
      ).toBe(true);
    });

    it("does not reset balances when accounts are being deleted", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.deleteData("user-1", {
        password: "CorrectPass123!",
        deleteAccounts: true,
      });

      const queries = mockQueryRunner.query.mock.calls.map(
        (c: unknown[]) => c[0],
      );
      expect(
        queries.some((q: string) =>
          q.includes("UPDATE accounts SET current_balance = opening_balance"),
        ),
      ).toBe(false);
    });

    it("passes userId to all deletion queries", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.deleteData("user-1", {
        password: "CorrectPass123!",
      });

      for (const call of mockQueryRunner.query.mock.calls) {
        if (call[1]) {
          expect(call[1]).toContain("user-1");
        }
      }
    });

    it("falls back to 0 when query result[1] is undefined", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });
      // DELETEs omit their count so every deleted.<x> = result[1] ?? 0
      // fallback is exercised; SELECTs still return ordinary empty row sets.
      mockQueryRunner.query.mockImplementation(async (sql: string) =>
        sql.trimStart().startsWith("DELETE") ? [null, undefined] : [],
      );

      const r = await service.deleteData("user-1", {
        password: "CorrectPass123!",
        deleteAccounts: true,
        deleteCategories: true,
        deletePayees: true,
        deleteExchangeRates: true,
      });

      // When result[1] is undefined, the optional fields default to 0.
      expect(r.deleted.payees).toBe(0);
      expect(r.deleted.accounts).toBe(0);
      expect(r.deleted.categories).toBe(0);
      expect(r.deleted.exchangeRates).toBe(0);
    });

    it("deletes scheduled transactions before securities (investment_security_id FK)", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.deleteData("user-1", {
        password: "CorrectPass123!",
      });

      const sqls = mockQueryRunner.query.mock.calls.map(
        (call: unknown[]) => call[0] as string,
      );
      const scheduledIndex = sqls.findIndex((sql) =>
        sql.includes("DELETE FROM scheduled_transactions WHERE"),
      );
      const splitsIndex = sqls.findIndex((sql) =>
        sql.includes("DELETE FROM scheduled_transaction_splits"),
      );
      const securitiesIndex = sqls.findIndex((sql) =>
        sql.includes("DELETE FROM securities"),
      );

      expect(scheduledIndex).toBeGreaterThan(-1);
      expect(splitsIndex).toBeGreaterThan(-1);
      expect(securitiesIndex).toBeGreaterThan(-1);
      expect(scheduledIndex).toBeLessThan(securitiesIndex);
      expect(splitsIndex).toBeLessThan(securitiesIndex);
    });
  });
});
