"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { TABLE_CLASS, TABLE_BODY_CLASS, Th, Td } from "@/components/ui/Table";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useDateFormat } from "@/hooks/useDateFormat";
import { accrualsApi, type AccrualSourceImpact } from "@/lib/accruals";
import type { UpdateTransactionData } from "@/types/transaction";
import { AccrualPlanTable } from "./AccrualPreviewTable";

/** The submitted patch is frozen before preview; confirm never reads a live form. */
export function useAccrualSourceEditReview(sourceId: string | undefined) {
  const [preview, setPreview] = useState<{
    sourceId: string;
    value: AccrualSourceImpact;
  } | null>(null);
  const decision = useRef<((accepted: boolean) => void) | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
      decision.current?.(false);
      decision.current = null;
    };
  }, [sourceId]);
  const decide = (accepted: boolean) => {
    setPreview(null);
    decision.current?.(accepted);
    decision.current = null;
  };
  const review = async (patch: UpdateTransactionData) => {
    if (!sourceId) return null;
    generation.current += 1;
    const origin = generation.current;
    decision.current?.(false);
    decision.current = null;
    setPreview(null);
    // JSON matches the wire representation, removes undefined and detaches arrays.
    const frozen: UpdateTransactionData = JSON.parse(JSON.stringify(patch));
    const value = await accrualsApi.sourcePreview(sourceId, frozen);
    if (origin !== generation.current) return null;
    if (!value.fingerprint) return frozen;
    setPreview({ sourceId, value });
    const accepted = await new Promise<boolean>((resolve) => {
      decision.current = resolve;
    });
    return accepted && origin === generation.current
      ? { ...frozen, accrualImpactFingerprint: value.fingerprint }
      : null;
  };
  return {
    review,
    dialog:
      preview && preview.sourceId === sourceId ? (
        <AccrualSourceEditReview preview={preview.value} onDecision={decide} />
      ) : null,
  };
}

export function AccrualSourceEditReview({
  preview,
  onDecision,
}: {
  preview: AccrualSourceImpact;
  onDecision: (accepted: boolean) => void;
}) {
  const t = useTranslations("transactions.accrual");
  const tc = useTranslations("common");
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  return (
    <Modal
      padding="md"
      isOpen
      title={t("reviewEdit")}
      onClose={() => onDecision(false)}
      maxWidth="lg"
    >
      <div className="space-y-4">
        <p>{t("reviewHelp")}</p>
        {preview.impacts.map((impact) => (
          <section key={impact.scheduleId} className="space-y-3">
            <p>
              {impact.sourceSplitId
                ? `${t("component")}: ${impact.sourceSplitId}`
                : t("whole")}
            </p>
            <p>
              {t("source", {
                date: formatDate(impact.paymentDateBefore),
                amount: formatCurrency(
                  Number(impact.before.amount),
                  impact.currencyBefore,
                  4,
                ),
              })}
            </p>
            <details open>
              <summary>{t("existing")}</summary>
              <AccrualPlanTable
                plan={impact.before}
                currency={impact.currencyBefore}
              />
            </details>
            {impact.after ? (
              <details open>
                <summary>{t("afterEdit")}</summary>
                <p>
                  {t("source", {
                    date: formatDate(impact.paymentDateAfter),
                    amount: formatCurrency(
                      Number(impact.after.amount),
                      impact.currencyAfter,
                      4,
                    ),
                  })}
                </p>
                <AccrualPlanTable
                  plan={impact.after}
                  currency={impact.currencyAfter}
                />
              </details>
            ) : (
              <p role="status">{t("removeImpact")}</p>
            )}
            <details>
              <summary>
                {t(impact.familyBefore === "expense" ? "prepaid" : "unearned")}
              </summary>
              <p>{t("balanceHelp")}</p>
              <table className={TABLE_CLASS}>
                <thead>
                  <tr>
                    <Th>{t("recognition")}</Th>
                    <Th>
                      {t("existing")}{" "}
                      {t(
                        impact.familyBefore === "expense"
                          ? "prepaid"
                          : "unearned",
                      )}{" "}
                      ({impact.currencyBefore})
                    </Th>
                    <Th>
                      {t("afterEdit")}{" "}
                      {t(
                        (impact.familyAfter ?? impact.familyBefore) === "income"
                          ? "unearned"
                          : "prepaid",
                      )}{" "}
                      ({impact.currencyAfter})
                    </Th>
                  </tr>
                </thead>
                <tbody className={TABLE_BODY_CLASS}>
                  {impact.timingBalances.map((row) => (
                    <tr key={row.asOf}>
                      <Td>{formatDate(row.asOf)}</Td>
                      <Td>
                        {formatCurrency(
                          Number(row.before),
                          impact.currencyBefore,
                          4,
                        )}
                      </Td>
                      <Td>
                        {formatCurrency(
                          Number(row.after),
                          impact.currencyAfter,
                          4,
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </section>
        ))}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => onDecision(false)}
          >
            {tc("cancel")}
          </Button>
          <Button type="button" onClick={() => onDecision(true)}>
            {t("confirmEdit")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
