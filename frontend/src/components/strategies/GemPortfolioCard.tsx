"use client";

import { useTranslations } from "next-intl";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { GemPosition } from "@/types/gem-strategy";
import { compliancePercent, isKnown } from "@/lib/gem-strategy-view";
import {
  GemBadge,
  GemCard,
  GemEmptyState,
  GemSecurityLink,
  GemStatRow,
  GemUnknown,
} from "./GemPrimitives";
import { useGemLabels } from "./useGemLabels";

interface GemPortfolioCardProps {
  position: GemPosition | null;
  /** True when no account is assigned to the strategy. */
  noAccount: boolean;
}

/**
 * Question 3 of the report: does the real portfolio match the strategy? Shows the
 * held instrument against the target one and how much of the strategy account is
 * already positioned per the signal.
 */
export function GemPortfolioCard({
  position,
  noAccount,
}: GemPortfolioCardProps) {
  const t = useTranslations("strategies");
  const { assetFullLabel } = useGemLabels();
  const { formatPercent, formatCurrency } = useNumberFormat();

  if (!position || noAccount) {
    return (
      <GemCard title={t("gem.portfolio.title")} hint={t("gem.portfolio.hint")}>
        <GemEmptyState
          title={t("gem.portfolio.noAccountTitle")}
          description={t("gem.portfolio.noAccountDescription")}
        />
      </GemCard>
    );
  }

  const percent = compliancePercent(position.exactTargetPercent);
  const securities = position.holdings.filter((holding) => !holding.isCash);
  const largest = position.current;

  return (
    <GemCard title={t("gem.portfolio.title")} hint={t("gem.portfolio.hint")}>
      <dl className="space-y-1">
        {/* What the accounts hold, counted. Naming the largest holding as "the
            current instrument" described a four-fund portfolio as though it
            were in one of them, and the other three appeared only as "+3". */}
        <GemStatRow
          label={t("gem.portfolio.positions")}
          value={t("gem.portfolio.positionsValue", {
            instruments: securities.length,
            accounts: position.accounts.length,
          })}
        />
        <GemStatRow
          label={t("gem.portfolio.target")}
          value={
            position.target ? (
              <GemSecurityLink securityId={position.target.securityId}>
                {assetFullLabel(position.target)}
              </GemSecurityLink>
            ) : (
              <GemUnknown />
            )
          }
        />
        {/* Secondary, and labelled as what it is: the biggest position, not
            the portfolio's identity. */}
        {largest && (
          <GemStatRow
            label={t("gem.portfolio.largest")}
            value={
              <span>
                <GemSecurityLink securityId={largest.securityId}>
                  {largest.isCash
                    ? t("gem.portfolioPanel.workingCash")
                    : assetFullLabel(largest)}
                </GemSecurityLink>
                {isKnown(largest.marketValue) && (
                  <span className="text-gray-500 dark:text-gray-400">
                    {t("gem.portfolio.largestValue", {
                      value: formatCurrency(
                        largest.marketValue,
                        position.currencyCode,
                      ),
                    })}
                  </span>
                )}
              </span>
            }
          />
        )}
      </dl>

      <div className="mt-3">
        <div className="mb-1 flex items-baseline justify-between text-xs">
          <span className="text-gray-500 dark:text-gray-400">
            {t("gem.portfolio.exactTarget")}
          </span>
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {percent === null ? <GemUnknown /> : formatPercent(percent, 0)}
          </span>
        </div>
        {/* An unknown figure gets a distinct empty track, not a fill of zero
            width. `${percent ?? 0}%` drew the two identically, and the shape
            is what most people read: a meter with nothing in it says the
            portfolio holds none of the target instrument, which is a measured
            answer this card does not have. The dashed outline has no fill at
            all, so it cannot be mistaken for one at 0%. */}
        <div
          role="progressbar"
          aria-label={t("gem.portfolio.exactTarget")}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(percent === null ? {} : { "aria-valuenow": percent })}
          className={
            percent === null
              ? "h-2 w-full rounded-full border border-dashed border-gray-300 dark:border-gray-600"
              : "ui-meter h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
          }
        >
          {/* One neutral fill: the percentage above and the "change required"
              badge below already say whether this is good or bad. */}
          {percent !== null && (
            <div
              className="ui-meter-fill h-full rounded-full bg-gray-400 dark:bg-gray-500"
              style={{ width: `${percent}%` }}
            />
          )}
        </div>
      </div>

      {/* The estimate, kept apart from the instruction above. Holding a fund
          with some of the same exposure is not holding the fund the strategy
          named, and one number for both read as "you are part of the way
          there" -- which is not true of an instruction to hold one instrument. */}
      <div className="mt-2 flex items-baseline justify-between text-xs">
        <span className="text-gray-500 dark:text-gray-400">
          {t("gem.portfolio.marketExposure")}
        </span>
        <span className="font-medium text-gray-700 dark:text-gray-200">
          {isKnown(position.marketExposurePercent) ? (
            // A lower bound is never printed as a measurement; see the product
            // decision in `backend/src/strategies/gem-composition.util.ts`.
            position.marketExposureIsFloor ? (
              t("gem.common.atLeast", {
                value: formatPercent(position.marketExposurePercent, 0),
              })
            ) : (
              formatPercent(position.marketExposurePercent, 0)
            )
          ) : (
            <GemUnknown label={t("gem.portfolio.marketExposureUnknown")} />
          )}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-gray-500 dark:text-gray-400">
          {t("gem.portfolio.changeRequired")}
        </span>
        <GemBadge tone={position.changeRequired ? "red" : "green"}>
          {position.changeRequired ? t("gem.common.yes") : t("gem.common.no")}
        </GemBadge>
      </div>
    </GemCard>
  );
}
