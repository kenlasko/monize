import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { SharedEntryTable } from "./SharedEntryTable";
import { SharedGroupTable } from "./SharedGroupTable";
import { SharedFilters } from "./SharedFilters";
import {
  sharedEntryFixture,
  sharedGroupFixture,
} from "./__fixtures__/shared-fixtures";

describe("Shared expense table and filter interactions", () => {
  it("opens an expense by keyboard and refuses actions on stale rows", async () => {
    const onOpen = vi.fn();
    const entry = sharedEntryFixture();
    const group = sharedGroupFixture({ entries: [entry] });
    const view = await act(async () =>
      render(<SharedEntryTable group={group} fresh onOpen={onOpen} />),
    );
    const row = screen.getByText(entry.title).closest("tr")!;
    await act(async () => fireEvent.keyDown(row, { key: "Enter" }));
    expect(onOpen).toHaveBeenCalledWith(entry);
    onOpen.mockClear();
    await act(async () =>
      view.rerender(
        <SharedEntryTable group={group} fresh={false} onOpen={onOpen} />,
      ),
    );
    await act(async () => {
      fireEvent.click(row);
      fireEvent.keyDown(row, { key: " " });
    });
    expect(onOpen).not.toHaveBeenCalled();
    expect(row).toHaveAttribute("aria-disabled", "true");
  });
  it("opens a group from the row and preserves known zero versus unknown positions", async () => {
    const onOpen = vi.fn();
    const group = sharedGroupFixture();
    await act(async () =>
      render(
        <SharedGroupTable
          fresh
          onOpen={onOpen}
          groups={[
            {
              ...group,
              name: "Settled trip",
              myPosition: { ...group.myPosition!, balance: "0.0000" },
            },
            {
              ...group,
              id: "unknown",
              name: "Unpriced trip",
              myPosition: null,
            },
          ]}
        />,
      ),
    );
    expect(screen.getByText("Settled trip").closest("tr")).toHaveTextContent(
      "Settled",
    );
    expect(screen.getByText("Unpriced trip").closest("tr")).toHaveTextContent(
      "Not available",
    );
    await act(async () =>
      fireEvent.click(screen.getByText("Settled trip").closest("tr")!),
    );
    expect(onOpen).toHaveBeenCalledWith(group.id);
  });
  it("keeps filter controls visible and preserves independent Clear and chip removal", async () => {
    const remove = vi.fn(),
      clear = vi.fn();
    await act(async () =>
      render(
        <SharedFilters
          onClear={clear}
          chips={[
            {
              key: "search",
              label: "Coffee",
              removeLabel: "Remove search filter",
              remove,
            },
          ]}
        >
          <input aria-label="Search draft" defaultValue="Coffee" />
        </SharedFilters>,
      ),
    );
    const field = screen.getByLabelText("Search draft");
    expect(field).toBeVisible();
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Remove search filter" }),
      ),
    );
    expect(remove).toHaveBeenCalledOnce();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Clear" })),
    );
    expect(clear).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Search draft")).toBe(field);
    expect(field).toHaveValue("Coffee");
  });
});
