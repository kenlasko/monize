import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
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
  AttachmentListItem,
  AttachmentsService,
  MAX_ATTACHMENT_BYTES,
} from "./attachments.service";
import { TransactionAttachment } from "./entities/transaction-attachment.entity";

@ApiTags("Attachments")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller()
export class AttachmentsController {
  constructor(private readonly attachmentsService: AttachmentsService) {}

  @Post("transactions/:transactionId/attachments")
  @ApiOperation({ summary: "Upload a file attachment to a transaction" })
  @ApiConsumes("multipart/form-data")
  @ApiResponse({ status: 201, description: "Attachment metadata" })
  @UseInterceptors(
    // Two parts, not one: `file` is the attachment the user sees, and the
    // optional `original` is the unprocessed photo a scan came from. The size
    // limit is per file, and `files: 2` caps the request at the pair.
    FileFieldsInterceptor(
      [
        { name: "file", maxCount: 1 },
        { name: "original", maxCount: 1 },
      ],
      {
        storage: memoryStorage(),
        limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 2 },
      },
    ),
  )
  upload(
    @Request() req,
    @Param("transactionId", ParseUUIDPipe) transactionId: string,
    @UploadedFiles()
    files: {
      file?: Express.Multer.File[];
      original?: Express.Multer.File[];
    },
  ): Promise<TransactionAttachment> {
    return this.attachmentsService.create(
      req.user.id,
      transactionId,
      files?.file?.[0],
      files?.original?.[0],
    );
  }

  @Get("transactions/:transactionId/attachments")
  @ApiOperation({ summary: "List attachments for a transaction" })
  @ApiResponse({ status: 200, description: "Attachment metadata list" })
  findAll(
    @Request() req,
    @Param("transactionId", ParseUUIDPipe) transactionId: string,
  ): Promise<AttachmentListItem[]> {
    return this.attachmentsService.findAllForTransaction(
      req.user.id,
      transactionId,
    );
  }

  @Get("attachments/:id/download")
  @ApiOperation({ summary: "Download an attachment's bytes" })
  @ApiResponse({ status: 200, description: "Attachment file bytes" })
  @ApiResponse({ status: 404, description: "Attachment not found" })
  async download(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { data, contentType, filename, byteSize } =
      await this.attachmentsService.getForDownload(req.user.id, id);

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
