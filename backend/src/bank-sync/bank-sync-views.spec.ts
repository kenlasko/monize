import {
  toBankSyncAccountView,
  toBankSyncConnectionView,
} from "./bank-sync-views";
import { bankAccountRow, connectionRow } from "./bank-sync-testing";

describe("toBankSyncAccountView", () => {
  it("shows the bank's account type and the masked number, and the identifier for prefilling an account", () => {
    const view = toBankSyncAccountView(
      bankAccountRow({
        accountIdentifier: "PL61109010140000071219812874",
        cashAccountType: "CARD",
        identifierMasked: "**** 2874",
      }),
    );
    expect(view.cashAccountType).toBe("CARD");
    expect(view.identifierMasked).toBe("**** 2874");
    expect(view.accountIdentifier).toBe("PL61109010140000071219812874");
  });

  it("answers a null identifier as null for an account that predates the column", () => {
    expect(
      toBankSyncAccountView(bankAccountRow({ accountIdentifier: null }))
        .accountIdentifier,
    ).toBeNull();
  });

  it("answers a null type as null: not stated, not a guess", () => {
    expect(
      toBankSyncAccountView(bankAccountRow({ cashAccountType: null }))
        .cashAccountType,
    ).toBeNull();
  });

  describe("needsPreview (spec section 7a)", () => {
    it("is true for a linked bank account that has never synced successfully", () => {
      expect(
        toBankSyncAccountView(bankAccountRow({ lastSuccessAt: null }))
          .needsPreview,
      ).toBe(true);
    });

    it("is true after a failed first sync: only a success confirms the link", () => {
      expect(
        toBankSyncAccountView(
          bankAccountRow({
            lastSuccessAt: null,
            lastSyncStatus: "failed",
            lastSyncedAt: new Date("2026-09-20T00:00:00.000Z"),
          }),
        ).needsPreview,
      ).toBe(true);
    });

    it("is false once a sync succeeded", () => {
      expect(
        toBankSyncAccountView(
          bankAccountRow({
            lastSuccessAt: new Date("2026-09-20T00:00:00.000Z"),
          }),
        ).needsPreview,
      ).toBe(false);
    });

    it("is false for an unlinked bank account: there is nothing to preview", () => {
      expect(
        toBankSyncAccountView(
          bankAccountRow({ accountId: null, lastSuccessAt: null }),
        ).needsPreview,
      ).toBe(false);
    });
  });
});

describe("toBankSyncConnectionView", () => {
  it("carries each account's view", () => {
    const view = toBankSyncConnectionView(connectionRow(), [
      bankAccountRow({ cashAccountType: "SVGS" }),
    ]);
    expect(view.accounts[0]).toMatchObject({
      cashAccountType: "SVGS",
      needsPreview: true,
    });
  });
});
