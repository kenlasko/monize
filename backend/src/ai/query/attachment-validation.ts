import { BadRequestException } from "@nestjs/common";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  AttachmentDto,
  AttachmentKind,
} from "./dto/ai-query.dto";
import { tr } from "../../i18n/translate";

/**
 * Shared, stateless attachment validation -- the single source of truth for both
 * the native AI query path (AiQueryService.buildCurrentUserMessage) and the
 * reverse relay path (RelayAttachmentStore). Never trust the client: checks the
 * declared kind against the media-type family, the decoded per-file and total
 * size, and the leading magic bytes so a client can't mislabel a file. Throws
 * BadRequestException with the existing i18n keys on any failure.
 */
export function validateAttachments(attachments: AttachmentDto[]): void {
  let totalBytes = 0;
  for (const att of attachments) {
    if (mediaTypeKind(att.mediaType) !== att.kind) {
      throw new BadRequestException(
        tr(
          "errors.ai.attachmentTypeMismatch",
          "An attachment's type does not match its file format.",
        ),
      );
    }
    const buf = Buffer.from(att.data, "base64");
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException(
        tr(
          "errors.ai.attachmentTooLarge",
          "An attachment exceeds the maximum file size.",
        ),
      );
    }
    if (!hasExpectedMagicBytes(att.mediaType, buf)) {
      throw new BadRequestException(
        tr(
          "errors.ai.attachmentCorrupt",
          "An attachment could not be read or is not the file type it claims to be.",
        ),
      );
    }
    totalBytes += buf.length;
  }
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new BadRequestException(
      tr(
        "errors.ai.attachmentsTooLarge",
        "The attachments exceed the total size limit.",
      ),
    );
  }
}

/** Map a MIME type to its attachment kind, or null if unsupported. */
export function mediaTypeKind(mediaType: string): AttachmentKind | null {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType === "text/csv" || mediaType === "text/plain") return "text";
  return null;
}

/**
 * Verify the decoded bytes begin with the signature expected for the declared
 * media type. Text files have no reliable signature, so they pass.
 */
export function hasExpectedMagicBytes(mediaType: string, buf: Buffer): boolean {
  if (mediaType === "text/csv" || mediaType === "text/plain") return true;
  if (buf.length < 4) return false;
  switch (mediaType) {
    case "image/png":
      return (
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
      );
    case "image/jpeg":
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "image/gif":
      return buf.toString("ascii", 0, 3) === "GIF";
    case "image/webp":
      return (
        buf.length >= 12 &&
        buf.toString("ascii", 0, 4) === "RIFF" &&
        buf.toString("ascii", 8, 12) === "WEBP"
      );
    case "application/pdf":
      return buf.toString("ascii", 0, 4) === "%PDF";
    default:
      return false;
  }
}
