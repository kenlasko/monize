import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, createEvent, act } from "@/test/render";
import { FavouriteAccounts } from "./FavouriteAccounts";
import { accountsApi } from "@/lib/accounts";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockPreferences = vi.hoisted(() => ({
  viewDefaults: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@/store/preferencesStore", () => ({
  // The selector has to be applied. Returning the whole state object regardless
  // meant `usePreferencesStore((s) => s.preferences)` got `{ preferences: ... }`,
  // so `preferences?.defaultCurrency` was undefined and every case below ran on
  // the fallback while the fixture claimed to set CAD -- a mock that cannot do
  // what the real hook does, hiding the branch the fixture was written to pin.
  usePreferencesStore: (selector?: (state: unknown) => unknown) => {
    const state = {
      preferences: { defaultCurrency: "CAD", viewDefaults: mockPreferences.viewDefaults },
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    }),
};
});
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

  it("links the title to the Accounts page in every state", () => {
    const favourite = [
      {
        id: "1",
        name: "Checking",
        currentBalance: 1500,
        currencyCode: "CAD",
        isFavourite: true, favouriteSortOrder: 0,
        isClosed: false,
      },
    ] as any[];
    for (const [accounts, isLoading] of [
      [[], true],
      [[], false],
      [favourite, false],
    ] as const) {
      const { unmount } = render(
        <FavouriteAccounts accounts={accounts as any[]} isLoading={isLoading} />,
      );
      expect(screen.getByRole("link", { name: "Favourite Accounts" })).toHaveAttribute(
        "href",
        "/accounts",
      );
      unmount();
    }
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
      screen.getByLabelText(/last day of the billing cycle/i)
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

  it("says what an investment account card total is made of", () => {
    const accounts = [
      {
        id: "brok-1",
        name: "Brokerage",
        currentBalance: 0,
        currencyCode: "CAD",
        isFavourite: true,
        favouriteSortOrder: 0,
        isClosed: false,
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_BROKERAGE",
      },
    ] as any[];

    const brokerageMarketValues = new Map([["brok-1", 25000]]);

    render(
      <FavouriteAccounts
        accounts={accounts}
        brokerageMarketValues={brokerageMarketValues}
        isLoading={false}
      />
    );
    expect(screen.getByText("$25000.00")).toBeInTheDocument();
    expect(
      screen.getByText("Investments $25000.00 · Cash $0.00"),
    ).toBeInTheDocument();
  });

  it("displays current balance for non-brokerage accounts even when market values provided", () => {
    const accounts = [
      {
        id: "chk-1",
        name: "Checking",
        currentBalance: 1500,
        currencyCode: "CAD",
        isFavourite: true,
        favouriteSortOrder: 0,
        isClosed: false,
        accountType: "CHEQUING",
        accountSubType: null,
      },
    ] as any[];

    const brokerageMarketValues = new Map<string, number>();

    render(
      <FavouriteAccounts
        accounts={accounts}
        brokerageMarketValues={brokerageMarketValues}
        isLoading={false}
      />
    );
    expect(screen.getByText("$1500.00")).toBeInTheDocument();
    expect(screen.queryByText("Market value")).not.toBeInTheDocument();
  });

  it("navigates to transactions page on regular account click", () => {
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

  it("navigates to investments page on brokerage account click", () => {
    const accounts = [
      {
        id: "brok-1",
        name: "My Brokerage",
        currentBalance: 0,
        currencyCode: "CAD",
        isFavourite: true, favouriteSortOrder: 0,
        isClosed: false,
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_BROKERAGE",
      },
    ] as any[];

    render(<FavouriteAccounts accounts={accounts} isLoading={false} />);
    fireEvent.click(screen.getByText("My Brokerage"));
    expect(mockPush).toHaveBeenCalledWith("/investments?accountId=brok-1");
  });

  describe("when the reader chose to open accounts on their dashboard", () => {
    beforeEach(() => {
      mockPush.mockClear();
      mockPreferences.viewDefaults = { accountOpenTarget: "dashboard" };
    });
    afterEach(() => {
      mockPreferences.viewDefaults = undefined;
    });

    it("opens a regular account on its dashboard", () => {
      const accounts = [
        {
          id: "acc-1",
          name: "Checking",
          currentBalance: 1500,
          currencyCode: "CAD",
          isFavourite: true, favouriteSortOrder: 0,
          isClosed: false,
          accountType: "CHEQUING",
        },
      ] as any[];

      render(<FavouriteAccounts accounts={accounts} isLoading={false} />);
      fireEvent.click(screen.getByText("Checking"));
      expect(mockPush).toHaveBeenCalledWith("/accounts/acc-1");
    });

    it("opens a brokerage account on its dashboard rather than the portfolio", () => {
      const accounts = [
        {
          id: "brok-1",
          name: "My Brokerage",
          currentBalance: 0,
          currencyCode: "CAD",
          isFavourite: true, favouriteSortOrder: 0,
          isClosed: false,
          accountType: "INVESTMENT",
          accountSubType: "INVESTMENT_BROKERAGE",
        },
      ] as any[];

      render(<FavouriteAccounts accounts={accounts} isLoading={false} />);
      fireEvent.click(screen.getByText("My Brokerage"));
      expect(mockPush).toHaveBeenCalledWith("/accounts/brok-1");
    });
  });

  it("navigates from the statement line, which the card's hover promises", () => {
    // The line sits outside the navigation button (a button cannot contain the
    // help triggers), inside a card whose hover advertises the whole thing as
    // clickable. Before the click moved to the card, the bottom of every
    // credit-card tile looked live and did nothing.
    const accounts = [
      {
        id: "cc-1",
        name: "Visa Card",
        currentBalance: -500,
        currencyCode: "CAD",
        isFavourite: true,
        favouriteSortOrder: 0,
        isClosed: false,
        accountType: "CREDIT_CARD",
        statementDueDay: 15,
      },
    ] as any[];

    render(<FavouriteAccounts accounts={accounts} isLoading={false} />);
    fireEvent.click(screen.getByText(/Due: 15th/));
    expect(mockPush).toHaveBeenCalledWith("/transactions?accountId=cc-1");
  });

  it("navigates once, not twice, when the button itself is clicked", () => {
    mockPush.mockClear();
    const accounts = [
      {
        id: "acc-1",
        name: "Checking",
        currentBalance: 1500,
        currencyCode: "CAD",
        isFavourite: true,
        favouriteSortOrder: 0,
        isClosed: false,
      },
    ] as any[];

    render(<FavouriteAccounts accounts={accounts} isLoading={false} />);
    fireEvent.click(screen.getByText("Checking"));
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it("does not navigate when the statement help is opened", () => {
    mockPush.mockClear();
    // A help icon explains the row; it does not activate it.
    const accounts = [
      {
        id: "cc-1",
        name: "Visa Card",
        currentBalance: -500,
        currencyCode: "CAD",
        isFavourite: true,
        favouriteSortOrder: 0,
        isClosed: false,
        accountType: "CREDIT_CARD",
        statementDueDay: 15,
      },
    ] as any[];

    render(<FavouriteAccounts accounts={accounts} isLoading={false} />);
    fireEvent.click(
      screen.getByRole("button", { name: /payment is due/i }),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("highlights the row edge on hover, matching the Top Movers widget", () => {
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
    // The border and its hover live on the card, which wraps the navigation
    // button rather than being it -- a credit card's statement-day help
    // carries its own button, and one cannot be nested in the other.
    const card = screen.getByText("Checking").closest("button")!.parentElement!;
    expect(card.className).toContain("hover:border-blue-400");
    expect(card.className).toContain("dark:hover:border-blue-500");
  });

  it("keeps the statement-day help out of the navigation button", () => {
    // A `<button>` inside a `<button>` is closed early by the parser: the card
    // lost most of its click target, and the server's markup stopped matching
    // what React built on the client.
    const accounts = [
      {
        id: "acc-cc",
        name: "Visa",
        accountType: "CREDIT_CARD",
        statementDueDay: 15,
        statementSettlementDay: 3,
        currentBalance: -250,
        currencyCode: "CAD",
        isFavourite: true,
        favouriteSortOrder: 0,
        isClosed: false,
      },
    ] as any[];

    render(<FavouriteAccounts accounts={accounts} isLoading={false} />);

    const navigation = screen.getByText("Visa").closest("button")!;
    expect(navigation.querySelector("button")).toBeNull();
    // The help is still on the card, beside the button rather than within it.
    const card = navigation.parentElement!;
    expect(card.textContent).toContain("15th");
    expect(card.querySelectorAll("button").length).toBeGreaterThan(1);
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

    // jsdom rows have a zero-height bounding rect, so a negative clientY lands
    // in the top half (insert above) and a positive one in the bottom half.
    const dragOverAt = (el: Element, clientY: number) => {
      const evt = createEvent.dragOver(el);
      Object.defineProperty(evt, "clientY", { value: clientY });
      fireEvent(el, evt);
    };

    it("calls reorderFavourites API when dragging an account above another", async () => {
      render(<FavouriteAccounts accounts={orderedAccounts} isLoading={false} />);

      fireEvent.click(screen.getByText("Reorder"));

      // Sorted display order is Alpha (acc-a), Bravo (acc-b), Charlie (acc-c);
      // drag Charlie above Alpha to move it to the top.
      fireEvent.dragStart(screen.getByTestId("favourite-account-row-acc-c"));
      dragOverAt(screen.getByTestId("favourite-account-row-acc-a"), -5);
      await act(async () => {
        fireEvent.drop(screen.getByTestId("favourite-account-row-acc-a"));
      });

      expect(accountsApi.reorderFavourites).toHaveBeenCalledWith([
        "acc-c",
        "acc-a",
        "acc-b",
      ]);
    });

    it("dropping in the bottom half of a row inserts below it", async () => {
      render(<FavouriteAccounts accounts={orderedAccounts} isLoading={false} />);

      fireEvent.click(screen.getByText("Reorder"));

      // Drag Alpha below Bravo.
      fireEvent.dragStart(screen.getByTestId("favourite-account-row-acc-a"));
      dragOverAt(screen.getByTestId("favourite-account-row-acc-b"), 5);
      await act(async () => {
        fireEvent.drop(screen.getByTestId("favourite-account-row-acc-b"));
      });

      expect(accountsApi.reorderFavourites).toHaveBeenCalledWith([
        "acc-b",
        "acc-a",
        "acc-c",
      ]);
    });

    it("dropping an account onto itself does not call the API", async () => {
      render(<FavouriteAccounts accounts={orderedAccounts} isLoading={false} />);

      fireEvent.click(screen.getByText("Reorder"));

      fireEvent.dragStart(screen.getByTestId("favourite-account-row-acc-a"));
      await act(async () => {
        fireEvent.drop(screen.getByTestId("favourite-account-row-acc-a"));
      });

      expect(accountsApi.reorderFavourites).not.toHaveBeenCalled();
    });

    it("rows are only draggable in reorder mode", () => {
      render(<FavouriteAccounts accounts={orderedAccounts} isLoading={false} />);

      expect(screen.getByTestId("favourite-account-row-acc-a")).toHaveAttribute(
        "draggable",
        "false",
      );

      fireEvent.click(screen.getByText("Reorder"));

      expect(screen.getByTestId("favourite-account-row-acc-a")).toHaveAttribute(
        "draggable",
        "true",
      );
      expect(screen.getByText(/Drag accounts to reorder/)).toBeInTheDocument();
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
  // Favouriting both halves is favouriting one account, so it gets one card --
  // otherwise the same account appears twice under two names.
  it("shows one card when both halves of a pair are favourited", () => {
    const accounts = [
      {
        id: "brok-1",
        name: "TFSA - Brokerage",
        currentBalance: 0,
        currencyCode: "CAD",
        isFavourite: true,
        favouriteSortOrder: 0,
        isClosed: false,
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_BROKERAGE",
        linkedAccountId: "cash-1",
      },
      {
        id: "cash-1",
        name: "TFSA - Cash",
        currentBalance: 3500,
        currencyCode: "CAD",
        isFavourite: true,
        favouriteSortOrder: 1,
        isClosed: false,
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_CASH",
        linkedAccountId: "brok-1",
      },
    ] as any[];

    render(
      <FavouriteAccounts
        accounts={accounts}
        brokerageMarketValues={new Map([["brok-1", 12000]])}
        unpricedHoldingCounts={new Map([["brok-1", 0]])}
        isLoading={false}
      />
    );

    expect(screen.getAllByText("TFSA")).toHaveLength(1);
    expect(screen.queryByText("TFSA - Cash")).not.toBeInTheDocument();
    expect(screen.getByText("$15500.00")).toBeInTheDocument();
  });

  it("shows no total on a card whose holdings cannot all be priced", () => {
    const accounts = [
      {
        id: "brok-1",
        name: "TFSA - Brokerage",
        currentBalance: 0,
        currencyCode: "CAD",
        isFavourite: true,
        favouriteSortOrder: 0,
        isClosed: false,
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_BROKERAGE",
        linkedAccountId: "cash-1",
      },
      {
        id: "cash-1",
        name: "TFSA - Cash",
        currentBalance: 3500,
        currencyCode: "CAD",
        isFavourite: false,
        favouriteSortOrder: 1,
        isClosed: false,
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_CASH",
        linkedAccountId: "brok-1",
      },
    ] as any[];

    render(
      <FavouriteAccounts
        accounts={accounts}
        brokerageMarketValues={new Map([["brok-1", 9000]])}
        unpricedHoldingCounts={new Map([["brok-1", 2]])}
        isLoading={false}
      />
    );

    expect(screen.getByText("Total unavailable")).toBeInTheDocument();
    expect(screen.queryByText("$3500.00")).not.toBeInTheDocument();
    expect(screen.queryByText("$9000.00")).not.toBeInTheDocument();
  });

  it("shows no total for an account whose valuation is incomplete though every holding is priced", () => {
    const accounts = [
      {
        id: "brok-1",
        name: "TFSA - Brokerage",
        currentBalance: 0,
        currencyCode: "CAD",
        isFavourite: true,
        favouriteSortOrder: 1,
        isClosed: false,
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_BROKERAGE",
        linkedAccountId: "cash-1",
      },
      {
        id: "cash-1",
        name: "TFSA - Cash",
        currentBalance: 3500,
        currencyCode: "CAD",
        isFavourite: false,
        favouriteSortOrder: 1,
        isClosed: false,
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_CASH",
        linkedAccountId: "brok-1",
      },
    ] as any[];

    render(
      <FavouriteAccounts
        accounts={accounts}
        brokerageMarketValues={new Map([["brok-1", 9000]])}
        unpricedHoldingCounts={new Map([["brok-1", 0]])}
        incompleteHoldingAccountIds={new Set(["brok-1"])}
        isLoading={false}
      />
    );

    expect(screen.getByText("Total unavailable")).toBeInTheDocument();
    expect(screen.queryByText("$3500.00")).not.toBeInTheDocument();
    expect(screen.queryByText("$9000.00")).not.toBeInTheDocument();
  });

  describe("the mark beside the account name", () => {
    const account = {
      id: "1",
      name: "Checking",
      currentBalance: 1500,
      currencyCode: "CAD",
      isFavourite: true,
      favouriteSortOrder: 0,
      isClosed: false,
      institution: "TD Bank",
      institutionId: "inst-1",
    } as any;

    it("is the institution's logo when it has one, instead of the star", () => {
      render(
        <FavouriteAccounts
          accounts={[account]}
          institutions={[{ id: "inst-1", name: "TD Bank", hasLogo: true }]}
          isLoading={false}
        />,
      );
      expect(screen.getByRole("img", { name: "TD Bank" })).toHaveAttribute(
        "src",
        "/api/v1/institutions/inst-1/logo",
      );
      expect(screen.queryByTestId("favourite-account-star")).not.toBeInTheDocument();
    });

    it("stays the star when the institution has no logo", () => {
      render(
        <FavouriteAccounts
          accounts={[account]}
          institutions={[{ id: "inst-1", name: "TD Bank", hasLogo: false }]}
          isLoading={false}
        />,
      );
      expect(screen.getByTestId("favourite-account-star")).toBeInTheDocument();
      expect(screen.queryByRole("img", { name: "TD Bank" })).not.toBeInTheDocument();
    });

    it("stays the star when the account has no institution on the list", () => {
      render(
        <FavouriteAccounts
          accounts={[{ ...account, institutionId: null }]}
          institutions={[{ id: "inst-1", name: "TD Bank", hasLogo: true }]}
          isLoading={false}
        />,
      );
      expect(screen.getByTestId("favourite-account-star")).toBeInTheDocument();
    });
  });
});
