'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { accountsApi } from '@/lib/accounts';
import { investmentsApi } from '@/lib/investments';
import { roundToCents, sumMoney } from '@/lib/format';
import { createLogger } from '@/lib/logger';
import {
  INCOME_ACTIONS,
  incomeBaseKind,
  investmentIncomeAmount,
  investmentRowHasEffect,
} from '@/lib/investment-actions';
import { convertRowAmount, rowAmountCurrency } from '@/lib/investment-row-currency';
import { PortfolioSummaryCard } from '@/components/investments/PortfolioSummaryCard';
import { AssetAllocationChart } from '@/components/investments/AssetAllocationChart';
import { summaryAllocation } from '@/lib/portfolio-headline';
import { InvestmentValueChart } from '@/components/investments/InvestmentValueChart';
import { GroupedHoldingsList } from '@/components/investments/GroupedHoldingsList';
import { InvestmentRegisterPanel } from '@/components/investments/InvestmentRegisterPanel';
import { InvestmentIncomePanel } from './InvestmentIncomePanel';
import type { Account } from '@/types/account';
import type { PortfolioSummary, InvestmentTransaction, RealizedGainEntry } from '@/types/investment';

const logger = createLogger('InvestmentDetailView');

/** The year's dividends and interest, or why they cannot be added up. */
type DividendInterestYtd =
  | { amount: number; unknownReason?: undefined }
  | { amount: null; unknownReason: 'displayFx' | 'unknownCurrency' };

/**
 * The year's dividends and interest in the brokerage's currency. Each row's
 * income is in its own (security) currency and reaches the account's at the
 * rate its cash leg settled at. A reinvest created in the app stores no total;
 * its income is the cost of the shares it bought. One row that cannot be
 * converted makes the year unknown, never a smaller sum.
 */
function dividendInterestYtdOf(
  incomeTx: readonly InvestmentTransaction[],
  brokerage: Account,
  cash: Account | null,
): DividendInterestYtd {
  const accountCurrency = new Map<string, string>([[brokerage.id, brokerage.currencyCode]]);
  if (cash) accountCurrency.set(cash.id, cash.currencyCode);
  const amounts: number[] = [];
  for (const tx of incomeTx) {
    const amount = convertRowAmount(
      tx,
      investmentIncomeAmount(tx),
      accountCurrency.get(tx.accountId),
      brokerage.currencyCode,
    );
    if (amount === null) {
      // Two different repairs: a security to name, or a rate to add.
      return {
        amount: null,
        unknownReason: rowAmountCurrency(tx) === null ? 'unknownCurrency' : 'displayFx',
      };
    }
    amounts.push(amount);
  }
  return { amount: roundToCents(sumMoney(amounts)) };
}

interface InvestmentDetailViewProps {
  account: Account;
  /**
   * Bumped by the header's Refresh Prices button to re-fetch. The button lives
   * on the title row (`InvestmentDetailActions`), so the signal comes in rather
   * than being raised here.
   */
  refreshKey?: number;
}

/**
 * The actions that count towards the YTD "Dividends & Interest" figure: every
 * dividend and every interest payment, paid in cash or reinvested in shares.
 * Filtered server-side, one request each, because `GET /investment-transactions`
 * matches a single action per call.
 */
const DIVIDEND_INTEREST_ACTIONS = INCOME_ACTIONS.filter((action) => {
  const kind = incomeBaseKind(action);
  return kind === 'DIVIDEND' || kind === 'INTEREST';
});

/**
 * The investment detail body for a brokerage/cash pair. Resolves the pair (via
 * investment-pair, falling back to a standalone brokerage), then composes the
 * existing portfolio components scoped to the pair's accounts: summary,
 * allocation, value-over-time, holdings, YTD income, and recent transactions.
 */
export function InvestmentDetailView({ account, refreshKey = 0 }: InvestmentDetailViewProps) {
  const router = useRouter();
  const [brokerage, setBrokerage] = useState<Account>(account);
  const [cash, setCash] = useState<Account | null>(null);
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [incomeTx, setIncomeTx] = useState<InvestmentTransaction[]>([]);
  // `null` when a sale's gain is unknown; `realizedGainsKnownYtd` is the rest.
  const [realizedGainsYtd, setRealizedGainsYtd] = useState<number | null>(0);
  const [realizedGainsKnownYtd, setRealizedGainsKnownYtd] = useState(0);
  const [loadedForId, setLoadedForId] = useState<string | null>(null);
  // Bumped by the register panel after any write on either ledger. The figures
  // above it -- the summary card, the allocation and the holdings list, cash row
  // included -- are all derived from those rows, so a deposit that does not
  // re-run this effect leaves them reading their pre-write values (issue #1190).
  const [writeKey, setWriteKey] = useState(0);
  const handleRegisterWrite = useCallback(() => setWriteKey((k) => k + 1), []);
  // Which *account* the data on screen describes. A re-fetch triggered by a
  // write or a price refresh is still this account's data, so it does not
  // blank the page out from under the user.
  const isLoading = loadedForId !== account.id;

  // What the figures on screen were loaded for. A re-run for the same account
  // and the same write, with only `refreshKey` moved, is a price refresh (the
  // header's Refresh Prices, or the automatic one every 15 minutes): income and
  // realized gains are not priced, so only the summary is asked again, and a
  // request that fails keeps the summary on screen rather than reading as an
  // account with nothing in it.
  const loadedRef = useRef<{
    account: Account;
    writeKey: number;
    refreshKey: number;
    ids: string[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loaded = loadedRef.current;
    if (
      loaded &&
      loaded.account === account &&
      loaded.writeKey === writeKey &&
      loaded.refreshKey !== refreshKey
    ) {
      investmentsApi
        .getPortfolioSummary(loaded.ids)
        .then((summaryData) => {
          if (cancelled) return;
          setSummary(summaryData);
          loadedRef.current = { ...loaded, refreshKey };
        })
        .catch((error) => logger.error('Failed to re-value the account after a price refresh:', error));
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      // Resolve the brokerage/cash pair; a standalone account 400s, in which
      // case it is treated as its own brokerage with no cash half.
      let resolvedBrokerage = account;
      let resolvedCash: Account | null = null;
      try {
        const pair = await accountsApi.getInvestmentPair(account.id);
        resolvedBrokerage = pair.brokerageAccount;
        resolvedCash = pair.cashAccount;
      } catch {
        // not part of a pair
      }
      const ids = resolvedCash ? [resolvedBrokerage.id, resolvedCash.id] : [resolvedBrokerage.id];
      const idsStr = ids.join(',');
      const now = new Date();
      const today = format(now, 'yyyy-MM-dd');
      const yearStart = `${now.getFullYear()}-01-01`;

      // Income is asked for one action at a time and walked a page at a time.
      // A single unfiltered request capped the year at one page, and asking for
      // a bigger page is what the server refuses outright -- the 400 landed in
      // the catch below and reported the year's dividends as 0.00.
      const [summaryData, fetchedIncome, realized] = await Promise.all([
        investmentsApi.getPortfolioSummary(ids).catch(() => null),
        Promise.all(
          DIVIDEND_INTEREST_ACTIONS.map((action) =>
            investmentsApi.getAllTransactionPages({
              accountIds: idsStr,
              startDate: yearStart,
              endDate: today,
              action,
            }),
          ),
        )
          .then((perAction) => perAction.flat())
          .catch(() => [] as InvestmentTransaction[]),
        investmentsApi
          .getRealizedGains({ accountIds: idsStr, startDate: yearStart, endDate: today })
          .catch(() => [] as RealizedGainEntry[]),
      ]);

      if (cancelled) return;
      setBrokerage(resolvedBrokerage);
      setCash(resolvedCash);
      setSummary(summaryData);
      // A VOID row is listed by the endpoint as a record; it paid nothing.
      setIncomeTx(fetchedIncome.filter(investmentRowHasEffect));
      const knownGains = realized.flatMap((r) => (r.realizedGain === null ? [] : [Number(r.realizedGain) || 0]));
      const knownTotal = roundToCents(sumMoney(knownGains));
      setRealizedGainsKnownYtd(knownTotal);
      setRealizedGainsYtd(knownGains.length === realized.length ? knownTotal : null);
      setLoadedForId(account.id);
      loadedRef.current = { account, writeKey, refreshKey, ids };
    })();
    return () => {
      cancelled = true;
    };
  }, [account, refreshKey, writeKey]);

  const accountIds = cash ? [brokerage.id, cash.id] : [brokerage.id];
  const currency = brokerage.currencyCode;

  const dividendInterestYtd = dividendInterestYtdOf(incomeTx, brokerage, cash);

  return (
    <div className="space-y-6">
      <PortfolioSummaryCard summary={summary} isLoading={isLoading} singleAccountCurrency={currency} />

      <div className="grid gap-6 lg:grid-cols-2">
        <AssetAllocationChart
          allocation={summary ? summaryAllocation(summary) : null}
          isLoading={isLoading}
          singleAccountCurrency={currency}
          holdingsByAccount={summary?.holdingsByAccount}
          accountIds={accountIds}
          valuationComplete={summary?.valuationComplete}
        />
        <InvestmentValueChart
          accountIds={accountIds}
          displayCurrency={currency}
          refreshKey={writeKey}
        />
      </div>

      <GroupedHoldingsList
        holdingsByAccount={summary?.holdingsByAccount ?? []}
        isLoading={isLoading}
        totalPortfolioValue={summary?.totalPortfolioValue ?? null}
        valuationComplete={summary?.valuationComplete}
        onSecurityClick={(securityId) => router.push(`/securities/${securityId}`)}
        onCashClick={(cashAccountId) => router.push(`/transactions?accountId=${cashAccountId}`)}
      />

      <InvestmentIncomePanel
        dividendInterestYtd={dividendInterestYtd.amount}
        dividendInterestUnknownReason={dividendInterestYtd.unknownReason}
        realizedGainsYtd={realizedGainsYtd}
        realizedGainsKnownYtd={realizedGainsKnownYtd}
        currencyCode={currency}
        isLoading={isLoading}
      />

      {/* Both ledgers of this account, behind one toggle: the trades, and the
          cash register that funds them. */}
      <InvestmentRegisterPanel
        holdingsAccount={brokerage}
        cashAccount={cash}
        onDataChanged={handleRegisterWrite}
      />
    </div>
  );
}
