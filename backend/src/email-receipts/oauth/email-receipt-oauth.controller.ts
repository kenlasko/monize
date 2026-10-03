import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { OwnerOnly } from "../../delegation/decorators/delegate-access.decorator";
import {
  CompleteEmailReceiptOAuthDto,
  StartEmailReceiptOAuthDto,
} from "./dto/email-receipt-oauth.dto";
import { EmailReceiptOAuthService } from "./email-receipt-oauth.service";

/**
 * Connecting the receipts mailbox with Google or Microsoft 365 (design section
 * 3a). Owner-only like the rest of the mailbox: a delegate ("acting as")
 * session is refused on every route, since the mailbox is the owner's own
 * credential. `userId` is the JWT's, and it is what the `state` of a flow is
 * checked against (INV-RECEIPT-007). No token, code or secret is ever returned.
 */
@ApiTags("Email Receipts")
@Controller("email-receipts/mailbox/oauth")
@UseGuards(AuthGuard("jwt"))
@OwnerOnly()
@ApiBearerAuth()
export class EmailReceiptOAuthController {
  constructor(private readonly oauth: EmailReceiptOAuthService) {}

  @Get("providers")
  @ApiOperation({
    summary:
      "Which OAuth providers this server offers, and the redirect URI registered with them",
  })
  providers() {
    return this.oauth.providers();
  }

  @Post("start")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Start connecting the mailbox with a provider: the authorization URL to send the browser to",
  })
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  start(
    @Request() req: { user: { id: string } },
    @Body() dto: StartEmailReceiptOAuthDto,
  ) {
    return this.oauth.start(req.user.id, dto);
  }

  @Post("complete")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Finish connecting the mailbox with the code and state the provider redirected back with",
  })
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  complete(
    @Request() req: { user: { id: string } },
    @Body() dto: CompleteEmailReceiptOAuthDto,
  ) {
    return this.oauth.complete(req.user.id, dto);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      "Disconnect: delete the stored refresh token and switch the poll off (the mailbox and its emails stay)",
  })
  async disconnect(@Request() req: { user: { id: string } }): Promise<void> {
    await this.oauth.disconnect(req.user.id);
  }
}
