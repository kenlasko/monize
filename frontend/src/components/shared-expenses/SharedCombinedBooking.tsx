"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useReportData } from "@/hooks/useReportData";
import { sharedCommand, sharedExpensesApi } from "@/lib/shared-expenses";
import type {
  SharedEntry,
  SharedEntryInput,
  SharedFinanceInput,
  SharedGroupDetail,
} from "@/types/shared-expense";
import { SharedError, SharedNotice } from "./SharedPrimitives";
import { SharedBooking } from "./SharedBooking";

export function SharedCombinedBooking({
  group,
  entry,
  entryInput,
  entryId,
  initialInput,
  onClose,
  onSaved,
}: {
  group: SharedGroupDetail;
  entry: SharedEntry;
  entryInput: SharedEntryInput;
  entryId?: string;
  initialInput?: Partial<SharedFinanceInput>;
  onClose: () => void;
  onSaved: (entry: SharedEntry) => Promise<void>;
}) {
  const t = useTranslations("sharedExpenses");
  const finances = useReportData(
    () => sharedExpensesApi.finances(group.id),
    [group.id],
  );
  const [command] = useState(() => sharedCommand(group.revision));
  const [enableCommand] = useState(() => sharedCommand(group.revision));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      await sharedExpensesApi.enableFinance(group.id, {
        ...enableCommand,
        accountName: group.name,
      });
      finances.reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  if (finances.data?.integration) {
    const previous = finances.data.entries.find(
      (row) => row.entryId === entry.id,
    );
    return (
      <SharedBooking
        group={group}
        row={{
          entryId: entry.id,
          title: entry.title,
          date: entry.date,
          type: entry.type,
          state: entry.state,
          revision: entry.revision,
          effect: entry.ownEffect ?? null,
          needsReview: true,
          posting: previous?.posting ?? null,
        }}
        initialInput={initialInput}
        onClose={onClose}
        onSaved={() => {}}
        onPreview={async (finance) => {
          const result = await sharedExpensesApi.previewEntryFinance(group.id, {
            ...command,
            entryId,
            entry: entryInput,
            finance,
          });
          return { ...result.finance, commitFingerprint: result.fingerprint };
        }}
        onCommit={async (finance, preview) => {
          const result = await sharedExpensesApi.saveEntryFinance(group.id, {
            ...command,
            entryId,
            entry: entryInput,
            finance,
            previewFingerprint: preview.commitFingerprint,
          });
          await onSaved(result.entry);
        }}
      />
    );
  }
  return (
    <Modal
      isOpen
      title={t("enableFinance")}
      padding="md"
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            isLoading={busy || finances.isLoading}
            disabled={!finances.data || !!finances.error}
            onClick={enable}
          >
            {t("next")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <SharedNotice>{t("financeHelp")}</SharedNotice>
        <p>{t("managedHelp")}</p>
        <SharedError error={error || finances.error} retry={finances.reload} />
      </div>
    </Modal>
  );
}
