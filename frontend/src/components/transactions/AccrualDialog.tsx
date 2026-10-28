"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { EmptyState } from "@/components/ui/EmptyState";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { Transaction, TransactionStatus } from "@/types/transaction";
import { transactionsApi } from "@/lib/transactions";
import { accrualsApi, type AccrualScheduleSummary } from "@/lib/accruals";
import { getErrorMessage } from "@/lib/errors";
import { AccrualForm, type AccrualComponent } from "./AccrualForm";

export function AccrualDialog({
  transactionId,
  onClose,
  onSaved,
  embedded = false,
}: {
  transactionId: string;
  onClose: () => void;
  onSaved: () => void;
  embedded?: boolean;
}) {
  const t = useTranslations("transactions.accrual");
  const tc = useTranslations("common");
  const { formatCurrency, formatNumber } = useNumberFormat();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${transactionId}:${attempt}`;
  const [result, setResult] = useState<{
    key: string;
    transaction?: Transaction;
    schedules?: AccrualScheduleSummary[];
    error?: string;
  } | null>(null);
  const [selected, setSelected] = useState("");
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      transactionsApi.getById(transactionId),
      accrualsApi.sourceSchedules(transactionId),
    ])
      .then(([transaction, schedules]) => {
        if (!cancelled) setResult({ key: requestKey, transaction, schedules });
      })
      .catch((reason) => {
        if (!cancelled)
          setResult({
            key: requestKey,
            error: getErrorMessage(reason, t("failed")),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, transactionId, t]);
  const current = result?.key === requestKey ? result : null;
  const transaction = current?.transaction;
  const components: AccrualComponent[] = transaction
    ? transaction.isSplit
      ? (transaction.splits ?? [])
          .filter(
            (split) =>
              !split.transferAccountId &&
              !split.investmentTransaction &&
              (!split.kind || split.kind === "category"),
          )
          .map<AccrualComponent>((split, index) => ({
            id: split.id,
            label: t("split", {
              number: formatNumber(index + 1),
              amount: formatCurrency(
                Number(split.amount),
                transaction.currencyCode,
                4,
              ),
            }),
            family: split.category
              ? split.category.isIncome
                ? "income"
                : "expense"
              : null,
          }))
      : [
          {
            id: null,
            label: t("whole"),
            family: transaction.category
              ? transaction.category.isIncome
                ? "income"
                : "expense"
              : null,
          },
        ]
    : [];
  const component =
    components.find((value) => (value.id ?? "") === selected) ?? components[0];
  const schedule = current?.schedules?.find(
    (value) => value.sourceSplitId === component?.id,
  );
  const content = (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-300">{t("help")}</p>
      {notice && <p role="status">{notice}</p>}
      {!current && <p role="status">{tc("loading")}</p>}
      {current?.error && (
        <div role="alert">
          <p>{current.error}</p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t("retry")}
          </Button>
        </div>
      )}
      {transaction && components.length === 0 && (
        <EmptyState title={t("noEligible")} />
      )}
      {component && transaction && (
        <>
          {transaction.isSplit && (
            <Select
              disabled={busy}
              label={t("component")}
              value={component.id ?? ""}
              options={components.map((value) => ({
                value: value.id ?? "",
                label: value.label,
              }))}
              onChange={(event) => setSelected(event.target.value)}
            />
          )}
          <AccrualForm
            key={`${requestKey}:${component.id ?? "whole"}`}
            embedded={embedded}
            transactionId={transaction.id}
            paymentMonth={transaction.transactionDate.slice(0, 7)}
            component={component}
            schedule={schedule}
            disabled={transaction.status === TransactionStatus.VOID}
            onSaved={onSaved}
            onBusyChange={setBusy}
            onStale={() => {
              setBusy(false);
              setNotice(t("changed"));
              setAttempt((value) => value + 1);
            }}
          />
        </>
      )}
    </div>
  );
  return embedded ? (
    <section
      aria-label={t("title")}
      className="space-y-4 border-t border-gray-200 dark:border-gray-700 pt-4"
    >
      {content}
    </section>
  ) : (
    <Modal
      padding="md"
      isOpen
      onClose={() => {
        if (!busy) onClose();
      }}
      title={t("title")}
      maxWidth="lg"
    >
      {content}
    </Modal>
  );
}
