/**
 * The transaction register's column contract: which columns exist, in what
 * order, and the width each becomes visible at.
 *
 * Before this file the visibility classes were hand-written per `<th>` and
 * `<td>`, and they drifted into incoherence: Status (which the user ranks
 * high) appeared last of all at 1400px, Attachments (ranked low) appeared
 * before Tags (ranked medium), and the Account column rendered on
 * single-account pages where every row repeats the page's own title. Writing
 * the order and the tiers once is what makes the register predictable; the
 * guard test beside this file fails any visibility class that does not come
 * from here.
 *
 * The tiers are **container queries, not viewport breakpoints**. The register
 * sits inside page padding (and, on some surfaces, a card), so the viewport
 * overstates the width the table actually has -- keyed off the viewport, the
 * low-tier columns appeared before the register could hold them, the table
 * overflowed its `overflow-x-auto` wrapper, and with Actions pinned sticky
 * right it was exactly the columns at the table's right end -- Status, ranked
 * high -- that scrolled out of sight while Description, ranked low, stayed on
 * screen. The wrapper carries `REGISTER_TABLE_CONTAINER` and every tier
 * measures that container, so "appears at 1536px" means 1536px of register.
 *
 * Rules the tiers do not express, stated here because they are part of the
 * same contract:
 *
 * - **Density never changes which columns exist.** Normal/Compact/Dense move
 *   padding and secondary content (`useTableDensity`), not columns -- a column
 *   set that changed with density would make the same window show different
 *   registers depending on a toggle about row height.
 *
 *   One deliberate exception, and it is about LAYOUT rather than the tiers: on
 *   a phone (`useIsMobile`, a 639px viewport query) at **Normal** density,
 *   `TransactionList` sets `TransactionRow`'s `wrapped` prop and the row
 *   renders as a two-line card in a single `<td>` instead of the tier cells --
 *   date, payee, amount, balance, category, status and account across two
 *   lines, and the row's tags on a third line of their own under the category
 *   when it has any, with description, ref #, attachments and the row actions
 *   omitted (the long-press action sheet already carries the actions). The
 *   full column header is replaced there by a slim control header that keeps
 *   the day/month date toggle and the select-all-on-page box, because the card
 *   labels its own values. Compact and Dense keep the tier table on a phone,
 *   and so do the foreign-currency fee surfaces (`showFxColumns`) at every
 *   level, since the card does not carry their paid-currency / amount / fee
 *   columns. Every non-phone width keeps it at all three levels. Column
 *   presence in the TIER TABLE is
 *   still never density-dependent: the exception swaps one layout for another,
 *   it does not add or remove a column from the table this file describes.
 * - **The Account column is structural, not responsive.** It renders only when
 *   the list spans more than one account (`!isSingleAccountView`); on a single
 *   account's page it is omitted from the DOM entirely, at every width. When
 *   it does render, it takes its tier below like any other column.
 * - **Description is the column that yields.** Its cells carry
 *   `REGISTER_DESCRIPTION_CELL_FLEX`, so it absorbs whatever width the other
 *   columns leave and shrinks -- down to nothing -- before the table can
 *   outgrow its container. A lower-ranked column appearing must squeeze
 *   itself, never scroll a higher-ranked one out of view; and once even a
 *   squeezed Description is not worth having, the low tier removes it and
 *   Ref # together.
 * - **Payee outranks Description for width.** Whenever Description is on
 *   screen the payee name is uncapped (`REGISTER_PAYEE_NAME_CAP`): the
 *   longest payee renders in full and Description gives the width back.
 *   The cap survives only below the low tier, where there is no Description
 *   to yield and an uncapped payee would push Amount and Balance into the
 *   horizontal scroll instead.
 * - **A yielding column takes the leftover, so the columns above it have to
 *   say what they need.** `w-full` does not mean "take what is spare": it is
 *   a claim on 100% of the table, and an auto-layout table settles that claim
 *   against the content columns *in proportion to their content*, scaling
 *   them below what they hold. So the width Description gets depends on how
 *   long the OTHER columns' content is, and filtering the register to one
 *   payee -- which shortens Payee, Category, Ref # and the amounts all at
 *   once -- handed Description the difference: on a 1710px register Payee
 *   went 270px -> 212px and Description 386px -> 517px, truncating the very
 *   payee that had just been filtered for while Description sat empty. Payee
 *   therefore declares a floor (`REGISTER_PAYEE_CELL_FLOOR`) and Description
 *   absorbs only what is left above it.
 */
export const REGISTER_COLUMN_ORDER = [
  'date',
  'account',
  'payee',
  'category',
  'description',
  'refNumber',
  'tags',
  'attachments',
  'amount',
  // The three FX columns are a feature set (`showFxColumns`), present only on
  // the account-detail Foreign Currency Transaction Fees section; when the
  // feature asks for them they are always visible, like Amount.
  'paidCurrency',
  'paidAmount',
  'feePaid',
  'balance',
  'status',
  'actions',
] as const;

export type RegisterColumnId = (typeof REGISTER_COLUMN_ORDER)[number];

/**
 * The visibility tiers, from the user-facing spec:
 *
 * - `always`: part of what a register *is* -- visible at every width.
 * - `high`, `medium`, `low`: appear as the window widens, in that order.
 * - `exceptPhones`: the Actions column -- everywhere but phone widths, where
 *   the long-press action sheet carries the same actions.
 */
export type RegisterColumnPriority =
  | 'always'
  | 'high'
  | 'medium'
  | 'low'
  | 'exceptPhones';

export const REGISTER_COLUMN_PRIORITY: Record<
  RegisterColumnId,
  RegisterColumnPriority
> = {
  date: 'always',
  account: 'high',
  payee: 'always',
  category: 'high',
  description: 'low',
  refNumber: 'low',
  tags: 'medium',
  attachments: 'low',
  amount: 'always',
  paidCurrency: 'always',
  paidAmount: 'always',
  feePaid: 'always',
  balance: 'always',
  status: 'high',
  actions: 'exceptPhones',
};

/**
 * One breakpoint per tier -- a `@min-[...]` container-query variant measured
 * against `REGISTER_TABLE_CONTAINER`, never a viewport breakpoint (the
 * viewport lies about the register's width by however much page padding
 * surrounds it). A tier maps to a class, never a column to a class, so two
 * columns of the same rank cannot appear at different widths.
 *
 * The 480px on Actions predates the tiers (it is where the action sheet
 * stops being the only way to act on a row); 900px is where the category
 * pills genuinely have room; 1280/1536 keep the old `xl`/`2xl` figures, now
 * honestly measured.
 */
const PRIORITY_VISIBILITY: Record<RegisterColumnPriority, string> = {
  always: '',
  high: 'hidden @min-[900px]:table-cell',
  medium: 'hidden @min-[1280px]:table-cell',
  low: 'hidden @min-[1536px]:table-cell',
  exceptPhones: 'hidden @min-[480px]:table-cell',
};

/**
 * The minimum *register* width, in px, at which each tier's columns render.
 * Exported for the guard test, which asserts the tiers appear in rank order
 * (high before medium before low) rather than trusting the class strings.
 */
export const PRIORITY_MIN_WIDTH_PX: Record<RegisterColumnPriority, number> = {
  always: 0,
  high: 900,
  medium: 1280,
  low: 1536,
  exceptPhones: 480,
};

/**
 * The responsive-visibility classes for a register column's `<th>` and `<td>`.
 * Empty string for an always-visible column, so call sites can interpolate it
 * unconditionally.
 */
export function registerColumnClass(id: RegisterColumnId): string {
  return PRIORITY_VISIBILITY[REGISTER_COLUMN_PRIORITY[id]];
}

/**
 * The class the register's scroll wrapper must carry so the tier classes have
 * a container to measure. Without it every `@min-[...]` variant silently
 * never matches and the hideable columns never appear -- which is why the
 * guard test asserts the wrapper references this constant.
 */
export const REGISTER_TABLE_CONTAINER = '@container';

/**
 * The classes that make Description the column that yields. In an auto-layout
 * table, `w-full` hands the column every pixel the content-sized columns do
 * not claim and `max-w-0` lets it shrink below its own content (the cell's
 * inner `truncate` div then ellipsizes) -- so Description grows with the page
 * when there is room and gives its width back, down to nothing, when there is
 * not, instead of the table overflowing and scrolling Status out from behind
 * the sticky Actions column.
 */
export const REGISTER_DESCRIPTION_CELL_FLEX = 'w-full max-w-0';

/**
 * The width classes on the payee NAME (the button or div inside the payee
 * cell). The cap is never a fixed pixel figure -- a fixed cap is what kept
 * the longest payees truncated at 280px however wide the register grew. It
 * scales with the register in `cqw` (1cqw = 1% of the @container's width):
 *
 * - Below the low tier nothing can yield, so the cap is conservative --
 *   `max(280px, 35cqw)`: never narrower than the old fixed cap, and growing
 *   with the register so a wider window always shows more of the payee.
 * - From the low tier -- whose 1536px this string must repeat because
 *   Tailwind's scanner only sees complete literal class names (the guard
 *   test holds the two figures equal) -- Description is on screen and yields,
 *   so the cap opens to `60cqw`: any realistic longest payee renders in full
 *   and Description hands the width back. It stays a bound rather than
 *   `max-w-none` because a payee at the column's 255-char maximum would
 *   otherwise overflow the table and scroll Status out from behind the
 *   sticky Actions -- the defect this whole contract exists to prevent.
 *
 * Below `sm` the phone caps on the payee *cell* apply instead (see the cell
 * in TransactionRow).
 */
/**
 * The floor under the payee COLUMN -- the width Description may not take from
 * it. It sits on the payee `<th>` and `<td>` (a column's minimum is the
 * largest of its cells', so header and body must agree or the label and the
 * values it labels sit over different columns).
 *
 * It has to be a length. `min-width: max-content` and `min-width: fit-content`
 * are both ignored on a table cell by the auto-layout algorithm -- measured,
 * not assumed -- so "never below the payee's own content" is not expressible;
 * a length share of the register is. Like every other figure here it scales in
 * `cqw` with a px floor, so a narrow register keeps a readable payee and a
 * wide one gives it more.
 *
 * It is deliberately smaller than `REGISTER_PAYEE_NAME_CAP`'s base share: a
 * floor is what the payee is guaranteed, the cap is how far it may grow, and a
 * floor that met the cap would freeze the column at one width and pad it with
 * blank space whenever the payees are short.
 *
 * `sm:` only, like the cap -- below it the phone caps on the payee cell apply,
 * and `min-width` beats `max-width`, so an unscoped floor would silently
 * override them and blow the phone layout open.
 */
export const REGISTER_PAYEE_CELL_FLOOR = 'sm:min-w-[max(240px,16cqw)]';

export const REGISTER_PAYEE_NAME_CAP =
  'sm:max-w-[max(280px,35cqw)] @min-[1536px]:max-w-[60cqw]';
