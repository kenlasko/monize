import apiClient from "./api";
import type { DocumentKind, StagedAttachment } from "@/types/attachment";

export interface SharedDocument {
  uploaderName: string | null;
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  documentKind: DocumentKind;
  documentRevision: number;
  sharedGroupId: string | null;
  sharedEntryId: string | null;
  entryTitle: string | null;
  originalAttachmentId: string | null;
  createdAt: string;
  canEdit: boolean;
}
export const sharedDocumentsApi = {
  list: async (groupId: string, entryId?: string, offset = 0) => {
    if (entryId)
      return {
        items: (
          await apiClient.get<SharedDocument[]>(
            `/shared-expenses/groups/${groupId}/entries/${entryId}/attachments`,
          )
        ).data,
        nextOffset: null,
      };
    return (
      await apiClient.get<{
        items: SharedDocument[];
        nextOffset: number | null;
      }>(`/shared-expenses/groups/${groupId}/documents`, { params: { offset } })
    ).data;
  },
  upload: async (
    groupId: string,
    entryId: string | undefined,
    file: StagedAttachment,
    operationId: string,
  ) => {
    const data = new FormData();
    data.append("file", file.file);
    if (file.original) data.append("original", file.original);
    data.append("operationId", operationId);
    return (
      await apiClient.post<SharedDocument>(
        `/shared-expenses/groups/${groupId}${entryId ? `/entries/${entryId}` : ""}/attachments`,
        data,
        { timeout: 60_000, headers: { "Content-Type": "multipart/form-data" } },
      )
    ).data;
  },
  update: async (
    groupId: string,
    document: SharedDocument,
    filename: string,
    documentKind: DocumentKind,
    entryId?: string | null,
  ) =>
    apiClient.patch(
      `/shared-expenses/groups/${groupId}/documents/${document.id}`,
      {
        expectedRevision: document.documentRevision,
        filename,
        documentKind,
        entryId,
      },
    ),
  publish: async (
    groupId: string,
    input: {
      operationId: string;
      sourceAttachmentId: string;
      entryId?: string;
      includeOriginal: boolean;
    },
  ) =>
    apiClient.post(
      `/shared-expenses/groups/${groupId}/documents/publish`,
      input,
    ),
};
