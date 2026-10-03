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
  TestEmailReceiptParserDto,
  UpdateEmailReceiptParserDto,
} from "./dto/email-receipt-parser.dto";
import { EmailReceiptParsersService } from "./email-receipt-parsers.service";

/**
 * The user's receipt parsers (design sections 5 and 8). Owner-only: a delegate
 * ("acting as") session is refused on every route, since a parser decides what
 * is proposed for the owner's transactions. `userId` is the JWT's.
 */
@ApiTags("Email Receipts")
@Controller("email-receipt-parsers")
@UseGuards(AuthGuard("jwt"))
@OwnerOnly()
@ApiBearerAuth()
export class EmailReceiptParsersController {
  constructor(private readonly parsers: EmailReceiptParsersService) {}

  @Get()
  @ApiOperation({ summary: "List my receipt parsers" })
  list(@Request() req: { user: { id: string } }) {
    return this.parsers.list(req.user.id);
  }

  @Post("test")
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

  @Get(":id")
  @ApiOperation({ summary: "Get one receipt parser" })
  get(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.parsers.get(req.user.id, id);
  }

  @Post()
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

  @Post(":id/approve")
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
