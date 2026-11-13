import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { OwnerOnly } from "../../delegation/decorators/delegate-access.decorator";
import {
  ApproveEmailReceiptParserDto,
  CreateEmailReceiptParserDto,
  DraftParserWithAiDto,
  GenerateParserWithAiDto,
  PreviewEmailReceiptParserDto,
  TestEmailReceiptParserDto,
  UpdateEmailReceiptParserDto,
} from "./dto/email-receipt-parser.dto";
import { EmailReceiptParserGenerateService } from "./email-receipt-parser-generate.service";
import { EmailReceiptParserPreviewService } from "./email-receipt-parser-preview.service";
import { EmailReceiptParsersService } from "./email-receipt-parsers.service";
import {
  AllowPat,
  NoPat,
  PatScope,
} from "../../auth/pat-access/pat-access.decorator";

/**
 * The user's receipt parsers (design sections 5 and 8). Owner-only: a delegate
 * ("acting as") session is refused on every route, since a parser decides what
 * is proposed for the owner's transactions. `userId` is the JWT's.
 */
@ApiTags("Email Receipts")
@AllowPat()
@Controller("email-receipt-parsers")
@UseGuards(AuthGuard("jwt"))
@OwnerOnly()
@ApiBearerAuth()
export class EmailReceiptParsersController {
  constructor(
    private readonly parsers: EmailReceiptParsersService,
    private readonly generator: EmailReceiptParserGenerateService,
    private readonly previews: EmailReceiptParserPreviewService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List my receipt parsers" })
  list(@Request() req: { user: { id: string } }) {
    return this.parsers.list(req.user.id);
  }

  @Post("test")
  @PatScope("read")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({
    summary:
      "Read a stored email with a definition that is not saved and preview the match (writes nothing)",
  })
  test(
    @Request() req: { user: { id: string } },
    @Body() dto: TestEmailReceiptParserDto,
  ) {
    return this.parsers.test(req.user.id, dto);
  }

  @Post("draft-with-ai")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary:
      "Queue a request for the assistant (or an MCP agent) to write a parser from 1 to 25 stored emails of one to five senders (at most 5 per sender); no provider is called",
  })
  draftWithAi(
    @Request() req: { user: { id: string } },
    @Body() dto: DraftParserWithAiDto,
  ) {
    return this.parsers.requestAiDraft(
      req.user.id,
      dto.receiptIds,
      dto.kind ?? "receipt",
    );
  }

  // Declared before `:id`, so the literal segment is matched first.
  @Post("generate-with-ai")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary:
      "Run the assistant now over 1 to 5 sample emails of a domain and the transactions they paid for; it saves (or, with parserId, updates) a draft parser ({ status: 'saved' }, 422 with the assistant's answer when it saved none). A user whose AI is their own agent over MCP gets a request in the AI inbox instead ({ status: 'queued', requestId }; 409 when the agent is already working on one for the domain)",
  })
  generateWithAi(
    @Request() req: { user: { id: string } },
    @Body() dto: GenerateParserWithAiDto,
  ) {
    return this.generator.generate(req.user.id, dto);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get one receipt parser" })
  get(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.parsers.get(req.user.id, id);
  }

  @Post()
  @NoPat()
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({
    summary: "Create a receipt parser (approved: a person wrote it)",
  })
  create(
    @Request() req: { user: { id: string } },
    @Body() dto: CreateEmailReceiptParserDto,
  ) {
    return this.parsers.create(req.user.id, dto);
  }

  @Patch(":id")
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({
    summary:
      "Change a receipt parser; expectedRevision is a compare-and-swap (409 when it moved on)",
  })
  update(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmailReceiptParserDto,
  ) {
    return this.parsers.update(req.user.id, id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete a receipt parser" })
  async remove(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.parsers.remove(req.user.id, id);
  }

  @Post(":id/preview")
  @PatScope("read")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({
    summary:
      "Run a parser (draft or approved) over the stored emails of its domains, read-only: the selected samples and the newest others, each with what the pipeline would do",
  })
  preview(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: PreviewEmailReceiptParserDto,
  ) {
    return this.previews.preview(req.user.id, id, dto);
  }

  @Post(":id/approve")
  @NoPat()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: "Approve a draft parser so it starts reading mail" })
  approve(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ApproveEmailReceiptParserDto,
  ) {
    return this.parsers.approve(req.user.id, id, dto);
  }
}
