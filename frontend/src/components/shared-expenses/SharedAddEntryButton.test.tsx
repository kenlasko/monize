import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { SharedAddEntryButton } from "./SharedAddEntryButton";

describe("Shared entry actions", () => {
  it.each(["Expense", "Income"])("offers %s from one action menu", (label) => {
    const onAdd = vi.fn();
    render(<SharedAddEntryButton disabled={false} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole("button", { name: "Add Expense" }));
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(onAdd).toHaveBeenCalledWith(label.toUpperCase());
    expect(screen.getByRole("button", { name: "Add Expense" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
  it("returns focus on Escape and prevents stale group actions", () => {
    const onAdd = vi.fn();
    const view = render(
      <SharedAddEntryButton disabled={false} onAdd={onAdd} />,
    );
    const trigger = screen.getByRole("button", { name: "Add Expense" });
    fireEvent.click(trigger);
    screen.getByRole("button", { name: "Income" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: "Income" }),
    ).not.toBeInTheDocument();
    fireEvent.click(trigger);
    view.rerender(<SharedAddEntryButton disabled onAdd={onAdd} />);
    expect(trigger).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Income" }),
    ).not.toBeInTheDocument();
    expect(onAdd).not.toHaveBeenCalled();
  });
});
