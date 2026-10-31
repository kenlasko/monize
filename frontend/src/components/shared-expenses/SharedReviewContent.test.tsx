import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { SharedReviewContent } from "./SharedReviewContent";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import { useAuthStore } from "@/store/authStore";
import { setAuthenticatedState } from "@/test/mocks/stores";
import type { SharedReviewSummary } from "@/types/shared-expense";

const location = vi.hoisted(() => ({ pathname: "/shared-expenses/review" }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => location.pathname,
}));
vi.mock("@/lib/shared-expenses", () => ({
  sharedExpensesApi: { review: vi.fn() },
}));
const summary = (
  patch: Partial<SharedReviewSummary> = {},
): SharedReviewSummary => ({
  ledgerBasis: "ACCEPTED_SHARED_POSTINGS",
  pendingCount: 2,
  unavailableGroupCount: 0,
  groups: [
    {
      groupId: "group",
      accountId: "account",
      accountName: "Trip",
      pendingCount: patch.pendingCount ?? 2,
      accessRevoked: (patch.unavailableGroupCount ?? 0) > 0,
    },
  ],
  reviewUrl: "/shared-expenses/review",
  checkedAt: "2026-10-26T12:00:00Z",
  ...patch,
});

describe("Explicit shared review without global notices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuthenticatedState();
    useAuthStore.setState({ actingAsUserId: null });
    location.pathname = "/shared-expenses/review";
    vi.mocked(sharedExpensesApi.review).mockResolvedValue(summary());
  });
  it("shows the server count, accepted-booking basis and a repair link", async () => {
    await act(async () => {
      render(<SharedReviewContent />);
    });
    expect(
      screen.getByText(
        "Shared expenses awaiting your review: 2. Reports include your accepted bookings.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute(
      "href",
      "/shared-expenses/group?view=myFinances",
    );
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(sharedExpensesApi.review).toHaveBeenCalledTimes(2);
  });
  it("hides a known zero but explains a revoked group's unknown current state", async () => {
    vi.mocked(sharedExpensesApi.review).mockResolvedValue(
      summary({ pendingCount: 0 }),
    );
    const view = await act(async () => render(<SharedReviewContent />));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    vi.mocked(sharedExpensesApi.review).mockResolvedValue(
      summary({ pendingCount: 0, unavailableGroupCount: 1 }),
    );
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(
      screen.getByRole("link", { name: "Your private bookings" }),
    ).toHaveAttribute("href", "/shared-expenses/private-finances/group");
    expect(
      screen.queryByText("No changes to accepted entries need review."),
    ).not.toBeInTheDocument();
    view.unmount();
  });
  it("does not prompt a connected group with no changes to accepted finances", async () => {
    vi.mocked(sharedExpensesApi.review).mockResolvedValue(
      summary({
        pendingCount: 0,
        groups: [
          {
            groupId: "group",
            accountId: "account",
            accountName: "Trip",
            pendingCount: 0,
            accessRevoked: false,
          },
        ],
      }),
    );
    await act(async () => render(<SharedReviewContent />));
    expect(
      screen.queryByRole("heading", { name: "Trip" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Review" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("keeps a failed request distinct from zero, with retry", async () => {
    vi.mocked(sharedExpensesApi.review).mockRejectedValueOnce(
      new Error("network"),
    );
    await act(async () => {
      render(<SharedReviewContent />);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("could not be checked");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    });
    expect(screen.getByText(/review: 2/)).toBeInTheDocument();
  });
  it.each([
    "/settings",
    "/shared-expenses",
    "/login",
    "/dashboard",
    "/accounts",
    "/transactions",
    "/budgets",
    "/reports",
    "/net-worth",
  ])("does not fetch on %s", async (pathname) => {
    location.pathname = pathname;
    await act(async () => {
      render(<SharedReviewContent />);
    });
    expect(sharedExpensesApi.review).not.toHaveBeenCalled();
  });
  it("never requests private review data in a delegate context or after sign-out", async () => {
    useAuthStore.setState({ actingAsUserId: "owner" });
    const view = await act(async () => render(<SharedReviewContent />));
    await act(async () => {
      useAuthStore.setState({ actingAsUserId: null, isAuthenticated: false });
    });
    expect(sharedExpensesApi.review).not.toHaveBeenCalled();
    view.unmount();
  });
  it("cannot show a late old-user response after the active identity changes", async () => {
    let resolveOld!: (value: SharedReviewSummary) => void;
    vi.mocked(sharedExpensesApi.review)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValue(summary({ pendingCount: 0 }));
    await act(async () => {
      render(<SharedReviewContent />);
    });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => {
      const user = useAuthStore.getState().user!;
      useAuthStore.setState({ user: { ...user, id: "new-user" } });
    });
    await act(async () => {
      resolveOld(summary({ pendingCount: 9 }));
    });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Trip" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/review: 9/)).not.toBeInTheDocument();
    expect(sharedExpensesApi.review).toHaveBeenCalledTimes(2);
  });
});
