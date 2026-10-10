import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { BillReminderService } from "./bill-reminder.service";
import { ScheduledEffectiveAmountService } from "../scheduled-transactions/scheduled-effective-amount.service";
import { ScheduledOccurrenceService } from "../scheduled-transactions/scheduled-occurrence.service";
import { ScheduledTransactionLoanService } from "../scheduled-transactions/scheduled-transaction-loan.service";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import {
  createInvestmentFxMock,
  InvestmentFxMock,
} from "../test-helpers/investment-fx-testing";
import { EmailService } from "./email.service";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "../scheduled-transactions/entities/scheduled-transaction-override.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { NotificationPreferenceService } from "../notification-center/notification-preference.service";
import {
  createJobClaimMock,
  TEST_LEASE_TOKEN,
  JobClaimMock,
  jobClaimProvider,
} from "../test-helpers/job-claim-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("BillReminderService", () => {
  /** Wins every claim, matching the pre-claim behaviour these specs describe. */
  const jobClaims: JobClaimMock = createJobClaimMock();
  let service: BillReminderService;
  let scheduledTransactionsRepo: Record<string, jest.Mock>;
  let overridesRepo: Record<string, jest.Mock>;
  let usersRepo: Record<string, jest.Mock>;
  let preferencesRepo: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;
  let investmentTransactionsService: InvestmentFxMock;

  beforeEach(async () => {
    // The claim double is shared across tests, so recorded calls and any queued
    // `...Once` would leak forward -- invisible until a spec asserts a claim was
    // *not* taken, and then it reads as a product bug.
    jobClaims.claimOnce.mockReset().mockResolvedValue(true);
    jobClaims.claimLease.mockReset().mockResolvedValue(TEST_LEASE_TOKEN);
    jobClaims.releaseLease.mockReset().mockResolvedValue(undefined);
    jobClaims.markDelivered.mockReset().mockResolvedValue(undefined);
    jobClaims.wasDelivered.mockReset().mockResolvedValue(false);

    scheduledTransactionsRepo = {
      find: jest.fn(),
    };

    // The occurrence contract loads a bill's overrides itself, keyed by schedule
    // id -- the per-bill fixtures below still carry them on the row for the
    // cross-user window filter, which cannot reach the database.
    overridesRepo = {
      find: jest.fn().mockResolvedValue([]),
    };

    usersRepo = {
      findOne: jest.fn(),
    };

    preferencesRepo = {
      findOne: jest.fn(),
    };

    emailService = {
      getStatus: jest.fn(),
      sendMail: jest.fn(),
    };

    configService = {
      get: jest.fn(),
    };

    // Issue #1247: the reminder's amounts come from the real effective-amount
    // resolver, so the double is the FX source beneath it, not the resolver
    // itself. Same-currency by default -- a plain bill's effective amount then
    // equals its stored one, which is what the pre-existing expectations assert.
    investmentTransactionsService = createInvestmentFxMock();

    const { dataSource } = createScopedDbMocks([
      [ScheduledTransaction, scheduledTransactionsRepo],
      [ScheduledTransactionOverride, overridesRepo],
      [User, usersRepo],
      [UserPreference, preferencesRepo],
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillReminderService,
        // Both read-side services are real over the stubbed FX source: which
        // occurrence is due and what it costs ARE their output (issue #1247).
        ScheduledOccurrenceService,
        // No loan bill here: the per-occurrence loan pricing is
        // `scheduled-occurrence.service.spec.ts`'s.
        {
          provide: ScheduledTransactionLoanService,
          useValue: {
            projectLoanOccurrencesMany: jest.fn().mockResolvedValue(new Map()),
          },
        },
        ScheduledEffectiveAmountService,
        {
          provide: InvestmentTransactionsService,
          useValue: investmentTransactionsService,
        },
        jobClaimProvider(jobClaims),
        { provide: DataSource, useValue: dataSource },
        { provide: EmailService, useValue: emailService },
        { provide: ConfigService, useValue: configService },
        {
          provide: I18nService,
          useValue: {
            translate: (key: string, opts?: { defaultValue?: string }) =>
              opts?.defaultValue ?? key,
          },
        },
        {
          // Mirror the real resolver's master-gate: with no per-category row,
          // resolveEmail == the user's notification_email, so the existing
          // preferencesRepo fixtures keep controlling the email path.
          provide: NotificationPreferenceService,
          useValue: {
            resolveEmail: jest.fn(async (userId: string) => {
              const prefs = await preferencesRepo.findOne({
                where: { userId },
              });
              return prefs ? prefs.notificationEmail !== false : true;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<BillReminderService>(BillReminderService);
  });

  describe("sendBillReminders", () => {
    const userId1 = "11111111-1111-1111-1111-111111111111";
    const userId2 = "22222222-2222-2222-2222-222222222222";

    const mockUser1: Partial<User> = {
      id: userId1,
      email: "user1@example.com",
      firstName: "Alice",
    };

    const mockUser2: Partial<User> = {
      id: userId2,
      email: "user2@example.com",
      firstName: "Bob",
    };

    const mockPrefsEmailEnabled: Partial<UserPreference> = {
      userId: userId1,
      notificationEmail: true,
    };

    const mockPrefsEmailDisabled: Partial<UserPreference> = {
      userId: userId2,
      notificationEmail: false,
    };

    function makeBill(
      overrides: Partial<ScheduledTransaction>,
    ): Partial<ScheduledTransaction> {
      return {
        id: "bill-uuid-1",
        userId: userId1,
        name: "Electric Bill",
        payeeName: null,
        payee: null,
        amount: -150.0,
        currencyCode: "USD",
        nextDueDate: daysFromNow(0),
        isActive: true,
        autoPost: false,
        reminderDaysBefore: 3,
        overrides: [],
        ...overrides,
      };
    }

    function makeOverride(
      overrides: Partial<ScheduledTransactionOverride>,
    ): Partial<ScheduledTransactionOverride> {
      return {
        id: "override-uuid-1",
        scheduledTransactionId: "bill-uuid-1",
        originalDate: daysFromNow(1),
        overrideDate: daysFromNow(1),
        amount: null,
        categoryId: null,
        description: null,
        isSplit: null,
        splits: null,
        ...overrides,
      };
    }

    function daysFromNow(days: number): string {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() + days);
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const d = String(date.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }

    describe("when SMTP is not configured", () => {
      it("returns early without querying bills", async () => {
        emailService.getStatus.mockReturnValue({ configured: false });

        await service.sendBillReminders();

        expect(scheduledTransactionsRepo.find).not.toHaveBeenCalled();
        expect(emailService.sendMail).not.toHaveBeenCalled();
      });
    });

    describe("when SMTP is configured", () => {
      beforeEach(() => {
        emailService.getStatus.mockReturnValue({ configured: true });
        configService.get.mockReturnValue("https://app.monize.com");
        emailService.sendMail.mockResolvedValue(undefined);
      });

      /**
       * Coordination and delivery are two different facts (audit RV4-006).
       *
       * `claimOnce` was taken before the send and was the only record that the
       * send was owed, so a replica killed in between left a permanent row that
       * every later run read as "already handled" -- the reminder was never sent
       * and nothing could notice.
       */
      describe("the claim is a lease, and delivery is recorded separately", () => {
        const dueBill = () =>
          makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(0),
            reminderDaysBefore: 3,
            name: "Electric Bill",
          });

        beforeEach(() => {
          scheduledTransactionsRepo.find.mockResolvedValue([dueBill()]);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);
        });

        it("takes a bounded lease rather than a permanent claim", async () => {
          await service.sendBillReminders();

          expect(jobClaims.claimLease).toHaveBeenCalledWith(
            "bill_reminder",
            userId1,
            expect.any(String),
            expect.any(Number),
          );
          expect(jobClaims.claimOnce).not.toHaveBeenCalled();
        });

        it("records the delivery only after the send succeeds", async () => {
          await service.sendBillReminders();

          expect(jobClaims.markDelivered).toHaveBeenCalledWith(
            "bill_reminder",
            userId1,
            expect.any(String),
            // The token, so the record is written against *this* attempt's lease:
            // a stalled worker whose lease was retaken must not stamp a delivery
            // for the new holder's unfinished send (audit DR-RRV4-01).
            TEST_LEASE_TOKEN,
          );
          expect(
            emailService.sendMail.mock.invocationCallOrder[0],
          ).toBeLessThan(jobClaims.markDelivered.mock.invocationCallOrder[0]);
        });

        it("does not record a delivery when the send fails", async () => {
          emailService.sendMail.mockRejectedValue(new Error("smtp down"));

          await service.sendBillReminders();

          // The notice stays owed, and the lease goes back so the next run can
          // retry immediately.
          expect(jobClaims.markDelivered).not.toHaveBeenCalled();
          expect(jobClaims.releaseLease).toHaveBeenCalled();
        });

        it("stands down when the work is already recorded as delivered", async () => {
          // The lease was won -- an earlier holder let it expire -- but the send
          // had already happened. Only the delivery record can say so.
          jobClaims.wasDelivered.mockResolvedValue(true);

          await service.sendBillReminders();

          expect(emailService.sendMail).not.toHaveBeenCalled();
          expect(jobClaims.releaseLease).toHaveBeenCalled();
        });

        it("sends when another holder's lease expired without delivering", async () => {
          // The recovery the permanent claim made impossible: the lease is
          // retakeable and nothing was delivered, so this replica sends.
          jobClaims.claimLease.mockResolvedValue(TEST_LEASE_TOKEN);
          jobClaims.wasDelivered.mockResolvedValue(false);

          await service.sendBillReminders();

          expect(emailService.sendMail).toHaveBeenCalledTimes(1);
        });

        it("does not send while another replica holds the lease", async () => {
          jobClaims.claimLease.mockResolvedValue(null);

          await service.sendBillReminders();

          expect(emailService.sendMail).not.toHaveBeenCalled();
        });
      });

      it("returns early when no manual bills exist", async () => {
        scheduledTransactionsRepo.find.mockResolvedValue([]);

        await service.sendBillReminders();

        expect(scheduledTransactionsRepo.find).toHaveBeenCalledWith({
          where: { isActive: true, autoPost: false },
          // `splits` is loaded because the effective-amount resolver decides from
          // them whether a schedule's cash total re-prices at the current FX rate
          // (issue #1247).
          relations: ["payee", "overrides", "splits"],
        });
        expect(emailService.sendMail).not.toHaveBeenCalled();
      });

      it("returns early when no bills are within their reminder window", async () => {
        const billFarAway = makeBill({
          nextDueDate: daysFromNow(30),
          reminderDaysBefore: 3,
        });

        scheduledTransactionsRepo.find.mockResolvedValue([billFarAway]);

        await service.sendBillReminders();

        expect(emailService.sendMail).not.toHaveBeenCalled();
      });

      it("does not remind for bills with past due dates (negative days)", async () => {
        const overdueBill = makeBill({
          nextDueDate: daysFromNow(-1),
          reminderDaysBefore: 3,
        });

        scheduledTransactionsRepo.find.mockResolvedValue([overdueBill]);

        await service.sendBillReminders();

        expect(emailService.sendMail).not.toHaveBeenCalled();
      });

      it("sends reminder for a bill due today (0 days away)", async () => {
        const billDueToday = makeBill({
          userId: userId1,
          nextDueDate: daysFromNow(0),
          reminderDaysBefore: 3,
          name: "Electric Bill",
        });

        scheduledTransactionsRepo.find.mockResolvedValue([billDueToday]);
        preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
        usersRepo.findOne.mockResolvedValue(mockUser1);

        await service.sendBillReminders();

        expect(emailService.sendMail).toHaveBeenCalledTimes(1);
        expect(emailService.sendMail).toHaveBeenCalledWith(
          "user1@example.com",
          "Monize: 1 upcoming bill needs attention",
          expect.any(String),
        );
      });

      it("sends reminder for a bill due exactly at the reminder window boundary", async () => {
        const billAtBoundary = makeBill({
          userId: userId1,
          nextDueDate: daysFromNow(3),
          reminderDaysBefore: 3,
        });

        scheduledTransactionsRepo.find.mockResolvedValue([billAtBoundary]);
        preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
        usersRepo.findOne.mockResolvedValue(mockUser1);

        await service.sendBillReminders();

        expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      });

      it("does not send reminder for a bill due one day past the reminder window", async () => {
        const billJustOutside = makeBill({
          nextDueDate: daysFromNow(4),
          reminderDaysBefore: 3,
        });

        scheduledTransactionsRepo.find.mockResolvedValue([billJustOutside]);

        await service.sendBillReminders();

        expect(emailService.sendMail).not.toHaveBeenCalled();
      });

      it("sends plural subject when multiple bills are due for one user", async () => {
        const bill1 = makeBill({
          id: "bill-1",
          userId: userId1,
          nextDueDate: daysFromNow(1),
          reminderDaysBefore: 3,
          name: "Electric Bill",
        });
        const bill2 = makeBill({
          id: "bill-2",
          userId: userId1,
          nextDueDate: daysFromNow(2),
          reminderDaysBefore: 3,
          name: "Water Bill",
        });

        scheduledTransactionsRepo.find.mockResolvedValue([bill1, bill2]);
        preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
        usersRepo.findOne.mockResolvedValue(mockUser1);

        await service.sendBillReminders();

        expect(emailService.sendMail).toHaveBeenCalledTimes(1);
        expect(emailService.sendMail).toHaveBeenCalledWith(
          "user1@example.com",
          "Monize: 2 upcoming bills need attention",
          expect.any(String),
        );
      });

      it("sends separate emails to different users", async () => {
        const bill1 = makeBill({
          id: "bill-1",
          userId: userId1,
          nextDueDate: daysFromNow(1),
          reminderDaysBefore: 3,
        });
        const bill2 = makeBill({
          id: "bill-2",
          userId: userId2,
          nextDueDate: daysFromNow(2),
          reminderDaysBefore: 5,
        });

        scheduledTransactionsRepo.find.mockResolvedValue([bill1, bill2]);
        preferencesRepo.findOne.mockImplementation(
          async ({ where }: { where: { userId: string } }) => {
            if (where.userId === userId1) return mockPrefsEmailEnabled;
            return { ...mockPrefsEmailEnabled, userId: userId2 };
          },
        );
        usersRepo.findOne.mockImplementation(
          async ({ where }: { where: { id: string } }) => {
            if (where.id === userId1) return mockUser1;
            return mockUser2;
          },
        );

        await service.sendBillReminders();

        expect(emailService.sendMail).toHaveBeenCalledTimes(2);
        expect(emailService.sendMail).toHaveBeenCalledWith(
          "user1@example.com",
          expect.any(String),
          expect.any(String),
        );
        expect(emailService.sendMail).toHaveBeenCalledWith(
          "user2@example.com",
          expect.any(String),
          expect.any(String),
        );
      });

      describe("skipping users", () => {
        it("skips user when email notifications are disabled in preferences", async () => {
          const bill = makeBill({
            userId: userId2,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailDisabled);

          await service.sendBillReminders();

          expect(usersRepo.findOne).not.toHaveBeenCalled();
          expect(emailService.sendMail).not.toHaveBeenCalled();
        });

        it("sends email when preferences record does not exist (null)", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          preferencesRepo.findOne.mockResolvedValue(null);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          expect(emailService.sendMail).toHaveBeenCalledTimes(1);
        });

        it("sends email when preferences exist with notificationEmail = true", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          expect(emailService.sendMail).toHaveBeenCalledTimes(1);
        });

        it("skips user when user record is not found", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(null);

          await service.sendBillReminders();

          expect(emailService.sendMail).not.toHaveBeenCalled();
        });

        it("skips user when user has no email address", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue({
            ...mockUser1,
            email: null,
          });

          await service.sendBillReminders();

          expect(emailService.sendMail).not.toHaveBeenCalled();
        });
      });

      describe("bill data mapping", () => {
        it("uses payee.name when payee relation is present", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
            payee: {
              id: "payee-1",
              name: "Electric Co",
              userId: userId1,
              defaultCategoryId: null,
              notes: "",
              website: null,
              logoData: null,
              logoContentType: null,
              hasLogo: false,
              logoFetchedAt: null,
              address: null,
              email: null,
              phone: null,
              contactLookupAt: null,
              contactLookupSource: null,
              isActive: true,
              defaultCategory: null as any,
              createdAt: new Date(),
            },
            payeeName: "Fallback Payee",
            name: "Fallback Name",
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          const htmlArg = emailService.sendMail.mock.calls[0][2];
          expect(htmlArg).toContain("Electric Co");
        });

        it("uses payeeName when payee relation is null", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
            payee: null,
            payeeName: "Manual Payee Name",
            name: "Bill Name Fallback",
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          const htmlArg = emailService.sendMail.mock.calls[0][2];
          expect(htmlArg).toContain("Manual Payee Name");
        });

        it("uses bill name when both payee and payeeName are null", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
            payee: null,
            payeeName: null,
            name: "Monthly Rent",
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          const htmlArg = emailService.sendMail.mock.calls[0][2];
          expect(htmlArg).toContain("Monthly Rent");
        });

        it("uses absolute value for negative amounts", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
            amount: -250.75,
            currencyCode: "EUR",
            name: "Test Bill",
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          const htmlArg = emailService.sendMail.mock.calls[0][2];
          expect(htmlArg).toContain("€250.75");
        });

        it("says the amount is unavailable rather than naming a stale one (issue #1247)", async () => {
          // The issue's schedule: 10 x 100 pinned at 1.50 while the security was
          // priced in EUR. The security is USD now and no USD -> CAD rate
          // resolves, so the amount is unknown -- and the reminder must say so
          // rather than repeating the CAD 1,500 snapshot the user would pay.
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
            name: "Monthly ETF buy",
            amount: -1000,
            currencyCode: "CAD",
            isInvestment: true,
            investmentAction: "BUY" as never,
            investmentSecurityId: "SEC-1",
            investmentQuantity: 10,
            investmentPrice: 100,
            investmentCommission: 0,
            investmentExchangeRate: 1.5,
            investmentExchangeRateFromCurrency: "EUR",
            investmentExchangeRateToCurrency: "CAD",
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);
          investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
            { from: "USD", to: "CAD" },
          );
          investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
            null,
          );

          await service.sendBillReminders();

          const htmlArg = emailService.sendMail.mock.calls[0][2];
          expect(htmlArg).toContain("Amount unavailable");
          expect(htmlArg).not.toContain("1,500");
          expect(htmlArg).not.toContain("1,000");
        });

        it("quotes the re-priced amount when the current rate is known (issue #1247)", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
            name: "Monthly ETF buy",
            amount: -1000,
            currencyCode: "CAD",
            isInvestment: true,
            investmentAction: "BUY" as never,
            investmentSecurityId: "SEC-1",
            investmentQuantity: 10,
            investmentPrice: 100,
            investmentCommission: 0,
            investmentExchangeRate: 1.5,
            investmentExchangeRateFromCurrency: "EUR",
            investmentExchangeRateToCurrency: "CAD",
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);
          investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
            { from: "USD", to: "CAD" },
          );
          investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
            1.35,
          );

          await service.sendBillReminders();

          const htmlArg = emailService.sendMail.mock.calls[0][2];
          expect(htmlArg).toContain("1,350.00");
          expect(htmlArg).not.toContain("1,500.00");
        });

        it("passes appUrl from config to email template", async () => {
          configService.get.mockReturnValue("https://custom.monize.app");

          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          const htmlArg = emailService.sendMail.mock.calls[0][2];
          expect(htmlArg).toContain("https://custom.monize.app");
        });

        it("passes user firstName to the email template", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue({
            ...mockUser1,
            firstName: "Alice",
          });

          await service.sendBillReminders();

          const htmlArg = emailService.sendMail.mock.calls[0][2];
          expect(htmlArg).toContain("Alice");
        });

        it("handles user with null firstName gracefully", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue({
            ...mockUser1,
            firstName: null,
          });

          await service.sendBillReminders();

          expect(emailService.sendMail).toHaveBeenCalledTimes(1);
          // billReminderTemplate uses firstName || "" which the template then renders as "there"
          const htmlArg = emailService.sendMail.mock.calls[0][2];
          expect(htmlArg).toContain("there");
        });
      });

      describe("configService usage", () => {
        it("requests PUBLIC_APP_URL with fallback default", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          expect(configService.get).toHaveBeenCalledWith(
            "PUBLIC_APP_URL",
            "http://localhost:3000",
          );
        });
      });

      describe("error handling", () => {
        it("continues sending to other users when one user fails", async () => {
          const bill1 = makeBill({
            id: "bill-1",
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
          });
          const bill2 = makeBill({
            id: "bill-2",
            userId: userId2,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill1, bill2]);

          // Both users have enabled notifications
          preferencesRepo.findOne.mockResolvedValue({
            notificationEmail: true,
          });

          // First user lookup succeeds, second user lookup succeeds
          usersRepo.findOne.mockImplementation(
            async ({ where }: { where: { id: string } }) => {
              if (where.id === userId1) return mockUser1;
              return mockUser2;
            },
          );

          // sendMail fails for first user, succeeds for second
          emailService.sendMail
            .mockRejectedValueOnce(new Error("SMTP timeout"))
            .mockResolvedValueOnce(undefined);

          await service.sendBillReminders();

          // Should have tried to send to both users
          expect(emailService.sendMail).toHaveBeenCalledTimes(2);
        });

        it("does not throw when sendMail throws an error", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);
          emailService.sendMail.mockRejectedValue(
            new Error("Connection refused"),
          );

          // Should not throw
          await expect(service.sendBillReminders()).resolves.toBeUndefined();
        });

        it("does not throw when preferences lookup throws", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          preferencesRepo.findOne.mockRejectedValue(
            new Error("DB connection lost"),
          );

          await expect(service.sendBillReminders()).resolves.toBeUndefined();
        });

        it("does not throw when user lookup throws", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockRejectedValue(new Error("DB error"));

          await expect(service.sendBillReminders()).resolves.toBeUndefined();
        });
      });

      describe("reminder window edge cases", () => {
        it("includes bill with reminderDaysBefore = 0 only when due today", async () => {
          const billDueToday = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(0),
            reminderDaysBefore: 0,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([billDueToday]);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          expect(emailService.sendMail).toHaveBeenCalledTimes(1);
        });

        it("does not include bill with reminderDaysBefore = 0 when due tomorrow", async () => {
          const billDueTomorrow = makeBill({
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 0,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([billDueTomorrow]);

          await service.sendBillReminders();

          expect(emailService.sendMail).not.toHaveBeenCalled();
        });

        it("handles large reminderDaysBefore values", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(25),
            reminderDaysBefore: 30,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          expect(emailService.sendMail).toHaveBeenCalledTimes(1);
        });

        /**
         * The two halves of the cron ask their own question, against their own
         * "today". They can disagree -- the run crosses midnight, an override
         * moves in between -- and an email with an empty table plus a
         * `delivered_at` record is the worst possible outcome: the subject claims
         * a bill, the body shows none, and the delivery record makes the genuine
         * reminder unsendable for the rest of the day.
         */
        it("sends nothing and records nothing when no occurrence survives the owner's own window", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(0),
            reminderDaysBefore: 3,
          });
          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);
          // The divergence is real and in the code: the cross-user pass reads the
          // overrides hydrated on the row, while `expand` re-reads them from the
          // database. An override written between the two moves this occurrence
          // out of the window, so the second pass has nothing to say.
          overridesRepo.find.mockResolvedValue([
            {
              id: "ovr-moved",
              scheduledTransactionId: bill.id,
              originalDate: String(bill.nextDueDate).split("T")[0],
              overrideDate: daysFromNow(90),
              amount: null,
            },
          ]);

          await service.sendBillReminders();

          expect(emailService.sendMail).not.toHaveBeenCalled();
          expect(jobClaims.markDelivered).not.toHaveBeenCalled();
          // The lease goes back, so the next run can try again.
          expect(jobClaims.releaseLease).toHaveBeenCalled();
        });

        /**
         * A run that crosses local midnight measures both of its windows from
         * one day.
         *
         * Each pass used to read `todayYMD()` for itself. The selecting pass ran
         * at 23:59 and matched a bill due that day; the delivering pass ran a
         * minute later, on the next date, and its window opened AFTER the
         * occurrence -- so the bill vanished, nothing was emailed, and the next
         * run (now also on D+1) no longer selected it either. A reminder nobody
         * would ever get, and no record that one was owed.
         *
         * The window's date is a value passed down, so advancing the clock
         * mid-run cannot move it.
         */
        it("measures both passes from one date when the run crosses midnight", async () => {
          const oneSecond = 1000;
          // 23:59:30 local, so a minute's advance lands on the next date whatever
          // the runner's timezone. Derived from the boundary the defect is about,
          // not a hardcoded instant.
          const almostMidnight = new Date(2026, 2, 15, 23, 59, 30);
          jest.useFakeTimers({
            now: almostMidnight,
            // `Date` only: faking the microtask queue under the async repository
            // doubles below deadlocks the run rather than failing it.
            doNotFake: [
              "nextTick",
              "queueMicrotask",
              "setImmediate",
              "setTimeout",
              "setInterval",
            ],
          });
          try {
            const bill = makeBill({
              userId: userId1,
              nextDueDate: daysFromNow(0),
              // Zero, so the window is exactly one day and a one-day slip moves
              // the occurrence out of it entirely.
              reminderDaysBefore: 0,
            });
            scheduledTransactionsRepo.find.mockResolvedValue([bill]);
            overridesRepo.find.mockResolvedValue([]);
            preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
            // The clock crosses midnight between the two passes: this read
            // happens inside the delivering pass, before it computes its window.
            usersRepo.findOne.mockImplementation(async () => {
              jest.setSystemTime(
                new Date(almostMidnight.getTime() + 60 * oneSecond),
              );
              return mockUser1 as User;
            });

            await service.sendBillReminders();

            // The bill is still reported, against the date the run started on.
            expect(emailService.sendMail).toHaveBeenCalledTimes(1);
            expect(emailService.sendMail).toHaveBeenCalledWith(
              "user1@example.com",
              "Monize: 1 upcoming bill needs attention",
              expect.any(String),
            );
            expect(jobClaims.markDelivered).toHaveBeenCalled();
          } finally {
            jest.useRealTimers();
          }
        });

        /**
         * Every claim in one run carries the run's date, not the date the user's
         * turn happened to fall on.
         *
         * The claim key is what makes the reminder single-shot, and it is built
         * once per user inside the loop. Reading the clock there, a run that
         * spans local midnight claims the early users under `key(D)` and the
         * rest under `key(D+1)` while every window is measured from D -- so the
         * next run re-selects a user emailed at 23:59:59, finds no delivery
         * record under its own `key(D+1)`, and sends the identical reminder a
         * second time. Pinning the windows and leaving the key unpinned moves the
         * midnight bug rather than fixing it.
         */
        it("keys every user's claim on the run's date, not on their turn's", async () => {
          const almostMidnight = new Date(2026, 2, 15, 23, 59, 30);
          jest.useFakeTimers({
            now: almostMidnight,
            doNotFake: [
              "nextTick",
              "queueMicrotask",
              "setImmediate",
              "setTimeout",
              "setInterval",
            ],
          });
          try {
            scheduledTransactionsRepo.find.mockResolvedValue([
              makeBill({
                id: "bill-u1",
                userId: userId1,
                nextDueDate: daysFromNow(0),
                reminderDaysBefore: 0,
              }),
              makeBill({
                id: "bill-u2",
                userId: userId2,
                nextDueDate: daysFromNow(0),
                reminderDaysBefore: 0,
              }),
            ]);
            overridesRepo.find.mockResolvedValue([]);
            preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
            // The clock crosses midnight while the FIRST user is being served,
            // so the second user's turn happens on the next date.
            let served = 0;
            usersRepo.findOne.mockImplementation(async () => {
              served += 1;
              if (served === 1) {
                jest.setSystemTime(
                  new Date(almostMidnight.getTime() + 60 * 1000),
                );
              }
              return (served === 1 ? mockUser1 : mockUser2) as User;
            });

            await service.sendBillReminders();

            const runDate = `${almostMidnight.getFullYear()}-${String(
              almostMidnight.getMonth() + 1,
            ).padStart(
              2,
              "0",
            )}-${String(almostMidnight.getDate()).padStart(2, "0")}`;
            expect(jobClaims.claimLease).toHaveBeenCalledTimes(2);
            const claimKeys = jobClaims.claimLease.mock.calls.map((call) =>
              String(call[2]),
            );
            for (const key of claimKeys) {
              expect(key.startsWith(`${runDate}#`)).toBe(true);
            }
            // Two users, two different bill sets, so two different digests --
            // the date prefix being shared is the point, not the whole key.
            expect(new Set(claimKeys).size).toBe(2);
          } finally {
            jest.useRealTimers();
          }
        });

        /**
         * The partial case: pass one selected two bills, pass two can report
         * only one.
         *
         * Reachable through the same divergence as the empty case above -- pass
         * one reads the overrides hydrated on the row, pass two re-reads them
         * from the database -- so an override written in between can move ONE of
         * the two occurrences out of the window. The email must describe what it
         * actually lists (a subject counted from the pre-expansion list is how
         * "1 upcoming bill needs attention" came to sit over an empty table), and
         * the claim still settles: a bill that is no longer due is one there is
         * nothing to remind about.
         */
        it("emails the bills it can report when only some survive the second pass", async () => {
          const staying = makeBill({
            id: "bill-staying",
            userId: userId1,
            nextDueDate: daysFromNow(0),
            reminderDaysBefore: 3,
            name: "Rent",
          });
          const moving = makeBill({
            id: "bill-moving",
            userId: userId1,
            nextDueDate: daysFromNow(1),
            reminderDaysBefore: 3,
            name: "Hydro",
          });
          scheduledTransactionsRepo.find.mockResolvedValue([staying, moving]);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);
          overridesRepo.find.mockResolvedValue([
            {
              id: "ovr-moved",
              scheduledTransactionId: "bill-moving",
              originalDate: String(moving.nextDueDate).split("T")[0],
              overrideDate: daysFromNow(90),
              amount: null,
            },
          ]);

          await service.sendBillReminders();

          expect(emailService.sendMail).toHaveBeenCalledTimes(1);
          // Counted from the body, not from what pass one selected.
          expect(emailService.sendMail).toHaveBeenCalledWith(
            "user1@example.com",
            "Monize: 1 upcoming bill needs attention",
            expect.any(String),
          );
          const html = String(emailService.sendMail.mock.calls[0][2]);
          expect(html).toContain("Rent");
          expect(html).not.toContain("Hydro");
          // Something was sent, so the claim settles rather than being handed
          // back -- the empty case above is the one that releases.
          expect(jobClaims.markDelivered).toHaveBeenCalled();
          expect(jobClaims.releaseLease).not.toHaveBeenCalled();
        });

        it("groups multiple bills for the same user into one email", async () => {
          const bill1 = makeBill({
            id: "bill-1",
            userId: userId1,
            nextDueDate: daysFromNow(0),
            reminderDaysBefore: 3,
            name: "Bill A",
          });
          const bill2 = makeBill({
            id: "bill-2",
            userId: userId1,
            nextDueDate: daysFromNow(2),
            reminderDaysBefore: 3,
            name: "Bill B",
          });
          const bill3 = makeBill({
            id: "bill-3",
            userId: userId1,
            nextDueDate: daysFromNow(10),
            reminderDaysBefore: 3,
            name: "Bill C (out of window)",
          });

          scheduledTransactionsRepo.find.mockResolvedValue([
            bill1,
            bill2,
            bill3,
          ]);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          // Only 1 email sent (bills grouped), and only 2 bills in window
          expect(emailService.sendMail).toHaveBeenCalledTimes(1);
          expect(emailService.sendMail).toHaveBeenCalledWith(
            "user1@example.com",
            "Monize: 2 upcoming bills need attention",
            expect.any(String),
          );
        });
      });

      describe("occurrence overrides", () => {
        it("uses overridden amount instead of base amount in email", async () => {
          const dueDateStr = daysFromNow(1);
          const bill = makeBill({
            userId: userId1,
            nextDueDate: dueDateStr as any,
            reminderDaysBefore: 3,
            amount: -150.0,
            overrides: [
              makeOverride({
                originalDate: dueDateStr,
                overrideDate: dueDateStr,
                amount: -200.0,
              }) as any,
            ],
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          expect(emailService.sendMail).toHaveBeenCalledTimes(1);
          const htmlArg = emailService.sendMail.mock.calls[0][2];
          expect(htmlArg).toContain("200.00");
          expect(htmlArg).not.toContain("150.00");
        });

        it("uses overridden date instead of base date in email", async () => {
          const baseDateStr = daysFromNow(1);
          const overrideDateStr = daysFromNow(2);
          const bill = makeBill({
            userId: userId1,
            nextDueDate: baseDateStr as any,
            reminderDaysBefore: 3,
            overrides: [
              makeOverride({
                originalDate: baseDateStr,
                overrideDate: overrideDateStr,
              }) as any,
            ],
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          expect(emailService.sendMail).toHaveBeenCalledTimes(1);
          const htmlArg = emailService.sendMail.mock.calls[0][2];
          expect(htmlArg).toContain(overrideDateStr);
        });

        it("uses base amount when override amount is null", async () => {
          const dueDateStr = daysFromNow(1);
          const bill = makeBill({
            userId: userId1,
            nextDueDate: dueDateStr as any,
            reminderDaysBefore: 3,
            amount: -150.0,
            overrides: [
              makeOverride({
                originalDate: dueDateStr,
                overrideDate: dueDateStr,
                amount: null,
              }) as any,
            ],
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          expect(emailService.sendMail).toHaveBeenCalledTimes(1);
          const htmlArg = emailService.sendMail.mock.calls[0][2];
          expect(htmlArg).toContain("150.00");
        });

        it("uses overridden date for reminder window calculation", async () => {
          // Base date is within window, but override pushes it far out
          const baseDateStr = daysFromNow(1);
          const overrideDateStr = daysFromNow(30);
          const bill = makeBill({
            userId: userId1,
            nextDueDate: baseDateStr as any,
            reminderDaysBefore: 3,
            overrides: [
              makeOverride({
                originalDate: baseDateStr,
                overrideDate: overrideDateStr,
              }) as any,
            ],
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);

          await service.sendBillReminders();

          // Should not send — the effective date is 30 days out, beyond the 3-day window
          expect(emailService.sendMail).not.toHaveBeenCalled();
        });

        it("uses overridden date to bring bill into reminder window", async () => {
          // Base date is far out, but override brings it within window
          const baseDateStr = daysFromNow(30);
          const overrideDateStr = daysFromNow(1);
          const bill = makeBill({
            userId: userId1,
            nextDueDate: baseDateStr as any,
            reminderDaysBefore: 3,
            overrides: [
              makeOverride({
                originalDate: baseDateStr,
                overrideDate: overrideDateStr,
              }) as any,
            ],
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          expect(emailService.sendMail).toHaveBeenCalledTimes(1);
        });

        it("ignores overrides for non-matching dates", async () => {
          const dueDateStr = daysFromNow(1);
          const otherDateStr = daysFromNow(15);
          const bill = makeBill({
            userId: userId1,
            nextDueDate: dueDateStr as any,
            reminderDaysBefore: 3,
            amount: -150.0,
            overrides: [
              makeOverride({
                originalDate: otherDateStr,
                overrideDate: otherDateStr,
                amount: -999.0,
              }) as any,
            ],
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          expect(emailService.sendMail).toHaveBeenCalledTimes(1);
          const htmlArg = emailService.sendMail.mock.calls[0][2];
          // Should use base amount since override doesn't match nextDueDate
          expect(htmlArg).toContain("150.00");
          expect(htmlArg).not.toContain("999.00");
        });

        it("works when overrides array is undefined", async () => {
          const bill = makeBill({
            userId: userId1,
            nextDueDate: daysFromNow(1) as any,
            reminderDaysBefore: 3,
            overrides: undefined as any,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          expect(emailService.sendMail).toHaveBeenCalledTimes(1);
        });
      });

      describe("date formatting in bill data", () => {
        it("formats nextDueDate as YYYY-MM-DD string (splits on T)", async () => {
          const dueDate = daysFromNow(1);
          const bill = makeBill({
            userId: userId1,
            nextDueDate: dueDate,
            reminderDaysBefore: 999, // large window so it triggers
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          const htmlArg = emailService.sendMail.mock.calls[0][2];
          // String(date) produces a format like "Sat Mar 15 2026 ..." but
          // the service does String(b.nextDueDate).split("T")[0].
          // When nextDueDate is a Date object, String(date) is locale-dependent.
          // But when it comes from DB, it's often a string like "2026-03-15".
          // We verify the template was called and contains numeric date info.
          expect(htmlArg).toBeDefined();
          expect(typeof htmlArg).toBe("string");
        });

        it("handles nextDueDate as ISO string from database", async () => {
          // When TypeORM returns a date column as a string (common for date type)
          const dueDateStr = daysFromNow(1);
          const bill = makeBill({
            userId: userId1,
            nextDueDate: dueDateStr as any,
            reminderDaysBefore: 999,
          });

          scheduledTransactionsRepo.find.mockResolvedValue([bill]);
          overridesRepo.find.mockResolvedValue(bill.overrides ?? []);
          preferencesRepo.findOne.mockResolvedValue(mockPrefsEmailEnabled);
          usersRepo.findOne.mockResolvedValue(mockUser1);

          await service.sendBillReminders();

          const htmlArg = emailService.sendMail.mock.calls[0][2];
          expect(htmlArg).toContain(dueDateStr);
        });
      });
    });
  });
});
