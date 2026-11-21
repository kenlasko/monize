"use client";

import { CARD_CLASS } from '@/components/ui/Card';
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { KeyValueList, type KeyValueRow } from "@/components/ui/KeyValueList";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { isHttpsUrl } from "@/lib/bond-offer";
import { investmentsApi } from "@/lib/investments";
import { usePreferencesStore } from "@/store/preferencesStore";
import {
  documentHost,
  inferDistributionPolicy,
  type SecurityPricePoint,
} from "@/lib/security-detail";
import type { BondProgramSummary } from "@/types/bond";
import type { Security } from "@/types/investment";

interface SecurityKeyInformationProps {
  security: Security;
  /** Latest close price and the day it is from; null when none is recorded. */
  latestPrice: { price: number; priceDate: string } | null;
  /** Full price history, for reading the distribution behaviour off it. */
  prices: readonly SecurityPricePoint[];
  /**
   * Bumped by the page each time a price refresh completes (whatever its
   * outcome): the bond data the refresh fetched is re-read once, in place.
   */
  refreshVersion?: number;
}

/**
 * The reference facts about the instrument, beside the chart.
 *
 * Every row comes from a field Monize actually stores, and rows without a value
 * are dropped by `KeyValueList` -- so a thinly-filled security shows a short
 * list rather than a column of dashes. Fields the schema has no column for
 * (ISIN, market cap) are simply absent until there is somewhere to keep them.
 */
export function SecurityKeyInformation({
  security,
  latestPrice,
  prices,
  refreshVersion = 0,
}: SecurityKeyInformationProps) {
  const t = useTranslations("securityDetail");
  const ts = useTranslations("securities");
  const { formatDate } = useDateFormat();
  const { formatCurrencyPrecise } = useNumberFormat();
  // A security with no provider of its own inherits the user's default, so the
  // effective provider is the answer here -- never a blank row.
  const defaultQuoteProvider =
    usePreferencesStore((s) => s.preferences?.defaultQuoteProvider) ?? "yahoo";

  // Whether the fund pays out is not a field anyone stores -- it is read off the
  // price history, where the adjusted close parts from the quoted one on every
  // distribution. `unknown` drops the row rather than guessing.
  const policy = inferDistributionPolicy(prices);

  // The issuer's page for a bond kind comes from the program catalog. Only a
  // linked bond asks; a failed read just leaves the row out, since the link is
  // a convenience and nothing is said to be missing.
  const bondProgramId = security.bondProgramId ?? null;
  const [catalog, setCatalog] = useState<BondProgramSummary[] | null>(null);
  useEffect(() => {
    if (!bondProgramId) return;
    let cancelled = false;
    investmentsApi
      .listBondPrograms()
      .then((list) => {
        if (!cancelled) setCatalog(list);
      })
      .catch(() => {
        // Left out on purpose; see above.
      });
    return () => {
      cancelled = true;
    };
  }, [bondProgramId, refreshVersion]);
  const infoUrl = bondProgramId
    ? (catalog?.find((p) => p.id === bondProgramId)?.infoUrl ?? null)
    : null;

  const rows: KeyValueRow[] = [
    { key: "symbol", label: t("keyInfo.symbol"), value: security.symbol },
    {
      // "Security type", not "asset class": an ETF is a kind of instrument, not
      // an asset class, and the latter term is needed for the percentage
      // breakdown a security can carry (review of discussion #964).
      key: "securityType",
      label: t("keyInfo.securityType"),
      value: security.securityType
        ? ts(`typeLabels.${security.securityType}` as Parameters<typeof ts>[0])
        : null,
    },
    {
      key: "distributions",
      label: t("keyInfo.distributions"),
      value:
        policy === "unknown" ? null : (
          <span title={t("keyInfo.distributionsTitle")}>
            {policy === "distributing"
              ? t("keyInfo.distributing")
              : t("keyInfo.accumulating")}
          </span>
        ),
    },
    { key: "exchange", label: t("keyInfo.exchange"), value: security.exchange },
    {
      key: "currency",
      label: t("keyInfo.currency"),
      value: security.currencyCode,
    },
    { key: "sector", label: t("keyInfo.sector"), value: security.sector },
    { key: "industry", label: t("keyInfo.industry"), value: security.industry },
    {
      key: "provider",
      label: t("keyInfo.provider"),
      // A security linked to a bond program is priced by the bond engine from
      // its issue terms; no quote provider is ever asked for it.
      value: ts(
        (security.bondProgramId
          ? "form.providers.bond_engine"
          : `form.providers.${security.quoteProvider ?? defaultQuoteProvider}`) as Parameters<
          typeof ts
        >[0],
      ),
    },
    {
      key: "bondDescription",
      label: t("keyInfo.bondDescription"),
      // Only an https address becomes a link; the host says where it goes.
      value:
        infoUrl !== null && isHttpsUrl(infoUrl) ? (
          <a
            href={infoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400"
          >
            {documentHost(infoUrl)}
          </a>
        ) : null,
    },
    {
      key: "lastPrice",
      label: t("keyInfo.lastPrice"),
      value: latestPrice
        ? `${formatCurrencyPrecise(latestPrice.price, security.currencyCode)} (${formatDate(latestPrice.priceDate)})`
        : null,
    },
  ];

  return (
    <div className={`${CARD_CLASS} p-4`}>
      <h3 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t("keyInfo.title")}
      </h3>
      <KeyValueList rows={rows} />
    </div>
  );
}
