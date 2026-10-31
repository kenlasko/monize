import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@/test/render";
import { usePreferencesStore } from "@/store/preferencesStore";
import { SharedEntryConversion } from "./SharedEntryConversion";
import { SharedEntryPreview } from "./SharedEntryPreview";
import { SharedAmount } from "./SharedPrimitives";
import {
  sharedEntryFixture,
  sharedGroupFixture,
} from "./__fixtures__/shared-fixtures";

const group = sharedGroupFixture({ currencyCode: "CAD" });
const entry = sharedEntryFixture({
  currencyCode: "USD",
  originalAmount: "900.0000",
  groupAmount: "1215.0100",
  fxRate: "1.3500123456",
  fxRateDate: "2026-10-24",
  fxSource: "MARKET",
});

describe("SharedEntryConversion", () => {
  beforeEach(() => {
    usePreferencesStore.getState().updatePreferences({
      numberFormat: "en-US",
      dateFormat: "YYYY-MM-DD",
    });
  });
  afterEach(() => {
    cleanup();
    usePreferencesStore.getState().clearPreferences();
  });

  it("discloses the accepted amount, standard rate precision, source and observation date", () => {
    render(<SharedEntryConversion group={group} entry={entry} />);
    expect(
      screen.getByText("Group amount · CAD").parentElement,
    ).toHaveTextContent("$1,215.01 CAD");
    expect(screen.getByText("1 USD = 1.350012 CAD")).toBeInTheDocument();
    expect(screen.getByText("Historical market rate")).toBeInTheDocument();
    expect(screen.getByText("2026-10-24")).toBeInTheDocument();
    expect(screen.queryByText("2026-10-25")).not.toBeInTheDocument();
  });

  it("uses the reader's number preference for both money and the rate", () => {
    usePreferencesStore.getState().updatePreferences({ numberFormat: "de-DE" });
    render(<SharedEntryConversion group={group} entry={entry} />);
    expect(
      screen.getByText("Group amount · CAD").parentElement,
    ).toHaveTextContent("1.215,01");
    expect(screen.getByText("1 USD = 1,350012 CAD")).toBeInTheDocument();
  });

  it.each([
    ["MANUAL", "Entered rate"],
    ["ORIGINAL_REFUND", "Original expense’s rate"],
  ])(
    "identifies %s without presenting it as a market quote",
    (fxSource, label) => {
      render(
        <SharedEntryConversion group={group} entry={{ ...entry, fxSource }} />,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(
        screen.queryByText("Historical market rate"),
      ).not.toBeInTheDocument();
    },
  );

  it("keeps an unavailable rate and total unknown and names the missing pair in the preview", () => {
    render(
      <SharedEntryPreview
        group={group}
        entry={{
          ...entry,
          state: "DRAFT",
          draftReason: "MISSING_RATE",
          groupAmount: null,
          fxRate: null,
          fxRateDate: null,
          fxSource: null,
          allocations: [],
        }}
      />,
    );
    expect(
      screen.getByText("Group amount · CAD").parentElement,
    ).toHaveTextContent("Not available");
    expect(screen.getByText(/No rate for USD to CAD/)).toBeInTheDocument();
    expect(screen.queryByText(/1 USD =/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("Historical market rate"),
    ).not.toBeInTheDocument();
  });

  it("renders a known amount rounded to zero as zero", () => {
    render(
      <SharedEntryConversion
        group={group}
        entry={{
          ...entry,
          currencyCode: "JPY",
          originalAmount: "1.0000",
          groupAmount: "0.0000",
          fxRate: "0.0001000000",
          fxSource: "MANUAL",
        }}
      />,
    );
    expect(
      screen.getByText("Group amount · CAD").parentElement,
    ).toHaveTextContent("$0.00 CAD");
    expect(screen.queryByText("Not available")).not.toBeInTheDocument();
  });

  it("keeps ordinary same-currency entry free of conversion controls", () => {
    render(
      <SharedEntryConversion
        group={group}
        entry={{ ...entry, currencyCode: "CAD" }}
      />,
    );
    expect(
      screen.queryByRole("region", { name: "Currency conversion" }),
    ).not.toBeInTheDocument();
  });

  it("distinguishes an original USD amount from CAD balances even when the user prefers USD", () => {
    usePreferencesStore
      .getState()
      .updatePreferences({ defaultCurrency: "USD" });
    render(<SharedAmount amount="100.0000" currency="USD" relativeTo="CAD" />);
    expect(screen.getByText("$100.00 USD")).toBeInTheDocument();
  });

  it("keeps the usual foreign-currency label when the amount matches the group but not the reader's preference", () => {
    usePreferencesStore
      .getState()
      .updatePreferences({ defaultCurrency: "USD" });
    render(<SharedAmount amount="135.0000" currency="CAD" relativeTo="CAD" />);
    expect(screen.getByText("$135.00 CAD")).toBeInTheDocument();
  });
});
