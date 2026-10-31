"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/Input";
import { DateInput } from "@/components/ui/DateInput";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { HOVER_ROW_ON_CARD } from "@/components/ui/Card";
import { useReportData } from "@/hooks/useReportData";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { transactionsApi } from "@/lib/transactions";
import type { Transaction } from "@/types/transaction";
import { hasShareableBankStructure } from "@/lib/shared-bank-eligibility";
import { SharedError } from "./SharedPrimitives";

export function SharedTransactionPicker({
  accountId,
  attachmentsOnly = false,
  onChoose,
}: {
  accountId?: string;
  attachmentsOnly?: boolean;
  onChoose: (row: Transaction) => void;
}) {
  const t = useTranslations("sharedExpenses");
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const key = JSON.stringify({
    accountId,
    attachmentsOnly,
    search,
    from,
    to,
    page,
  });
  const data = useReportData(
    () =>
      transactionsApi.getAll({
        accountId,
        search,
        page,
        limit: 25,
        startDate: from || undefined,
        endDate: to || undefined,
        hasAttachments: attachmentsOnly || undefined,
      }),
    [key],
    { requestKey: key },
  );
  const visible =
    data.dataKey === key
      ? data.data?.data.filter(
          (row) => attachmentsOnly || hasShareableBankStructure(row),
        )
      : undefined;
  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(draft);
          setPage(1);
        }}
      >
        <div className="min-w-0 flex-1">
          <Input
            label={t("searchEntries")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={200}
          />
        </div>
        <Button type="submit" variant="outline">
          {t("search")}
        </Button>
      </form>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <DateInput
          label={t("from")}
          value={from}
          onDateChange={(value) => {
            setFrom(value);
            setPage(1);
          }}
        />
        <DateInput
          label={t("to")}
          value={to}
          onDateChange={(value) => {
            setTo(value);
            setPage(1);
          }}
        />
      </div>
      <SharedError error={data.error} retry={data.reload} />
      {data.isLoading && <LoadingSpinner />}
      <div className="scrollbar-slim max-h-72 overflow-y-auto space-y-1">
        {visible?.map((row) => (
          <button
            key={row.id}
            type="button"
            className={`block text-left w-full p-3 rounded-md border border-gray-200 dark:border-gray-700 focus-visible:ring-2 focus-visible:ring-blue-500 ${HOVER_ROW_ON_CARD}`}
            onClick={() => onChoose(row)}
          >
            <span className="block break-words font-medium">
              {row.payee?.name ||
                row.payeeName ||
                row.description ||
                t("bankTransaction")}
            </span>
            <span className="flex flex-wrap justify-between gap-2 text-sm mt-1">
              <span>{formatDate(row.transactionDate)}</span>
              <span>
                {formatCurrency(Number(row.amount), row.currencyCode)}
              </span>
            </span>
          </button>
        ))}
      </div>
      {!data.isLoading && !data.error && visible?.length === 0 && (
        <EmptyState title={t("emptyEntries")} />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={page === 1 || data.isLoading}
          onClick={() => setPage(page - 1)}
        >
          {t("previousPage")}
        </Button>
        <Button
          variant="outline"
          disabled={
            data.dataKey !== key ||
            !data.data?.pagination.hasMore ||
            data.isLoading
          }
          onClick={() => setPage(page + 1)}
        >
          {t("loadMore")}
        </Button>
      </div>
    </div>
  );
}
