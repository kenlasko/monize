'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { format } from 'date-fns';
import { accountsApi } from '@/lib/accounts';
import { investmentsApi } from '@/lib/investments';
import { Button } from '@/components/ui/Button';
import { PortfolioSummaryCard } from '@/components/investments/PortfolioSummaryCard';
import { AssetAllocationChart } from '@/components/investments/AssetAllocationChart';
import { InvestmentValueChart } from '@/components/investments/InvestmentValueChart';
import { GroupedHoldingsList } from '@/components/investments/GroupedHoldingsList';
import { InvestmentTransactionList } from '@/components/investments/InvestmentTransactionList';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { InvestmentIncomePanel } from './InvestmentIncomePanel';
import type { Account } from '@/types/account';
import type { PortfolioSummary, InvestmentTransaction, RealizedGainEntry } from '@/types/investment';

interface InvestmentDetailViewProps {
  account: Account;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The investment detail body for a brokerage/cash pair. Resolves the pair (via
 * investment-pair, falling back to a standalone brokerage), then composes the
 * existing portfolio components scoped to the pair's accounts: summary,
 * allocation, value-over-time, holdings, YTD income, and recent transactions.
 */
export function InvestmentDetailView({ account }: InvestmentDetailViewProps) {
  const t = useTranslations('accountDetail-investment');
  const router = useRouter();

  const [brokerage, setBrokerage] = useState<Account>(account);
  const [cash, setCash] = useState<Account | null>(null);
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [recentTx, setRecentTx] = useState<InvestmentTransaction[]>([]);
  const [dividendInterestYtd, setDividendInterestYtd] = useState(0);
  const [realizedGainsYtd, setRealizedGainsYtd] = useState(0);
  const [loadedForId, setLoadedForId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const isLoading = loadedForId !== account.id;

  useEffect(() => {
    let cancelled = false;
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

      const [summaryData, recent, incomeTx, realized] = await Promise.all([
        investmentsApi.getPortfolioSummary(ids).catch(() => null),
        investmentsApi
          .getTransactions({ accountIds: idsStr, page: 1, limit: 15 })
          .catch(() => ({ data: [] as InvestmentTransaction[] })),
        investmentsApi
          .getTransactions({ accountIds: idsStr, startDate: yearStart, endDate: today, limit: 500 })
          .catch(() => ({ data: [] as InvestmentTransaction[] })),
        investmentsApi
          .getRealizedGains({ accountIds: idsStr, startDate: yearStart, endDate: today })
          .catch(() => [] as RealizedGainEntry[]),
      ]);

      if (cancelled) return;
      setBrokerage(resolvedBrokerage);
      setCash(resolvedCash);
      setSummary(summaryData);
      setRecentTx(recent.data);
      const income = incomeTx.data
        .filter((tx) => tx.action === 'DIVIDEND' || tx.action === 'INTEREST')
        .reduce((sum, tx) => sum + (Number(tx.totalAmount) || 0), 0);
      setDividendInterestYtd(round2(income));
      setRealizedGainsYtd(round2(realized.reduce((sum, r) => sum + (Number(r.realizedGain) || 0), 0)));
      setLoadedForId(account.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [account, reloadKey]);

  const accountIds = cash ? [brokerage.id, cash.id] : [brokerage.id];
  const currency = brokerage.currencyCode;
  const accountsForList = cash ? [brokerage, cash] : [brokerage];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap justify-end gap-3">
        <RefreshPricesButton onRefreshComplete={() => setReloadKey((k) => k + 1)} />
        <Button
          variant="outline"
          onClick={() => router.push(`/investments?accountId=${brokerage.id}`)}
        >
          {t('openInInvestments')}
        </Button>
      </div>

      <PortfolioSummaryCard summary={summary} isLoading={isLoading} singleAccountCurrency={currency} />

      <div className="grid gap-6 lg:grid-cols-2">
        <AssetAllocationChart
          allocation={
            summary
              ? { allocation: summary.allocation, totalValue: summary.totalPortfolioValue }
              : null
          }
          isLoading={isLoading}
          singleAccountCurrency={currency}
          holdingsByAccount={summary?.holdingsByAccount}
          accountIds={accountIds}
        />
        <InvestmentValueChart accountIds={accountIds} displayCurrency={currency} />
      </div>

      <GroupedHoldingsList
        holdingsByAccount={summary?.holdingsByAccount ?? []}
        isLoading={isLoading}
        totalPortfolioValue={summary?.totalPortfolioValue ?? 0}
      />

      <InvestmentIncomePanel
        dividendInterestYtd={dividendInterestYtd}
        realizedGainsYtd={realizedGainsYtd}
        currencyCode={currency}
        isLoading={isLoading}
      />

      <InvestmentTransactionList
        transactions={recentTx}
        accounts={accountsForList}
        isLoading={isLoading}
      />
    </div>
  );
}
