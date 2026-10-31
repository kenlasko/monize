import {
  IsBoolean,
  IsIn,
  IsInt,
  ValidateIf,
  IsString,
  IsUUID,
  Length,
  Min,
} from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import {
  DOCUMENT_KINDS,
  DocumentKind,
} from "../../attachments/attachment-parent";

export class SharedDocumentUploadDto {
  @IsUUID("4") operationId: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(DOCUMENT_KINDS)
  documentKind?: DocumentKind;
}
export class PublishSharedDocumentDto extends SharedDocumentUploadDto {
  @IsUUID() sourceAttachmentId: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  entryId?: string;
  @IsBoolean() includeOriginal: boolean;
}
export class UpdateSharedDocumentDto {
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsUUID()
  entryId?: string | null;
  @IsInt() @Min(1) expectedRevision: number;
  @IsString() @Length(1, 255) @SanitizeHtml() filename: string;
  @IsIn(DOCUMENT_KINDS) documentKind: DocumentKind;
}
