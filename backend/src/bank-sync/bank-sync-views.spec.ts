import {
  toBankInstitutionProfileView,
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

    it("is true while possible duplicates wait for a decision, and carries their count", () => {
      const view = toBankSyncAccountView(
        bankAccountRow({
          lastSuccessAt: new Date("2026-09-20T00:00:00.000Z"),
          heldDuplicateCount: 2,
        }),
      );
      expect(view.needsPreview).toBe(true);
      expect(view.heldDuplicateCount).toBe(2);
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
    const view = toBankSyncConnectionView(
      connectionRow(),
      [bankAccountRow({ cashAccountType: "SVGS" })],
      "en",
    );
    expect(view.accounts[0]).toMatchObject({
      cashAccountType: "SVGS",
      needsPreview: true,
    });
  });

  it("carries the profile its rows are read by, notes in the reader's language", () => {
    const row = connectionRow({ institutionName: "PKO Bank Polski" });
    const polish = toBankSyncConnectionView(row, [], "pl").profile;
    expect(polish).toMatchObject({ id: "pl/pko-bp", version: 1 });
    expect(polish.notes.map((n) => [n.id, n.severity, n.lang])).toEqual([
      ["gluedFields", "warning", "pl"],
      ["operationCodeLine", "info", "pl"],
      ["counterpartyOnTransfers", "info", "pl"],
    ]);
    expect(polish.notes[0].text).toMatch(/^Przy płatnościach kartą i BLIK/);

    const german = toBankSyncConnectionView(row, [], "de").profile;
    expect(german.notes.map((n) => n.lang)).toEqual(["en", "en", "en"]);
    expect(german.notes[0].text).toMatch(/^For card and BLIK payments/);
  });

  it("carries the default profile, with no notes, for a bank that has none", () => {
    expect(toBankSyncConnectionView(connectionRow(), [], "pl").profile).toEqual(
      { id: "default", version: 1, notes: [] },
    );
  });
});

describe("toBankInstitutionProfileView", () => {
  it("is null for a bank resolving to the default profile", () => {
    expect(
      toBankInstitutionProfileView(
        "enable_banking",
        { country: "PL", name: "Unlisted Bank" },
        "pl",
      ),
    ).toBeNull();
  });

  it("is the id and notes of a bank's own profile, and nothing else", () => {
    const view = toBankInstitutionProfileView(
      "enable_banking",
      { country: "PL", name: "pko bank polski" },
      "en",
    );
    expect(view?.id).toBe("pl/pko-bp");
    expect(view?.notes).toHaveLength(3);
    expect(view?.notes[1]).toMatchObject({
      id: "operationCodeLine",
      lang: "en",
    });
    expect(Object.keys(view ?? {}).sort()).toEqual(["id", "notes"]);
  });
});

it("shows SimpleFIN API notes for an unknown countryless institution", () => {
  const view = toBankSyncConnectionView(
    connectionRow({
      provider: "simplefin",
      institutionCountry: "",
      institutionName: "Unknown Bank",
    }),
    [],
    "fr-CA",
  );
  expect(view.profile.id).toBe("simplefin/default");
  expect(view.profile.notes).toHaveLength(7);
  expect(view.profile.notes.every((note) => note.lang === "fr-CA")).toBe(true);
});
