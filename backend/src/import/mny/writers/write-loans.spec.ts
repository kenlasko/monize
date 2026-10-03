import { EntityManager } from "typeorm";
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
            ...existing,
          },
    ),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as Record<string, jest.Mock>;
}

function managerFor(repo: Record<string, jest.Mock>): EntityManager {
  return { getRepository: jest.fn(() => repo) } as unknown as EntityManager;
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

    const written = await writeLoans(managerFor(repo), "user-1", input());

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
