/**
 * Metadata for a file attached to a transaction. The bytes themselves are never
 * part of this payload -- they are fetched from the download endpoint.
 */
export interface Attachment {
  id: string;
  transactionId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
  /**
   * The unprocessed photo a scanned document came from, when one was kept.
   *
   * A scan pair is ONE attachment: this row is what the user sees, and the
   * original is reached through this id rather than listed beside it. `null`
   * for an ordinary upload; absent from an older backend, which reads the same
   * way.
   */
  originalAttachmentId?: string | null;
}

/** Client-side limits mirroring the server (server remains authoritative). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_ATTACHMENTS_PER_TRANSACTION = 10;
/**
 * A file staged against a transaction that does not exist yet.
 *
 * Two files rather than one, because a scan is a pair: the enhanced image the
 * user will see, and the photo it came from. Both are uploaded together once
 * the transaction has been created, in the request that makes them a pair.
 */
export interface StagedAttachment {
  file: File;
  original?: File;
}

export const ACCEPTED_ATTACHMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
];
