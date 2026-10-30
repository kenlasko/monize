"use client";

import { useTranslations } from "next-intl";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { GemPosition } from "@/types/gem-strategy";
import { compliancePercent, isKnown } from "@/lib/gem-strategy-view";
import { Th } from "@/components/ui/Table";
import { sumMoney } from "@/lib/format";
import {
  GemAccountLinks,
  GemBadge,
  GemCard,
  GemEmptyState,
  GemSecurityLink,
  GemStatRow,
  GemUnknown,
} from "./GemPrimitives";
import { useGemLabels } from "./useGemLabels";

interface GemPortfolioPanelProps {
  position: GemPosition | null;
  noAccount: boolean;
  noPosition: boolean;
}

/**
 * "My portfolio" tab: every instrument the strategy accounts hold, valued and
 * marked against the signal, plus the compliance figure the overview summarizes.
 * The whole portfolio is listed because that is what the strategy compares
 * against -- an instrument it never assigned still has to be moved.
 */
export function GemPortfolioPanel({
  position,
  noAccount,
  noPosition,
}: GemPortfolioPanelProps) {
  const t = useTranslations("strategies");
  const { assetFullLabel, dimensionLabel } = useGemLabels();
  const { formatCurrency, formatQuantity, formatPercent } = useNumberFormat();

  if (!position || noAccount) {
    return (
      <GemCard title={t("gem.portfolioPanel.title")}>
        <GemEmptyState
          title={t("gem.portfolio.noAccountTitle")}
          description={t("gem.portfolio.noAccountDescription")}
        />
      </GemCard>
    );
  }

  const percent = compliancePercent(position.exactTargetPercent);
  /** The securities' total, which is what both percentages are measured over. */
  const securities = position.holdings.filter((holding) => !holding.isCash);
  const securitiesValue = securities.some(
    (holding) => !isKnown(holding.marketValue),
  )
    ? null
    : sumMoney(securities.map((holding) => holding.marketValue ?? 0));
  /**
   * What is actually in the target, summed from the same rows the table marks
   * "Yes — kept".
   *
   * Not `securitiesValue * percent`: the percentage arrives rounded to two
   * decimals, so on a million-pound portfolio that reconstruction printed a
   * figure tens of pounds away from the row three lines above it.
   */
  const inTargetValue =
    securitiesValue === null
      ? null
      : sumMoney(
          securities
            .filter((holding) => holding.isTargetInstrument)
            .map((holding) => holding.marketValue ?? 0),
        );

  /**
   * An exposure figure, marked as a lower bound when it is one.
   *
   * A floor printed as a plain percentage is the only misreading this can
   * produce, so the two are never formatted the same way. See the product
   * decision in `backend/src/strategies/gem-composition.util.ts`.
   */
  const exposureText = (percent: number, isFloor: boolean): string =>
    isFloor
      ? t("gem.common.atLeast", { value: formatPercent(percent, 0) })
      : formatPercent(percent, 0);

  /** True when any figure on screen is a floor, so the note is worth showing. */
  const anyFloor =
    position.marketExposureIsFloor ||
    position.holdings.some((holding) => holding.matchIsFloor);

  return (
    <GemCard
      title={t("gem.portfolioPanel.title")}
      hint={t("gem.portfolio.hint")}
    >
      <dl className="space-y-1">
        <GemStatRow
          label={t("gem.portfolioPanel.accounts")}
          value={
            position.accounts.length > 0 ? (
              <GemAccountLinks accounts={position.accounts} />
            ) : (
              <GemUnknown />
            )
          }
        />
        <GemStatRow
          label={t("gem.portfolio.target")}
          value={
            position.target?.securityId ? (
              <GemSecurityLink securityId={position.target.securityId}>
                {assetFullLabel(position.target)}
              </GemSecurityLink>
            ) : (
              <GemUnknown />
            )
          }
        />
        <GemStatRow
          label={t("gem.portfolio.exactTarget")}
          value={percent === null ? <GemUnknown /> : formatPercent(percent, 0)}
        />
        {/* The estimate, on its own row and never merged with the one above:
            exposure to the same market is not holding the named fund. */}
        <GemStatRow
          label={t("gem.portfolio.marketExposure")}
          value={
            isKnown(position.marketExposurePercent) ? (
              exposureText(
                position.marketExposurePercent,
                position.marketExposureIsFloor,
              )
            ) : (
              <GemUnknown label={t("gem.portfolio.marketExposureUnknown")} />
            )
          }
        />
        <GemStatRow
          label={t("gem.portfolio.changeRequired")}
          value={
            <GemBadge tone={position.changeRequired ? "red" : "green"}>
              {position.changeRequired
                ? t("gem.common.yes")
                : t("gem.common.no")}
            </GemBadge>
          }
        />
        <GemStatRow
          label={t("gem.portfolioPanel.totalValue")}
          value={
            isKnown(position.totalMarketValue) ? (
              formatCurrency(position.totalMarketValue, position.currencyCode)
            ) : (
              <GemUnknown />
            )
          }
        />
      </dl>

      {noPosition || position.holdings.length === 0 ? (
        <div className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
          <GemEmptyState
            title={t("gem.portfolio.noPositionTitle")}
            description={t("gem.portfolioPanel.noPositionHint")}
          />
        </div>
      ) : (
        <div className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t("gem.portfolioPanel.holdings", {
              count: position.holdings.length,
            })}
          </h4>
          <ul className="space-y-1">
            {position.holdings.map((holding) => {
              const isTarget = holding.isTargetInstrument;
              // Some exposure to the same markets is worth naming -- as an
              // estimate about this fund, never as a part of the position that
              // stays put. It is sold whole like everything else.
              const partial =
                !isTarget &&
                isKnown(holding.matchPercent) &&
                holding.matchPercent > 0 &&
                holding.matchPercent < 100;
              return (
                <li
                  // Cash has neither a security nor a ticker, so it is the one
                  // row both fallbacks come back null for -- the same key the
                  // working-out table below spells out.
                  key={
                    holding.isCash
                      ? "cash"
                      : (holding.securityId ?? holding.symbol)
                  }
                  className="flex items-start justify-between gap-3 text-sm"
                >
                  <span className="flex min-w-0 items-start gap-1.5">
                    <span className="min-w-0">
                      <span className="block text-gray-900 dark:text-gray-100">
                        <GemSecurityLink
                          securityId={holding.securityId}
                          className="break-words"
                        >
                          {assetFullLabel(holding)}
                        </GemSecurityLink>
                      </span>
                      <span className="block text-xs text-gray-500 dark:text-gray-400">
                        {/* Cash has no unit count and no role by design, so
                            neither the unknown marker nor "not part of the
                            strategy" belongs on it: both read as a gap in the
                            data, and the second contradicts the note this same
                            row carries in the table below. */}
                        {holding.isCash
                          ? t("gem.portfolioPanel.workingCashNote")
                          : isKnown(holding.quantity)
                            ? t("gem.action.units", {
                                units: formatQuantity(holding.quantity),
                              })
                            : t("gem.common.unknown")}
                        {isTarget && (
                          <>
                            <span aria-hidden="true"> &middot; </span>
                            {t("gem.portfolioPanel.isTarget")}
                          </>
                        )}
                        {partial && (
                          <>
                            <span aria-hidden="true"> &middot; </span>
                            {t("gem.portfolioPanel.partialMatch", {
                              percent: exposureText(
                                holding.matchPercent as number,
                                holding.matchIsFloor,
                              ),
                            })}
                          </>
                        )}
                        {!holding.role && !holding.isCash && (
                          <>
                            <span aria-hidden="true"> &middot; </span>
                            {t("gem.portfolioPanel.notInStrategy")}
                          </>
                        )}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-gray-900 dark:text-gray-100">
                    {isKnown(holding.marketValue) ? (
                      formatCurrency(holding.marketValue, position.currencyCode)
                    ) : (
                      <GemUnknown />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {t("gem.portfolioPanel.holdingsHint")}
          </p>
          {/* Shown whenever there is a target, priced or not. Gating it on a
              known total hid the whole working-out at the one moment it
              matters most: an unpriced holding makes the total unknown, and
              this table is where the row responsible is named. */}
          {position.target && (
            <div className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t("gem.portfolioPanel.workingTitle")}
              </h4>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr>
                      <Th scope="col" className="py-1 pl-0 pr-3">
                        {t("gem.portfolioPanel.workingInstrument")}
                      </Th>
                      <Th scope="col" align="right" className="py-1 pl-0 pr-3">
                        {t("gem.portfolioPanel.workingValue")}
                      </Th>
                      <Th scope="col" className="py-1 pl-0 pr-3">
                        {t("gem.portfolioPanel.workingIsTarget")}
                      </Th>
                      <Th scope="col" align="right" className="py-1 px-0">
                        {t("gem.portfolioPanel.workingExposure")}
                      </Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
                    {position.holdings.map((holding) => (
                      <tr
                        key={
                          holding.isCash
                            ? "cash"
                            : (holding.securityId ?? holding.symbol)
                        }
                      >
                        <td className="py-1 pr-3">
                          {/* Cash is a balance, not an instrument: there is
                              nothing to link to and no ticker to print. */}
                          {holding.isCash ? (
                            t("gem.portfolioPanel.workingCash")
                          ) : (
                            <GemSecurityLink securityId={holding.securityId}>
                              {holding.symbol ?? t("gem.common.unassigned")}
                            </GemSecurityLink>
                          )}
                        </td>
                        <td className="py-1 pr-3 text-right tabular-nums">
                          {isKnown(holding.marketValue) ? (
                            formatCurrency(
                              holding.marketValue,
                              position.currencyCode,
                            )
                          ) : (
                            <GemUnknown />
                          )}
                        </td>
                        {/* The operational column: is this the instrument the
                            signal named? Yes keeps the position, no sells it,
                            and no amount of similar exposure changes that. */}
                        <td className="py-1 pr-3">
                          {holding.isCash
                            ? t("gem.portfolioPanel.workingCashNote")
                            : holding.isTargetInstrument
                              ? t("gem.portfolioPanel.workingIsTargetYes")
                              : t("gem.portfolioPanel.workingIsTargetNo")}
                        </td>
                        {/* The estimate, beside it and clearly not the same
                            thing. Unknown stays unknown: a confident 0.00
                            beside a fund nobody measured is a claim about it. */}
                        <td className="py-1 text-right tabular-nums">
                          {holding.isCash ? (
                            <span className="text-gray-500 dark:text-gray-400">
                              {formatPercent(0, 0)}
                            </span>
                          ) : !isKnown(holding.matchPercent) ? (
                            // Spelled out rather than dashed: a blank cell in a
                            // column of percentages reads as zero, which is the
                            // one thing this is not.
                            <span className="text-gray-500 dark:text-gray-400">
                              {t("gem.portfolioPanel.workingNoData")}
                            </span>
                          ) : (
                            <span
                              title={
                                holding.matchedMarkets.length > 0
                                  ? holding.matchedMarkets
                                      .map((market) =>
                                        t("gem.portfolioPanel.workingMarket", {
                                          name: market.name,
                                          percent: formatPercent(
                                            market.percent,
                                            0,
                                          ),
                                        }),
                                      )
                                      .join(", ")
                                  : undefined
                              }
                            >
                              {exposureText(
                                holding.matchPercent,
                                holding.matchIsFloor,
                              )}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-gray-200 font-medium dark:border-gray-700">
                      <td className="py-1 pr-3">
                        {t("gem.portfolioPanel.workingTotal")}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums">
                        {isKnown(position.totalMarketValue) ? (
                          formatCurrency(
                            position.totalMarketValue,
                            position.currencyCode,
                          )
                        ) : (
                          <GemUnknown />
                        )}
                      </td>
                      <td className="py-1 pr-3" />
                      {/* No total for the exposure column. The Value cell
                          beside it includes cash and the estimate does not, so
                          a percentage here would not be the weighted average of
                          the column it foots. The portfolio-level figure is on
                          the card above, measured over the securities. */}
                      <td className="py-1" />
                    </tr>
                  </tfoot>
                </table>
              </div>
              {/* The allocation figure, written out. It is measured over the
                  securities: idle cash is off target and funds the purchase,
                  but it is not part of "how much of my equity is in the right
                  fund". */}
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {percent === null ||
                securitiesValue === null ||
                inTargetValue === null
                  ? t("gem.portfolioPanel.workingUnknown")
                  : t("gem.portfolioPanel.workingSum", {
                      counted: formatCurrency(
                        inTargetValue,
                        position.currencyCode,
                      ),
                      // Named as the instruments' total on screen, because the
                      // table's own Total row above it includes cash.
                      total: formatCurrency(
                        securitiesValue,
                        position.currencyCode,
                      ),
                      percent: formatPercent(percent, 0),
                    })}
              </p>
            </div>
          )}

          {/* What the *exposure estimate* could be built from, and what to do
              when it could not. It says nothing about compliance, which is
              exact either way: the signal names an instrument, and the accounts
              either hold it or they do not.
              
              Only with a target, though. Without one the sentence was built
              from two unknown placeholders -- "because Not assigned has no Not
              available structure recorded" -- and then claimed compliance was
              still being calculated exactly, which is false when there is no
              instrument to be compliant with. */}
          {position.target && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {position.basis === "COMPOSITION"
                ? t("gem.portfolioPanel.basisComposition", {
                    dimension: dimensionLabel(position.dimension),
                  })
                : t("gem.portfolioPanel.basisInstrument", {
                    dimension: dimensionLabel(position.requiredDimension),
                    target:
                      position.target?.symbol ?? t("gem.common.unassigned"),
                  })}
              {position.basis === "COMPOSITION" &&
                position.instrumentMatchedCount > 0 && (
                  <>
                    {" "}
                    {t("gem.portfolioPanel.basisPartialData", {
                      count: position.instrumentMatchedCount,
                    })}
                  </>
                )}
              {position.basis === "INSTRUMENT" && (
                <>
                  {" "}
                  <GemSecurityLink securityId={position.target?.securityId}>
                    {t("gem.portfolioPanel.basisFillStructure")}
                  </GemSecurityLink>
                </>
              )}
              {/* Why some figures read "at least". Shown only when one does:
                  a standing caveat about a case that did not arise is noise. */}
              {anyFloor && <> {t("gem.portfolioPanel.workingFloorNote")}</>}
            </p>
          )}
        </div>
      )}
    </GemCard>
  );
}
