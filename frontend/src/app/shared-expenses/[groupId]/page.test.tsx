import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { describe, it, vi } from "vitest";
import { expect } from "vitest";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import {
  sharedEntryFixture,
  sharedGroupFixture,
} from "@/components/shared-expenses/__fixtures__/shared-fixtures";
import type { SharedGroupDetail } from "@/types/shared-expense";
import SharedGroupPage from "./page";

vi.mock("@/components/auth/ProtectedRoute", () => ({
  ProtectedRoute: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/layout/PageLayout", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useParams: () => ({ groupId: "group" }),
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/shared-expenses", async (original) => ({
  ...(await original<typeof import("@/lib/shared-expenses")>()),
  sharedExpensesApi: { group: vi.fn(), groups: vi.fn() },
}));

describe("Shared group live filters", () => {
  it("keeps filters visible, navigates by Tabs and withholds stale rows during a search", async () => {
    const initial = sharedGroupFixture({
      id: "group",
      entries: [sharedEntryFixture({ title: "Old dinner" })],
      entryCount: 1,
    });
    const pending = new Map<string, (value: SharedGroupDetail) => void>();
    vi.mocked(sharedExpensesApi.groups).mockResolvedValue([initial]);
    vi.mocked(sharedExpensesApi.group).mockImplementation(
      (_id, _offset, filters) =>
        filters?.search
          ? new Promise((resolve) => pending.set(filters.search!, resolve))
          : Promise.resolve(initial),
    );
    await act(async () => render(<SharedGroupPage />));
    expect(screen.getByRole("tab", { name: "Activity" })).toBeInTheDocument();
    expect(
      screen.getByRole("tabpanel", { name: "Expenses" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("People")).toBeVisible();
    expect(screen.getByLabelText("From")).toBeVisible();
    expect(screen.getByLabelText("To")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Search" }),
    ).not.toBeInTheDocument();
    await act(async () =>
      fireEvent.change(screen.getByLabelText("Search descriptions and notes"), {
        target: { value: "Coffee" },
      }),
    );
    expect(screen.getByText("Old dinner").closest("tr")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await waitFor(() => expect(pending.has("Coffee")).toBe(true));
    await act(async () =>
      fireEvent.change(screen.getByLabelText("Search descriptions and notes"), {
        target: { value: "Fuel" },
      }),
    );
    await waitFor(() => expect(pending.has("Fuel")).toBe(true));
    await act(async () =>
      pending.get("Coffee")!({
        ...initial,
        entries: [sharedEntryFixture({ title: "Old coffee response" })],
      }),
    );
    expect(screen.queryByText("Old coffee response")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
    await act(async () =>
      pending.get("Fuel")!({
        ...initial,
        entries: [sharedEntryFixture({ title: "Fuel purchase" })],
      }),
    );
    expect(screen.getByText("Fuel purchase").closest("tr")).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  });
  it("pages from either end and disables both pagers until the new page arrives", async () => {
    const initial = sharedGroupFixture({
      id: "group",
      entries: [sharedEntryFixture({ title: "First page" })],
      entryCount: 101,
    });
    let resolvePage!: (group: SharedGroupDetail) => void;
    vi.mocked(sharedExpensesApi.groups).mockResolvedValue([initial]);
    vi.mocked(sharedExpensesApi.group).mockImplementation((_id, offset) =>
      offset
        ? new Promise((resolve) => {
            resolvePage = resolve;
          })
        : Promise.resolve(initial),
    );
    await act(async () => render(<SharedGroupPage />));
    expect(screen.getAllByTitle("Next page")).toHaveLength(2);
    await act(async () =>
      fireEvent.click(screen.getAllByTitle("Next page")[0]),
    );
    expect(sharedExpensesApi.group).toHaveBeenLastCalledWith(
      "group",
      100,
      expect.any(Object),
    );
    for (const button of screen.getAllByTitle("Previous page"))
      expect(button).toBeDisabled();
    await act(async () =>
      resolvePage({
        ...initial,
        entries: [sharedEntryFixture({ title: "Last page" })],
      }),
    );
    expect(screen.getByText("Last page")).toBeInTheDocument();
    expect(
      screen.getAllByText("Showing", { exact: false })[0],
    ).toHaveTextContent("Showing 101 - 101 of 101 Expenses");
    await act(async () =>
      fireEvent.click(screen.getAllByTitle("Previous page")[1]),
    );
    expect(screen.getByText("First page")).toBeInTheDocument();
  });
  it("does not label a pending filter lookup as an empty result", async () => {
    const empty = sharedGroupFixture({
      id: "group",
      entries: [],
      entryCount: 0,
    });
    let resolvePage!: (group: SharedGroupDetail) => void;
    vi.mocked(sharedExpensesApi.groups).mockResolvedValue([empty]);
    vi.mocked(sharedExpensesApi.group).mockImplementation(
      (_id, _offset, filters) =>
        filters?.search
          ? new Promise((resolve) => {
              resolvePage = resolve;
            })
          : Promise.resolve(empty),
    );
    await act(async () => render(<SharedGroupPage />));
    const emptyHeading = screen.getByRole("heading", {
      name: "No expenses yet",
    });
    expect(emptyHeading).toBeInTheDocument();
    await act(async () =>
      fireEvent.change(screen.getByLabelText("Search descriptions and notes"), {
        target: { value: "Coffee" },
      }),
    );
    expect(
      screen.queryByRole("heading", { name: "No expenses yet" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(resolvePage).toBeDefined());
    await act(async () =>
      resolvePage({
        ...empty,
        entries: [sharedEntryFixture({ title: "Coffee" })],
        entryCount: 1,
      }),
    );
    expect(screen.getByRole("row", { name: /Coffee/ })).toBeInTheDocument();
  });
});
