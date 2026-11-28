'use client';

import { CARD_CLASS } from '@/components/ui/Card';
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { PortfolioSummary } from '@/types/investment';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import {
  hasRepairableDataCause,
  periodResultUnknownReason,
} from '@/components/investments/portfolio-period-result';
import { IncompleteDataDetails } from '@/components/reports/IncompleteDataDetails';
import {
  hasIncompleteData,
  type IncompleteDataCauses,
} from '@/lib/incomplete-data-ranges';
import { gainLossColor } from '@/lib/format';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { isPortfolioPartial, partialTotalFor, totalOrSubtotal } from '@/lib/net-worth-completeness';
import { isComplete } from '@/lib/currency-total';
import { portfolioHeadline, summaryFigure, type SummaryFigure } from '@/lib/portfolio-headline';
import { PortfolioHeadline } from './variants/PortfolioHeadline';

interface PortfolioSummaryCardProps {
  summary: PortfolioSummary | null;
  isLoading: boolean;
  singleAccountCurrency?: string | null;
  titleSuffix?: string;
  /**
   * True where the screen has an account filter feeding this summary, so the
   * repair offered under a withheld return may name it. The account detail view
   * has none -- its scope is the account it is about -- and telling that reader
   * to use a filter above would be a repair they cannot make.
   */
  hasAccountFilter?: boolean;
}

export function PortfolioSummaryCard({
  summary,
  isLoading,
  singleAccountCurrency,
  titleSuffix,
  hasAccountFilter = false,
}: PortfolioSummaryCardProps) {
  const t = useTranslations('investments');
  const { formatCurrency, formatSignedPercent } = useNumberFormat();
  const { getRate, defaultCurrency } = useExchangeRates();

  // When viewing a single foreign-currency account, show values in that currency
  const foreignCurrency = singleAccountCurrency && singleAccountCurrency !== defaultCurrency
    ? singleAccountCurrency
    : null;

  const converted = useMemo(() => {
    if (!summary) return null;

    if (foreignCurrency) {
      // Single foreign account: use raw values without conversion
      let cash = 0;
      let holdings = 0;
      let costBasis = 0;
      let netInvested = 0;
      let gainLoss = 0;
      let gainCostBasis = 0;
      for (const acct of summary.holdingsByAccount) {
        cash += acct.cashBalance;
        holdings += acct.totalMarketValue;
        costBasis += acct.totalCostBasis;
        netInvested += acct.netInvested;
        // The server's gain is over the holdings that have a value; value less
        // every cost charged an unpriced holding's cost against a value that
        // never included it (A26-M38). An older backend sends no
        // `gainCostBasis`, and its gain was value less the whole cost.
        gainLoss += acct.totalGainLoss;
        gainCostBasis += acct.gainCostBasis ?? acct.totalCostBasis;
      }
      const portfolio = cash + holdings;
      const gainLossPercent = gainCostBasis > 0 ? (gainLoss / gainCostBasis) * 100 : 0;
      return { cash, holdings, costBasis, netInvested, portfolio, gainLoss, gainLossPercent };
    }

    // Default-currency view: use the backend totals as-is. They are already
    // converted to the default currency using live spot FX -- the same rate
    // source the Portfolio Value Over Time chart uses -- so the two stay in
    // sync. Re-converting per account here with the cached daily-snapshot
    // rates from useExchangeRates drifted from the chart (and triangulated
    // through each account's currency); returning null makes every field below
    // fall back to summary.total* directly.
    return null;
  }, [summary, foreignCurrency]);

  // Compute default-currency total when showing foreign, for the "approx" line.
  //
  // Through getRate, never convertToDefault: convertToDefault passes the amount
  // through unchanged when the pair has no rate, so a JPY total with no JPY->USD
  // rate rendered as "~ $15,000.00 USD" -- an implicit rate of 1, which "Rate 1
  // means same currency, never no rate found" forbids (review #1133). A missing
  // rate makes the approximation unknown; null suppresses the line.
  const defaultTotal = useMemo(() => {
    if (!summary || !foreignCurrency) return null;
    let total = 0;
    for (const acct of summary.holdingsByAccount) {
      const rate = getRate(acct.currencyCode, defaultCurrency);
      if (rate === null) return null;
      total += (acct.cashBalance + acct.totalMarketValue) * rate;
    }
    return total;
  }, [summary, getRate, defaultCurrency, foreignCurrency]);

  // Completeness has to come from the SAME aggregate that supplies the displayed
  // values. In the default-currency view that is the summary's own top-level
  // flags; in the single foreign-account view the displayed values are the
  // account-currency subtotals from `holdingsByAccount`, whose conversion path --
  // into the account's currency -- can be incomplete even when the top-level
  // default-currency totals are complete. Reading the top-level flag there let a
  // JPY account whose EUR->JPY rate was missing render 0 JPY under an ordinary
  // total with no warning (recheck RR5-001). Absent fields read as complete
  // (`!== false`), the same rolling-deploy defence as everywhere else here.
  const completeness = useMemo(() => {
    if (!summary) {
      return {
        valuationComplete: true,
        pricesComplete: true,
        fxComplete: true,
        missingRatePairs: [] as string[],
        unpricedSecurityIds: [] as string[],
      };
    }
    if (foreignCurrency) {
      const accounts = summary.holdingsByAccount;
      return {
        valuationComplete: accounts.every((a) => a.valuationComplete !== false),
        pricesComplete: accounts.every((a) => a.pricesComplete !== false),
        fxComplete: accounts.every((a) => a.fxComplete !== false),
        missingRatePairs: [
          ...new Set(accounts.flatMap((a) => a.missingRatePairs ?? [])),
        ].sort(),
        unpricedSecurityIds: [
          ...new Set(accounts.flatMap((a) => a.unpricedSecurityIds ?? [])),
        ].sort(),
      };
    }
    return {
      valuationComplete: summary.valuationComplete !== false,
      pricesComplete: summary.pricesComplete !== false,
      fxComplete: summary.fxComplete !== false,
      missingRatePairs: summary.missingRatePairs ?? [],
      unpricedSecurityIds: summary.unpricedSecurityIds ?? [],
    };
  }, [summary, foreignCurrency]);

  // What a withheld return is waiting for, as the report's own list renders it.
  // The server folded the window's per-point gaps into runs and resolved the
  // names, because this card has no series of its own to fold: a summary that
  // says "no price" sends the reader guessing which of their funds it is
  // (#1392). Ids are the keys the list is built on; the labels are what is
  // shown.
  const diagnostics = useMemo(() => {
    const data = summary?.returnDiagnostics;
    if (!data) return null;
    const causes: IncompleteDataCauses = {
      prices: data.prices.map((row) => ({
        key: row.securityId,
        start: row.start,
        end: row.end,
      })),
      rates: data.rates.map((row) => ({
        key: row.pair,
        start: row.start,
        end: row.end,
      })),
      cash: data.cash.map((row) => ({
        key: row.accountId,
        start: row.start,
        end: row.end,
      })),
    };
    const symbols = new Map(
      data.prices.map((row) => [row.securityId, row.symbol]),
    );
    const accountNames = new Map(
      data.cash.map((row) => [row.accountId, row.name]),
    );
    return {
      causes,
      securityLabel: (id: string) => symbols.get(id) ?? id,
      accountLabel: (id: string) => accountNames.get(id) ?? id,
    };
  }, [summary]);

  const fmtVal = (value: number) => {
    if (foreignCurrency) return `${formatCurrency(value, foreignCurrency)} ${foreignCurrency}`;
    return formatCurrency(value);
  };

  const formatPercent = (value: number) => formatSignedPercent(value);

  // The direction a signed figure points, for the Folio style's mark; a
  // figure with no value (withheld) has none and carries no mark.
  const signOf = (value: number | null | undefined) =>
    value == null || value === 0 ? undefined : value > 0 ? 'up' : 'down';

  const returnColorClass = (value: number | null | undefined) => {
    if (value == null) return 'text-gray-400 dark:text-gray-500';
    return gainLossColor(value);
  };

  if (isLoading) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6 lg:min-h-[420px]`}>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('portfolioSummary.title')}{titleSuffix ? ` (${titleSuffix})` : ''}
        </h3>
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="animate-pulse skeleton-shimmer">
              <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/3 mb-1" />
              <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-1/2" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6 lg:min-h-[420px]`}>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('portfolioSummary.title')}{titleSuffix ? ` (${titleSuffix})` : ''}
        </h3>
        <p className="text-gray-500 dark:text-gray-400">
          {t('portfolioSummary.noData')}
        </p>
      </div>
    );
  }

  // The server knows when a total is a subtotal; it used to say so and this card
  // rendered the number under a total's label anyway (recheck RR4-002). A missing
  // price and a missing rate are different causes, so they get different sentences.
  //
  // Read defensively: during a rolling deploy the page can briefly receive a
  // response from an older backend that has none of these fields. Absent means "no
  // information", which must not render as "incomplete" -- and must certainly not
  // crash the page.
  const unpricedSymbols = completeness.unpricedSecurityIds
    .map(
      (id) =>
        summary.holdings.find((holding) => holding.securityId === id)?.symbol ??
        id,
    )
    .sort();
  const incompleteReasons: string[] = [];
  if (!completeness.pricesComplete && unpricedSymbols.length > 0) {
    incompleteReasons.push(
      t('portfolioSummary.incompletePrices', {
        symbols: unpricedSymbols.join(', '),
      }),
    );
  }
  const missingRatePairs = completeness.missingRatePairs;
  if (!completeness.fxComplete && missingRatePairs.length > 0) {
    incompleteReasons.push(
      t('portfolioSummary.incompleteFx', {
        pairs: missingRatePairs.join(', '),
      }),
    );
  }
  const valuationIncomplete = !completeness.valuationComplete;
  // The gain and the simple return are over the holdings that have a value, so
  // they are partial figures whenever the valuation is (A26-M38).
  const gainPartial = partialTotalFor(
    0,
    completeness.valuationComplete,
    completeness.missingRatePairs,
  );
  const gainDisplayCurrency = foreignCurrency ?? defaultCurrency;

  // A withheld total (null) is shown as its known subtotal, marked partial from
  // ITS OWN total being withheld, not from the summary-wide flags: a missing
  // cost rate must not mark a market value that is fully known. Both absent is
  // unknown and renders as such. The foreign-account view reads its own flags.
  const incompleteLabel = t('portfolioSummary.incompleteHeading');
  const gainTotal = converted
    ? gainPartial
    : summaryFigure(summary, 'gain');
  const gainLossVal =
    converted?.gainLoss ?? totalOrSubtotal(summary.totalGainLoss, summary.knownGainLossSubtotal);
  const gainLossPercentVal =
    converted?.gainLossPercent ??
    totalOrSubtotal(summary.totalGainLossPercent, summary.knownGainLossPercentSubtotal);
  // The server's one rounding of value less net invested; a difference of the
  // two readings can sit a cent off it. A foreign account's view and an older
  // backend take the difference here.
  const olderBackendGain = (): number | null => {
    const value = totalOrSubtotal(summary.totalPortfolioValue, summary.knownPortfolioValueSubtotal);
    const invested = totalOrSubtotal(summary.totalNetInvested, summary.knownNetInvestedSubtotal);
    return value === null || invested === null ? null : value - invested;
  };
  const totalGainVal = converted
    ? converted.portfolio - converted.netInvested
    : (totalOrSubtotal(summary.totalGainOverNetInvested, summary.knownGainOverNetInvestedSubtotal) ??
      olderBackendGain());
  const percentTotal = converted
    ? gainPartial
    : summaryFigure(summary, 'gainPercent');
  const totalGainTotal = converted
    ? null
    : summaryFigure(summary, 'gainOverNetInvested');
  // One figure of the values grid: the foreign-account sum, else the server's
  // total or its known subtotal under the partial marker, else unknown.
  const figure = (own: number | undefined, which: SummaryFigure) => {
    if (own !== undefined) return fmtVal(own);
    const t = summaryFigure(summary, which);
    if (t === null) return <UnknownAmount reasonText={incompleteLabel} />;
    return (
      <PartialTotal total={t} displayCurrency={gainDisplayCurrency}>
        {fmtVal(t.value)}
      </PartialTotal>
    );
  };
  const headline = portfolioHeadline(summary, foreignCurrency);
  // Each caption follows its own figure, not the summary-wide flag.
  const headlinePartial = headline !== null && isPortfolioPartial(headline.completeness);
  const gainIsPartial = gainTotal !== null && !isComplete(gainTotal);
  const percentIsPartial = percentTotal !== null && !isComplete(percentTotal);
  const twr = summary.timeWeightedReturn;
  // A withheld return names its cause, as the chart's does: "n/a" with no cause
  // is a dead end, and the server sends the reasons precisely so the card can
  // point at the repair (INV-PORTRESULT-002).
  const twrUnknownReason = periodResultUnknownReason(
    summary.timeWeightedReturnReasons ?? [],
  );
  // The same measure's second figure, withheld the same way: a portfolio too
  // young to annualise, or a schedule of flows with no single rate, says so
  // rather than borrowing the time-weighted number.
  const mwr = summary.moneyWeightedReturn ?? null;
  const mwrUnknownReason = periodResultUnknownReason(
    summary.moneyWeightedReturnReasons ?? [],
  );
  const cagrVal = summary.cagr;
  // The list is offered only where there is a repair to make. `mwrUndefined`
  // and `windowTooShort` withhold a figure with nothing missing behind them, so
  // the marker beside the figure stands on its own there; a return withheld
  // with no ranges at all (a server that sent none) shows nothing extra rather
  // than an empty box.
  const returnsAwaitData =
    (twr == null &&
      hasRepairableDataCause(summary.timeWeightedReturnReasons ?? [])) ||
    (mwr == null &&
      hasRepairableDataCause(summary.moneyWeightedReturnReasons ?? []));
  const showReturnDiagnostics =
    returnsAwaitData &&
    diagnostics !== null &&
    hasIncompleteData(diagnostics.causes);

  return (
    <div className={`${CARD_CLASS} p-3 sm:p-6 lg:min-h-[420px]`}>
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        {t('portfolioSummary.title')}{titleSuffix ? ` (${titleSuffix})` : ''}
      </h3>

      {valuationIncomplete && incompleteReasons.length > 0 && (
        <div
          role="status"
          className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
        >
          <div className="font-medium">
            {t('portfolioSummary.incompleteHeading')}
          </div>
          <ul className="mt-1 list-disc pl-5 space-y-0.5">
            {incompleteReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-4">
        {/* Total Portfolio Value -- labelled a partial when it is one. */}
        {headline === null ? (
          <UnknownAmount reasonText={incompleteLabel} />
        ) : (
        <PortfolioHeadline
          label={
            headlinePartial
              ? t('portfolioSummary.knownPortfolioSubtotal')
              : t('portfolioSummary.totalPortfolioValue')
          }
          amount={headline.value}
          foreignCurrency={foreignCurrency}
          valueText={fmtVal(headline.value)}
          approx={
            foreignCurrency && defaultTotal !== null && !headlinePartial
              ? `\u2248 ${formatCurrency(defaultTotal, defaultCurrency)} ${defaultCurrency}`
              : null
          }
          gain={{
            label: t('portfolioSummary.gainLoss'),
            direction:
              gainLossVal === null ? 'flat' : gainLossVal > 0 ? 'up' : gainLossVal < 0 ? 'down' : 'flat',
            text:
              gainLossVal === null || gainLossPercentVal === null || gainTotal === null ? (
                <UnknownAmount reasonText={incompleteLabel} />
              ) : (
                <PartialTotal total={gainTotal} displayCurrency={gainDisplayCurrency}>
                  {`${gainLossVal > 0 ? '+' : ''}${fmtVal(gainLossVal)} \u00B7 ${formatPercent(gainLossPercentVal)}`}
                </PartialTotal>
              ),
          }}
        />
        )}

        {/* Values Section */}
        <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
          <div className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
            {t('portfolioSummary.values')}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 ui-sum-grid">
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center ui-figure-label">
                {t('portfolioSummary.holdingsValue')}
                <InfoTooltip placement="top" text={t('portfolioSummary.holdingsValueTooltip')} />
              </div>
              <div className="ui-sum-fig text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100">
                {figure(converted?.holdings, 'holdingsValue')}
              </div>
            </div>
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center ui-figure-label">
                {t('portfolioSummary.cashBalance')}
                <InfoTooltip placement="top" text={t('portfolioSummary.cashBalanceTooltip')} />
              </div>
              <div className="ui-sum-fig text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100">
                {figure(converted?.cash, 'cash')}
              </div>
            </div>
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center ui-figure-label">
                {t('portfolioSummary.totalGain')}
                <InfoTooltip
                  placement="top"
                  text={t('portfolioSummary.totalGainTooltip')}
                  learnMore="investmentCashVsReturns"
                />
              </div>
              <div data-sign={signOf(totalGainVal ?? 0)} className={`ui-sum-fig ui-gain text-base sm:text-lg font-semibold ${returnColorClass(totalGainVal ?? 0)}`}>
                {totalGainVal === null ? (
                  <UnknownAmount reasonText={incompleteLabel} />
                ) : totalGainTotal === null ? (
                  fmtVal(totalGainVal)
                ) : (
                  <PartialTotal total={totalGainTotal} displayCurrency={gainDisplayCurrency}>
                    {fmtVal(totalGainVal)}
                  </PartialTotal>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center ui-figure-label">
                {t('portfolioSummary.netInvested')}
                <InfoTooltip placement="top" text={t('portfolioSummary.netInvestedTooltip')} />
              </div>
              <div className="ui-sum-fig text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100">
                {figure(converted?.netInvested, 'netInvested')}
              </div>
            </div>
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center ui-figure-label">
                {t('portfolioSummary.costBasis')}
                <InfoTooltip
                  placement="top"
                  text={t('portfolioSummary.costBasisTooltip')}
                  learnMore="investmentCostBasis"
                />
              </div>
              <div className="ui-sum-fig text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100">
                {figure(converted?.costBasis, 'costBasis')}
              </div>
            </div>
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center ui-figure-label">
                {t('portfolioSummary.gainLoss')}
                <InfoTooltip placement="top" text={t('portfolioSummary.gainLossTooltip')} />
              </div>
              <div data-sign={signOf(gainLossVal ?? 0)} className={`ui-sum-fig ui-gain text-base sm:text-lg font-semibold ${returnColorClass(gainLossVal ?? 0)}`}>
                {gainLossVal === null || gainTotal === null ? (
                  <UnknownAmount reasonText={incompleteLabel} />
                ) : (
                  <PartialTotal total={gainTotal} displayCurrency={gainDisplayCurrency}>
                    {fmtVal(gainLossVal)}
                  </PartialTotal>
                )}
              </div>
              {gainIsPartial && (
                <div className="text-xs text-amber-700 dark:text-amber-300">
                  {t('portfolioSummary.gainPartialCaption')}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Returns Section */}
        <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
          <div className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
            {t('portfolioSummary.returns')}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 ui-sum-grid">
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center ui-figure-label">
                {t('portfolioSummary.simpleReturn')}
                <InfoTooltip placement="top" text={t('portfolioSummary.simpleReturnTooltip')} />
              </div>
              <div data-sign={signOf(gainLossPercentVal ?? 0)} className={`ui-sum-fig ui-gain text-base sm:text-lg font-semibold ${returnColorClass(gainLossPercentVal ?? 0)}`}>
                {gainLossPercentVal === null || percentTotal === null ? (
                  <UnknownAmount reasonText={incompleteLabel} />
                ) : (
                  <PartialTotal total={percentTotal} displayCurrency={gainDisplayCurrency}>
                    {formatPercent(gainLossPercentVal)}
                  </PartialTotal>
                )}
              </div>
              {percentIsPartial && (
                <div className="text-xs text-amber-700 dark:text-amber-300">
                  {t('portfolioSummary.gainPartialCaption')}
                </div>
              )}
            </div>
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center ui-figure-label">
                {t('portfolioSummary.twr')}
                <span className="hidden sm:inline">&nbsp;{t('portfolioSummary.twrFull')}</span>
                <InfoTooltip
                  placement="top"
                  text={t('portfolioSummary.twrTooltip')}
                  learnMore="investmentCashVsReturns"
                />
              </div>
              <div data-sign={signOf(twr)} className={`ui-sum-fig ui-gain text-base sm:text-lg font-semibold ${returnColorClass(twr)}`}>
                {twr != null ? formatPercent(twr) : (
                  <UnknownAmount reason={twrUnknownReason} className="text-sm font-normal" />
                )}
              </div>
            </div>
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center ui-figure-label">
                {t('portfolioSummary.mwr')}
                <span className="hidden sm:inline">&nbsp;{t('portfolioSummary.mwrFull')}</span>
                <InfoTooltip
                  placement="top"
                  text={t('portfolioSummary.mwrTooltip')}
                  learnMore="investmentCashVsReturns"
                />
              </div>
              <div data-sign={signOf(mwr)} className={`ui-sum-fig ui-gain text-base sm:text-lg font-semibold ${returnColorClass(mwr)}`}>
                {mwr != null ? formatPercent(mwr) : (
                  <UnknownAmount reason={mwrUnknownReason} className="text-sm font-normal" />
                )}
              </div>
            </div>
            <div>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex items-center ui-figure-label">
                {t('portfolioSummary.cagr')}
                <InfoTooltip placement="top" text={t('portfolioSummary.cagrTooltip')} />
              </div>
              <div data-sign={signOf(cagrVal)} className={`ui-sum-fig ui-gain text-base sm:text-lg font-semibold ${returnColorClass(cagrVal)}`}>
                {cagrVal != null ? formatPercent(cagrVal) : (
                  <span className="text-gray-400 dark:text-gray-500 text-sm font-normal">{t('portfolioSummary.notAvailable')}</span>
                )}
              </div>
            </div>
          </div>

          {showReturnDiagnostics && diagnostics && (
            <div className="mt-4 space-y-2" data-testid="return-diagnostics">
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t('portfolioSummary.returnDiagnosticsLead')}
              </p>
              <IncompleteDataDetails
                causes={diagnostics.causes}
                securityLabel={diagnostics.securityLabel}
                accountLabel={diagnostics.accountLabel}
              />
              {/* The second repair, and the one a reader with a workplace fund
                  in its own account can make today: the summary is measured
                  over the accounts the page's filter selected. */}
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {hasAccountFilter
                  ? t('portfolioSummary.returnDiagnosticsRepairFiltered')
                  : t('portfolioSummary.returnDiagnosticsRepair')}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
