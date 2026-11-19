import { EntityManager } from "typeorm";
import { Account } from "../../../accounts/entities/account.entity";
import { LoanRateChange } from "../../../loan-rate-changes/entities/loan-rate-change.entity";
import { FrequencyType } from "../../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { MappedLoanTerms } from "../model/mny-import-model";
import { WriteLoansInput, writeLoans } from "./write-loans";

/**
 * The writer's whole job is restraint: it fills in loan settings the account
 * does not have, and never overwrites one the user set by hand or one the
 * evidence did not settle.
 */

function repoDouble(existing: Record<string, unknown> | null = {}) {
  return {
    findOne: jest.fn().mockResolvedValue(
      existing === null
        ? null
        : {
            id: "account-9",
            interestCategoryId: null,
            interestBookingMode: "AUTO",
            sourceAccountId: null,
            paymentAmount: null,
            paymentFrequency: null,
            paymentStartDate: null,
            mortgageType: "ANNUITY",
            interestRate: null,
            originalPrincipal: null,
            amortizationMonths: null,
            ...existing,
          },
    ),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as Record<string, jest.Mock>;
}

function rateRepoDouble(existingRows = 0) {
  return {
    count: jest.fn().mockResolvedValue(existingRows),
    create: jest.fn((row: Partial<LoanRateChange>) => row),
    save: jest.fn((row: Partial<LoanRateChange>) => Promise.resolve(row)),
  } as unknown as Record<string, jest.Mock>;
}

function managerFor(
  repo: Record<string, jest.Mock>,
  rateRepo: Record<string, jest.Mock> = rateRepoDouble(),
): EntityManager & { getRepository: jest.Mock } {
  return {
    getRepository: jest.fn((entity: unknown) =>
      entity === LoanRateChange ? rateRepo : repo,
    ),
  } as unknown as EntityManager & { getRepository: jest.Mock };
}

function loan(overrides: Partial<MappedLoanTerms> = {}): MappedLoanTerms {
  return {
    accountKey: "acct-9",
    interestCategoryHandle: 61,
    interestBookingMode: "SPLIT",
    sourceAccountKey: "acct-1",
    paymentAmount: 1600,
    paymentFrequency: FrequencyType.MONTHLY,
    paymentStartDate: "2026-08-01",
    paymentsObserved: 12,
    ...overrides,
  };
}

function input(overrides: Partial<WriteLoansInput> = {}): WriteLoansInput {
  return {
    loans: [loan()],
    accountIdByKey: new Map([
      ["acct-1", "account-1"],
      ["acct-9", "account-9"],
    ]),
    categoryIdByHandle: new Map([[61, "category-61"]]),
    ...overrides,
  };
}

describe("writeLoans", () => {
  it("fills in every term the account was missing", async () => {
    const repo = repoDouble();
    const manager = managerFor(repo);

    const written = await writeLoans(manager, "user-1", input());

    // A Money loan states no rate: the timeline is never read or written.
    expect(manager.getRepository.mock.calls.map(([entity]) => entity)).toEqual([
      Account,
    ]);

    expect(written).toEqual({ updated: 1 });
    expect(repo.update).toHaveBeenCalledWith(
      { id: "account-9", userId: "user-1" },
      {
        interestCategoryId: "category-61",
        interestBookingMode: "SPLIT",
        sourceAccountId: "account-1",
        paymentAmount: 1600,
        paymentFrequency: FrequencyType.MONTHLY,
        paymentStartDate: "2026-08-01",
      },
    );
  });

  it.each(["LINEAR", "INTEREST_ONLY"])(
    "leaves a %s mortgage's payment null on a re-import, filling the rest",
    async (mortgageType) => {
      // The user switched the imported mortgage to a method with no constant
      // payment; writing one would fail accounts_payment_amount_method_check
      // and abort the whole re-import.
      const repo = repoDouble({ accountType: "MORTGAGE", mortgageType });

      await writeLoans(managerFor(repo), "user-1", input());

      const patch = repo.update.mock.calls[0][1];
      expect(patch).not.toHaveProperty("paymentAmount");
      expect(patch).toMatchObject({
        paymentFrequency: FrequencyType.MONTHLY,
        paymentStartDate: "2026-08-01",
      });
    },
  );

  it("still fills an annuity mortgage's missing payment", async () => {
    const repo = repoDouble({
      accountType: "MORTGAGE",
      mortgageType: "CANADIAN_FIXED",
    });

    await writeLoans(managerFor(repo), "user-1", input());

    expect(repo.update.mock.calls[0][1]).toMatchObject({ paymentAmount: 1600 });
  });

  it("never overwrites settings the account already carries", async () => {
    // A user who configured their loan by hand outranks an inference from
    // payment shape, which matters on a second import into a live profile.
    const repo = repoDouble({
      interestCategoryId: "category-mine",
      interestBookingMode: "SEPARATE",
      sourceAccountId: "account-mine",
      paymentAmount: 1234,
      paymentFrequency: FrequencyType.BIWEEKLY,
      paymentStartDate: "2020-01-01",
    });

    const written = await writeLoans(managerFor(repo), "user-1", input());

    expect(written).toEqual({ updated: 0 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("writes nothing for a term the evidence did not settle", async () => {
    const repo = repoDouble();

    await writeLoans(
      managerFor(repo),
      "user-1",
      input({
        loans: [
          loan({
            interestCategoryHandle: null,
            interestBookingMode: null,
            paymentFrequency: null,
            paymentStartDate: null,
          }),
        ],
      }),
    );

    expect(repo.update).toHaveBeenCalledWith(
      { id: "account-9", userId: "user-1" },
      { sourceAccountId: "account-1", paymentAmount: 1600 },
    );
  });

  it("skips a loan whose account did not import", async () => {
    const repo = repoDouble();

    const written = await writeLoans(
      managerFor(repo),
      "user-1",
      input({ loans: [loan({ accountKey: "acct-missing" })] }),
    );

    expect(written).toEqual({ updated: 0 });
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it("skips a loan whose account row is not this user's", async () => {
    const repo = repoDouble(null);

    const written = await writeLoans(managerFor(repo), "user-1", input());

    expect(written).toEqual({ updated: 0 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("does nothing at all when there are no loans", async () => {
    const repo = repoDouble();

    const written = await writeLoans(
      managerFor(repo),
      "user-1",
      input({ loans: [] }),
    );

    expect(written).toEqual({ updated: 0 });
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});

describe("writeLoans: the terms a KMyMoney loan states (spec kmymoney-import 5.11)", () => {
  const stated = (overrides: Partial<MappedLoanTerms> = {}) =>
    loan({
      interestCategoryHandle: null,
      interestBookingMode: null,
      sourceAccountKey: null,
      paymentAmount: null,
      paymentFrequency: null,
      paymentStartDate: null,
      paymentsObserved: 0,
      rates: [
        { effectiveDate: "2023-01-01", annualRate: 3 },
        { effectiveDate: "2024-01-01", annualRate: 4.5 },
      ],
      originalPrincipal: 250000,
      amortizationMonths: 300,
      ...overrides,
    });

  it("writes the origination rate, the amount and the term, and the rest of the rates as the timeline", async () => {
    const repo = repoDouble();
    const rateRepo = rateRepoDouble();

    const written = await writeLoans(
      managerFor(repo, rateRepo),
      "user-1",
      input({ loans: [stated()] }),
    );

    expect(written).toEqual({ updated: 1 });
    expect(repo.update).toHaveBeenCalledWith(
      { id: "account-9", userId: "user-1" },
      { interestRate: 3, originalPrincipal: 250000, amortizationMonths: 300 },
    );
    expect(rateRepo.count).toHaveBeenCalledWith({
      where: { accountId: "account-9" },
    });
    expect(rateRepo.save.mock.calls.map(([row]) => row)).toEqual([
      {
        userId: "user-1",
        accountId: "account-9",
        effectiveDate: "2023-01-01",
        annualRate: 3,
        newPaymentAmount: null,
        source: "initial",
        note: null,
      },
      {
        userId: "user-1",
        accountId: "account-9",
        effectiveDate: "2024-01-01",
        annualRate: 4.5,
        newPaymentAmount: null,
        source: "manual",
        note: null,
      },
    ]);
  });

  it("writes a single rate to the account only, with no timeline", async () => {
    const repo = repoDouble();
    const rateRepo = rateRepoDouble();

    await writeLoans(
      managerFor(repo, rateRepo),
      "user-1",
      input({
        loans: [
          stated({ rates: [{ effectiveDate: "2023-01-01", annualRate: 3 }] }),
        ],
      }),
    );

    expect(repo.update.mock.calls[0][1]).toMatchObject({ interestRate: 3 });
    expect(rateRepo.count).not.toHaveBeenCalled();
    expect(rateRepo.save).not.toHaveBeenCalled();
  });

  it("keeps a rate, an amount and a term the account already has, and writes no timeline beside the user's rate", async () => {
    const repo = repoDouble({
      interestRate: 5.25,
      originalPrincipal: 199000,
      amortizationMonths: 240,
    });
    const rateRepo = rateRepoDouble();

    const written = await writeLoans(
      managerFor(repo, rateRepo),
      "user-1",
      input({ loans: [stated()] }),
    );

    expect(written).toEqual({ updated: 0 });
    expect(repo.update).not.toHaveBeenCalled();
    expect(rateRepo.save).not.toHaveBeenCalled();
  });

  it("leaves a timeline the loan already has alone", async () => {
    const repo = repoDouble();
    const rateRepo = rateRepoDouble(2);

    await writeLoans(
      managerFor(repo, rateRepo),
      "user-1",
      input({ loans: [stated()] }),
    );

    expect(repo.update.mock.calls[0][1]).toMatchObject({ interestRate: 3 });
    expect(rateRepo.save).not.toHaveBeenCalled();
  });

  it("writes nothing for a term or an amount the file did not state", async () => {
    const repo = repoDouble();

    await writeLoans(
      managerFor(repo),
      "user-1",
      input({
        loans: [
          stated({ rates: [], originalPrincipal: null, amortizationMonths: 0 }),
        ],
      }),
    );

    expect(repo.update).not.toHaveBeenCalled();
  });
});
