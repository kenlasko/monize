import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import { sharedGroupFixture } from "@/components/shared-expenses/__fixtures__/shared-fixtures";
import SharedExpensesPage from "./page";

vi.mock("@/components/auth/ProtectedRoute", () => ({
  ProtectedRoute: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/layout/PageLayout", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/shared-expenses", async (original) => ({
  ...(await original<typeof import("@/lib/shared-expenses")>()),
  sharedExpensesApi: { overview: vi.fn(), privateGroups: vi.fn() },
}));

describe("Shared group overview", () => {
  beforeEach(() => {
    vi.mocked(sharedExpensesApi.overview).mockReset();
    vi.mocked(sharedExpensesApi.privateGroups)
      .mockReset()
      .mockResolvedValue([]);
  });

  it("does not present a failed initial lookup as an empty group table", async () => {
    vi.mocked(sharedExpensesApi.overview).mockRejectedValue(
      new Error("Connection failed"),
    );
    await act(async () => render(<SharedExpensesPage />));
    expect(screen.getByRole("alert")).toHaveTextContent("Connection failed");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("returns to an existing page when a refresh removes the last page", async () => {
    const groups = Array.from({ length: 26 }, (_, i) =>
      sharedGroupFixture({
        id: `group-${i}`,
        name: `Trip ${i}`,
      }),
    );
    vi.mocked(sharedExpensesApi.overview)
      .mockResolvedValueOnce({ groups, totals: [] })
      .mockResolvedValueOnce({ groups: groups.slice(0, 1), totals: [] });
    await act(async () => render(<SharedExpensesPage />));
    await act(async () => {
      fireEvent.click(screen.getAllByTitle("Next page")[0]);
    });
    expect(screen.getByText("Trip 25", { exact: true })).toBeInTheDocument();
    expect(screen.getAllByTitle("Next page")).toHaveLength(2);
    expect(
      screen
        .getAllByTitle("Next page")
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });
    expect(screen.getByText("Trip 0", { exact: true })).toBeInTheDocument();
    expect(
      screen.queryByText("Trip 25", { exact: true }),
    ).not.toBeInTheDocument();
    expect(screen.getByTitle("Next page")).toBeDisabled();
    expect(screen.getByText("Showing", { exact: false })).toHaveTextContent(
      "Showing 1 - 1 of 1 Groups",
    );
  });
  it("keeps a filtered one-page count and resets both pagers", async () => {
    const groups = Array.from({ length: 26 }, (_, i) =>
      sharedGroupFixture({ id: `group-${i}`, name: `Trip ${i}` }),
    );
    vi.mocked(sharedExpensesApi.overview).mockResolvedValue({
      groups,
      totals: [],
    });
    await act(async () => render(<SharedExpensesPage />));
    await act(async () =>
      fireEvent.click(screen.getAllByTitle("Next page")[1]),
    );
    await act(async () =>
      fireEvent.change(screen.getByLabelText("Search groups"), {
        target: { value: "Trip 17" },
      }),
    );
    expect(screen.getByText("Trip 17", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Showing", { exact: false })).toHaveTextContent(
      "Showing 1 - 1 of 1 Groups",
    );
    expect(screen.getByTitle("Next page")).toBeDisabled();
    expect(screen.getByTitle("Previous page")).toBeDisabled();
  });
});
