"use client";

import { useEffect, useState } from "react";
import { SharedNavigationGuard } from "./SharedNavigationGuard";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { AttachmentsSection } from "@/components/transactions/AttachmentsSection";
import {
  AttachmentPreviewDialog,
  type PreviewTarget,
} from "@/components/transactions/AttachmentPreviewDialog";
import { Button } from "@/components/ui/Button";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { FormActions } from "@/components/ui/FormActions";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SharedDocumentDestination } from "./SharedDocumentDestination";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useReportData } from "@/hooks/useReportData";
import { attachmentsApi } from "@/lib/attachments";
import {
  sharedDocumentsApi,
  type SharedDocument,
} from "@/lib/shared-documents";
import type { SharedGroupDetail } from "@/types/shared-expense";
import {
  DOCUMENT_KINDS,
  type StagedAttachment,
  type DocumentKind,
} from "@/types/attachment";
import { SharedError, SharedNotice } from "./SharedPrimitives";
const SharedDocumentCopy = dynamic(
  () => import("./SharedDocumentCopy").then((m) => m.SharedDocumentCopy),
  { ssr: false },
);

export function SharedDocuments({
  group,
  entryId,
  onOpenEntry,
  onCreateEntry,
  onPendingChange,
  allowUpload = true,
}: {
  group: SharedGroupDetail;
  entryId?: string;
  onPendingChange?: (pending: boolean) => void;
  allowUpload?: boolean;
  onOpenEntry?: (id: string) => void;
  onCreateEntry?: (document: SharedDocument) => void;
}) {
  const t = useTranslations("sharedExpenses");
  const ta = useTranslations("attachments");
  const tw = useTranslations("warranties");
  const { formatBytes } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const [destination, setDestination] = useState<{
    id: string | null;
    title: string | null;
  }>({ id: null, title: null });
  const [offset, setOffset] = useState(0);
  const key = `${group.id}:${entryId ?? "all"}:${offset}`;
  const documents = useReportData(
    () => sharedDocumentsApi.list(group.id, entryId, offset),
    [key, group.revision],
    { requestKey: key },
  );
  const [files, setFiles] = useState<
    (StagedAttachment & { operationId: string })[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [edit, setEdit] = useState<SharedDocument | null>(null);
  const [remove, setRemove] = useState<SharedDocument | null>(null);
  const [filename, setFilename] = useState("");
  const [kind, setKind] = useState<DocumentKind>("other");
  const [copy, setCopy] = useState(false);
  const pending = files.length > 0 || busy;
  useEffect(() => {
    onPendingChange?.(pending);
    return () => onPendingChange?.(false);
  }, [pending, onPendingChange]);
  const canWrite = group.role !== "VIEWER" && !group.archivedAt;
  const queue = (next: StagedAttachment[]) =>
    setFiles(
      next.map((file) => ({
        ...file,
        operationId:
          files.find(
            (old) => old.file === file.file && old.original === file.original,
          )?.operationId ?? crypto.randomUUID(),
      })),
    );
  const upload = async () => {
    setBusy(true);
    setError(null);
    const failed: typeof files = [];
    for (const file of files) {
      try {
        await sharedDocumentsApi.upload(
          group.id,
          entryId,
          file,
          file.operationId,
        );
      } catch (cause) {
        failed.push(file);
        setError(cause);
      }
    }
    setFiles(failed);
    setBusy(false);
    documents.reload();
  };
  const update = async () => {
    if (!edit) return;
    setBusy(true);
    setError(null);
    try {
      await sharedDocumentsApi.update(
        group.id,
        edit,
        filename,
        kind,
        destination.id,
      );
      setEdit(null);
      documents.reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  const deleteFile = async () => {
    if (!remove || busy) return;
    setBusy(true);
    setError(null);
    try {
      await attachmentsApi.delete(remove.id);
      setRemove(null);
      documents.reload();
    } catch (cause) {
      setError(cause);
      setRemove(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <SharedNavigationGuard
        when={pending}
        message={t("pendingFilesLeave")}
        guardBack={!entryId}
      />
      <SharedError
        error={error || documents.error}
        retry={documents.error ? documents.reload : undefined}
      />
      {files.length > 0 && Boolean(error) && (
        <SharedNotice>{t("fileFailed")}</SharedNotice>
      )}
      {canWrite && allowUpload && (
        <fieldset disabled={busy} className="space-y-3">
          <AttachmentsSection
            pendingHint={t("uploadHint")}
            hasSavedAttachments={
              documents.dataKey !== key ||
              documents.isLoading ||
              !!documents.error ||
              !!documents.data?.items.length
            }
            headerActions={
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setCopy(true)}
                >
                  {t("copyPrivate")}
                </Button>
                <InfoTooltip text={t("fileHelp")} usePortal />
              </>
            }
            stagedFiles={files}
            onStagedFilesChange={queue}
          />
          <div className="flex flex-wrap gap-2">
            {files.length > 0 && (
              <Button type="button" isLoading={busy} onClick={upload}>
                {t("uploadFiles")}
              </Button>
            )}
          </div>
        </fieldset>
      )}
      {(!canWrite || !allowUpload) &&
        documents.dataKey === key &&
        !documents.isLoading &&
        !documents.error &&
        documents.data?.items.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {ta("empty")}
          </p>
        )}
      <ul className="space-y-2">
        {documents.dataKey === key &&
          documents.data?.items.map((document) => (
            <li
              key={document.id}
              className="rounded-md border border-gray-200 dark:border-gray-700 p-3"
            >
              <button
                type="button"
                className="block text-left w-full min-w-0 focus-visible:ring-2 focus-visible:ring-blue-500"
                onClick={() =>
                  setPreview({ kind: "saved", attachment: document })
                }
              >
                <p className="font-medium break-words">{document.filename}</p>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  {formatBytes(document.byteSize)}
                </p>
                <p className="text-xs mt-2 break-words">
                  {document.entryTitle ?? t("directFiles")}
                  {document.uploaderName && (
                    <span className="block mt-1">
                      {t("activityBy", {
                        actor: document.uploaderName,
                        date: formatDate(document.createdAt),
                      })}
                    </span>
                  )}
                </p>
              </button>
              {document.sharedEntryId && onOpenEntry && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenEntry(document.sharedEntryId!)}
                >
                  {t("openEntry")}
                </Button>
              )}
              {!document.sharedEntryId && document.canEdit && onCreateEntry && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => onCreateEntry(document)}
                >
                  {t("expenseFromFile")}
                </Button>
              )}
              {document.canEdit && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEdit(document);
                      setDestination({
                        id: document.sharedEntryId,
                        title: document.entryTitle,
                      });
                      setFilename(document.filename);
                      setKind(document.documentKind);
                    }}
                  >
                    {t("edit")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setRemove(document)}
                  >
                    {ta("delete")}
                  </Button>
                </div>
              )}
            </li>
          ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {offset > 0 && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setOffset(Math.max(0, offset - 100))}
          >
            {t("previousPage")}
          </Button>
        )}
        {documents.dataKey === key &&
          documents.data?.nextOffset !== null &&
          documents.data?.nextOffset !== undefined && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setOffset(documents.data!.nextOffset!)}
            >
              {t("loadMore")}
            </Button>
          )}
      </div>
      {preview && (
        <AttachmentPreviewDialog
          isOpen
          target={preview}
          onClose={() => setPreview(null)}
        />
      )}
      {edit && (
        <Modal
          isOpen
          title={t("renameFile")}
          padding="none"
          className="p-6"
          onClose={() => setEdit(null)}
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!busy) void update();
            }}
          >
            <SharedError error={error} />
            <Input
              label={t("filename")}
              value={filename}
              maxLength={255}
              onChange={(e) => setFilename(e.target.value)}
            />
            <Select
              label={t("documentKind")}
              value={kind}
              options={DOCUMENT_KINDS.map((value) => ({
                value,
                label: tw(`documents.kinds.${value}`),
              }))}
              onChange={(e) => setKind(e.target.value as DocumentKind)}
            />
            <SharedDocumentDestination
              groupId={group.id}
              value={destination.id}
              label={destination.title}
              onChange={(id, title) => setDestination({ id, title })}
            />
            <FormActions
              onCancel={() => setEdit(null)}
              submitLabel={t("saveChanges")}
              isSubmitting={busy}
            />
          </form>
        </Modal>
      )}
      <ConfirmDialog
        isOpen={!!remove}
        title={ta("delete")}
        message={remove?.filename ?? ""}
        onConfirm={deleteFile}
        onCancel={() => setRemove(null)}
      />
      {copy && (
        <SharedDocumentCopy
          groupId={group.id}
          entryId={entryId}
          onClose={() => setCopy(false)}
          onSaved={() => {
            setCopy(false);
            documents.reload();
          }}
        />
      )}
    </div>
  );
}
