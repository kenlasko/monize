"use client";
import { useTranslations } from "next-intl";
import { Button, ButtonLink } from "@/components/ui/Button";
import { useReportData } from "@/hooks/useReportData";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import { AttachmentsSection } from "@/components/transactions/AttachmentsSection";
import { SharedError, SharedNotice } from "./SharedPrimitives";

export function SharedLinkedTransactionNotice({
  postingId,
  transactionId,
  onClose,
}: {
  postingId: string;
  transactionId: string;
  onClose?: () => void;
}) {
  const t = useTranslations("sharedExpenses");
  const data = useReportData(
    () => sharedExpensesApi.postingLocation(postingId),
    [postingId],
  );
  return (
    <div className="space-y-4">
      <SharedNotice>{t("linkedTransactionHelp")}</SharedNotice>
      <SharedError error={data.error} retry={data.reload} />
      <AttachmentsSection transactionId={transactionId} />
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="outline" onClick={onClose}>
          {t("close")}
        </Button>
        {data.data && (
          <ButtonLink
            href={`/shared-expenses/private-finances/${data.data.groupId}`}
            onClick={onClose}
          >
            {t("myFinances")}
          </ButtonLink>
        )}
      </div>
    </div>
  );
}
