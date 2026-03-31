import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@/test/render";
import { FavouriteAccounts } from "./FavouriteAccounts";
import { accountsApi } from "@/lib/accounts";

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

  describe("favourite account ordering", () => {
    const orderedAccounts = [
      {
        id: "acc-c",
        name: "Charlie",
        currentBalance: 300,
        currencyCode: "CAD",
        isFavourite: true,
        favouriteSortOrder: 2,
        isClosed: false,
      },
      {
        id: "acc-a",
        name: "Alpha",
        currentBalance: 100,
        currencyCode: "CAD",
        isFavourite: true,
        favouriteSortOrder: 0,
        isClosed: false,
      },
      {
        id: "acc-b",
        name: "Bravo",
        currentBalance: 200,
        currencyCode: "CAD",
        isFavourite: true,
        favouriteSortOrder: 1,
        isClosed: false,
      },
    ] as any[];

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("sorts accounts by favouriteSortOrder, not alphabetically", () => {
      render(<FavouriteAccounts accounts={orderedAccounts} isLoading={false} />);

      const buttons = screen.getAllByRole("button").filter(
        (b) => ["Alpha", "Bravo", "Charlie"].includes(b.textContent?.split("$")[0]?.trim() ?? "")
      );
      expect(buttons).toHaveLength(3);

      const names = buttons.map((b) => b.textContent?.split("$")[0]?.trim());
      expect(names).toEqual(["Alpha", "Bravo", "Charlie"]);
    });

    it("does not show Reorder button when there is only one favourite", () => {
      const singleAccount = [orderedAccounts[0]] as any[];
      render(<FavouriteAccounts accounts={singleAccount} isLoading={false} />);
      expect(screen.queryByText("Reorder")).not.toBeInTheDocument();
    });

    it("shows Reorder button when there are multiple favourites", () => {
      render(<FavouriteAccounts accounts={orderedAccounts} isLoading={false} />);
      expect(screen.getByText("Reorder")).toBeInTheDocument();
    });

    it("shows up/down arrows when Reorder is clicked", () => {
      render(<FavouriteAccounts accounts={orderedAccounts} isLoading={false} />);

      fireEvent.click(screen.getByText("Reorder"));

      expect(screen.getByText("Done")).toBeInTheDocument();
      const moveUpButtons = screen.getAllByTitle("Move up");
      const moveDownButtons = screen.getAllByTitle("Move down");
      expect(moveUpButtons).toHaveLength(3);
      expect(moveDownButtons).toHaveLength(3);
    });

    it("disables up arrow on first item and down arrow on last item", () => {
      render(<FavouriteAccounts accounts={orderedAccounts} isLoading={false} />);

      fireEvent.click(screen.getByText("Reorder"));

      const moveUpButtons = screen.getAllByTitle("Move up");
      const moveDownButtons = screen.getAllByTitle("Move down");

      expect(moveUpButtons[0]).toBeDisabled();
      expect(moveDownButtons[moveDownButtons.length - 1]).toBeDisabled();
      expect(moveUpButtons[1]).not.toBeDisabled();
      expect(moveDownButtons[0]).not.toBeDisabled();
    });

    it("calls reorderFavourites API when moving an account down", async () => {
      render(<FavouriteAccounts accounts={orderedAccounts} isLoading={false} />);

      fireEvent.click(screen.getByText("Reorder"));

      const moveDownButtons = screen.getAllByTitle("Move down");
      await act(async () => {
        fireEvent.click(moveDownButtons[0]);
      });

      expect(accountsApi.reorderFavourites).toHaveBeenCalledWith([
        "acc-b",
        "acc-a",
        "acc-c",
      ]);
    });

    it("calls reorderFavourites API when moving an account up", async () => {
      render(<FavouriteAccounts accounts={orderedAccounts} isLoading={false} />);

      fireEvent.click(screen.getByText("Reorder"));

      const moveUpButtons = screen.getAllByTitle("Move up");
      await act(async () => {
        fireEvent.click(moveUpButtons[2]);
      });

      expect(accountsApi.reorderFavourites).toHaveBeenCalledWith([
        "acc-a",
        "acc-c",
        "acc-b",
      ]);
    });

    it("does not navigate when clicking an account in reorder mode", () => {
      render(<FavouriteAccounts accounts={orderedAccounts} isLoading={false} />);

      fireEvent.click(screen.getByText("Reorder"));
      fireEvent.click(screen.getByText("Alpha"));

      expect(mockPush).not.toHaveBeenCalled();
    });

    it("hides arrows and shows Reorder button when Done is clicked", () => {
      render(<FavouriteAccounts accounts={orderedAccounts} isLoading={false} />);

      fireEvent.click(screen.getByText("Reorder"));
      expect(screen.getByText("Done")).toBeInTheDocument();

      fireEvent.click(screen.getByText("Done"));
      expect(screen.getByText("Reorder")).toBeInTheDocument();
      expect(screen.queryByTitle("Move up")).not.toBeInTheDocument();
    });
  });
});
