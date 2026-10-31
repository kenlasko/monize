import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test/render";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import type { SharedFinanceOverview } from "@/types/shared-expense";
import { SharedFinances } from "./SharedFinances";
import { sharedGroupFixture } from "./__fixtures__/shared-fixtures";

vi.mock("@/lib/shared-expenses", async (original) => ({
  ...(await original<typeof import("@/lib/shared-expenses")>()),
  sharedExpensesApi: {
    finances: vi.fn(),
    enableFinance: vi.fn(),
    privateGroups: vi.fn(),
    unlink: vi.fn(),
  },
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
const overview: SharedFinanceOverview = {
  integration: {
    id: "integration",
    accountId: "account",
    currencyCode: "PLN",
    participantId: "me",
  },
  pendingCount: 0,
  entries: [
    {
      entryId: "entry",
      title: "Dinner",
      date: "2026-10-25",
      type: "EXPENSE",
      state: "POSTED",
      revision: 1,
      effect: {
        cash: "0.0000",
        originalCash: "0.0000",
        originalCurrency: "PLN",
        personal: "-100.0000",
        position: "-100.0000",
      },
      needsReview: false,
      reviewReason: "NOT_BOOKED",
      posting: null,
    },
  ],
};

describe("Optional personal finances", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sharedExpensesApi.finances).mockResolvedValue(overview);
    vi.mocked(sharedExpensesApi.privateGroups).mockResolvedValue([
      {
        groupId: "group",
        accountId: "account",
        name: "Weekend",
        currencyCode: "PLN",
      },
    ]);
  });
  it("keeps group-only entries out of the compatibility booking view", async () => {
    await act(async () =>
      render(<SharedFinances group={sharedGroupFixture()} />),
    );
    expect(
      screen.getByText(/New personal-finance connections are unavailable/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add to My Finances" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Needs your review")).not.toBeInTheDocument();
  });
  it("keeps previous rows non-actionable during a reload and after its failure", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(sharedExpensesApi.finances)
      .mockResolvedValueOnce(overview)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      );
    const view = await act(async () =>
      render(<SharedFinances group={sharedGroupFixture()} />),
    );
    await act(async () =>
      view.rerender(
        <SharedFinances group={sharedGroupFixture({ revision: 3 })} />,
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Add to My Finances" }),
    ).not.toBeInTheDocument();
    await act(async () => reject(new Error("Refresh failed")));
    expect(screen.getByRole("alert")).toHaveTextContent("Refresh failed");
    expect(
      screen.queryByRole("button", { name: "Add to My Finances" }),
    ).not.toBeInTheDocument();
  });
  it("does not offer account setup even when integration is absent", async () => {
    vi.mocked(sharedExpensesApi.finances).mockResolvedValue({
      integration: null,
      entries: [],
      pendingCount: 0,
    });
    await act(async () =>
      render(<SharedFinances group={sharedGroupFixture()} />),
    );
    expect(
      screen.queryByRole("button", { name: "Set Up My Finances" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/New personal-finance connections are unavailable/),
    ).toBeInTheDocument();
    expect(sharedExpensesApi.enableFinance).not.toHaveBeenCalled();
  });
});
