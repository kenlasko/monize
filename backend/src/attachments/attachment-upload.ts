import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { createHash } from "crypto";
import { tr } from "../i18n/translate";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  sniffAttachmentMime,
} from "./attachment-mime.util";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Uploaded file shape we depend on -- a subset of Express.Multer.File so callers
 * (and tests) need not construct the full multer object.
 */
export interface UploadedAttachmentFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/** An uploaded part that has passed every admission check, with what they derived. */
export interface ValidatedUpload {
  filename: string;
  contentType: string;
  buffer: Buffer;
  sha256: string;
}

export function validateAttachmentUpload(
  file: UploadedAttachmentFile | undefined,
): ValidatedUpload {
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new BadRequestException(
      tr("errors.attachments.empty", "Uploaded file is empty"),
    );
  }
  if (file.buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new PayloadTooLargeException(
      tr(
        "errors.attachments.fileTooLarge",
        `File exceeds the maximum size of ${MAX_ATTACHMENT_BYTES} bytes`,
        { max: MAX_ATTACHMENT_BYTES },
      ),
    );
  }

  const contentType = sniffAttachmentMime(file.buffer);
  if (!contentType) {
    const types = ALLOWED_ATTACHMENT_MIME_TYPES.join(", ");
    throw new UnsupportedMediaTypeException(
      tr(
        "errors.attachments.unsupportedType",
        `Unsupported file type. Allowed types: ${types}`,
        { types },
      ),
    );
  }

  return {
    filename: sanitizeFilename(file.originalname),
    contentType,
    buffer: file.buffer,
    sha256: createHash("sha256").update(file.buffer).digest("hex"),
  };
}

/**
 * Reduce a client-supplied filename to a safe display name: strip any path
 * components and control characters, collapse to a fallback when empty, and cap
 * at the column length.
 */
export function sanitizeFilename(raw: string | undefined): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  // Remove control chars (including CR/LF) that could break Content-Disposition.
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  const safe = cleaned.length > 0 ? cleaned : "attachment";
  return safe.slice(0, 255);
}
