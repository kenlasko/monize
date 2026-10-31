import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, render, screen } from "@/test/render";
import { useAuthStore } from "@/store/authStore";
import { transactionsApi } from "@/lib/transactions";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import {
  sharedEntryFixture,
  sharedGroupFixture,
} from "@/components/shared-expenses/__fixtures__/shared-fixtures";
import ShareBankPage from "./page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ transactionId: "bank-row" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/components/auth/ProtectedRoute", () => ({
  ProtectedRoute: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/layout/PageLayout", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/transactions", () => ({
  transactionsApi: { getById: vi.fn() },
}));
vi.mock("@/lib/shared-expenses", async (original) => ({
  ...(await original<typeof import("@/lib/shared-expenses")>()),
  sharedExpensesApi: { groups: vi.fn(), group: vi.fn(), finances: vi.fn() },
}));

describe("Continue from a saved payment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      user: { id: "owner" } as never,
      actingAsUserId: null,
    });
    vi.mocked(transactionsApi.getById).mockResolvedValue({
      id: "bank-row",
      userId: "owner",
      amount: -300,
      currencyCode: "PLN",
      account: { accountType: "CHEQUING" },
    } as never);
    vi.mocked(sharedExpensesApi.groups).mockResolvedValue([
      sharedGroupFixture(),
      sharedGroupFixture({ id: "other", name: "Other" }),
    ]);
    vi.mocked(sharedExpensesApi.group).mockResolvedValue(
      sharedGroupFixture({
        entries: [
          sharedEntryFixture({
            ownEffect: {
              cash: "-300.0000",
              personal: "-150.0000",
              position: "150.0000",
              originalCash: "-300.0000",
              originalCurrency: "PLN",
            },
          }),
        ],
      }),
    );
    vi.mocked(sharedExpensesApi.finances).mockResolvedValue({
      integration: {
        id: "integration",
        accountId: "position",
        currencyCode: "PLN",
        participantId: "me",
      },
      entries: [],
      pendingCount: 0,
    });
  });
  it("explains the deferred handoff without reading or changing the source payment", async () => {
    await act(async () => render(<ShareBankPage />));
    expect(
      screen.getByText(/New personal-finance connections are unavailable/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Groups" }),
    ).toHaveAttribute("href", "/shared-expenses");
    expect(transactionsApi.getById).not.toHaveBeenCalled();
    expect(sharedExpensesApi.groups).not.toHaveBeenCalled();
    expect(sharedExpensesApi.finances).not.toHaveBeenCalled();
  });
  it("offers no creation or matching action in a delegated context", async () => {
    useAuthStore.setState({ actingAsUserId: "other-owner" });
    await act(async () => render(<ShareBankPage />));
    expect(
      screen.queryByRole("button", { name: "Create A Shared Expense" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Use This Expense" }),
    ).not.toBeInTheDocument();
    expect(transactionsApi.getById).not.toHaveBeenCalled();
    expect(sharedExpensesApi.group).not.toHaveBeenCalled();
  });
});
