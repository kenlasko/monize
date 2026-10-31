import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@/test/render";
import type { SharedEntryInput } from "@/types/shared-expense";
import { SharedSplitEditor } from "./SharedSplitEditor";
import { initialSharedEntry } from "@/lib/shared-split-draft";
import { sharedGroupFixture } from "./__fixtures__/shared-fixtures";

vi.mock("./useSharedEntryPreview", () => ({
  useSharedEntryPreview: (_groupId: string, input: SharedEntryInput) => ({
    preview: {
      allocations: input.shares.map((row) => ({
        participantId: row.participantId,
        kind: "SHARE",
        originalAmount: input.splitMode === "EXACT" ? row.value : "50.00",
      })),
    },
    pending: false,
    error: null,
  }),
}));

function setup(group = sharedGroupFixture()) {
  const input = {
    ...initialSharedEntry(group, "2026-10-25"),
    amount: "100",
    contributions: [{ participantId: "me", value: "100" }],
  };
  const onApply = vi.fn(),
    onClose = vi.fn();
  render(
    <SharedSplitEditor
      groupId={group.id}
      input={input}
      participants={group.participants}
      places={2}
      onApply={onApply}
      onClose={onClose}
    />,
  );
  return { onApply, onClose, input };
}
describe("SharedSplitEditor", () => {
  it("keeps a fixed coffee amount and zero while sharing the rest only among selected people", () => {
    const group = sharedGroupFixture({
      participantCount: 6,
      participants: [
        ...sharedGroupFixture().participants,
        ...["Bartek", "Celina", "Daniel", "Ewa"].map((name) => ({
          id: name.toLowerCase(),
          name,
          isActive: true,
          connected: false,
          role: null,
        })),
      ],
    });
    const { onApply, input } = setup(group);
    fireEvent.change(screen.getByLabelText("Share for Me"), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByLabelText("Share for Anna"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Ewa" }));
    expect(screen.getByLabelText("Share for Me")).toHaveValue("20.00");
    expect(screen.getByLabelText("Share for Anna")).toHaveValue("0.00");
    expect(screen.getByLabelText("Share for Bartek")).toHaveValue("26.67");
    expect(screen.getByLabelText("Share for Celina")).toHaveValue("26.67");
    expect(screen.getByLabelText("Share for Daniel")).toHaveValue("26.66");
    expect(screen.queryByLabelText("Share for Ewa")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Ready to apply");
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply Split" }));
    expect(onApply).toHaveBeenCalledWith({
      splitMode: "EXACT",
      shares: [
        { participantId: "me", value: "20" },
        { participantId: "anna", value: "0" },
        { participantId: "bartek", value: "26.67" },
        { participantId: "celina", value: "26.67" },
        { participantId: "daniel", value: "26.66" },
      ],
    });
    expect(group.participants).toHaveLength(6);
    expect(group.participants.every((p) => p.isActive)).toBe(true);
    expect(input.shares).toHaveLength(6);
    expect(input.contributions).toEqual([
      { participantId: "me", value: "100" },
    ]);
  });
  it("lets a payer cover someone else's expense without taking a share or leaving the group", () => {
    const { onApply, input } = setup();
    fireEvent.click(screen.getByRole("switch", { name: "Me" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply Split" }));
    expect(onApply).toHaveBeenCalledWith({
      splitMode: "EQUAL",
      shares: [{ participantId: "anna" }],
    });
    expect(input.contributions).toEqual([
      { participantId: "me", value: "100" },
    ]);
    expect(input.shares).toHaveLength(2);
  });
  it("cancels the equal split without changing the applied shares", () => {
    const { onApply, onClose, input } = setup();
    expect(screen.getByLabelText("Share for Me")).toHaveValue("50.00");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
    expect(input.shares).toEqual([
      { participantId: "me" },
      { participantId: "anna" },
    ]);
  });
  it("cancels local edits without replacing the parent's split", () => {
    const { input, onApply, onClose } = setup();
    fireEvent.click(screen.getByRole("switch", { name: "Anna" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
    expect(input.shares).toHaveLength(2);
  });
  it("keeps a fixed amount while assigning only the remainder to the other person", () => {
    const { onApply } = setup();
    fireEvent.change(screen.getByLabelText("Share for Me"), {
      target: { value: "35" },
    });
    expect(screen.getByLabelText("Share for Me")).toHaveValue("35.00");
    fireEvent.click(screen.getByRole("button", { name: "Apply Split" }));
    expect(onApply).toHaveBeenCalledWith({
      splitMode: "EXACT",
      shares: [
        { participantId: "me", value: "35" },
        { participantId: "anna", value: "65.00" },
      ],
    });
  });
  it("identifies a missing 0.01 percent instead of normalizing 99.99 percent", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Percentage for Me"), {
      target: { value: "50" },
    });
    fireEvent.change(screen.getByLabelText("Percentage for Anna"), {
      target: { value: "49.99" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("0.01%");
    expect(screen.getByRole("button", { name: "Apply Split" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Percentage for Anna"), {
      target: { value: "50" },
    });
    expect(screen.getByRole("button", { name: "Apply Split" })).toBeEnabled();
  });
  it("explains why an empty selection cannot be applied", () => {
    const { onApply } = setup();
    fireEvent.click(screen.getByRole("switch", { name: "Me" }));
    fireEvent.click(screen.getByRole("switch", { name: "Anna" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Choose at least one person",
    );
    expect(screen.getByRole("button", { name: "Apply Split" })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
  });
  it("keeps extras optional and only applies their calculation on request", () => {
    const { onApply } = setup();
    fireEvent.change(screen.getByLabelText("Share for Me"), {
      target: { value: "20" },
    });
    const disclosure = screen
      .getByText("More split options")
      .closest("details")!;
    expect(disclosure.open).toBe(false);
    disclosure.open = true;
    expect(screen.getByLabelText("Share for Me")).toHaveValue("20.00");
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Extras, then split the rest equally",
      }),
    );
    expect(screen.getByLabelText("Share for Me")).toHaveValue("60.00");
    expect(screen.getByLabelText("Share for Anna")).toHaveValue("40.00");
    expect(screen.getByRole("status")).toHaveTextContent("Ready to apply");
    expect(
      screen.queryByRole("button", { name: /Give remainder/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply Split" }));
    expect(onApply).toHaveBeenCalledWith({
      splitMode: "EXACT",
      shares: [
        { participantId: "me", value: "60.00" },
        { participantId: "anna", value: "40.00" },
      ],
    });
  });
  it("names over-allocation and does not offer a positive-remainder action", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Share for Me"), {
      target: { value: "120" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(/Over-allocated:.*20/);
    expect(screen.getByRole("button", { name: "Apply Split" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /Give remainder/ }),
    ).not.toBeInTheDocument();
  });
  it("offers linked percentage and weight controls without mode tabs", () => {
    const { onApply } = setup();
    expect(screen.getByLabelText("Percentage for Me")).toBeInTheDocument();
    expect(screen.getByLabelText("Shares for Me")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Exact amounts" }),
    ).not.toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("slider", { name: "Adjust Percentage for Me" }),
      { target: { value: "40" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply Split" }));
    expect(onApply).toHaveBeenCalledWith({
      splitMode: "PERCENT",
      shares: [
        { participantId: "me", value: "40" },
        { participantId: "anna", value: "60.00" },
      ],
    });
  });
  it("gives people with the same name distinct numeric field labels", () => {
    const group = sharedGroupFixture();
    setup({
      ...group,
      participants: group.participants.map((person) => ({
        ...person,
        name: "Alex",
      })),
    });
    const labels = screen.getAllByText("Percentage for Alex", {
      selector: "label",
    });
    expect(new Set(labels.map((label) => label.getAttribute("for"))).size).toBe(
      2,
    );
    expect(
      screen.getAllByRole("textbox", { name: "Percentage for Alex" }),
    ).toHaveLength(2);
  });
  it("keeps the slider's accessible percentage within its range while naming an over-allocation", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Percentage for Me"), {
      target: { value: "120" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(/Over-allocated/);
    expect(
      screen.getByRole("slider", { name: "Adjust Percentage for Me" }),
    ).toHaveAttribute("aria-valuetext", "100.00%");
    expect(screen.getByRole("button", { name: "Apply Split" })).toBeDisabled();
  });
});
