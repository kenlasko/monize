import { describe, it, expect } from "vitest";
import { render, screen } from "@/test/render";
import { SharedGroupSummary } from "./SharedGroupSummary";
import { SharedEntryContext } from "./SharedEntryContext";
import {
  sharedEntryFixture,
  sharedGroupFixture,
} from "./__fixtures__/shared-fixtures";
import type { SharedPosition } from "@/types/shared-expense";

const position = (patch: Partial<SharedPosition> = {}): SharedPosition => ({
  participantId: "me",
  balance: "200.0000",
  knownBalance: "200.0000",
  cost: "100.0000",
  paid: "300.0000",
  income: "0.0000",
  incomeReceived: "0.0000",
  sent: "0.0000",
  received: "0.0000",
  ...patch,
});

describe("Readable shared positions", () => {
  it("names the currency shared by the group's totals and balances", () => {
    render(
      <SharedGroupSummary
        group={sharedGroupFixture({ currencyCode: "CAD" })}
      />,
    );
    expect(screen.getByText("Balances and totals in CAD")).toBeInTheDocument();
  });
  it.each([
    ["200.0000", "Owed to You"],
    ["-200.0000", "You Owe"],
    ["0.0000", "Settled up"],
  ])(
    "names the direction of %s separately from personal and group costs",
    (balance, label) => {
      const group = sharedGroupFixture();
      render(
        <SharedGroupSummary
          group={{
            ...group,
            balances: { ...group.balances, positions: [position({ balance })] },
          }}
        />,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(
        screen.getByText("Your Cost").closest("article"),
      ).toHaveTextContent(/100\.00/);
      expect(
        screen.getByText("Group Expenses").closest("article"),
      ).toHaveTextContent(/300\.00/);
      expect(screen.getByText("You Paid", { exact: false })).toHaveTextContent(
        /300\.00/,
      );
      expect(screen.queryByText(/-200/)).not.toBeInTheDocument();
    },
  );
  it("does not turn an absent or incomplete personal position into settled up", () => {
    const group = sharedGroupFixture();
    const { rerender } = render(<SharedGroupSummary group={group} />);
    expect(screen.queryByText("Settled up")).not.toBeInTheDocument();
    expect(screen.getAllByText("Not available")).toHaveLength(3);
    rerender(
      <SharedGroupSummary
        group={{
          ...group,
          balances: {
            ...group.balances,
            totalExpenses: null,
            positions: [position({ balance: null, cost: null, paid: null })],
          },
        }}
      />,
    );
    expect(screen.getAllByText("Not available")).toHaveLength(4);
    expect(screen.queryByText("Settled up")).not.toBeInTheDocument();
  });
  it("shows the server's own share in the settlement currency beside the actual payer", () => {
    render(
      <SharedEntryContext
        group={sharedGroupFixture()}
        entry={sharedEntryFixture({
          currencyCode: "EUR",
          ownEffect: { personal: "-150.0000" } as never,
        })}
      />,
    );
    expect(screen.getByText("Paid By · Me")).toBeInTheDocument();
    expect(screen.getByText("Your Cost", { exact: false })).toHaveTextContent(
      /150\.00/,
    );
    expect(screen.getByText("Your Cost", { exact: false })).toHaveTextContent(
      /zł/,
    );
  });
  it("names both repayment participants and does not label their transfer as cost", () => {
    render(
      <SharedEntryContext
        group={sharedGroupFixture()}
        entry={sharedEntryFixture({
          type: "REPAYMENT",
          fromParticipantId: "anna",
          toParticipantId: "me",
        })}
      />,
    );
    expect(screen.getByText("Anna → Me")).toBeInTheDocument();
    expect(
      screen.queryByText("Your Cost", { exact: false }),
    ).not.toBeInTheDocument();
  });
  it("does not show a future or missing-rate draft as a known personal cost", () => {
    render(
      <SharedEntryContext
        group={sharedGroupFixture()}
        entry={sharedEntryFixture({ state: "DRAFT", ownEffect: null })}
      />,
    );
    expect(
      screen.queryByText("Your Cost", { exact: false }),
    ).not.toBeInTheDocument();
  });
});
