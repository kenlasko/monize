"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { FormActions } from "@/components/ui/FormActions";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { useReportData } from "@/hooks/useReportData";
import { attachmentsApi } from "@/lib/attachments";
import { sharedDocumentsApi } from "@/lib/shared-documents";
import { AttachmentPreviewDialog } from "@/components/transactions/AttachmentPreviewDialog";
import { SharedWarrantyPicker } from "./SharedWarrantyPicker";
import { SharedTransactionPicker } from "./SharedTransactionPicker";
import { SharedError, SharedNotice, SharedTabs } from "./SharedPrimitives";

export function SharedDocumentCopy({
  groupId,
  entryId,
  onClose,
  onSaved,
}: {
  groupId: string;
  entryId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("sharedExpenses");
  const [transactionId, setTransaction] = useState("");
  const [warrantyId, setWarranty] = useState("");
  const [parentKind, setParentKind] = useState<
    "bankTransaction" | "warrantyDocuments"
  >("bankTransaction");
  const [preview, setPreview] = useState(false);
  const parentKey =
    parentKind === "bankTransaction" ? transactionId : warrantyId;
  const [source, setSource] = useState("");
  const [original, setOriginal] = useState(false);
  const [operationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const files = useReportData(
    () =>
      parentKey
        ? attachmentsApi.list(
            parentKind === "bankTransaction"
              ? { transactionId }
              : { warrantyId },
          )
        : Promise.resolve(null),
    [parentKind, parentKey],
    { requestKey: `${parentKind}:${parentKey}` },
  );
  const copy = async () => {
    setBusy(true);
    setError(null);
    try {
      await sharedDocumentsApi.publish(groupId, {
        operationId,
        sourceAttachmentId: source,
        entryId,
        includeOriginal: original,
      });
      onSaved();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Modal
        isOpen
        title={t("copyPrivate")}
        padding="none"
        className="p-6"
        maxWidth="lg"
        onClose={busy ? undefined : onClose}
      >
        <div className="space-y-4">
          <SharedNotice>{t("copyHelp")}</SharedNotice>
          <SharedError error={error || files.error} />
          <SharedTabs
            label={t("copyPrivate")}
            value={parentKind}
            onChange={(kind) => {
              setParentKind(kind);
              setSource("");
              setOriginal(false);
            }}
            options={[
              { value: "bankTransaction", label: t("bankTransaction") },
              { value: "warrantyDocuments", label: t("warrantyDocuments") },
            ]}
          />
          {parentKind === "warrantyDocuments" ? (
            <SharedWarrantyPicker
              onChoose={(id) => {
                setWarranty(id);
                setSource("");
                setOriginal(false);
              }}
            />
          ) : (
            <SharedTransactionPicker
              attachmentsOnly
              onChoose={(row) => {
                setTransaction(row.id);
                setSource("");
                setOriginal(false);
              }}
            />
          )}
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (
                !busy &&
                source &&
                files.dataKey === `${parentKind}:${parentKey}`
              )
                void copy();
            }}
          >
            {files.dataKey === `${parentKind}:${parentKey}` && files.data && (
              <>
                <Select
                  label={t("copyDocument")}
                  value={source}
                  options={[
                    { value: "", label: t("choose") },
                    ...files.data.map((file) => ({
                      value: file.id,
                      label: file.filename,
                    })),
                  ]}
                  onChange={(e) => {
                    setSource(e.target.value);
                    setOriginal(false);
                  }}
                />
                {source && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setPreview(true)}
                  >
                    {t("previewFile")}
                  </Button>
                )}
                {files.data.find((f) => f.id === source)
                  ?.originalAttachmentId && (
                  <label className="flex items-center gap-3 text-sm">
                    <ToggleSwitch
                      label={t("includeOriginal")}
                      checked={original}
                      onChange={setOriginal}
                    />
                    {t("includeOriginal")}
                  </label>
                )}
              </>
            )}
            <FormActions
              onCancel={onClose}
              submitLabel={t("copy")}
              isSubmitting={busy}
              submitDisabled={
                !source || files.dataKey !== `${parentKind}:${parentKey}`
              }
            />
          </form>
        </div>
      </Modal>
      {preview && files.data?.find((f) => f.id === source) && (
        <AttachmentPreviewDialog
          isOpen
          target={{
            kind: "saved",
            attachment: files.data.find((f) => f.id === source)!,
          }}
          onClose={() => setPreview(false)}
        />
      )}
    </>
  );
}
