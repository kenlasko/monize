import { isAxiosError } from 'axios';
import apiClient from './api';
import type { Attachment, AttachmentParent, DocumentKind } from '@/types/attachment';
import { invalidateCache } from './apiCache';

/**
 * Same-origin URL for an attachment's bytes. Rendered directly in an <img> (for
 * images) or an <a download> (for any type); the request carries the auth cookie
 * and streams straight from the backend.
 */
export function attachmentDownloadUrl(id: string): string {
  return `/api/v1/attachments/${id}/download`;
}

/**
 * The code the server puts on that one refusal (`AttachmentStoreUnreachableError`).
 * Mirrored here rather than imported: the client and the server share the string,
 * not the module.
 */
export const ATTACHMENT_STORE_UNREACHABLE_CODE = 'ATTACHMENT_STORE_UNREACHABLE';

/**
 * Whether a failed read means "this deployment cannot reach the backend holding
 * these bytes".
 *
 * It is the one attachment failure a reader can do something about: nothing is
 * lost, a setting is missing, and downloading fails for the same reason -- so the
 * usual "you can still download the file" advice is wrong for it. Everything
 * else, including a 404, stays the generic failure.
 *
 * Matched on the **code**, not the status. A reverse proxy answers 503 when the
 * backend is down, and reading the status alone would tell the reader their file
 * sits in an unconfigured storage backend during an ordinary outage.
 */
export function isStoreUnreachable(error: unknown): boolean {
  if (!isAxiosError(error) || error.response?.status !== 503) return false;
  return errorCode(error.response.data) === ATTACHMENT_STORE_UNREACHABLE_CODE;
}

/**
 * The `code` on an error body, whatever shape axios handed back.
 *
 * `fetchBytes` asks for an `arraybuffer`, and axios applies that to the error
 * response too -- so the body of a refusal arrives as bytes and has to be decoded
 * before it can be read. Duck-typed rather than `instanceof ArrayBuffer`: a buffer
 * that crossed a realm boundary (jsdom in the tests, a worker in a browser) fails
 * that check while decoding perfectly well, and the whole point of this function
 * is to be right about the body it is actually given. A body that is not JSON, or
 * carries no code, is not this failure.
 */
function errorCode(body: unknown): string | undefined {
  const text = decodeBody(body);
  if (text === null) {
    return typeof body === 'object' && body !== null
      ? (body as { code?: string }).code
      : undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as { code?: string }).code
      : undefined;
  } catch {
    return undefined;
  }
}

/** A response body as text, or `null` when it is not text or bytes. */
function decodeBody(body: unknown): string | null {
  if (typeof body === 'string') return body;
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  const maybeBuffer = body as { byteLength?: unknown } | null;
  if (
    typeof body === 'object' &&
    body !== null &&
    typeof maybeBuffer?.byteLength === 'number'
  ) {
    try {
      return new TextDecoder().decode(body as ArrayBuffer);
    } catch {
      return null;
    }
  }
  return null;
}

/** An attachment's bytes, as the preview reads them. */
export interface AttachmentBytes {
  bytes: ArrayBuffer;
  /** What the server said the bytes are (it sniffed them on upload). */
  contentType: string;
}

/**
 * The preview reads a whole file, and a 10 MB scan over a phone connection
 * takes longer than the client's 10 s default.
 */
export const ATTACHMENT_BYTES_TIMEOUT_MS = 60_000;

/**
 * The collection route for a parent's attachments: one route per parent kind
 * on the server (`attachments.controller.ts`), never two ids in one request.
 */
export function attachmentParentPath(parent: AttachmentParent): string {
  return 'warrantyId' in parent
    ? `/warranties/${parent.warrantyId}/attachments`
    : `/transactions/${parent.transactionId}/attachments`;
}

export const attachmentsApi = {
  list: async (parent: AttachmentParent): Promise<Attachment[]> => {
    const response = await apiClient.get<Attachment[]>(
      attachmentParentPath(parent),
    );
    return response.data;
  },

  /**
   * Upload one attachment, optionally with the unprocessed photo it was
   * scanned from.
   *
   * Both parts travel in ONE request because the server writes them in one
   * transaction: uploading the original separately would leave a window where
   * the pair is half stored, and a failure would leave an orphan the user can
   * see but not explain.
   *
   * `documentKind` is a warranty's field only: the transaction route takes no
   * body beside the files, so it is never sent there.
   */
  upload: async (
    parent: AttachmentParent,
    file: File,
    original?: File,
    documentKind?: DocumentKind,
  ): Promise<Attachment> => {
    const formData = new FormData();
    formData.append('file', file);
    if (original) formData.append('original', original);
    if (documentKind && 'warrantyId' in parent) {
      formData.append('documentKind', documentKind);
    }
    const response = await apiClient.post<Attachment>(
      attachmentParentPath(parent),
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    );
    invalidateCache('attachments:');
    // A warranty carries its `documentCount`, so its cached view moved too.
    if ('warrantyId' in parent) invalidateCache('warranties:');
    return response.data;
  },

  /**
   * Put a document the reader already uploaded (a transaction's receipt,
   * another warranty's manual) on a warranty as well. The server copies it:
   * an attachment has one parent, so the source stays where it was. A retry
   * with the same `operationId` returns the first copy.
   */
  copyToWarranty: async (
    warrantyId: string,
    sourceAttachmentId: string,
    documentKind: DocumentKind,
    operationId: string,
  ): Promise<Attachment> => {
    const response = await apiClient.post<Attachment>(
      `/warranties/${warrantyId}/attachments/copy`,
      { sourceAttachmentId, documentKind, operationId },
    );
    invalidateCache('attachments:');
    invalidateCache('warranties:');
    return response.data;
  },

  /**
   * The bytes behind an attachment, for the in-app preview.
   *
   * Through the axios client rather than a bare `<img src>` or a plain
   * `fetch`, so the 401-refresh interceptor applies: an `<img>` whose access
   * token expired simply fails to load, with nothing able to refresh it. The
   * same-origin URL and credentials mean the request is still answered from
   * the HTTP cache the row's thumbnail primed. `signal` lets a closed preview
   * abandon a transfer it no longer needs.
   */
  fetchBytes: async (
    id: string,
    signal?: AbortSignal,
  ): Promise<AttachmentBytes> => {
    const response = await apiClient.get<ArrayBuffer>(
      `/attachments/${id}/download`,
      {
        responseType: 'arraybuffer',
        timeout: ATTACHMENT_BYTES_TIMEOUT_MS,
        signal,
      },
    );
    const header = response.headers?.['content-type'];
    return {
      bytes: response.data,
      contentType:
        typeof header === 'string' && header.length > 0
          ? header.split(';')[0].trim()
          : 'application/octet-stream',
    };
  },

  /**
   * Change what kind of document a warranty's document is. A transaction's
   * own attachment has no kind to change (the server answers 400).
   */
  updateDocumentKind: async (
    id: string,
    documentKind: DocumentKind,
  ): Promise<Attachment> => {
    const response = await apiClient.patch<Attachment>(`/attachments/${id}`, {
      documentKind,
    });
    invalidateCache('attachments:');
    invalidateCache('warranties:');
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/attachments/${id}`);
    invalidateCache('attachments:');
    // The id does not say which parent it hung off; when that was a warranty,
    // its cached `documentCount` is now one too many.
    invalidateCache('warranties:');
  },
};
