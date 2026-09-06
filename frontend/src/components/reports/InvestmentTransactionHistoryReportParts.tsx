/**
 * Presentational parts of the Investment Transaction History table, split out
 * of `InvestmentTransactionHistoryReport.tsx` to keep that file under the
 * repository's 800-line ceiling. Everything here is fingerprint-free (no card
 * trio, no row-hover pair, no divide string, no pill trio) -- the classes that
 * carry a `ui-conventions` baseline stay in the component file, because those
 * baselines are keyed per file.
 */
import { InvestmentAction, InvestmentTransaction } from '@/types/investment';

export type InvestmentTxSortField = 'date' | 'action' | 'security' | 'account' | 'quantity' | 'price' | 'total';

/**
 * One sortable column of the transaction table. The seven are declared once and
 * rendered by BOTH header rows -- the column header row (from `sm` up) and the
 * phone sort strip -- so the two can never list different fields, each captioned
 * value cell takes its phone caption from the same entry as its header, and the
 * CSV / PDF export builds its headings from that same ordered record.
 */
export interface SortColumn {
  field: InvestmentTxSortField;
  label: string;
  /** How the column header aligns from `sm` up; the cells restate it. */
  align?: 'right' | 'center';
  /**
   * The tier this column belongs to, spelled for BOTH of its halves here so
   * they cannot drift -- a header that returns at one breakpoint over values
   * that return at another is a column of unlabelled figures. Account is the
   * only column with a tier today: its header keeps the `hidden md:table-cell`
   * it wears now (the phone strip still offers its sort chip), and its value
   * cell is a visible grid item below `sm`, hidden from `sm` and back at `md`.
   *
   * Two literals rather than one interpolated breakpoint because Tailwind
   * extracts class names from the source TEXT: a class name built at runtime
   * emits no CSS at all.
   */
  headerClass?: string;
  cellClass?: string;
  /**
   * This column's cell in the CSV / PDF export, beside the heading the export
   * takes from `label`. The two live on ONE entry deliberately: with the
   * headings derived from the record and the cells written out as a separate
   * ordered literal, reordering the record -- the natural edit, since it drives
   * both header rows -- would move every heading and leave the cells where they
   * were, shipping a spreadsheet with "Price" over the quantity column. Here a
   * reorder moves both halves together. `formatted` is the PDF's rendering (the
   * CSV writes raw numbers, which is what makes them numbers in a spreadsheet).
   */
  csvValue: (tx: InvestmentTransaction, formatted: boolean) => string | number;
}

/**
 * The record the two header rows are built from, keyed by sort field.
 *
 * The key is tied to the entry's own `field`, which a plain
 * `Record<InvestmentTxSortField, SortColumn>` does not do: that forces an entry
 * to EXIST for every member of the union but lets it name a different one, so
 * `price: { field: 'total', ... }` would type-check. Both header rows would then
 * render two controls keyed `total` (a duplicate React key), tapping "Price"
 * would sort by Total, and "Price" would be unsortable -- none of which a test
 * comparing header LABELS can see, because the labels stay right. Here it is a
 * compile error instead.
 */
export type SortColumnsByField = {
  [K in InvestmentTxSortField]: SortColumn & { field: K };
};

// Today's header cell, unchanged.
export const HEADER_CLASS = 'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase';

// The same sort controls in the phone strip: a wrapped row of compact chips.
// Column alignment means nothing there -- the column header row is hidden and
// each data row is a grid -- so every control is left-aligned and self-naming.
// The border is what says "tappable": there is no hover on a touch screen, and
// the chip's own fill is a shade off the header band it sits on (this table's
// `<thead>` keeps its `bg-gray-50` / `dark:bg-gray-900/50`). The class is kept
// identical to the sibling report tables that ship this strip; the copies are
// one of the duplications the converted-table consolidation pass folds into one
// home -- `components/ui/` is not this change's to edit.
//
// Seven chips. Measured on the Chromium replica at 320px they wrap to four
// lines in `en`/`pl`/`de`, five in `ru`/`id` and seven in the pseudo-locale
// above the first row; at 390px, three lines in every real locale. That is a
// measured cost, not a reason to drop a control:
// `reports.investment-transactions.sort` persists any of the seven, so a field
// with no control anywhere would leave a phone POINTING at a sort with no
// pointer back -- and Account is exactly that field today, offered by a column
// header that no phone and no tablet can see.
export const PHONE_HEADER_CLASS =
  'rounded border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 uppercase';

// A figure cell inside a wrapped row: no padding of its own below `sm` and this
// table's own `px-4 py-3` from `sm` up. Smaller type on phones so a seven-figure
// 2dp amount still fits half the width.
//
// `whitespace-nowrap` is the ONE property here that changes the desktop
// rendering (`text-right` is unprefixed too, and must be -- it is the alignment
// these three columns already have at every width). The nowrap is deliberate: a
// locale that groups thousands with a space (`1 234 567,89 CHF`) could otherwise
// break a figure in the middle, which is what this table does today. Measured on
// the replica at 700px and 800px, the rendering is pixel-identical to today in
// `pl`/`ru`/`id`/`de`/`xx` once that one difference is neutralised, and differs
// only by it when it is on. A figure cut in half is worse.
//
// The budget was measured on a hand-written CSS replica in Chromium at the
// insets this table really gets -- the report page's `px-4` and the cell's own
// `px-4`, the card contributing NONE (it is `overflow-hidden` with a heading row
// above the table and no padding of its own) -- so 256px of content at 320px and
// 326px at 390px. Two EQUAL `minmax(0,1fr)` tracks, resolved off
// `getComputedStyle`: 122px each at 320px and 157px each at 390px. Equal tracks
// rather than an `auto` one for the identity because each `<tr>` is its OWN
// grid, so an `auto` track sized by one row's content would land at a different
// width in the next row and step the figure column left and right down the card.
//
// The formatter is `fmtValue`, and its worst case is not a symbol: it calls
// `formatCurrency` (2dp, `narrowSymbol`, which falls back to the three-letter
// ISO code where a currency has none) and then, for a single account whose
// currency is not the reader's default, appends that ISO code AGAIN. So the
// widest unit the column can print is CHF twice over. Measured at `text-xs`,
// space-grouped: six figures `123 456,78 CHF CHF` 125px, seven
// `1 234 567,89 CHF CHF` 136px, eight 144px, nine 152px -- against a 122px track
// plus the row's own 16px right padding, which a right-track figure spends
// before it can reopen the wrapper's sideways scroll. So seven figures is the
// measured ceiling at 320px in the doubled form (14px of the 16px padding, 2px
// to spare) and eight is the first past it (measured: the wrapper goes 294/288).
// In the ordinary single-code form eight figures (116px) is still inside the
// track. At 390px (157px tracks) nine figures fit inside the track itself.
// Quantity is `toFixed(4)`: `12345.6789` is 73px, `1234567.8912` 88px.
//
// THREE tracks were rejected on the same measurement: a third of the same box is
// 77px at 320px, which even a six-figure 125px amount overflows by 48px -- past
// the row padding and into the wrapper's scroll -- in every locale and for all
// three figure cells. Two tracks, and therefore four lines for seven columns, is
// what this box can hold.
export const MONEY_CELL = 'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

// The date is a fixed-shape label, not a number: `format(..., 'MMM d, yyyy')`
// renders `Dec 25, 2025` (80px at `text-xs`). It keeps the `whitespace-nowrap`
// it wears today, because a date is one label and breaking it after `Dec` reads
// as two values, and it is spelled out rather than aliased to `MONEY_CELL`
// deliberately: the two hold nearly the same string for different reasons, and
// an alias would carry a money-driven edit (a wider type for a longer figure)
// silently onto the date. The one difference is the alignment -- this table's
// Date column is LEFT-aligned from `sm` up, unlike its three figure columns, so
// the phone's right alignment inside the right-hand track is scoped `max-sm:`
// and the desktop is untouched.
export const DATE_CELL = 'p-0 text-xs whitespace-nowrap max-sm:text-right sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

/** Every caption in a wrapped cell is phone-only. */
export const CAPTION_CLASS = 'sm:hidden';

export const ACTION_COLORS: Record<InvestmentAction, string> = {
  BUY: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  SELL: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  REDEEM: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  CAPITAL_GAIN_SHORT: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  CAPITAL_GAIN_LONG: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  REINVEST_INTEREST: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
  REINVEST_CAPITAL_GAIN_SHORT: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
  REINVEST_CAPITAL_GAIN_LONG: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
  DIVIDEND: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  INTEREST: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  CAPITAL_GAIN: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  SPLIT: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  TRANSFER_IN: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  TRANSFER_OUT: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  REINVEST: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
  ADD_SHARES: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300',
  REMOVE_SHARES: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
};
