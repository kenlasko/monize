import type { AttachmentKind, ChatAttachment } from '@/types/ai';

// Keep these in sync with the backend caps in
// backend/src/ai/query/dto/ai-query.dto.ts.
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const MAX_ATTACHMENT_MB = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));
export const MAX_TOTAL_ATTACHMENT_MB = Math.round(
  MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024),
);

/** MIME types the assistant accepts, mirroring the backend whitelist. */
export const ACCEPTED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/csv',
  'text/plain',
] as const;

/**
 * Extension -> canonical MIME. Used as a fallback when the browser-reported MIME
 * is missing or unrecognised -- common for CSV, which browsers report as
 * text/csv, application/vnd.ms-excel, or empty.
 */
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
};

/**
 * `accept` attribute for the file input. Lists both extensions AND the accepted
 * MIME types: an extension-only list hides files that carry the right MIME but
 * no (or a different) extension from the OS picker -- e.g. a real application/pdf
 * downloaded without a ".pdf" suffix, which is exactly what could not be
 * attached. The MIME entries let the picker match those by content type.
 */
export const ATTACHMENT_ACCEPT =
  '.png,.jpg,.jpeg,.gif,.webp,.pdf,.csv,.txt,' +
  'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/csv,text/plain';

/** An i18n error key plus interpolation values, surfaced as a toast. */
export interface AttachmentError {
  key: string;
  values?: Record<string, string | number>;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

/** Resolve a file to one of the accepted MIME types, or null if unsupported. */
export function resolveMediaType(file: File): string | null {
  // Trust the browser-reported MIME when it is one we accept: it describes the
  // file's actual format, whereas the filename extension can be missing or
  // misleading (e.g. a real application/pdf saved without a ".pdf" suffix, or a
  // file renamed to the wrong extension). Fall back to the extension only when
  // the MIME is absent or unrecognised -- common for CSV, which browsers report
  // as text/csv, application/vnd.ms-excel, or ''.
  if ((ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return file.type;
  }
  const byExt = EXT_TO_MIME[extensionOf(file.name)];
  if (byExt) return byExt;
  return null;
}

export function kindForMediaType(mediaType: string): AttachmentKind {
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType.startsWith('image/')) return 'image';
  return 'text';
}

/** Validate a single file's type and per-file size. Returns null when valid. */
export function validateFile(file: File): AttachmentError | null {
  if (!resolveMediaType(file)) {
    return { key: 'chat.errors.unsupportedType', values: { filename: file.name } };
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return {
      key: 'chat.errors.fileTooLarge',
      values: { filename: file.name, maxMb: MAX_ATTACHMENT_MB },
    };
  }
  return null;
}

/**
 * Validate that adding `incoming` files to the current selection stays within
 * the count and total-size caps. Returns null when the addition is allowed.
 */
export function validateAddition(
  current: ChatAttachment[],
  incoming: File[],
): AttachmentError | null {
  if (current.length + incoming.length > MAX_ATTACHMENTS) {
    return {
      key: 'chat.errors.tooManyAttachments',
      values: { max: MAX_ATTACHMENTS },
    };
  }
  const currentBytes = current.reduce((sum, a) => sum + a.size, 0);
  const incomingBytes = incoming.reduce((sum, f) => sum + f.size, 0);
  if (currentBytes + incomingBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    return {
      key: 'chat.errors.totalTooLarge',
      values: { maxMb: MAX_TOTAL_ATTACHMENT_MB },
    };
  }
  return null;
}

function newId(): string {
  // crypto.randomUUID() (not Math.random) so the security scanner doesn't flag
  // a weak RNG; this id is only a client-side list key / removal handle.
  return `att-${crypto.randomUUID()}`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Read a validated file into a ChatAttachment: base64 payload (data-URL prefix
 * stripped), derived kind, and an object-URL preview for images. Callers should
 * run validateFile/validateAddition first; this assumes the file is acceptable.
 */
export async function fileToAttachment(file: File): Promise<ChatAttachment> {
  const mediaType = resolveMediaType(file) ?? file.type;
  const kind = kindForMediaType(mediaType);
  const dataUrl = await readAsDataUrl(file);
  const comma = dataUrl.indexOf(',');
  const data = comma >= 0 ? dataUrl.slice(comma + 1) : '';
  return {
    id: newId(),
    kind,
    mediaType,
    filename: file.name,
    data,
    size: file.size,
    previewUrl: kind === 'image' ? URL.createObjectURL(file) : undefined,
  };
}
