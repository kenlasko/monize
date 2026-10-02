import type { Payee } from "../payees/entities/payee.entity";
import { findExistingPayee, NO_PAYEE } from "./bank-sync-payee-lookup";

const payee = (over: Partial<Payee> = {}): Payee =>
  ({
    id: "payee-1",
    name: "Biedronka",
    defaultCategoryId: "cat-1",
    defaultCategory: { name: "Groceries" },
    ...over,
  }) as Payee;

describe("findExistingPayee", () => {
  const payees = {
    findByName: jest.fn(),
    findPayeeByAlias: jest.fn(),
  };
  beforeEach(() => {
    jest.resetAllMocks();
    payees.findByName.mockResolvedValue(null);
    payees.findPayeeByAlias.mockResolvedValue(null);
  });

  it("says `name` for an exact name, and does not ask the aliases", async () => {
    payees.findByName.mockResolvedValue(payee());
    await expect(findExistingPayee(payees, "u", "Biedronka")).resolves.toEqual({
      payeeId: "payee-1",
      payeeName: "Biedronka",
      defaultCategoryId: "cat-1",
      defaultCategoryName: "Groceries",
      via: "name",
    });
    expect(payees.findPayeeByAlias).not.toHaveBeenCalled();
  });

  it("says `alias` when only an alias matches", async () => {
    payees.findPayeeByAlias.mockResolvedValue(
      payee({ name: "Biedronka S.A.", defaultCategory: null as never }),
    );
    await expect(
      findExistingPayee(payees, "u", "BIEDRONKA 1"),
    ).resolves.toMatchObject({
      payeeName: "Biedronka S.A.",
      defaultCategoryName: null,
      via: "alias",
    });
  });

  it("is null when the user has no such payee", async () => {
    await expect(findExistingPayee(payees, "u", "Nobody")).resolves.toBeNull();
  });

  it("has no `via` for the no-payee marker", () => {
    expect(NO_PAYEE.via).toBeNull();
    expect(NO_PAYEE.payeeId).toBeNull();
  });
});
