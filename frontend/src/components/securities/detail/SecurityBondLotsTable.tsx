'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { BondLotValuation } from '@/types/bond';
import { valuationRefusalText } from './bond-labels';
import { SecurityBondPeriodRate } from './SecurityBondPeriodRate';

interface SecurityBondLotsTableProps {
  lots: BondLotValuation[];
  currency: string;
}

/**
 * One row per open lot, per spec section 13. A figure the server could not work
 * out is `null` and reads as unknown, never as a zero; an early redemption that
 * is refused shows the reason in the cell instead of a number.
 */
export function SecurityBondLotsTable({
  lots,
  currency,
}: SecurityBondLotsTableProps) {
  const t = useTranslations('securityDetail');
  const { formatDate } = useDateFormat();
  const { formatCurrency, formatShareQuantity } = useNumberFormat();

  const unknown = (
    <span className="text-gray-500 dark:text-gray-400">
      {t('bond.unknown')}
    </span>
  );
  // A decimal string is converted only here, at the formatting boundary.
  const money = (value: string | null): ReactNode =>
    value === null ? unknown : formatCurrency(Number(value), currency);

  return (
    <div className="overflow-x-auto scrollbar-slim">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <Th>{t('bond.lots.purchaseDate')}</Th>
            <Th align="right">{t('bond.lots.quantity')}</Th>
            <Th>{t('bond.lots.maturity')}</Th>
            <Th>{t('bond.lots.period')}</Th>
            <Th>{t('bond.lots.rate')}</Th>
            <Th align="right">{t('bond.lots.principal')}</Th>
            <Th align="right">{t('bond.lots.accruedInterest')}</Th>
            <Th align="right">{t('bond.lots.grossValue')}</Th>
            <Th align="right">{t('bond.lots.earlyRedemption')}</Th>
            <Th>{t('bond.lots.nextCashFlow')}</Th>
            <Th align="right">{t('bond.lots.maturityValue')}</Th>
          </tr>
        </thead>
        <tbody className={TABLE_BODY_CLASS}>
          {lots.map((lot, index) => {
            const v = lot.valuation;
            const period = v.currentPeriod;
            const refusalText =
              v.status === 'REFUSED' && v.refusal !== null
                ? valuationRefusalText(t, v.refusal, formatDate)
                : null;
            // A matured or refused lot has no current period; an open lot with a
            // period whose rate is not known still shows the period.
            const noPeriod = (
              <span className="text-gray-500 dark:text-gray-400">
                {v.status === 'MATURED' ? (
                  t('bond.lots.matured')
                ) : v.status === 'REFUSED' ? (
                  <>
                    {t('bond.lots.refused')}
                    {refusalText !== null && (
                      <span className="block whitespace-normal text-xs">
                        {refusalText}
                      </span>
                    )}
                  </>
                ) : (
                  t('bond.unknown')
                )}
              </span>
            );
            // The engine names every flow on the earliest date to come, an UNKNOWN
            // one included; the amount of such a flow is unknown, never a zero.
            const next = v.nextPayment;
            return (
              <tr key={`${lot.purchaseDate}-${lot.quantity}-${index}`}>
                <Td className="whitespace-nowrap">
                  {formatDate(lot.purchaseDate)}
                  {lot.purchaseDateAssumed && (
                    <Badge
                      variant="amber"
                      className="ml-2"
                      title={t('bond.lots.assumedTitle')}
                    >
                      {t('bond.lots.assumed')}
                    </Badge>
                  )}
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  {formatShareQuantity(lot.quantity)}
                </Td>
                <Td className="whitespace-nowrap">{formatDate(v.maturityDate)}</Td>
                <Td className="whitespace-nowrap">
                  {period === null
                    ? noPeriod
                    : t('bond.lots.periodValue', {
                        index: period.index,
                        start: formatDate(period.start),
                        end: formatDate(period.end),
                      })}
                </Td>
                <Td className="whitespace-nowrap">
                  {period === null ? (
                    v.status === 'OPEN' ? unknown : noPeriod
                  ) : (
                    <SecurityBondPeriodRate valuation={v} period={period} />
                  )}
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  {money(v.principal)}
                  {v.principalBasis === 'ISSUE_PRICE' && (
                    <span className="block whitespace-normal text-xs text-gray-500 dark:text-gray-400">
                      {t('bond.lots.principalIssuePrice')}
                    </span>
                  )}
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  {money(v.accruedInterest)}
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  {money(v.grossValue)}
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  {v.earlyRedemptionValue !== null ? (
                    money(v.earlyRedemptionValue)
                  ) : v.earlyRedemptionRefusal !== null ? (
                    <span className="text-gray-500 dark:text-gray-400">
                      {t(`bond.earlyRefusal.${v.earlyRedemptionRefusal}`)}
                    </span>
                  ) : (
                    unknown
                  )}
                </Td>
                <Td className="whitespace-nowrap">
                  {next.length === 0 ? (
                    <span className="text-gray-500 dark:text-gray-400">
                      {t('bond.lots.noCashFlow')}
                    </span>
                  ) : (
                    next.map((flow) => (
                      <div
                        key={`${flow.type}-${flow.status}-${flow.period}`}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <span>
                          {t('bond.lots.cashFlowValue', {
                            type: t(`bond.cashFlowType.${flow.type}`),
                            // Null is an unknown amount, never a zero.
                            amount:
                              flow.amount === null
                                ? t('bond.unknown')
                                : formatCurrency(Number(flow.amount), currency),
                            date: formatDate(flow.date),
                          })}
                        </span>
                        {flow.status === 'PROJECTED' && (
                          <Badge variant="amber">{t('bond.lots.projected')}</Badge>
                        )}
                        {flow.status === 'UNKNOWN' && (
                          <Badge variant="amber">{t('bond.lots.amountUnknown')}</Badge>
                        )}
                      </div>
                    ))
                  )}
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  <div>
                    {t('bond.lots.maturityKnown')} {money(v.maturityValueKnown)}
                  </div>
                  {v.maturityValueProjected !== null && (
                    <div>
                      {t('bond.lots.maturityProjected')}{' '}
                      {money(v.maturityValueProjected)}
                    </div>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
