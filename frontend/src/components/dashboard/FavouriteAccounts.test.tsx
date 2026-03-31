import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@/test/render";
import { FavouriteAccounts } from "./FavouriteAccounts";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: () => ({
    preferences: { defaultCurrency: "CAD" },
  }),
}));

vi.mock("@/hooks/useNumberFormat", () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
  }),
}));

vi.mock("@/lib/accounts", () => ({
  accountsApi: {
    reorderFavourites: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("FavouriteAccounts", () => {
  it("renders loading state", () => {
    render(<FavouriteAccounts accounts={[]} isLoading={true} />);
    expect(screen.getByText("Favourite Accounts")).toBeInTheDocument();
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("renders empty state when no favourites", () => {
    render(<FavouriteAccounts accounts={[]} isLoading={false} />);
    expect(screen.getByText(/No favourite accounts yet/)).toBeInTheDocument();
  });

  it("renders favourite accounts with balances", () => {
    const accounts = [
      {
        id: "1",
        name: "Checking",
        currentBalance: 1500,
        currencyCode: "CAD",
        isFavourite: true, favouriteSortOrder: 0,
        isClosed: false,
        institution: "TD Bank",
      },
      {
        id: "2",
        name: "Savings",
        currentBalance: -200,
        currencyCode: "CAD",
        isFavourite: true, favouriteSortOrder: 0,
        isClosed: false,
      },
    ] as any[];

    render(<FavouriteAccounts accounts={accounts} isLoading={false} />);
    expect(screen.getByText("Checking")).toBeInTheDocument();
    expect(screen.getByText("Savings")).toBeInTheDocument();
    expect(screen.getByText("TD Bank")).toBeInTheDocument();
    expect(screen.getByText("$1500.00")).toBeInTheDocument();
  });

  it("excludes closed accounts from display", () => {
    const accounts = [
      {
        id: "1",
        name: "Open",
        currentBalance: 100,
        currencyCode: "CAD",
        isFavourite: true, favouriteSortOrder: 0,
        isClosed: false,
      },
      {
        id: "2",
        name: "Closed",
        currentBalance: 0,
        currencyCode: "CAD",
        isFavourite: true, favouriteSortOrder: 0,
        isClosed: true,
      },
    ] as any[];

    render(<FavouriteAccounts accounts={accounts} isLoading={false} />);
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.queryByText("Closed")).not.toBeInTheDocument();
  });

  it("shows credit card statement dates for favourite CC accounts", () => {
    const accounts = [
      {
        id: "1",
        name: "Visa Card",
        currentBalance: -500,
        currencyCode: "CAD",
        isFavourite: true, favouriteSortOrder: 0,
        isClosed: false,
        accountType: "CREDIT_CARD",
        statementDueDay: 15,
        statementSettlementDay: 25,
      },
    ] as any[];

    render(<FavouriteAccounts accounts={accounts} isLoading={false} />);
    expect(screen.getByText(/Due: 15th/)).toBeInTheDocument();
    expect(screen.getByText(/Settlement: 25th/)).toBeInTheDocument();
  });

  it("shows ordinal suffixes correctly for CC dates", () => {
    const accounts = [
      {
        id: "1",
        name: "CC",
        currentBalance: 0,
        currencyCode: "CAD",
        isFavourite: true, favouriteSortOrder: 0,
        isClosed: false,
        accountType: "CREDIT_CARD",
        statementDueDay: 1,
        statementSettlementDay: 2,
      },
    ] as any[];

    render(<FavouriteAccounts accounts={accounts} isLoading={false} />);
    expect(screen.getByText(/Due: 1st/)).toBeInTheDocument();
    expect(screen.getByText(/Settlement: 2nd/)).toBeInTheDocument();
  });

  it("does not show CC dates for non-credit-card accounts", () => {
    const accounts = [
      {
        id: "1",
        name: "Checking",
        currentBalance: 1000,
        currencyCode: "CAD",
        isFavourite: true, favouriteSortOrder: 0,
        isClosed: false,
        accountType: "CHEQUING",
      },
    ] as any[];

    render(<FavouriteAccounts accounts={accounts} isLoading={false} />);
    expect(screen.queryByText(/Due:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Settlement:/)).not.toBeInTheDocument();
  });

  it("shows help tooltip for settlement date in favourites", () => {
    const accounts = [
      {
        id: "1",
        name: "Visa",
        currentBalance: -100,
        currencyCode: "CAD",
        isFavourite: true, favouriteSortOrder: 0,
        isClosed: false,
        accountType: "CREDIT_CARD",
        statementSettlementDay: 20,
      },
    ] as any[];

    render(<FavouriteAccounts accounts={accounts} isLoading={false} />);
    expect(
      screen.getByTitle(/last day of the billing cycle/i)
    ).toBeInTheDocument();
  });

  it("shows only due date when settlement day is not set", () => {
    const accounts = [
      {
        id: "1",
        name: "Amex",
        currentBalance: -200,
        currencyCode: "CAD",
        isFavourite: true, favouriteSortOrder: 0,
        isClosed: false,
        accountType: "CREDIT_CARD",
        statementDueDay: 3,
      },
    ] as any[];

    render(<FavouriteAccounts accounts={accounts} isLoading={false} />);
    expect(screen.getByText(/Due: 3rd/)).toBeInTheDocument();
    expect(screen.queryByText(/Settlement:/)).not.toBeInTheDocument();
  });

  it("navigates to transactions page on account click", () => {
    const accounts = [
      {
        id: "acc-1",
        name: "Checking",
        currentBalance: 1500,
        currencyCode: "CAD",
        isFavourite: true, favouriteSortOrder: 0,
        isClosed: false,
      },
    ] as any[];

    render(<FavouriteAccounts accounts={accounts} isLoading={false} />);
    fireEvent.click(screen.getByText("Checking"));
    expect(mockPush).toHaveBeenCalledWith("/transactions?accountId=acc-1");
  });
});
