'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { Button } from '@/components/ui/Button';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';

import { AccountList } from '@/components/accounts/AccountList';
import { AccountFormModal } from '@/components/accounts/AccountFormModal';
import { accountsApi } from '@/lib/accounts';
import { investmentsApi } from '@/lib/investments';
import { institutionsApi } from '@/lib/institutions';
import { countLogicalAccounts } from '@/lib/account-utils';
import {
  holdingsValuationIncomplete,
  incompleteHoldingAccountIds as incompleteHoldingAccountIdsOf,
} from '@/lib/logical-accounts';
import { Account } from '@/types/account';
import { Institution } from '@/types/institution';
import { PortfolioSummary } from '@/types/investment';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { sumConverted, combineTotals } from '@/lib/currency-total';
import { sumMoney } from '@/lib/format';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { CARD_CLASS } from '@/components/ui/Card';
import { useFormModal } from '@/hooks/useFormModal';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { showErrorToast } from '@/lib/errors';
import { docsUrl } from '@/lib/docs-links';

const logger = createLogger('Accounts');

export default function AccountsPage() {
  return (
    <ProtectedRoute>
      <AccountsContent />
    </ProtectedRoute>
  );
}

function AccountsContent() {
  const t = useTranslations('accounts');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummary | null>(null);
  // A failed portfolio request is not an empty portfolio. Kept apart so a
  // brokerage account's market value reads as unknown rather than zero -- the
  // page used to drop 100,000 of holdings out of Assets and Net Worth silently.
  const [portfolioFailed, setPortfolioFailed] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const formModal = useFormModal<Account>();
  const { openCreate, openEdit } = formModal;
  const { convertToDefault, defaultCurrency } = useExchangeRates();
  const { formatCurrency } = useNumberFormat();

  // The mount load: the state already says loading.
  const fetchAccounts = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      try {
        const [data, portfolio, insts] = await Promise.all([
          accountsApi.getAll(true),
          investmentsApi
            .getPortfolioSummary()
            .then((summary) => ({ ok: true as const, summary }))
            .catch(() => ({ ok: false as const, summary: null })),
          institutionsApi.getAll().catch(() => [] as Institution[]),
        ]);
        setAccounts(data);
        setPortfolioSummary(portfolio.summary);
        setPortfolioFailed(!portfolio.ok);
        setInstitutions(insts);
      } catch (error) {
        showErrorToast(error, t('toast.loadFailed'));
        logger.error(error);
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [t]);

  const loadAccounts = useCallback(() => {
    setIsLoading(true);
    return fetchAccounts();
  }, [fetchAccounts]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  useOnUndoRedo(loadAccounts);
  // An AI write can change account balances (e.g. a transaction created from
  // the chat bubble), so refresh the same way as an undo/redo.
  useOnAiAction(loadAccounts);

  // Build a map of brokerage account ID -> market value of holdings only.
  // Cash balance is tracked separately via the linked INVESTMENT_CASH account
  // to avoid double-counting in the net worth summary.
  const brokerageMarketValues = useMemo(() => {
    const map = new Map<string, number>();
    if (!portfolioSummary) return map;
    for (const accountHoldings of portfolioSummary.holdingsByAccount) {
      map.set(accountHoldings.accountId, accountHoldings.totalMarketValue);
    }
    return map;
  }, [portfolioSummary]);

  // How many holdings each account could not be priced. A market value missing
  // a component is a subtotal, so the row for such an account shows no total
  // rather than the cash half alone.
  const unpricedHoldingCounts = useMemo(() => {
    const map = new Map<string, number>();
    if (!portfolioSummary) return map;
    for (const accountHoldings of portfolioSummary.holdingsByAccount) {
      map.set(accountHoldings.accountId, accountHoldings.unpricedHoldingsCount ?? 0);
    }
    return map;
  }, [portfolioSummary]);

  // Which accounts' valuation is a subtotal for ANY cause. `unpricedHoldingsCount`
  // sees a missing price only; `valuationComplete === false` also covers a missing
  // exchange rate with every price present, so the gate reads both.
  const incompleteHoldingAccountIds = useMemo(
    () => incompleteHoldingAccountIdsOf(portfolioSummary?.holdingsByAccount),
    [portfolioSummary],
  );

  const LIABILITY_TYPES = ['CREDIT_CARD', 'LOAN', 'MORTGAGE', 'LINE_OF_CREDIT'];

  /**
   * The balance an account contributes, or `null` when it is not known.
   *
   * A brokerage account's contribution is its holdings' market value, which
   * comes from the portfolio summary. When that request failed the value is
   * unknown -- `?? 0` used to drop the whole position out of the totals without
   * a trace. A brokerage account genuinely absent from a *successful* summary
   * holds no positions, which is a real zero.
   */
  const contributedBalance = (a: Account): number | null => {
    if (a.accountSubType === 'INVESTMENT_BROKERAGE') {
      // Unknown when the valuation failed, and a subtotal when some holdings
      // could not be priced -- either way not a measured figure, matching the
      // account row, which shows an unknown marker in both cases.
      if (
        portfolioFailed ||
        holdingsValuationIncomplete(a.id, unpricedHoldingCounts, incompleteHoldingAccountIds)
      ) {
        return null;
      }
      return brokerageMarketValues.get(a.id) ?? 0;
    }
    return (Number(a.currentBalance) || 0) + (Number(a.futureTransactionsSum) || 0);
  };

  const summary = useMemo(() => {
    const activeAccounts = accounts.filter((a) => !a.isClosed);
    // An account the user excluded from net worth contributes to none of the
    // three money cards. Assets - Liabilities is the Net Worth card beside
    // them, so dropping the account from one and not the others would leave
    // the row unable to add up -- and the server's net worth series applies
    // the same predicate to both sides (net-worth.service.ts's
    // `exclude_from_net_worth = false`), which is what "it excludes it
    // elsewhere" refers to. The account count is a count of accounts, not of
    // money, so it stays over every active account.
    // A joint account carries the grantee's own overlay in this same field,
    // so no separate branch is needed for it.
    const countedAccounts = activeAccounts.filter((a) => !a.excludeFromNetWorth);
    const assets = countedAccounts.filter((a) => !LIABILITY_TYPES.includes(a.accountType));
    const liabilities = countedAccounts.filter((a) => LIABILITY_TYPES.includes(a.accountType));

    // An account whose contribution is unknown -- a brokerage whose valuation
    // failed -- has no currency to name, so it is excluded by count and kept
    // apart from the missing-rate path (which names currencies). Feeding it
    // through sumConverted as NaN would misreport it as a missing rate for its
    // own currency, including a nonsensical "no rate for USD" when that is the
    // display currency.
    const sumSide = (
      accts: Account[],
      convert: (amount: number, currency: string) => number | null,
    ) => {
      // Compute each contribution once (a brokerage lookup + balance arithmetic)
      // rather than in both the filter and the amount accessor.
      const contributions = accts.map((a) => ({ account: a, value: contributedBalance(a) }));
      const known = contributions.filter((c): c is { account: Account; value: number } => c.value !== null);
      const unknownCount = contributions.length - known.length;
      const converted = sumConverted(
        known,
        (c) => c.value,
        (c) => c.account.currencyCode,
        convert,
      );
      return { ...converted, excludedCount: converted.excludedCount + unknownCount };
    };

    const totalAssets = sumSide(assets, convertToDefault);
    const totalLiabilities = sumSide(liabilities, (amount, currency) => {
      const converted = convertToDefault(amount, currency);
      return converted === null ? null : Math.abs(converted);
    });
    // Net worth inherits the incompleteness of both sides: a hole in either
    // makes the difference partial too.
    const totalBalance = combineTotals(
      [totalAssets, totalLiabilities],
      // The difference of two 4dp values is not itself 4dp: round it so the
      // stored value and the sign test do not carry sub-cent float drift.
      ([a, l]) => sumMoney([a, -l]),
    );

    return {
      totalBalance,
      totalAssets,
      totalLiabilities,
      accountCount: countLogicalAccounts(activeAccounts),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, brokerageMarketValues, unpricedHoldingCounts, incompleteHoldingAccountIds, portfolioFailed, convertToDefault]);

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          helpUrl={docsUrl('accounts')}
          actions={
            <Button
              {...tourAnchor(TOUR_ANCHORS.accountsAddButton)}
              onClick={openCreate}
            >
              {t('page.newAccount')}
            </Button>
          }
        />
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6 mb-4 sm:mb-6">
          <SummaryCard
            label={t('page.summary.totalActiveAccounts')}
            value={summary.accountCount}
            icon={SummaryIcons.accounts}
          />
          <SummaryCard
            label={t('page.summary.netWorth')}
            value={
              <PartialTotal total={summary.totalBalance} displayCurrency={defaultCurrency}>
                {formatCurrency(summary.totalBalance.value, defaultCurrency)}
              </PartialTotal>
            }
            icon={SummaryIcons.money}
            valueColor={
              // A partial net worth has an uncertain sign -- an excluded account
              // could flip it -- so it is left neutral rather than asserting a
              // red/blue the subtotal cannot vouch for.
              summary.totalBalance.excludedCount > 0
                ? 'default'
                : summary.totalBalance.value >= 0
                  ? 'blue'
                  : 'red'
            }
          />
          <SummaryCard
            label={t('page.summary.totalAssets')}
            value={
              <PartialTotal total={summary.totalAssets} displayCurrency={defaultCurrency}>
                {formatCurrency(summary.totalAssets.value, defaultCurrency)}
              </PartialTotal>
            }
            icon={SummaryIcons.checkmark}
            valueColor="green"
          />
          <SummaryCard
            label={t('page.summary.totalLiabilities')}
            value={
              <PartialTotal total={summary.totalLiabilities} displayCurrency={defaultCurrency}>
                {formatCurrency(summary.totalLiabilities.value, defaultCurrency)}
              </PartialTotal>
            }
            icon={SummaryIcons.cross}
            valueColor="red"
          />
        </div>

        {/* Form Modal */}
        <AccountFormModal formModal={formModal} onSaved={loadAccounts} />

        {/* Accounts List */}
        <div className={`${CARD_CLASS} overflow-hidden`}>
          {isLoading ? (
            <LoadingSpinner text={t('page.loadingAccounts')} />
          ) : (
            <AccountList accounts={accounts} institutions={institutions} brokerageMarketValues={brokerageMarketValues} unpricedHoldingCounts={unpricedHoldingCounts} incompleteHoldingAccountIds={incompleteHoldingAccountIds} portfolioFailed={portfolioFailed} defaultCurrency={defaultCurrency} convertToDefault={convertToDefault} onEdit={openEdit} onRefresh={loadAccounts} />
          )}
        </div>
      </main>
    </PageLayout>
  );
}
