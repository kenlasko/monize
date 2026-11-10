import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { TransactionStatus } from "./entities/transaction.entity";
import { lockTransactionRow } from "../common/db/locks";
import {
  lockedTransactionRow,
  stubLockedTransactions,
} from "../test-helpers/locks-testing";
import { assertReconciledRowsMutable } from "./reconciled-lock.util";
import {
  applyVoidTransitionToMirrorLeg,
  assertMirrorLegVoidTransitionMutable,
} from "./void-status-transition.util";

jest.mock("../common/db/locks", () =>
  jest.requireActual("../test-helpers/locks-testing").locksMockModule(),
);

jest.mock("./reconciled-lock.util", () => ({
  ...jest.requireActual("./reconciled-lock.util"),
  assertReconciledRowsMutable: jest.fn(),
}));

/**
 * Issue #2072: a VOID crossing writes the mirror transfer leg, so the mirror is
 * asked the strict reconciled lock, not only the leg the request named.
 */
describe("void-status-transition mirror leg and the strict lock", () => {
  const userId = "user-1";
  const assertMutable = assertReconciledRowsMutable as jest.Mock;
  let manager: { update: jest.Mock };
  let accounts: {
    updateBalance: jest.Mock;
    recalculateCurrentBalance: jest.Mock;
  };

  const stageCounterpart = (status: TransactionStatus, isSplit = false) =>
    stubLockedTransactions(
      {
        lockTransactionRow: lockTransactionRow as jest.Mock,
        lockTransactionRows: jest.fn(),
      },
      [
        lockedTransactionRow({
          id: "leg-2",
          accountId: "account-2",
          amount: 100,
          transactionDate: "2026-01-15",
          status,
          isSplit,
          linkedTransactionId: "leg-1",
        }),
      ],
    );

  beforeEach(() => {
    assertMutable.mockReset().mockResolvedValue({ undoWindowOpen: false });
    (lockTransactionRow as jest.Mock).mockReset();
    manager = { update: jest.fn().mockResolvedValue(undefined) };
    accounts = {
      updateBalance: jest.fn().mockResolvedValue(undefined),
      recalculateCurrentBalance: jest.fn().mockResolvedValue(undefined),
    };
  });

  describe("assertMirrorLegVoidTransitionMutable", () => {
    const m = () => manager as unknown as EntityManager;

    it("asks the lock of a counterpart the VOID would write", async () => {
      stageCounterpart(TransactionStatus.RECONCILED);

      await assertMirrorLegVoidTransitionMutable(
        m(),
        userId,
        { linkedTransactionId: "leg-2" },
        TransactionStatus.VOID,
      );

      expect(assertMutable).toHaveBeenCalledWith(m(), userId, [
        expect.objectContaining({
          id: "leg-2",
          status: TransactionStatus.RECONCILED,
        }),
      ]);
    });

    it("does not ask for a row with no counterpart", async () => {
      await assertMirrorLegVoidTransitionMutable(
        m(),
        userId,
        { linkedTransactionId: null },
        TransactionStatus.VOID,
      );

      expect(lockTransactionRow).not.toHaveBeenCalled();
      expect(assertMutable).not.toHaveBeenCalled();
    });

    it("does not ask for a counterpart that does not lock or is a split parent", async () => {
      (lockTransactionRow as jest.Mock).mockResolvedValueOnce(null);
      await assertMirrorLegVoidTransitionMutable(
        m(),
        userId,
        { linkedTransactionId: "leg-2" },
        TransactionStatus.VOID,
      );

      stageCounterpart(TransactionStatus.RECONCILED, true);
      await assertMirrorLegVoidTransitionMutable(
        m(),
        userId,
        { linkedTransactionId: "leg-2" },
        TransactionStatus.VOID,
      );

      expect(assertMutable).not.toHaveBeenCalled();
    });

    it("does not ask for a counterpart already on the target side", async () => {
      stageCounterpart(TransactionStatus.VOID);

      await assertMirrorLegVoidTransitionMutable(
        m(),
        userId,
        { linkedTransactionId: "leg-2" },
        TransactionStatus.VOID,
      );

      expect(assertMutable).not.toHaveBeenCalled();
    });
  });

  describe("applyVoidTransitionToMirrorLeg", () => {
    it("refuses before writing a counterpart the lock holds", async () => {
      stageCounterpart(TransactionStatus.RECONCILED);
      assertMutable.mockRejectedValue(new ConflictException("locked"));

      await expect(
        applyVoidTransitionToMirrorLeg(
          manager as unknown as EntityManager,
          accounts,
          userId,
          { linkedTransactionId: "leg-2" },
          TransactionStatus.VOID,
        ),
      ).rejects.toThrow(ConflictException);

      expect(manager.update).not.toHaveBeenCalled();
      expect(accounts.updateBalance).not.toHaveBeenCalled();
      expect(accounts.recalculateCurrentBalance).not.toHaveBeenCalled();
    });

    it("voids a counterpart the lock lets through, by its own amount", async () => {
      stageCounterpart(TransactionStatus.CLEARED);

      await expect(
        applyVoidTransitionToMirrorLeg(
          manager as unknown as EntityManager,
          accounts,
          userId,
          { linkedTransactionId: "leg-2" },
          TransactionStatus.VOID,
        ),
      ).resolves.toEqual(["account-2"]);

      expect(manager.update).toHaveBeenCalledWith(expect.anything(), "leg-2", {
        status: TransactionStatus.VOID,
      });
      expect(accounts.updateBalance).toHaveBeenCalledWith("account-2", -100);
    });
  });
});
