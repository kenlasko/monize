"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { useDateFormat } from "@/hooks/useDateFormat";
import { sharedCommand, sharedExpensesApi } from "@/lib/shared-expenses";
import type { SharedEntry, SharedGroupDetail } from "@/types/shared-expense";
import { SharedEntryPreview } from "./SharedEntryPreview";
import { SharedAmount, SharedError, SharedNotice } from "./SharedPrimitives";
const SharedDocuments = dynamic(
  () => import("./SharedDocuments").then((m) => m.SharedDocuments),
  { ssr: false },
);

export function SharedEntryDetail({
  entry,
  group,
  onClose,
  onEdit,
  onRefund,
  onChanged,
}: {
  entry: SharedEntry;
  group: SharedGroupDetail;
  onClose: () => void;
  onEdit: () => void;
  onRefund: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("sharedExpenses");
  const { formatDate } = useDateFormat();
  const [pendingFiles, setPendingFiles] = useState(false);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const leave = (next: () => void) => {
    if (pendingFiles) setLeaving(() => next);
    else next();
  };
  const [reverse, setReverse] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [command] = useState(() => sharedCommand(entry.revision));
  const canEdit =
    entry.canEdit &&
    !group.archivedAt &&
    entry.state !== "REVERSED" &&
    group.role !== "VIEWER";
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await sharedExpensesApi.reverse(group.id, entry, reason, command);
      onChanged();
      onClose();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Modal
        pushHistory
        onBeforeClose={() => {
          if (pendingFiles) {
            setLeaving(() => onClose);
            return false;
          }
        }}
        isOpen
        title={entry.title}
        padding="md"
        maxWidth="2xl"
        onClose={() => leave(onClose)}
        footer={
          <>
            <Button variant="outline" onClick={() => leave(onClose)}>
              {t("close")}
            </Button>
            {canEdit && (
              <Button onClick={() => leave(onEdit)}>{t("edit")}</Button>
            )}
          </>
        }
      >
        <div className="space-y-5">
          <div className="flex flex-wrap justify-between gap-3 items-center">
            <div className="space-x-2">
              <Badge>{t(entry.type)}</Badge>
              <Badge variant={entry.state === "DRAFT" ? "amber" : "gray"}>
                {t(entry.state)}
              </Badge>
            </div>
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {formatDate(entry.date)}
            </span>
          </div>
          <p className="text-3xl font-semibold">
            <SharedAmount
              amount={entry.originalAmount}
              currency={entry.currencyCode}
              relativeTo={group.currencyCode}
            />
          </p>
          {entry.note && (
            <p className="whitespace-pre-wrap break-words">{entry.note}</p>
          )}
          <SharedEntryPreview entry={entry} group={group} />
          <div className="pt-4">
            <SharedDocuments
              group={group}
              entryId={entry.id}
              onPendingChange={setPendingFiles}
            />
          </div>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              {entry.type === "EXPENSE" && entry.state === "POSTED" && (
                <Button variant="outline" onClick={() => leave(onRefund)}>
                  {t("refund")}
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => leave(() => setReverse(true))}
              >
                {t("reverse")}
              </Button>
            </div>
          )}
        </div>
      </Modal>
      {reverse && (
        <Modal
          isOpen
          title={t("reverse")}
          padding="md"
          onClose={busy ? undefined : () => setReverse(false)}
          footer={
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setReverse(false)}
              >
                {t("cancel")}
              </Button>
              <Button
                variant="danger"
                isLoading={busy}
                disabled={!reason.trim()}
                onClick={remove}
              >
                {t("reverse")}
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <SharedError error={error} />
            <SharedNotice>{t("reverseHelp")}</SharedNotice>
            <Input
              label={t("reverseReason")}
              value={reason}
              maxLength={750}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </Modal>
      )}
      <ConfirmDialog
        isOpen={!!leaving}
        title={t("discardTitle")}
        message={t("pendingFilesLeave")}
        confirmLabel={t("discard")}
        onCancel={() => setLeaving(null)}
        onConfirm={() => {
          leaving?.();
          setLeaving(null);
        }}
      />
    </>
  );
}
