"use client";

import {
  useContext,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import {
  reportingDetailsFromUrl,
  type ReportingDetailsInput,
} from "@/lib/reporting-details";
import { RecognitionDetailsDialog } from "./RecognitionDetailsDialog";
import {
  SEGMENTED_GROUP_CLASS,
  segmentClass,
} from "@/components/ui/segmented-control";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useAuthStore } from "@/store/authStore";

import {
  BasisContext,
  type ReportingBasis,
  type Selection,
} from "./ReportingBasisContext";
export type { ReportingBasis } from "./ReportingBasisContext";

export const SELECTABLE_REPORT_IDS = new Set([
  "spending-by-category",
  "spending-by-payee",
  "income-by-source",
  "monthly-spending-trend",
  "income-vs-expenses",
  "year-over-year",
  "monthly-comparison",
  "monthly-category-breakdown",
  "net-worth",
  "budget-vs-actual",
  "budget-health-score",
  "budget-seasonal-patterns",
  "budget-trend",
  "category-performance",
  "savings-rate",
  "health-score-history",
  "flex-group-analysis",
  "seasonal-spending-map",
]);
export const CASH_REPORT_IDS = new Set([
  "cash-flow",
  "cash-flow-sankey",
  "weekend-weekday-spending",
  "spending-anomalies",
  "tax-summary",
  "recurring-expenses",
  "bill-payment-history",
  "uncategorized-transactions",
  "duplicate-transactions",
]);

/** Ephemeral view override. The account preference remains the only persisted default. */
export function ReportingBasisScope({
  children,
  surface,
  resetOnBasis = false,
  fixedBasis,
  initialBasis,
}: {
  children: ReactNode;
  surface: string;
  resetOnBasis?: boolean;
  fixedBasis?: ReportingBasis;
  initialBasis?: ReportingBasis;
}) {
  const owner = useAuthStore((state) => state.actingAsUserId ?? state.user?.id);
  const realUser = useAuthStore((state) => state.user?.id);
  const preference = usePreferencesStore(
    (state) => state.preferences?.reportingBasis,
  );
  const featureEnabled = usePreferencesStore(
    (state) => state.preferences?.accrualEnabled === true,
  );
  const defaultBasis: ReportingBasis =
    preference === "accrual" ? "accrual" : "cash";
  const identity = JSON.stringify([realUser, owner, surface, initialBasis]);
  const [override, setOverride] = useState<{
    identity: string;
    selection: Selection;
  } | null>(null);
  const selection =
    override?.identity === identity
      ? override.selection
      : (initialBasis ?? "default");
  const basis = !featureEnabled
    ? "cash"
    : fixedBasis ?? (selection === "default" ? defaultBasis : selection);
  const [detail, setDetail] = useState<{
    identity: string;
    basis: ReportingBasis;
    input: ReportingDetailsInput | null;
  } | null>(null);
  const showDetails = useCallback(
    (href: string) => {
      if (!href.startsWith("/transactions")) return false;
      if (
        basis !== "accrual" &&
        !new URL(href, "https://internal.invalid").searchParams.has(
          "unsupported",
        )
      )
        return false;
      try {
        const input = reportingDetailsFromUrl(href);
        if (!input) return false;
        setDetail({ identity, basis, input });
      } catch {
        setDetail({ identity, basis, input: null });
      }
      return true;
    },
    [basis, identity],
  );

  return (
    <BasisContext.Provider
      value={{
        basis,
        viewChanged: override?.identity === identity,
        showDetails,
        selection,
        choose: (value) => setOverride({ identity, selection: value }),
      }}
    >
      <div key={resetOnBasis ? `${identity}:${basis}` : identity}>
        {children}
        {detail?.identity === identity && detail.basis === basis && (
          <RecognitionDetailsDialog
            key={JSON.stringify(detail)}
            input={detail.input}
            onClose={() => setDetail(null)}
          />
        )}
      </div>
    </BasisContext.Provider>
  );
}

/** Standalone consumers omit basis and use the server's user default. */
export function useReportingViewChanged() {
  return useContext(BasisContext)?.viewChanged === true;
}

export function useReportingBasis() {
  return useContext(BasisContext)?.basis;
}

export function ReportingBasisControl({
  detail = false,
}: {
  detail?: boolean;
}) {
  const context = useContext(BasisContext);
  const t = useTranslations("common.reportingBasis");
  const ts = useTranslations("settings.preferences");
  const preference = usePreferencesStore(
    (state) => state.preferences?.reportingBasis,
  );
  const accrualFeatureEnabled = usePreferencesStore(
    (state) => state.preferences?.accrualEnabled ?? false,
  );
  const defaultBasis = preference === "accrual" ? "accrual" : "cash";
  if (!context || !accrualFeatureEnabled) return null;
  return (
    <div className="mb-4 space-y-2">
      <div
        className={SEGMENTED_GROUP_CLASS}
        role="group"
        aria-label={t("label")}
      >
        {(["cash", "accrual"] as const).map((basis) => {
          const label = ts(
            basis === "cash" ? "reportingCash" : "reportingAccrual",
          );
          return (
            <button
              key={basis}
              type="button"
              aria-pressed={context.basis === basis}
              className={segmentClass(context.basis === basis)}
              onClick={() =>
                context.choose(basis === defaultBasis ? "default" : basis)
              }
            >
              {basis === defaultBasis ? t("default", { basis: label }) : label}
            </button>
          );
        })}
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {t(detail ? "detailHelp" : "help")}
      </p>
    </div>
  );
}

export { CashReportingNotice } from "./CashReportingNotice";

/** Recognized report links expand facts; other routes and cash views keep normal navigation. */
export function useReportingRouter() {
  const router = useRouter();
  const context = useContext(BasisContext);
  const showDetails = context?.showDetails;
  const basis = context?.basis;
  return useMemo(
    () =>
      showDetails
        ? {
            ...router,
            push: (...args: Parameters<typeof router.push>) => {
              if (!showDetails(args[0])) {
                let href = args[0];
                if (href.startsWith("/transactions?") && basis) {
                  const url = new URL(href, "https://internal.invalid");
                  if (!url.searchParams.has("basis"))
                    url.searchParams.set("basis", basis);
                  href = `${url.pathname}${url.search}${url.hash}`;
                }
                if (args.length > 1) router.push(href, args[1]);
                else router.push(href);
              }
            },
          }
        : router,
    [basis, router, showDetails],
  );
}
