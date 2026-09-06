'use client';

import { useTranslations } from 'next-intl';
import { CellLabel } from '@/components/ui/Table';
import { StatusCellButton } from '@/components/transactions/StatusCellButton';
import { InvestmentTransaction } from '@/types/investment';
import {
  redemptionTotalWithInterest,
  supportsAccruedInterest,
} from '@/lib/investment-actions';
import type { RowAction } from '@/components/ui/row-actions/rowAction';

/**
 * The fingerprint-free pieces of `InvestmentTransactionList`: the action
 * vocabulary, the three value renderers both row layouts share, and the phone
 * card's body.
 *
 * The list file stays the home of anything carrying a `ui-conventions`
 * fingerprint -- its card surface, the row hover pair, the table divide string
 * -- because those baselines are keyed per file and shrink-only. Nothing here
 * carries one.
 */

/**
 * Builds the standard row actions for an investment transaction. Shared by the
 * desktop `RowActions` cell and the mobile `RowActionSheet`.
 */
export function buildInvestmentTxActions(
  tx: InvestmentTransaction,
  labels: { edit: string; delete: string },
  handlers: { onEdit?: (tx: InvestmentTransaction) => void; onDeleteClick: (tx: InvestmentTransaction) => void },
): RowAction[] {
  return [
    {
      key: 'edit',
      label: labels.edit,
      icon: 'edit',
      tone: 'primary',
      onClick: () => handlers.onEdit?.(tx),
      hidden: !handlers.onEdit,
    },
    {
      key: 'delete',
      label: labels.delete,
      icon: 'delete',
      tone: 'delete',
      destructive: true,
      onClick: () => handlers.onDeleteClick(tx),
    },
  ];
}

/**
 * Decide whether a SPLIT transaction's stored quantity looks like a ratio a
 * user (or the current QIF parser) would actually have set. Older buggy
 * imports left stray integers like 5, 10, 20, 30 in the quantity column;
 * those would render as misleading "5:1" / "20:1" splits if shown verbatim.
 * Mirror the SPLIT form's logic so the list and the editor agree on which
 * quantities count as "set" and which are blank.
 */
function isPlausibleSplitRatio(quantity: number | null | undefined): boolean {
  if (quantity === null || quantity === undefined) return false;
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) return false;
  if (!Number.isInteger(q)) return true; // 1.5, 0.5, 0.333...
  return q === 2 || q === 3 || q === 4;
}

/**
 * Render a SPLIT transaction's stored ratio (new shares per old share)
 * as human-readable "N:M" notation. Examples: 2 -> "2:1", 0.5 -> "1:2",
 * 1.5 -> "3:2". Returns "-" when the stored quantity is missing or doesn't
 * look like an actual user-set ratio so the list never advertises a split
 * the user didn't author.
 */
export function formatSplitRatio(quantity: number | null | undefined): string {
  if (!isPlausibleSplitRatio(quantity)) return '-';
  const ratio = Number(quantity);
  const trim = (n: number) =>
    Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
  // Probe small denominators for the most natural ratio rendering.
  for (const denom of [1, 2, 3, 4, 5, 6, 8, 10]) {
    const numer = ratio * denom;
    if (Math.abs(numer - Math.round(numer)) < 1e-6) {
      const n = Math.round(numer);
      if (n > 0) return `${trim(n)}:${denom}`;
    }
  }
  if (ratio >= 1) return `${trim(ratio)}:1`;
  return `1:${trim(1 / ratio)}`;
}

export const ACTION_COLORS: Record<string, string> = {
  BUY: 'text-green-600 dark:text-green-400',
  SELL: 'text-red-600 dark:text-red-400',
  DIVIDEND: 'text-blue-600 dark:text-blue-400',
  INTEREST: 'text-blue-600 dark:text-blue-400',
  CAPITAL_GAIN: 'text-purple-600 dark:text-purple-400',
  SPLIT: 'text-yellow-600 dark:text-yellow-400',
  TRANSFER_IN: 'text-green-600 dark:text-green-400',
  TRANSFER_OUT: 'text-red-600 dark:text-red-400',
  REINVEST: 'text-indigo-600 dark:text-indigo-400',
  ADD_SHARES: 'text-teal-600 dark:text-teal-400',
  REMOVE_SHARES: 'text-orange-600 dark:text-orange-400',
  // Money-vocabulary refinements share their base action's colour.
  REINVEST_INTEREST: 'text-indigo-600 dark:text-indigo-400',
  REINVEST_CAPITAL_GAIN_SHORT: 'text-indigo-600 dark:text-indigo-400',
  REINVEST_CAPITAL_GAIN_LONG: 'text-indigo-600 dark:text-indigo-400',
  CAPITAL_GAIN_SHORT: 'text-purple-600 dark:text-purple-400',
  CAPITAL_GAIN_LONG: 'text-purple-600 dark:text-purple-400',
  REDEEM: 'text-red-600 dark:text-red-400',
};

export interface InvestmentActionInfo {
  label: string;
  shortLabel: string;
  color: string;
}

/**
 * One action vocabulary, read by the tier row, the phone card, the delete
 * confirmation and the action sheet's title, so an action cannot be named one
 * thing in a row and another in the dialog that deletes it. An action with no
 * entry falls back to its raw code in a neutral colour.
 */
export function useInvestmentActionInfo(): (action: string) => InvestmentActionInfo {
  const t = useTranslations('investments');
  const labels: Record<string, InvestmentActionInfo> = {
    BUY: { label: t('transactionList.actionBuy'), shortLabel: t('transactionList.actionBuy'), color: ACTION_COLORS.BUY },
    SELL: { label: t('transactionList.actionSell'), shortLabel: t('transactionList.actionSell'), color: ACTION_COLORS.SELL },
    DIVIDEND: { label: t('transactionList.actionDividend'), shortLabel: 'Div', color: ACTION_COLORS.DIVIDEND },
    INTEREST: { label: t('transactionList.actionInterest'), shortLabel: 'Int', color: ACTION_COLORS.INTEREST },
    CAPITAL_GAIN: { label: t('transactionList.actionCapitalGain'), shortLabel: 'Cap', color: ACTION_COLORS.CAPITAL_GAIN },
    SPLIT: { label: t('transactionList.actionSplit'), shortLabel: t('transactionList.actionSplit'), color: ACTION_COLORS.SPLIT },
    TRANSFER_IN: { label: t('transactionList.actionTransferIn'), shortLabel: 'In', color: ACTION_COLORS.TRANSFER_IN },
    TRANSFER_OUT: { label: t('transactionList.actionTransferOut'), shortLabel: 'Out', color: ACTION_COLORS.TRANSFER_OUT },
    REINVEST: { label: t('transactionList.actionReinvest'), shortLabel: 'Reinv', color: ACTION_COLORS.REINVEST },
    ADD_SHARES: { label: t('transactionList.actionAddShares'), shortLabel: 'Add', color: ACTION_COLORS.ADD_SHARES },
    REMOVE_SHARES: { label: t('transactionList.actionRemoveShares'), shortLabel: 'Rem', color: ACTION_COLORS.REMOVE_SHARES },
    REINVEST_INTEREST: { label: t('transactionList.actionReinvestInterest'), shortLabel: 'RInt', color: ACTION_COLORS.REINVEST_INTEREST },
    REINVEST_CAPITAL_GAIN_SHORT: { label: t('transactionList.actionReinvestCapitalGainShort'), shortLabel: 'RScg', color: ACTION_COLORS.REINVEST_CAPITAL_GAIN_SHORT },
    REINVEST_CAPITAL_GAIN_LONG: { label: t('transactionList.actionReinvestCapitalGainLong'), shortLabel: 'RLcg', color: ACTION_COLORS.REINVEST_CAPITAL_GAIN_LONG },
    CAPITAL_GAIN_SHORT: { label: t('transactionList.actionCapitalGainShort'), shortLabel: 'SCap', color: ACTION_COLORS.CAPITAL_GAIN_SHORT },
    CAPITAL_GAIN_LONG: { label: t('transactionList.actionCapitalGainLong'), shortLabel: 'LCap', color: ACTION_COLORS.CAPITAL_GAIN_LONG },
    REDEEM: { label: t('transactionList.actionRedeem'), shortLabel: 'Rdm', color: ACTION_COLORS.REDEEM },
  };
  return (action: string) =>
    labels[action] || {
      label: action,
      shortLabel: action,
      color: 'text-gray-600 dark:text-gray-400',
    };
}

type FormatCurrency = (amount: number, currencyCode?: string, fractionDigits?: number) => string;

/**
 * The three figures whose rendering is a DECISION rather than a label, each
 * written once and called by both row layouts. A layout mode must not
 * re-decide what a SPLIT's quantity means, when a price is a dash, or what a
 * redemption's total is -- duplicating any of those is how the two branches
 * come to disagree about the same row.
 */
export function InvestmentSharesValue({
  tx,
  formatQuantity,
}: {
  tx: InvestmentTransaction;
  formatQuantity: (value: number) => string;
}) {
  // `quantity` is a share count for every action but SPLIT, where it is the
  // ratio -- the one distinction duplicated readings of this column lose.
  return (
    <>
      {tx.action === 'SPLIT'
        ? formatSplitRatio(tx.quantity)
        : formatQuantity(tx.quantity ?? 0)}
    </>
  );
}

/**
 * The Price column's figure. A SPLIT records a ratio rather than a price, so
 * an unpriced one is a dash. Everything else prints `price`, which is what the
 * tier cell prints -- including the amount-only actions, where the column
 * holds the cash amount rather than a per-share price. That the header
 * overstates what the figure is for those actions is a property of the column
 * this renderer serves, not of the layout calling it.
 */
export function InvestmentPriceValue({
  tx,
  formatCurrency,
  defaultCurrency,
}: {
  tx: InvestmentTransaction;
  formatCurrency: FormatCurrency;
  defaultCurrency: string;
}) {
  return (
    <>
      {tx.action === 'SPLIT' && !tx.price ? (
        '-'
      ) : (
        <>
          {formatCurrency(tx.price ?? 0, tx.security?.currencyCode, 4)}
          {tx.security?.currencyCode && tx.security.currencyCode !== defaultCurrency && (
            <span className="ml-1">{tx.security.currencyCode}</span>
          )}
        </>
      )}
    </>
  );
}

export function InvestmentTotalValue({
  tx,
  formatCurrency,
  defaultCurrency,
}: {
  tx: InvestmentTransaction;
  formatCurrency: FormatCurrency;
  defaultCurrency: string;
}) {
  return (
    <>
      {formatCurrency(
        // A redemption's accrued interest moved with its proceeds, so the
        // register shows what the cash account received rather than the
        // stored proceeds, which are only part of it.
        supportsAccruedInterest(tx.action)
          ? redemptionTotalWithInterest(tx.totalAmount, tx.accruedInterest)
          : tx.totalAmount,
        tx.security?.currencyCode,
      )}
      {tx.security?.currencyCode && tx.security.currencyCode !== defaultCurrency && (
        <span className="ml-1 font-normal">{tx.security.currencyCode}</span>
      )}
    </>
  );
}

interface InvestmentTransactionCardBodyProps {
  tx: InvestmentTransaction;
  accountName?: string;
  defaultCurrency: string;
  formatDate: (date: string) => string;
  formatCurrency: FormatCurrency;
  formatQuantity: (value: number) => string;
  actionInfo: InvestmentActionInfo;
  onCycleStatus: (tx: InvestmentTransaction) => void;
  /** `line-through` for a VOID row, exactly as the tier cells carry it. */
  voidText: string;
}

/**
 * The phone card's three lines. The `<tr>`, its hover class and the card
 * surface stay in the list file (their fingerprints are baselined there); this
 * is the fingerprint-free interior.
 *
 * Every value is the same value the tier row renders, from the same helper:
 * the date, the action label in its own colour, the symbol, the security name
 * that hangs under the symbol cell at Normal density, Shares, Price, the
 * Total, the Account and the status button. Nothing is recomputed here.
 */
export function InvestmentTransactionCardBody({
  tx,
  accountName,
  defaultCurrency,
  formatDate,
  formatCurrency,
  formatQuantity,
  actionInfo,
  onCycleStatus,
  voidText,
}: InvestmentTransactionCardBodyProps) {
  const t = useTranslations('investments');

  return (
    // A grid, not a flex row, and `minmax(0,1fr)` rather than a plain `1fr`: a
    // track that may be zero lets the symbol shrink and the security name
    // clamp, where a flex item's `min-w-0` still contributes the full width of
    // its nowrap text to the table's minimum. On a phone that is not merely a
    // scrollbar -- mobile Chrome sizes the viewport `position: fixed` attaches
    // to from the widest content on the page.
    //
    // TWO tracks on line 1, not three, and the date rides inside the identity
    // one. Three items there means two `auto` tracks either side of the
    // identity, and an `auto` track takes MAX-content: at 320px a nowrap date
    // (76px) and a six-figure Total in `pl` (150px) left the identity 69px --
    // narrower than "krótkoterminowych" is on its own, so `break-words` did
    // what it is there to do and shattered the action label across seven
    // lines, 237px of row for one trade. Measured in Chromium: folding the
    // date into the identity track takes it to 162px at 320px and 232px at
    // 390px, with no word broken and the row down to 207px -- and
    // `documentElement.scrollWidth` and the table's own still equal the
    // viewport at 320, 390 and 800.
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 items-start">
      {/* Line 1, left: when, and what was traded. The date leads, uncaptioned
          -- it is the row's identity and the one column a phone-width tier row
          already shows -- and it cannot shrink, so the action label and the
          symbol are what yield beside it.

          Those two share a `flex-wrap` row for the reason the payee card's
          name row does: the SYMBOL is the shrinkable one (`truncate` floors
          its min-width at zero) while an action label cannot shrink below its
          own words -- and these words are long ("Reinwestycja
          krótkoterminowych zysków kapitałowych" in `pl`, 49 characters against
          "Buy"). Wrapping lets the label take its own line instead of taking
          the symbol's width, and `break-words` remains the last resort for a
          word longer than the whole track. All three are self-describing, so
          none takes a caption; the security name hangs under them exactly as
          it hangs under the tier's Symbol cell at Normal density. */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={`text-sm text-gray-900 dark:text-gray-100 whitespace-nowrap ${voidText}`}>
            {formatDate(tx.transactionDate)}
          </span>
          <span className={`min-w-0 break-words text-sm font-medium ${actionInfo.color}`}>
            {actionInfo.label}
          </span>
          <span
            className="min-w-0 truncate max-w-full text-sm font-medium text-gray-900 dark:text-gray-100"
            title={tx.security?.symbol || undefined}
          >
            {tx.security?.symbol || '-'}
          </span>
        </div>
        {/* The tier's Symbol cell lets this name WRAP (it carries no
            `whitespace-nowrap`), so cutting it to one line here would lose
            more than the tier does. `line-clamp-2` keeps two and adds no
            minimum width, so containment is identical to `truncate`; `title`
            recovers the rest for a pointer and for assistive technology. */}
        {tx.security?.name && (
          <div
            className="line-clamp-2 text-xs text-gray-500 dark:text-gray-400"
            title={tx.security.name}
          >
            {tx.security.name}
          </div>
        )}
      </div>
      {/* Line 1, right: the key figure. A bare number with no column header to
          name it, so it carries the header's own label, in its own node above
          the value so a test still matches the figure alone.

          `whitespace-nowrap` goes on the VALUE, never on the wrapper: this is
          an `auto` track, and an auto track's minimum is its item's
          min-content -- a nowrap wrapper would size the track from whichever
          is wider, the figure or the CAPTION. The figure itself must not wrap,
          because a locale grouping thousands with a thin space would break it
          in two ("3 210,00 zł"). It is never truncated either: a silently cut
          figure is worse than a crowded one. */}
      <div className="text-right text-sm font-medium text-gray-900 dark:text-gray-100">
        {/* The strike-through belongs to the FIGURE, not to the caption above
            it: a caption is not data, and a struck-through column label reads
            as the column being void rather than the trade. */}
        <CellLabel>{t('transactionList.totalColumn')}</CellLabel>
        <div className={`whitespace-nowrap ${voidText}`}>
          <InvestmentTotalValue
            tx={tx}
            formatCurrency={formatCurrency}
            defaultCurrency={defaultCurrency}
          />
        </div>
      </div>
      {/* Line 2: two EQUAL zero-minimum tracks (`grid-cols-2` is
          `repeat(2, minmax(0,1fr))`), never an `auto` beside a `1fr`. An auto
          track takes its item's MAX-content when there is any room, so a
          captioned value in one starves the track beside it -- and a caption
          is a locale-sized width input. Both of these columns are ones a phone
          cannot see at all in the tier table (Shares below `sm`, Price below
          `md`), which is what the card is for. */}
      <div className="col-span-2 grid grid-cols-2 items-start gap-x-4">
        <div>
          <CellLabel>{t('transactionList.sharesColumn')}</CellLabel>
          <div className={`text-sm text-gray-900 dark:text-gray-100 whitespace-nowrap ${voidText}`}>
            <InvestmentSharesValue tx={tx} formatQuantity={formatQuantity} />
          </div>
        </div>
        <div>
          <CellLabel>{t('transactionList.priceColumn')}</CellLabel>
          <div className={`text-sm text-gray-900 dark:text-gray-100 whitespace-nowrap ${voidText}`}>
            <InvestmentPriceValue
              tx={tx}
              formatCurrency={formatCurrency}
              defaultCurrency={defaultCurrency}
            />
          </div>
        </div>
      </div>
      {/* Line 3: the account (captioned, and the only value on the card that
          may truncate once the symbol and the name have) beside the status
          button. The button is the `auto` track because its content is bounded
          -- one word, at most "Belum Direkonsiliasi" -- and it needs no
          caption: it names itself. `items-end` sits it on the account value's
          own line rather than centred against the caption above it. */}
      <div className="col-span-2 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3">
        <div className="min-w-0">
          <CellLabel>{t('transactionList.accountColumn')}</CellLabel>
          <div
            className="truncate text-sm text-gray-900 dark:text-gray-100"
            title={accountName}
          >
            {accountName || '-'}
          </div>
        </div>
        {/* StatusCellButton stops the click itself, so it needs no wrapper
            here -- the tier branch mounts it bare too. */}
        <StatusCellButton
          status={tx.status}
          dense={false}
          onCycle={() => onCycleStatus(tx)}
        />
      </div>
    </div>
  );
}
