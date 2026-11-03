import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Request,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { ReplaceLoanFeesDto } from "./dto/loan-fee.dto";
import { LoanFeesService, LoanFeeView } from "./loan-fees.service";

/**
 * A mortgage's fees (docs/specs/mortgage-fees.md section 7). Owner-only on
 * every route by the global delegate guard's default; `userId` comes from the
 * JWT and never from the request.
 */
@ApiTags("Accounts")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("accounts/:accountId/loan-fees")
export class LoanFeesController {
  constructor(private readonly service: LoanFeesService) {}

  @Get()
  @ApiOperation({ summary: "List a mortgage's fees, in display order" })
  @ApiResponse({ status: 200, description: "The fees" })
  @ApiResponse({ status: 404, description: "Account not found" })
  list(
    @Request() req,
    @Param("accountId", ParseUUIDPipe) accountId: string,
  ): Promise<LoanFeeView[]> {
    return this.service.list(req.user.id, accountId);
  }

  @Put()
  @ApiOperation({
    summary:
      "Replace a mortgage's fees and update the lines of its scheduled payment to match",
  })
  @ApiResponse({ status: 200, description: "The new fee set" })
  @ApiResponse({ status: 400, description: "A fee was refused" })
  @ApiResponse({ status: 404, description: "Account not found" })
  replace(
    @Request() req,
    @Param("accountId", ParseUUIDPipe) accountId: string,
    @Body() dto: ReplaceLoanFeesDto,
  ): Promise<LoanFeeView[]> {
    return this.service.replace(req.user.id, accountId, dto.fees);
  }
}
