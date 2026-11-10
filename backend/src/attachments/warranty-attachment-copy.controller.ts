import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CopyAttachmentToWarrantyDto } from "./dto/copy-attachment-to-warranty.dto";
import { TransactionAttachment } from "./entities/transaction-attachment.entity";
import { WarrantyAttachmentCopyService } from "./warranty-attachment-copy.service";

/**
 * The warranty's "add an existing document" route. Owner only, as every
 * warranty upload is: no `@AllowDelegate`, so a delegate is refused by the
 * global delegate guard before the service runs.
 */
@ApiTags("Attachments")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller()
export class WarrantyAttachmentCopyController {
  constructor(private readonly copies: WarrantyAttachmentCopyService) {}

  @Post("warranties/:warrantyId/attachments/copy")
  @ApiOperation({
    summary:
      "Add a document already uploaded elsewhere (a transaction's receipt, another warranty's manual) to a warranty, as a copy",
  })
  @ApiResponse({ status: 201, description: "The new attachment's metadata" })
  @ApiResponse({
    status: 400,
    description: "Not the reader's own document, or already on this warranty",
  })
  @ApiResponse({ status: 404, description: "Attachment or warranty not found" })
  copy(
    @Request() req,
    @Param("warrantyId", ParseUUIDPipe) warrantyId: string,
    @Body() dto: CopyAttachmentToWarrantyDto,
  ): Promise<TransactionAttachment> {
    return this.copies.copyToWarranty(req.user.id, warrantyId, dto);
  }
}
