import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent, act, within } from "@/test/render";
import { InvestmentTransactionHistoryReport } from "./InvestmentTransactionHistoryReport";

/**
 * The phone layout of the Investment Transaction History table.
 *
 * The table is ONE tree restyled by CSS (mechanism A): below `sm` the rows wrap
 * into a two-column, four-line grid and the column header row is replaced by a
 * strip of sort chips, from `sm` up it is the ordinary table. jsdom applies no
 * media queries, so both header rows, the Account cell and every phone caption
 * are in the DOM here at all times -- which is what lets these assertions read
 * the phone markup without emulating a viewport, and why a sort control is
 * addressed by position rather than by label (each label matches the phone
 * strip, the column header row, and -- for the five captioned columns -- a
 * caption in every row).
 *
 * The Account column is the one place this card shows MORE than the tier table:
 * its header and its cell are `hidden md:table-cell` today, so no phone and no
 * tablet has ever seen it, while `account` is a persisted sort field. The class
 * SHAPE is therefore asserted rather than a rendered width -- what a class
 * resolves to at 700px is the Chromium replica's job, not jsdom's.
 */

// One router for the run, and the module's other exports beside it: a factory
// returning a fresh object per call re-creates every `useCallback([router])`
// each render, and a factory naming one export blanks the rest of the module
// for the whole graph under test. This report reads neither today; the mock is
// here so "the rows are inert" is a behaviour claim rather than an assertion
// about an attribute React never writes.
const mockPush = vi.fn();
vi.mock("next/navigation", () => {
  const router = { push: mockPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
  return {
    useRouter: () => router,
    usePathname: () => "/reports/investment-transactions",
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
  useNumberFormat: () => ({
    ...numberFormatMockDefaults(),
    formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    defaultCurrency: "CAD",
  }),
  };
});

vi.mock("@/hooks/useExchangeRates", () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number, _currency: string) => amount,
    defaultCurrency: "CAD",
  }),
}));

const stableResolvedRange = { start: "2025-01-01", end: "2026-01-01" };
vi.mock("@/hooks/useDateRange", () => ({
  useDateRange: () => ({
    dateRange: "1y",
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

const mockGetTransactions = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
vi.mock("@/lib/investments", () => ({
  investmentsApi: {
    getTransactions: (...args: any[]) => mockGetTransactions(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
  },
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const mockExportToCsv = vi.fn();
vi.mock("@/lib/csv-export", () => ({
  exportToCsv: (...args: any[]) => mockExportToCsv(...args),
}));

/**
 * Three rows on two accounts, chosen so the stored default sort (date,
 * descending) and an ascending sort by Account disagree -- otherwise a tap on
 * the phone strip could re-sort and leave the rows in the order they were
 * already in.
 *
 * The third carries the three absences this table has to render captioned: a
 * row with no security at all (the symbol falls back to `-`) and neither a
 * quantity nor a price, which is what a DIVIDEND on an unnamed holding looks
 * like.
 */
const TRANSACTIONS = [
  {
    id: "tx-early",
    transactionDate: "2025-01-05",
    action: "BUY",
    totalAmount: 5000,
    quantity: 50,
    price: 100,
    accountId: "acc-z",
    security: { symbol: "VWCE.DE", name: "Vanguard FTSE All-World UCITS ETF" },
  },
  {
    id: "tx-late",
    transactionDate: "2025-11-20",
    action: "SELL",
    totalAmount: -3000,
    quantity: -30,
    price: 100,
    accountId: "acc-a",
    security: { symbol: "MSFT", name: "Microsoft Corp." },
  },
  {
    id: "tx-bare",
    transactionDate: "2025-06-10",
    action: "DIVIDEND",
    totalAmount: 42,
    quantity: null,
    price: null,
    accountId: "acc-z",
    security: null,
  },
];

const ACCOUNTS = [
  { id: "acc-z", name: "Zeta Brokerage", currencyCode: "CAD", accountSubType: "INVESTMENT_BROKERAGE" },
  { id: "acc-a", name: "Alpha RRSP", currencyCode: "CAD", accountSubType: "INVESTMENT_BROKERAGE" },
];

/** The column order, which is also the `<td>` order in every row. */
const EXPECTED_LABELS = [
  "Date",
  "Action",
  "Security",
  "Account",
  "Quantity",
  "Price",
  "Total",
];

/** The index of each column in that order, for addressing a cell. */
const COL = {
  date: 0,
  action: 1,
  security: 2,
  account: 3,
  quantity: 4,
  price: 5,
  total: 6,
} as const;

const stripGlyph = (text: string | null | undefined) =>
  (text ?? "").replace(/[↑↓↕]/g, "").trim();

async function renderTable(transactions: unknown[] = TRANSACTIONS) {
  mockGetTransactions.mockResolvedValue({
    data: transactions,
    pagination: { hasMore: false },
  });
  mockGetInvestmentAccounts.mockResolvedValue(ACCOUNTS);
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<InvestmentTransactionHistoryReport />));
  });
  await waitFor(() => expect(container.querySelector("table")).toBeInTheDocument());
  return container;
}

const bodyRows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr"));

const cellsOf = (row: Element) => Array.from(row.querySelectorAll("td"));

const txRow = (container: HTMLElement, name: string) =>
  bodyRows(container).find((r) => r.textContent?.includes(name));

/** The identity cell of every body row, in render order. */
const order = (container: HTMLElement) =>
  bodyRows(container).map((r) => cellsOf(r)[COL.security]?.textContent);

const headerRows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("thead tr"));

describe("InvestmentTransactionHistoryReport (phone wrapped rows)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    // The sort is persisted, so a tap in one test would otherwise decide the
    // starting order of the next.
    localStorage.clear();
  });

  it("builds both header rows from one record of all seven sort fields", async () => {
    const container = await renderTable();

    const rows = headerRows(container);
    expect(rows).toHaveLength(2);
    const [phoneRow, columnRow] = rows;
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
    const cellCount = cellsOf(bodyRows(container)[0]).length;
    expect(cellCount).toBe(7);
    expect(phoneRow.querySelectorAll("th")).toHaveLength(cellCount);
    expect(columnRow.querySelectorAll("th")).toHaveLength(cellCount);
  });

  it("offers the Account sort chip on the phone strip, where its column header cannot be seen", async () => {
    const container = await renderTable();

    const [phoneRow, columnRow] = headerRows(container);
    const accountChip = phoneRow.querySelectorAll("th")[COL.account];
    const accountHeader = columnRow.querySelectorAll("th")[COL.account];
    expect(stripGlyph(accountChip.textContent)).toBe("Account");

    // The column header keeps exactly today's tier visibility -- hidden until
    // `md`, so a tablet never sees it either. The chip carries no such class,
    // which is the whole point: `account` is a persisted sort field.
    expect(accountHeader.className).toContain("hidden");
    expect(accountHeader.className).toContain("md:table-cell");
    expect(accountChip.className).not.toMatch(/\bhidden\b/);
    expect(accountChip.className).not.toMatch(/md:table-cell/);
  });

  it("returns the Account header and the Account values at the SAME breakpoint", async () => {
    const container = await renderTable();

    // The two halves of one column's tier are two class strings; a header that
    // came back at `lg` over values that came back at `md` would be a column of
    // unlabelled account names, and nothing about either string alone can see
    // it. Both are declared on one record entry -- assert they agree.
    const tierOf = (el: Element) =>
      /\b(sm|md|lg|xl|2xl):table-cell\b/.exec(el.className)?.[1] ?? null;

    const accountHeader = headerRows(container)[1].querySelectorAll("th")[COL.account];
    expect(tierOf(accountHeader)).toBe("md");
    for (const row of bodyRows(container)) {
      expect(tierOf(cellsOf(row)[COL.account])).toBe(tierOf(accountHeader));
    }
    // Every other column returns at `sm`, so the tier really is this column's.
    for (const row of bodyRows(container)) {
      cellsOf(row).forEach((cell, i) => {
        if (i !== COL.account) expect(tierOf(cell)).toBe("sm");
      });
    }
  });

  it("carries the account value on EVERY row, visible below sm and hidden until md above it", async () => {
    const container = await renderTable();

    const expected: Record<string, string> = {
      "VWCE.DE": "Zeta Brokerage",
      MSFT: "Alpha RRSP",
      "-": "Zeta Brokerage",
    };
    for (const row of bodyRows(container)) {
      const cells = cellsOf(row);
      const symbol = cells[COL.security].querySelectorAll("div")[0].textContent!;
      const account = cells[COL.account];
      // The value is IN the DOM on every row, beside its caption.
      expect(account.textContent).toBe(`Account${expected[symbol]}`);
      // Below `sm` it is a visible grid item: no unprefixed `hidden`, which
      // would win over the placement and delete the cell from the wrap.
      expect(account.className).not.toMatch(/(^|\s)hidden(\s|$)/);
      // From `sm` up it resolves to today's `hidden md:table-cell` -- `sm:hidden`
      // at 640-767px, `md:table-cell` from 768px, and no `sm:table-cell` that
      // would beat the first of those inside the same media query.
      expect(account.className).toContain("sm:hidden");
      expect(account.className).toContain("md:table-cell");
      expect(account.className).not.toMatch(/\bsm:table-cell\b/);
    }
  });

  it("sorts from the phone strip, which the column header row cannot do on a phone", async () => {
    const container = await renderTable();

    // The stored default is date, descending.
    expect(order(container)).toEqual([
      "MSFTMicrosoft Corp.",
      "-",
      "VWCE.DEVanguard FTSE All-World UCITS ETF",
    ]);

    // "Account" is the fourth of the seven controls in the phone strip.
    // Addressed by position: the label also names the column header and the
    // caption of a cell in every row.
    const phoneAccount = headerRows(container)[0].querySelectorAll("th")[COL.account];
    await act(async () => {
      fireEvent.click(phoneAccount);
    });
    // Ascending by account name: Alpha before Zeta, and the two Zeta rows keep
    // their relative order.
    expect(order(container)).toEqual([
      "MSFTMicrosoft Corp.",
      "VWCE.DEVanguard FTSE All-World UCITS ETF",
      "-",
    ]);
  });

  it("captions every figure and the date, and leaves the identity and the pill alone", async () => {
    const container = await renderTable();

    const row = txRow(container, "VWCE.DE")!;
    // Each caption sits immediately beside the value it names, as its own text
    // node, so a `getByText` on the value still matches the value node.
    expect(row.textContent).toContain("DateJan 5, 2025");
    expect(row.textContent).toContain("AccountZeta Brokerage");
    expect(row.textContent).toContain("Quantity50.0000");
    expect(row.textContent).toContain("Price$100.00");
    expect(row.textContent).toContain("Total$5000.00");
    // Scoped to the row: the summary cards above print the same figures.
    expect(within(row).getByText("$5000.00")).toBeInTheDocument();

    const cells = cellsOf(row);
    // The identity carries NO caption: a ticker and its name are the row itself
    // rather than one of its figures.
    expect(cells[COL.security].querySelector("span.sm\\:hidden")).toBeNull();
    expect(cells[COL.security].textContent).toBe("VWCE.DEVanguard FTSE All-World UCITS ETF");
    // Nor does the action pill, which is self-describing.
    expect(cells[COL.action].querySelector("span.sm\\:hidden")).toBeNull();
    expect(cells[COL.action].textContent).toBe("Buy");
  });

  it("associates every caption with the column header of the cell it sits in", async () => {
    const container = await renderTable();

    // Under mechanism A the DOM order is STILL the column order -- the grid
    // only paints -- so a swapped `<td>` would transpose two desktop columns
    // while every placement string below stayed correct. Read the association
    // rather than the placement: the Nth cell's caption is the Nth column
    // header's label.
    const headerLabels = Array.from(
      headerRows(container)[1].querySelectorAll("th"),
    ).map((th) => stripGlyph(th.textContent));
    expect(headerLabels).toEqual(EXPECTED_LABELS);

    const uncaptioned = new Set<number>([COL.action, COL.security]);
    for (const row of bodyRows(container)) {
      cellsOf(row).forEach((cell, i) => {
        const caption = cell.querySelector("span.sm\\:hidden")?.textContent ?? null;
        expect(caption).toBe(uncaptioned.has(i) ? null : headerLabels[i]);
      });
    }
  });

  it("places every cell on the phone grid explicitly, on four lines, with the pill spanning", async () => {
    const container = await renderTable();

    const placement = (cell: Element) => {
      const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
      const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
      return `c${col}/r${row}`;
    };
    for (const row of bodyRows(container)) {
      expect(row.className).toContain("grid grid-cols-2");
      const cells = cellsOf(row);
      expect(cells).toHaveLength(7);
      for (const cell of cells) {
        // Auto-flow placement is not deterministic once a cell is added or made
        // conditional, so each cell states its own column and line.
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
        // Nothing falls onto a fifth line.
        expect(cell.className).not.toMatch(/\brow-start-[5-9]\b/);
      }
      // Line 1 is what the row IS beside what it cost; line 2 which ledger it
      // sits in beside the unit price; line 3 what happened, across both
      // tracks; line 4 how many, and when.
      expect(placement(cells[COL.security])).toBe("c1/r1");
      expect(placement(cells[COL.total])).toBe("c2/r1");
      expect(placement(cells[COL.account])).toBe("c1/r2");
      expect(placement(cells[COL.price])).toBe("c2/r2");
      expect(placement(cells[COL.action])).toBe("c1/r3");
      expect(placement(cells[COL.quantity])).toBe("c1/r4");
      expect(placement(cells[COL.date])).toBe("c2/r4");
      // The pill is the ONLY spanning cell: its longest catalogue labels are
      // 41-49 characters, which stack 52-116px tall in one 122px track.
      expect(cells[COL.action].className).toContain("col-span-2");
      cells.forEach((cell, i) => {
        if (i !== COL.action) expect(cell.className).not.toMatch(/\bcol-span-\d\b/);
      });
    }
  });

  it("never wraps a figure or the date, and lets both text columns wrap", async () => {
    const container = await renderTable();

    for (const row of bodyRows(container)) {
      const cells = cellsOf(row);

      // A locale grouping thousands with a space would otherwise break a figure
      // in the middle, and a date is one label.
      for (const i of [COL.date, COL.quantity, COL.price, COL.total]) {
        expect(cells[i].className).toContain("whitespace-nowrap");
        expect(cells[i].className).toContain("text-xs");
        expect(cells[i].className).toContain("sm:text-sm");
      }
      // The three figures are right-aligned at every width, as they are today;
      // the date is LEFT-aligned from `sm` up on this table, so its phone
      // alignment is scoped and the desktop is untouched.
      for (const i of [COL.quantity, COL.price, COL.total]) {
        expect(cells[i].className).toContain("text-right");
      }
      expect(cells[COL.date].className).toContain("max-sm:text-right");
      expect(cells[COL.date].className).not.toMatch(/(^|\s)text-right\b/);

      // Both text columns are unbounded in the payload, so each may be narrower
      // than its own content inside a `minmax(0,1fr)` track, and a word too long
      // for the track breaks rather than setting the table's minimum width.
      for (const i of [COL.security, COL.account]) {
        expect(cells[i].className).toContain("min-w-0");
        expect(cells[i].className).toContain("break-words");
        expect(cells[i].className).toContain("sm:break-normal");
        // Not clamped: a clamp would cut the tail of a name no other surface
        // shows in full.
        expect(cells[i].className).not.toMatch(/line-clamp-\d/);
      }
      // The pill's cell is a grid item too, so it needs the zero minimum even
      // though the pill itself is an atomic inline-flex box.
      expect(cells[COL.action].className).toContain("min-w-0");
    }
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
      const cells = cellsOf(row);
      for (const cell of cells) {
        expect(cell.className).toContain("p-0");
        expect(cell.className).toContain("sm:px-4");
        expect(cell.className).toContain("sm:py-3");
      }
      // Every cell but the Account one restores `table-cell` at `sm`; Account
      // restores it at `md`, which is what it does today.
      cells.forEach((cell, i) => {
        expect(cell.className).toContain(
          i === COL.account ? "md:table-cell" : "sm:table-cell",
        );
      });
      // The total keeps the emphasis it draws today.
      expect(cells[COL.total].className).toContain("font-medium");
    }
    for (const th of Array.from(headerRows(container)[1].querySelectorAll("th"))) {
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

  it("leaves the rows inert -- the card is a layout, not a new affordance", async () => {
    const container = await renderTable();

    for (const row of bodyRows(container)) {
      // "Rows are not clickable" is a behaviour claim, so click each one and
      // each of its cells against the router mock rather than asserting on an
      // attribute React never writes.
      await act(async () => {
        fireEvent.click(row);
      });
      for (const cell of cellsOf(row)) {
        await act(async () => {
          fireEvent.click(cell);
        });
      }
      expect(row.className).not.toContain("cursor-pointer");
    }
    expect(mockPush).not.toHaveBeenCalled();
    // The row hover is the pair this table already draws, and it stays: the two
    // layouts of one table hover alike.
    expect(bodyRows(container)[0].className).toContain("hover:bg-gray-50");
  });

  it("keeps the dash markers for a row with no security, quantity or price", async () => {
    const container = await renderTable();

    const row = bodyRows(container).find((r) => r.textContent?.includes("Dividend"))!;
    const cells = cellsOf(row);
    // The symbol falls back to a bare dash and renders no name line at all.
    expect(cells[COL.security].textContent).toBe("-");
    expect(cells[COL.security].querySelectorAll("div")).toHaveLength(1);
    // The two absent figures keep their dash BESIDE the caption, so a reader
    // with no column header still knows which figure is missing.
    expect(cells[COL.quantity].textContent).toBe("Quantity-");
    expect(cells[COL.price].textContent).toBe("Price-");
    // The total is present, and the account still names the ledger.
    expect(cells[COL.total].textContent).toBe("Total$42.00");
    expect(cells[COL.account].textContent).toBe("AccountZeta Brokerage");
  });

  it("exports its headings and its cells from the same ordered record", async () => {
    // This case lives with the phone layout because the column record is what
    // that layout introduced: the export used to hold its headings and its
    // cells as two adjacent literals, and now derives both from the record the
    // two header rows and the captions are built from. A reorder there -- the
    // natural edit, since the record drives the header rows -- would otherwise
    // move every heading and leave the cells behind, shipping a spreadsheet
    // with "Price" over the quantity column and nothing to catch it.
    const container = await renderTable();

    fireEvent.click(within(container).getByTitle("Export report"));
    await act(async () => {
      fireEvent.click(within(container).getByText("CSV"));
    });

    expect(mockExportToCsv).toHaveBeenCalledTimes(1);
    const [filename, headers, rows] = mockExportToCsv.mock.calls[0];
    expect(filename).toBe("investment-transactions");
    expect(headers).toEqual(EXPECTED_LABELS);
    // Rows follow the table's own sort (date, descending), and each cell sits
    // under the heading that names it.
    expect(rows).toHaveLength(3);
    const [first] = rows;
    expect(first[COL.date]).toBe("2025-11-20");
    expect(first[COL.action]).toBe("Sell");
    expect(first[COL.security]).toBe("MSFT");
    expect(first[COL.account]).toBe("Alpha RRSP");
    // Quantity and Total reach the CSV through `Math.abs`, which makes them
    // numbers whatever the payload holds. Price is passed through exactly as
    // the row holds it, as it is today -- and a `decimal(20,4)` price crosses
    // the wire as the STRING `"100.0000"` however `InvestmentTransaction`
    // declares it, so that cell is a number here only because the fixture
    // follows the declared type. The CSV writer's numeric test accepts either
    // form, so nothing is mis-escaped; the shape gap is pre-existing and is
    // reported rather than changed inside a layout conversion.
    expect(first[COL.quantity]).toBe(30);
    expect(first[COL.price]).toBe(100);
    expect(first[COL.total]).toBe(3000);
    // The bare row's absent figures stay empty rather than becoming a dash: a
    // dash in a numeric column is text, and a missing quantity is not a value.
    const bare = rows.find((r: unknown[]) => r[COL.security] === "-")!;
    expect(bare[COL.quantity]).toBe("");
    expect(bare[COL.price]).toBe("");
  });

  it("renders an unnamed account as a dash rather than an empty captioned cell", async () => {
    const container = await renderTable([
      { ...TRANSACTIONS[0], accountId: "acc-unknown" },
    ]);

    const cells = cellsOf(bodyRows(container)[0]);
    expect(cells[COL.account].textContent).toBe("Account-");
  });
});
