"use client";

import { useRef, useState } from "react";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import {
  sharedDocumentsApi,
  type SharedDocument,
} from "@/lib/shared-documents";
import type { StagedAttachment } from "@/types/attachment";
import type { SharedEntry, SharedEntryInput } from "@/types/shared-expense";

type PendingFile = StagedAttachment & { operationId: string };

/** Keep the saved entry and each upload receipt identity across partial failures. */
export function useSharedEntrySave({
  groupId,
  entryId,
  sourceDocument,
  onSaved,
  onClose,
}: {
  groupId: string;
  entryId?: string;
  sourceDocument?: SharedDocument;
  onSaved: (entry: SharedEntry) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [saved, setSaved] = useState<SharedEntry | null>(null);
  const savedRef = useRef<SharedEntry | null>(null);
  const inFlight = useRef(false);
  const linked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
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

  const save = async (
    input: SharedEntryInput,
    preview?: SharedEntry | null,
  ) => {
    if (inFlight.current || (!savedRef.current && !preview)) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      let result = savedRef.current;
      if (!result) {
        result = await sharedExpensesApi.saveEntry(
          groupId,
          {
            ...input,
            previewFingerprint: preview!.previewFingerprint,
          },
          entryId,
        );
        savedRef.current = result;
        setSaved(result);
        onSaved(result);
      }
      if (sourceDocument && !linked.current) {
        // A lost PATCH response must not make its successful link unretryable.
        const current = await sharedDocumentsApi.list(groupId, result.id);
        if (
          !current.items.some((document) => document.id === sourceDocument.id)
        ) {
          await sharedDocumentsApi.update(
            groupId,
            sourceDocument,
            sourceDocument.filename,
            sourceDocument.documentKind,
            result.id,
          );
        }
        linked.current = true;
      }
      const failed: PendingFile[] = [];
      for (const file of files) {
        try {
          await sharedDocumentsApi.upload(
            groupId,
            result.id,
            file,
            file.operationId,
          );
        } catch (cause) {
          failed.push(file);
          setError(cause);
        }
      }
      setFiles(failed);
      if (!failed.length) onClose();
    } catch (cause) {
      setError(cause);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { files, queue, saved, busy, error, save };
}
