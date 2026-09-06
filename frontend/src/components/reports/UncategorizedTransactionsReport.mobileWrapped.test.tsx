import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@/test/render";
import { UncategorizedTransactionsReport } from "./UncategorizedTransactionsReport";

/**
 * The phone layout of the Uncategorized Transactions table.
 *
 * The table is ONE tree restyled by CSS (mechanism A): below `sm` the rows wrap
 * into a two-column, two-line grid and the column header row is replaced by a
 * strip of sort chips, from `sm` up it is the ordinary table. jsdom applies no
 * media queries, so both header rows and every phone caption are in the DOM
 * here at all times -- which is what lets these assertions read the phone
 * markup without emulating a viewport, and why a sort control is addressed by
 * position rather than by label (each label matches the phone strip, the column
 * header row, and -- for the three captioned columns -- a caption in every row).
 */

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
  useNumberFormat: () => ({
    ...numberFormatMockDefaults(),
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    defaultCurrency: "CAD",
  }),
  };
});

const stableResolvedRange = { start: "2025-01-01", end: "2025-03-31" };

vi.mock("@/hooks/useDateRange", () => ({
  useDateRange: () => ({
    dateRange: "3m",
    setDateRange: vi.fn(),
    resolvedRange: stableResolvedRange,
    isValid: true,
  }),
}));

// Spread the real module rather than replacing it: the phone captions render
// `CellLabel`, which reads `cn` from here, and a bare factory blanks every other
// export of the module for the whole graph under test.
vi.mock("@/lib/utils", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/utils")>()),
  parseLocalDate: (d: string) => new Date(d + "T00:00:00"),
}));

vi.mock("@/components/ui/DateRangeSelector", () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock("@/components/ui/ExportDropdown", () => ({
  ExportDropdown: () => <div data-testid="export-dropdown" />,
}));

const mockGetUncategorizedTransactions = vi.fn();
vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getUncategorizedTransactions: (...args: any[]) =>
      mockGetUncategorizedTransactions(...args),
  },
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

/**
 * Three rows, chosen so the stored default sort (date, descending) and an
 * ascending sort by Account disagree -- otherwise a tap on the phone strip
 * could re-sort and leave the rows in the order they were already in.
 *
 * The third carries the two absences this report has to render without a
 * name: the endpoint sends `payeeName` and `accountName` as null for a
 * free-text row on an account it could not name, and `description` null with
 * them, which is also the one navigation that sends no search term.
 */
const RESPONSE = {
  transactions: [
    {
      id: "tx-early",
      transactionDate: "2025-01-05",
      payeeName: "Westside Hardware & Garden Supply",
      description: "Contactless card purchase, terminal 4471",
      accountName: "Zeta Chequing",
      accountId: "acc-z",
      amount: -123456.78,
    },
    {
      id: "tx-late",
      transactionDate: "2025-03-20",
      payeeName: "Corner Store",
      description: null,
      accountName: "Alpha Savings",
      accountId: "acc-a",
      amount: 200,
    },
    {
      id: "tx-unknown",
      transactionDate: "2025-02-10",
      payeeName: null,
      description: null,
      accountName: null,
      accountId: "acc-u",
      amount: -75,
    },
  ],
  summary: {
    totalCount: 3,
    expenseCount: 2,
    expenseTotal: 123531.78,
    incomeCount: 1,
    incomeTotal: 200,
  },
};

/** The column order, which is also the `<td>` order in every row. */
const EXPECTED_LABELS = ["Date", "Payee / Description", "Account", "Amount"];

const stripGlyph = (text: string | null | undefined) =>
  (text ?? "").replace(/[↑↓↕]/g, "").trim();

async function renderTable(response: unknown = RESPONSE) {
  mockGetUncategorizedTransactions.mockResolvedValue(response);
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<UncategorizedTransactionsReport />));
  });
  await waitFor(() => expect(container.querySelector("table")).toBeInTheDocument());
  return container;
}

const bodyRows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr"));

const txRow = (container: HTMLElement, name: string) =>
  bodyRows(container).find((r) => r.textContent?.includes(name));

/** The identity cell of every body row, in render order. */
const order = (container: HTMLElement) =>
  bodyRows(container).map((r) => r.querySelectorAll("td")[1]?.textContent);

describe("UncategorizedTransactionsReport (phone wrapped rows)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    // The sort is persisted, so a tap in one test would otherwise decide the
    // starting order of the next.
    localStorage.clear();
  });

  it("builds both header rows from one record of all four sort fields", async () => {
    const container = await renderTable();

    const headerRows = Array.from(container.querySelectorAll("thead tr"));
    expect(headerRows).toHaveLength(2);
    const [phoneRow, columnRow] = headerRows;
    // Exactly one of the two is displayed at any width.
    expect(phoneRow.className).toContain("sm:hidden");
    expect(columnRow.className).toContain("hidden");
    expect(columnRow.className).toContain("sm:table-row");

    const labelsOf = (row: Element) =>
      Array.from(row.querySelectorAll("th")).map((th) => stripGlyph(th.textContent));
    expect(labelsOf(phoneRow)).toEqual(EXPECTED_LABELS);
    // Both rows are rendered from one record, so they cannot list different
    // fields -- assert it rather than trusting the loop.
    expect(labelsOf(columnRow)).toEqual(labelsOf(phoneRow));
    // As many controls in each header row as a data row has cells: a field
    // added to the union with no control anywhere would strand a stored sort.
    const cellCount = bodyRows(container)[0].querySelectorAll("td").length;
    expect(cellCount).toBe(4);
    expect(phoneRow.querySelectorAll("th")).toHaveLength(cellCount);
    expect(columnRow.querySelectorAll("th")).toHaveLength(cellCount);
  });

  it("sorts from the phone strip, which the column header row cannot do on a phone", async () => {
    const container = await renderTable();

    // The stored default is date, descending.
    expect(order(container)).toEqual([
      "Corner Store",
      "Unknown",
      "Westside Hardware & Garden SupplyContactless card purchase, terminal 4471",
    ]);

    // "Account" is the third of the four controls in the phone strip.
    // Addressed by position: the label also names the column header and the
    // caption of a cell in every row.
    const phoneAccount = container
      .querySelectorAll("thead tr")[0]
      .querySelectorAll("th")[2];
    await act(async () => {
      fireEvent.click(phoneAccount);
    });
    // Ascending by account name: the unnamed account sorts as an empty string,
    // then Alpha, then Zeta.
    expect(order(container)).toEqual([
      "Unknown",
      "Corner Store",
      "Westside Hardware & Garden SupplyContactless card purchase, terminal 4471",
    ]);
  });

  it("captions the date, the account and the amount, and leaves the identity alone", async () => {
    const container = await renderTable();

    const row = txRow(container, "Corner Store")!;
    // Each caption sits immediately beside the value it names, as its own text
    // node, so a `getByText` on the value still matches the value node.
    expect(row.textContent).toContain("DateMar 20, 2025");
    expect(row.textContent).toContain("AccountAlpha Savings");
    expect(row.textContent).toContain("Amount$200.00");
    // Scoped to the row: the income summary card above prints the same
    // figure. Inside the row it matches exactly once, on the value node.
    expect(within(row).getByText("$200.00")).toBeInTheDocument();

    // The identity carries NO caption: a payee and its description are the row
    // itself rather than one of its figures, and the header key they would
    // reuse is the one the sort chip above already shows.
    const identity = row.querySelectorAll("td")[1];
    expect(identity.querySelector("span.sm\\:hidden")).toBeNull();
    expect(identity.textContent).toBe("Corner Store");
  });

  it("associates every caption with the column header of the cell it sits in", async () => {
    const container = await renderTable();

    // Under mechanism A the DOM order is STILL the column order -- the grid
    // only paints -- so a swapped `<td>` would transpose two desktop columns
    // while every placement string below stayed correct. Read the association
    // rather than the placement: the Nth cell's caption is the Nth column
    // header's label.
    const headerLabels = Array.from(
      container.querySelectorAll("thead tr")[1].querySelectorAll("th"),
    ).map((th) => stripGlyph(th.textContent));
    expect(headerLabels).toEqual(EXPECTED_LABELS);

    for (const row of bodyRows(container)) {
      const cells = Array.from(row.querySelectorAll("td"));
      cells.forEach((cell, i) => {
        const caption = cell.querySelector("span.sm\\:hidden")?.textContent ?? null;
        expect(caption).toBe(i === 1 ? null : headerLabels[i]);
      });
    }
  });

  it("places every cell on the phone grid explicitly, on two lines", async () => {
    const container = await renderTable();

    const placement = (cell: Element) => {
      const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
      const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
      return `c${col}/r${row}`;
    };
    for (const row of bodyRows(container)) {
      expect(row.className).toContain("grid grid-cols-2");
      const cells = Array.from(row.querySelectorAll("td"));
      expect(cells).toHaveLength(4);
      for (const cell of cells) {
        // Auto-flow placement is not deterministic once a cell is added or
        // made conditional, so each cell states its own column and line.
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
        // Nothing spans, and nothing falls onto a third line.
        expect(cell.className).not.toMatch(/\bcol-span-\d\b/);
        expect(cell.className).not.toMatch(/\brow-start-[3-9]\b/);
      }
      const [date, identity, account, amount] = cells;
      // Line 1 is what the row IS beside what it was; line 2 is which ledger
      // it sits in beside when it happened.
      expect(placement(identity)).toBe("c1/r1");
      expect(placement(amount)).toBe("c2/r1");
      expect(placement(account)).toBe("c1/r2");
      expect(placement(date)).toBe("c2/r2");
    }
  });

  it("never wraps the figure or the date, and lets both text columns wrap", async () => {
    const container = await renderTable();

    for (const row of bodyRows(container)) {
      const [date, identity, account, amount] = Array.from(row.querySelectorAll("td"));

      // A locale grouping thousands with a space would otherwise break a figure
      // in the middle, and a date is one label -- both already carry the nowrap
      // at every width today.
      for (const cell of [date, amount]) {
        expect(cell.className).toContain("whitespace-nowrap");
        expect(cell.className).toContain("text-xs");
        expect(cell.className).toContain("sm:text-sm");
      }
      // The amount is right-aligned at every width, as it is today; the date is
      // LEFT-aligned from `sm` up on this table, so its phone alignment is
      // scoped and the desktop is untouched.
      expect(amount.className).toContain("text-right");
      expect(date.className).toContain("max-sm:text-right");
      expect(date.className).not.toMatch(/(^|\s)text-right\b/);

      // Both text columns are unbounded in the payload, so each may be narrower
      // than its own content inside a `minmax(0,1fr)` track, and a word too long
      // for the track breaks rather than setting the table's minimum width.
      for (const cell of [identity, account]) {
        expect(cell.className).toContain("min-w-0");
        expect(cell.className).toContain("break-words");
        expect(cell.className).toContain("sm:break-normal");
        // Not clamped: a clamp would cut the tail of a name no other surface
        // shows in full.
        expect(cell.className).not.toMatch(/line-clamp-\d/);
      }
      // The account keeps today's nowrap ONLY from `sm` up: a 40-character
      // account name held nowrap on a phone would set a minimum width no track
      // could hold.
      expect(account.className).toContain("sm:whitespace-nowrap");
      expect(account.className).not.toMatch(/(^|\s)whitespace-nowrap\b/);
    }
  });

  it("keeps the description truncating from sm up and wrapping below it", async () => {
    const container = await renderTable();

    const identity = txRow(container, "Westside Hardware")!.querySelectorAll("td")[1];
    const description = identity.querySelectorAll("div")[1];
    expect(description.textContent).toBe("Contactless card purchase, terminal 4471");
    // The desktop cap and ellipsis are unchanged; below `sm` the description
    // wraps instead, because where a row has no payee it is the only thing
    // naming the transaction -- and it is the search term the row's own click
    // sends.
    expect(description.className).toContain("sm:truncate");
    expect(description.className).toContain("sm:max-w-xs");
    expect(description.className).not.toMatch(/(^|\s)truncate\b/);
    expect(description.className).not.toMatch(/(^|\s)max-w-xs\b/);
  });

  it("keeps the row a table row from sm up and a grid below it", async () => {
    const container = await renderTable();

    const table = container.querySelector("table")!;
    expect(table.className).toContain("block");
    expect(table.className).toContain("sm:table");
    expect(container.querySelector("thead")?.className).toContain("sm:table-header-group");
    expect(container.querySelector("tbody")?.className).toContain("sm:table-row-group");
    const row = container.querySelector("tbody tr");
    expect(row?.className).toContain("grid grid-cols-2");
    expect(row?.className).toContain("sm:table-row");
    // The wrapper still scrolls horizontally, which is what the table needs
    // from `sm` up on a narrow desktop window.
    expect(table.parentElement?.className).toContain("overflow-x-auto");
  });

  it("restores this table's own cell padding and emphasis from sm up", async () => {
    const container = await renderTable();

    for (const row of bodyRows(container)) {
      expect(row.className).toContain("px-4 py-3");
      const cells = Array.from(row.querySelectorAll("td"));
      for (const cell of cells) {
        expect(cell.className).toContain("p-0");
        expect(cell.className).toContain("sm:px-4");
        expect(cell.className).toContain("sm:py-3");
        expect(cell.className).toContain("sm:table-cell");
      }
      // The amount keeps the emphasis and the sign colouring it draws today.
      const amount = cells[3];
      expect(amount.className).toContain("font-medium");
      expect(amount.className).toContain(
        row.textContent?.includes("Corner Store") ? "text-green-600" : "text-red-600",
      );
    }
    for (const th of Array.from(
      container.querySelectorAll("thead tr")[1].querySelectorAll("th"),
    )) {
      expect(th.className).toContain("px-4 py-3");
    }
  });

  it("restores the table semantics a phone restyle strips", async () => {
    const container = await renderTable();

    const table = container.querySelector("table")!;
    expect(table.getAttribute("role")).toBe("table");
    for (const group of ["thead", "tbody"]) {
      expect(container.querySelector(group)?.getAttribute("role")).toBe("rowgroup");
    }
    for (const row of Array.from(table.querySelectorAll("tr"))) {
      expect(row.getAttribute("role")).toBe("row");
    }
    // EVERY `<td>`, including the ones whose className is a template literal.
    for (const cell of Array.from(table.querySelectorAll("td"))) {
      expect(cell.getAttribute("role")).toBe("cell");
    }
    // `SortableHeader` restates `columnheader` on the `<th>` it renders, so
    // both header rows already carry it.
    for (const th of Array.from(table.querySelectorAll("th"))) {
      expect(th.getAttribute("role")).toBe("columnheader");
    }
  });

  it("navigates from the wrapped row to the register, filters and all", async () => {
    const container = await renderTable();

    const row = txRow(container, "Westside Hardware")!;
    expect(row.className).toContain("cursor-pointer");
    // The row hover is the pair this table already draws; the card is a layout,
    // not a second affordance.
    expect(row.className).toContain("hover:bg-gray-50");
    await act(async () => {
      fireEvent.click(row);
    });
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?categoryIds=uncategorized&accountIds=acc-z&search=Westside+Hardware+%26+Garden+Supply",
    );

    // A click landing on a captioned value cell is still a click on the row --
    // the whole row is the target, not the identity.
    mockPush.mockClear();
    await act(async () => {
      fireEvent.click(row.querySelectorAll("td")[3]);
    });
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?categoryIds=uncategorized&accountIds=acc-z&search=Westside+Hardware+%26+Garden+Supply",
    );
  });

  it("renders the unknown payee and unknown account fallbacks, and navigates without a search term", async () => {
    const container = await renderTable();

    const row = txRow(container, "Unknown")!;
    const cells = Array.from(row.querySelectorAll("td"));
    // The identity falls back to the unknown-payee string and renders no
    // description line at all; the account falls back beside its caption.
    expect(cells[1].textContent).toBe("Unknown");
    expect(cells[1].querySelectorAll("div")).toHaveLength(1);
    expect(cells[2].textContent).toBe("AccountUnknown");

    await act(async () => {
      fireEvent.click(row);
    });
    // No payee and no description means no search term -- the fallback string
    // is a label, never a filter.
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?categoryIds=uncategorized&accountIds=acc-u",
    );
  });

  it("keeps the 100-row cap and the footer that explains it", async () => {
    const transactions = Array.from({ length: 105 }, (_, i) => ({
      id: `tx-${i}`,
      transactionDate: "2025-02-15",
      payeeName: `Payee ${i}`,
      description: "",
      accountName: "Chequing",
      accountId: "acc-1",
      amount: -10,
    }));
    const container = await renderTable({
      transactions,
      summary: {
        totalCount: 105,
        expenseCount: 105,
        expenseTotal: 1050,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });

    // The cap is on the rows the table draws, not on what the report counted.
    expect(bodyRows(container)).toHaveLength(100);
    expect(
      screen.getByText(/Showing first 100 of 105 transactions/),
    ).toBeInTheDocument();
    // Every drawn row is a wrapped row: the cap does not skip the layout.
    for (const row of bodyRows(container)) {
      expect(row.className).toContain("grid grid-cols-2");
      expect(row.querySelectorAll("td")).toHaveLength(4);
    }
  });
});
