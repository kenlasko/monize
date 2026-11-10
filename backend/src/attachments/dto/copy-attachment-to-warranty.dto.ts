import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsUUID } from "class-validator";
import { DOCUMENT_KINDS, DocumentKind } from "../attachment-parent";

/**
 * `POST warranties/:warrantyId/attachments/copy`: put a file the reader
 * already uploaded (a transaction's receipt, another warranty's manual) on
 * this warranty too.
 */
export class CopyAttachmentToWarrantyDto {
  @ApiProperty({ description: "The attachment whose file is copied" })
  @IsUUID()
  sourceAttachmentId: string;

  @ApiPropertyOptional({
    enum: DOCUMENT_KINDS,
    description:
      "What the copy is on this warranty; defaults to the source's own kind",
  })
  @IsOptional()
  @IsIn(DOCUMENT_KINDS)
  documentKind?: DocumentKind;

  @ApiPropertyOptional({
    description:
      "Client-chosen id that makes a retried copy return the first one's result instead of a second copy",
  })
  @IsOptional()
  @IsUUID()
  operationId?: string;
}
