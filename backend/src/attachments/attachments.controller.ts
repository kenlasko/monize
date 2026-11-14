import {
  Body,
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Patch,
  Request,
  Res,
  UseGuards,
  UploadedFiles,
  ParseUUIDPipe,
  HttpCode,
} from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { UseInterceptors } from "@nestjs/common";
import { memoryStorage } from "multer";
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { Response } from "express";
import {
  AllowDelegate,
  DelegateRequiresSection,
} from "../delegation/decorators/delegate-access.decorator";
import {
  AttachmentListItem,
  AttachmentsService,
  MAX_ATTACHMENT_BYTES,
} from "./attachments.service";
import { TransactionAttachment } from "./entities/transaction-attachment.entity";
import { WarrantyAttachmentUploadDto } from "./dto/warranty-attachment-upload.dto";
import { UpdateDocumentKindDto } from "./dto/update-document-kind.dto";
import { AttachmentListItemDto } from "./dto/attachment-list-item.dto";
import { AllowPat } from "../auth/pat-access/pat-access.decorator";

/** The two named parts of one request, the same on every upload route. */
interface UploadParts {
  file?: Express.Multer.File[];
  original?: Express.Multer.File[];
}

/**
 * Two parts, not one: `file` is the attachment the user sees, and the optional
 * `original` is the unprocessed photo a scan came from. The size limit is per
 * file, and `files: 2` caps the request at the pair. One interceptor for both
 * parents, so a warranty's upload can never admit what a transaction's refuses.
 */
const uploadPairInterceptor = FileFieldsInterceptor(
  [
    { name: "file", maxCount: 1 },
    { name: "original", maxCount: 1 },
  ],
  {
    storage: memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 2 },
  },
);

/**
 * One route per parent (WTY-003): the parent's kind is the route, its id the
 * path parameter, and the service receives the pair as an `AttachmentParent`.
 * A delegate reaches only the two warranty reads, through the `warranties`
 * section (design decision 9): the warranty's document list, and the download,
 * which the service additionally refuses when the row's parent is a
 * transaction, so a transaction's attachments keep their owner-only rule.
 */
@ApiTags("Attachments")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@AllowPat()
@Controller()
export class AttachmentsController {
  constructor(private readonly attachmentsService: AttachmentsService) {}

  @Post("transactions/:transactionId/attachments")
  @ApiOperation({ summary: "Upload a file attachment to a transaction" })
  @ApiConsumes("multipart/form-data")
  @ApiResponse({ status: 201, description: "Attachment metadata" })
  @UseInterceptors(uploadPairInterceptor)
  upload(
    @Request() req,
    @Param("transactionId", ParseUUIDPipe) transactionId: string,
    @UploadedFiles() files: UploadParts,
  ): Promise<TransactionAttachment> {
    return this.attachmentsService.create(
      req.user.id,
      { kind: "transaction", id: transactionId },
      files?.file?.[0],
      files?.original?.[0],
    );
  }

  @Get("transactions/:transactionId/attachments")
  @ApiOperation({
    summary:
      "List a transaction's attachments: its own, then the documents of every warranty linked to it",
  })
  @ApiResponse({
    status: 200,
    description: "Attachment metadata list",
    type: [AttachmentListItemDto],
  })
  findAll(
    @Request() req,
    @Param("transactionId", ParseUUIDPipe) transactionId: string,
  ): Promise<AttachmentListItem[]> {
    return this.attachmentsService.findAllFor(req.user.id, {
      kind: "transaction",
      id: transactionId,
    });
  }

  @Post("warranties/:warrantyId/attachments")
  @ApiOperation({
    summary:
      "Upload a document (receipt, manual, photo, warranty certificate or other) to a warranty",
  })
  @ApiConsumes("multipart/form-data")
  @ApiResponse({ status: 201, description: "Attachment metadata" })
  @ApiResponse({ status: 404, description: "Warranty not found" })
  @UseInterceptors(uploadPairInterceptor)
  uploadForWarranty(
    @Request() req,
    @Param("warrantyId", ParseUUIDPipe) warrantyId: string,
    @UploadedFiles() files: UploadParts,
    @Body() body: WarrantyAttachmentUploadDto,
  ): Promise<TransactionAttachment> {
    return this.attachmentsService.create(
      req.user.id,
      { kind: "warranty", id: warrantyId },
      files?.file?.[0],
      files?.original?.[0],
      body.documentKind,
    );
  }

  @Get("warranties/:warrantyId/attachments")
  @AllowDelegate()
  @DelegateRequiresSection("warranties")
  @ApiOperation({ summary: "List a warranty's documents" })
  @ApiResponse({
    status: 200,
    description: "Attachment metadata list",
    type: [AttachmentListItemDto],
  })
  findAllForWarranty(
    @Request() req,
    @Param("warrantyId", ParseUUIDPipe) warrantyId: string,
  ): Promise<AttachmentListItem[]> {
    return this.attachmentsService.findAllFor(req.user.id, {
      kind: "warranty",
      id: warrantyId,
    });
  }

  @Get("attachments/:id/download")
  @AllowDelegate()
  @DelegateRequiresSection("warranties")
  @ApiOperation({ summary: "Download an attachment's bytes" })
  @ApiResponse({ status: 200, description: "Attachment file bytes" })
  @ApiResponse({
    status: 403,
    description: "A delegate asked for a transaction's attachment",
  })
  @ApiResponse({ status: 404, description: "Attachment not found" })
  @ApiResponse({
    status: 503,
    description:
      "The attachment's bytes are held in a storage backend this deployment is " +
      "not configured to reach; the response names it",
  })
  async download(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { data, contentType, filename, byteSize } =
      await this.attachmentsService.getForDownload(req.user.id, id, {
        isDelegate: req.user.isActing === true,
      });

    res.set({
      "Content-Type": contentType,
      "Content-Length": String(byteSize),
      "Content-Disposition": contentDisposition(filename),
      // Never let the browser reinterpret the bytes as a different type, and
      // neutralise any active content if it somehow slips the MIME whitelist.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Cache-Control": "private, max-age=86400",
    });
    res.end(data);
  }

  @Patch("attachments/:id")
  @ApiOperation({ summary: "Change what a warranty's document is" })
  @ApiResponse({
    status: 200,
    description: "The updated attachment",
    type: AttachmentListItemDto,
  })
  @ApiResponse({
    status: 400,
    description: "The attachment is a transaction's, which has no kind",
  })
  @ApiResponse({ status: 404, description: "Attachment not found" })
  updateDocumentKind(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateDocumentKindDto,
  ): Promise<AttachmentListItem> {
    return this.attachmentsService.updateDocumentKind(
      req.user.id,
      id,
      body.documentKind,
    );
  }

  @Delete("attachments/:id")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete an attachment" })
  @ApiResponse({ status: 204, description: "Attachment deleted" })
  @ApiResponse({ status: 404, description: "Attachment not found" })
  remove(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.attachmentsService.remove(req.user.id, id);
  }
}

/**
 * Build a safe Content-Disposition header. ASCII filenames use the plain
 * `filename=`; anything else is offered via RFC 5987 `filename*` (UTF-8) with an
 * ASCII fallback. The service already stripped control characters; we still
 * escape quotes/backslashes in the quoted form.
 */
export function contentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_");
  const quoted = asciiFallback.replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${quoted}"; filename*=UTF-8''${encoded}`;
}
