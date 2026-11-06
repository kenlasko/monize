"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from "@/components/ui/Table";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { benchmarkLabel, rateRuleLines } from "./bond-labels";
import { SecurityBondInterestChart } from "./SecurityBondInterestChart";
import {
  RATE_SOURCE_VARIANT,
  SecurityBondPeriodRate,
} from "./SecurityBondPeriodRate";
import type {
  BondLotValuation,
  BondRedemptionTerms,
  BondRateScheduleEntry,
} from "@/types/bond";

interface SecurityBondRateSectionProps {
  lots: BondLotValuation[];
  /** The currency of the holding, for the interest chart. */
  currency: string;
  /** The terms' redemption policy; null for a bond redeemable at maturity only. */
  redemptionTerms: BondRedemptionTerms | null;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How the rate is set, in words, and the rate of every period of each lot
 * (spec 13). The rule is read from the first lot: every lot of one series
 * shares the series' terms. The schedule differs per lot (its periods
 * start on the purchase date), so each lot has its own table under a heading
 * when there are several.
 */
export function SecurityBondRateSection({
  lots,
  currency,
  redemptionTerms,
}: SecurityBondRateSectionProps) {
  const t = useTranslations("securityDetail");
  const { formatDate } = useDateFormat();
  const { formatCurrency, formatPercentTrimmed } = useNumberFormat();

  if (lots.length === 0) return null;
  const rule = lots[0].valuation.rateRule;

  // Rates are fractions; the formatter takes percent units.
  const pct = (fraction: string) =>
    formatPercentTrimmed(Number(fraction) * 100);
  const benchmarkName = (id: string) => benchmarkLabel(t, id);
  // A step series is keyed by a day, a monthly one by YYYY-MM (shown as stored).
  const observationLabel = (key: string) =>
    YMD.test(key) ? formatDate(key) : key;

  const how = (entry: BondRateScheduleEntry) => {
    const b = entry.benchmark;
    if (b === null || entry.addend === null) {
      return (
        <span className="text-gray-500 dark:text-gray-400">
          {t("bond.rate.how.stated")}
        </span>
      );
    }
    const benchmark = benchmarkName(b.benchmarkId);
    const observation = observationLabel(b.observation);
    if (b.value === null) {
      return (
        <span className="text-gray-500 dark:text-gray-400">
          {t("bond.rate.how.missing", { benchmark, observation })}
        </span>
      );
    }
    const wasFloored =
      b.flooredValue !== null && Number(b.flooredValue) !== Number(b.value);
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          {t("bond.rate.how.observed", {
            benchmark,
            observation,
            value: pct(b.value),
            addend: pct(entry.addend),
          })}
        </span>
        {wasFloored && b.flooredValue !== null && (
          <span className="text-gray-500 dark:text-gray-400">
            {t("bond.rate.how.floored", {
              floor: pct(b.flooredValue),
            })}
          </span>
        )}
        {entry.rateSource === "PROJECTED" && (
          <Badge variant="amber">{t("bond.lots.projected")}</Badge>
        )}
      </span>
    );
  };

  // Spec 13.1: a lot whose rule reads a benchmark says so before any figure. The
  // date is that lot's own period 2 start (periods anchor on the purchase date).
  const indexationNotice = (lot: BondLotValuation): string | null => {
    const r = lot.valuation.rateRule;
    const second = lot.valuation.rateSchedule[1];
    if (r.type === "FIXED" || r.benchmarkId === null || r.addend === null)
      return null;
    if (!second) return null;
    return t(
      r.type === "INFLATION_PLUS_MARGIN_AS_RATE"
        ? "bond.indexation.inflation"
        : "bond.indexation.floating",
      {
        date: formatDate(second.start),
        benchmark: benchmarkName(r.benchmarkId),
        addend: pct(r.addend),
      },
    );
  };

  // What an early redemption costs, in words: each penalty of the terms, and
  // whether the face value floors the proceeds in every period or the first only.
  const redemptionLines = (r: BondRedemptionTerms | null): string[] => {
    if (r === null) return [];
    const lines = r.penalties.map((penalty) =>
      penalty.type === "FIXED_FEE_PER_UNIT"
        ? t("bond.redemption.fixedFee", {
            // A decimal string is converted only at the formatting boundary.
            amount: formatCurrency(Number(penalty.amount), currency),
          })
        : t("bond.redemption.forfeitAccrued"),
    );
    if (r.proceedsFloor !== null) {
      lines.push(
        t(
          r.proceedsFloor.appliesTo === "ALL_PERIODS"
            ? "bond.redemption.floorAllPeriods"
            : "bond.redemption.floorFirstPeriod",
        ),
      );
    }
    return lines;
  };
  const redemption = redemptionLines(redemptionTerms);

  const unknown = (
    <span className="text-gray-500 dark:text-gray-400">
      {t("bond.unknown")}
    </span>
  );

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        {t("bond.rate.title")}
      </h4>
      <div className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
        {rateRuleLines(t, rule, pct).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {redemption.length > 0 && (
        <div className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
          <p className="font-medium text-gray-900 dark:text-gray-100">
            {t("bond.redemption.title")}
          </p>
          {redemption.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      {lots.map((lot, lotIndex) => {
        const v = lot.valuation;
        const notice = indexationNotice(lot);
        return (
          <div
            key={`${lot.purchaseDate}-${lot.quantity}-${lotIndex}`}
            className="space-y-1"
          >
            {notice && (
              <p
                role="note"
                className="rounded-md bg-blue-50 p-2 text-sm text-blue-900 dark:bg-blue-900/20 dark:text-blue-200"
              >
                {notice}
              </p>
            )}
            {lots.length > 1 && (
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                {t("bond.rate.lotHeading", {
                  date: formatDate(lot.purchaseDate),
                })}
              </p>
            )}
            {(v.nextRateReset !== null || v.nextCapitalization !== null) && (
              <div className="space-y-0.5 text-sm text-gray-600 dark:text-gray-400">
                {v.nextRateReset !== null && (
                  <p>
                    {t("bond.rate.nextRateReset", {
                      date: formatDate(v.nextRateReset),
                    })}
                  </p>
                )}
                {v.nextCapitalization !== null && (
                  <p>
                    {t("bond.rate.nextCapitalization", {
                      date: formatDate(v.nextCapitalization),
                    })}
                  </p>
                )}
              </div>
            )}
            <div className="overflow-x-auto scrollbar-slim">
              <table className={TABLE_CLASS}>
                <thead>
                  <tr>
                    <Th>{t("bond.rate.columns.period")}</Th>
                    <Th>{t("bond.rate.columns.dates")}</Th>
                    <Th>{t("bond.rate.columns.rate")}</Th>
                    <Th>{t("bond.rate.columns.source")}</Th>
                    <Th>{t("bond.rate.columns.how")}</Th>
                  </tr>
                </thead>
                <tbody className={TABLE_BODY_CLASS}>
                  {v.rateSchedule.map((entry) => {
                    const isCurrent = v.currentPeriod?.index === entry.index;
                    return (
                      <tr
                        key={entry.index}
                        aria-current={isCurrent ? "true" : undefined}
                        className={
                          isCurrent
                            ? "bg-blue-50 dark:bg-blue-900/20"
                            : undefined
                        }
                      >
                        <Td className="whitespace-nowrap">
                          <span className="inline-flex flex-wrap items-center gap-2">
                            <span>{entry.index}</span>
                            {isCurrent && (
                              <Badge variant="blue">
                                {t("bond.rate.current")}
                              </Badge>
                            )}
                          </span>
                        </Td>
                        <Td className="whitespace-nowrap">
                          {t("bond.rate.range", {
                            start: formatDate(entry.start),
                            end: formatDate(entry.end),
                          })}
                        </Td>
                        <Td className={entry.dailyRates?.length ? "" : "whitespace-nowrap"}>
                          <SecurityBondPeriodRate
                            valuation={v}
                            period={entry}
                            detail
                            withSource={false}
                          />
                        </Td>
                        <Td className="whitespace-nowrap">
                          {entry.rateSource === null ? (
                            unknown
                          ) : (
                            <Badge
                              variant={RATE_SOURCE_VARIANT[entry.rateSource]}
                            >
                              {t(`bond.rateSource.${entry.rateSource}`)}
                            </Badge>
                          )}
                        </Td>
                        <Td>{how(entry)}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <SecurityBondInterestChart lot={lot} currency={currency} />
          </div>
        );
      })}
    </div>
  );
}
