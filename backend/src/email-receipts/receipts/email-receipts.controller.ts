import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { OwnerOnly } from "../../delegation/decorators/delegate-access.decorator";
import { EmailReceiptAiService } from "../ai/email-receipt-ai.service";
import {
  AskAiEmailReceiptDto,
  LinkEmailReceiptDto,
  ListEmailReceiptsDto,
} from "./dto/email-receipts.dto";
import { EmailReceiptsService } from "./email-receipts.service";

/**
 * The stored order-confirmation emails (design sections 6 and 8): the list, one
 * email, and what a person does with it. Owner-only: a delegate ("acting as")
 * session is refused on every route, since an email and its proposal belong to
 * the owner alone. `userId` is the JWT's, never the request's.
 *
 * `email-receipts/mailbox` is the mailbox controller's and is registered first
 * in the module, so `:id` (a UUID, by `ParseUUIDPipe`) never sees it.
 */
@ApiTags("Email Receipts")
@Controller("email-receipts")
@UseGuards(AuthGuard("jwt"))
@OwnerOnly()
@ApiBearerAuth()
export class EmailReceiptsController {
  constructor(
    private readonly receipts: EmailReceiptsService,
    private readonly ai: EmailReceiptAiService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "List my stored emails, newest first (no text), with their state",
  })
  list(
    @Request() req: { user: { id: string } },
    @Query() query: ListEmailReceiptsDto,
  ) {
    return this.receipts.list(req.user.id, {
      status: query.status,
      limit: query.limit,
    });
  }

  @Get(":id")
  @ApiOperation({
    summary:
      "One stored email with its text, what the parser read and the candidates",
  })
  get(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.receipts.get(req.user.id, id);
  }

  @Post(":id/reprocess")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: "Run an email through the pipeline again" })
  reprocess(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.receipts.reprocess(req.user.id, id);
  }

  @Post(":id/link")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: "Link an email to the transaction it paid for" })
  link(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: LinkEmailReceiptDto,
  ) {
    return this.receipts.link(req.user.id, id, dto.transactionId);
  }

  @Post(":id/ignore")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Ignore an email: it proposes nothing" })
  ignore(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.receipts.ignore(req.user.id, id);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Delete a stored email and dismiss its open request",
  })
  async remove(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.receipts.remove(req.user.id, id);
  }

  @Post(":id/ask-ai")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary:
      "Queue an AI review request for the email's transaction (optionally a chosen one); the assistant in the chat answers it",
  })
  askAi(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AskAiEmailReceiptDto,
  ) {
    return this.ai.askAi(req.user.id, id, dto.transactionId || null);
  }

  @Post(":id/draft-parser")
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary:
      "Draft a parser for the email's sender with the AI (a draft: it reads nothing until approved)",
  })
  draftParser(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.ai.draftParser(req.user.id, id);
  }
}
