"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@/store/authStore";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useReportData } from "@/hooks/useReportData";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { SharedError } from "./SharedPrimitives";

/** Private review is requested only on its explicit page, under its owner. */
export function SharedReviewContent() {
  const pathname = usePathname();
  const userId = useAuthStore((state) => state.user?.id);
  const authenticated = useAuthStore((state) => state.isAuthenticated);
  const actingAs = useAuthStore((state) => state.actingAsUserId);
  if (
    !authenticated ||
    !userId ||
    actingAs ||
    pathname !== "/shared-expenses/review"
  )
    return null;
  return <ReviewList key={userId} />;
}

function ReviewList() {
  const t = useTranslations("sharedExpenses");
  const { formatNumber } = useNumberFormat();
  const review = useReportData(sharedExpensesApi.review, []);
  useEffect(() => {
    window.addEventListener("focus", review.reload);
    return () => window.removeEventListener("focus", review.reload);
  }, [review.reload]);
  if (review.isLoading) return <LoadingSpinner />;
  if (review.error)
    return (
      <SharedError
        error={new Error(t("reviewLoadFailed"))}
        retry={review.reload}
      />
    );
  if (!review.data) return null;
  const groups = review.data.groups.filter(
    (group) => group.pendingCount > 0 || group.accessRevoked,
  );
  if (groups.length === 0) return <EmptyState title={t("reviewCurrent")} />;
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <Card key={group.groupId} padding="md">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold break-words">{group.accountName}</h2>
              <p className="mt-1 text-sm">
                {group.accessRevoked
                  ? t("accessRevoked")
                  : t("reviewPending", {
                      count: formatNumber(group.pendingCount, 0),
                    })}
              </p>
            </div>
            <Link
              className="text-blue-600 dark:text-blue-400 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500"
              href={
                group.accessRevoked
                  ? `/shared-expenses/private-finances/${group.groupId}`
                  : `/shared-expenses/${group.groupId}?view=myFinances`
              }
            >
              {t(group.accessRevoked ? "retainedFinance" : "review")}
            </Link>
          </div>
        </Card>
      ))}
    </div>
  );
}
