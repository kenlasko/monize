import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { HoldingsService } from "./holdings.service";
import { Holding } from "./entities/holding.entity";
import { AllowPat } from "../auth/pat-access/pat-access.decorator";

@ApiTags("Holdings")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@AllowPat()
@Controller("holdings")
export class HoldingsController {
  constructor(private readonly holdingsService: HoldingsService) {}

  @Get()
  @ApiOperation({ summary: "Get all holdings for the authenticated user" })
  @ApiQuery({
    name: "accountId",
    required: false,
    description: "Filter by account ID",
  })
  @ApiResponse({
    status: 200,
    description: "List of holdings",
    type: [Holding],
  })
  findAll(
    @Request() req,
    @Query("accountId") accountId?: string,
  ): Promise<Holding[]> {
    return this.holdingsService.findAll(req.user.id, accountId);
  }

  @Get("summary")
  @ApiOperation({ summary: "Get holdings summary for an account" })
  @ApiQuery({ name: "accountId", required: true, description: "Account ID" })
  @ApiResponse({ status: 200, description: "Holdings summary" })
  getSummary(
    @Request() req,
    @Query("accountId", ParseUUIDPipe) accountId: string,
  ) {
    return this.holdingsService.getHoldingsSummary(req.user.id, accountId);
  }

  @Get("at")
  @ApiOperation({
    summary: "Get holding state for (account, security) as of a given date",
    description:
      "Replays the user's investment transactions strictly earlier than `asOfDate` and returns the resulting quantity and average cost. Pass `excludeTransactionId` to omit a specific transaction (e.g. when previewing the holding state just before editing a SPLIT).",
  })
  @ApiQuery({ name: "accountId", required: true })
  @ApiQuery({ name: "securityId", required: true })
  @ApiQuery({
    name: "asOfDate",
    required: true,
    description: "ISO date string (YYYY-MM-DD)",
  })
  @ApiQuery({ name: "excludeTransactionId", required: false })
  @ApiResponse({
    status: 200,
    description: "Holding state at the requested date",
    schema: {
      type: "object",
      properties: {
        quantity: { type: "number" },
        averageCost: { type: "number" },
      },
    },
  })
  getHoldingAt(
    @Request() req,
    @Query("accountId", ParseUUIDPipe) accountId: string,
    @Query("securityId", ParseUUIDPipe) securityId: string,
    @Query("asOfDate") asOfDate: string,
    @Query("excludeTransactionId") excludeTransactionId?: string,
  ): Promise<{ quantity: number; averageCost: number }> {
    return this.holdingsService.getHoldingAt(
      req.user.id,
      accountId,
      securityId,
      asOfDate,
      excludeTransactionId,
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a holding by ID" })
  @ApiResponse({ status: 200, description: "Holding details", type: Holding })
  @ApiResponse({ status: 404, description: "Holding not found" })
  findOne(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<Holding> {
    return this.holdingsService.findOne(req.user.id, id);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a holding (only if quantity is zero)" })
  @ApiResponse({ status: 200, description: "Holding deleted successfully" })
  @ApiResponse({
    status: 403,
    description: "Cannot delete holding with non-zero quantity",
  })
  @ApiResponse({ status: 404, description: "Holding not found" })
  remove(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.holdingsService.remove(req.user.id, id);
  }

  @Post("rebuild")
  @ApiOperation({
    summary: "Rebuild all holdings from investment transactions",
    description:
      "Recalculates all holdings based on transaction history. Useful for fixing data after imports.",
  })
  @ApiResponse({
    status: 200,
    description: "Holdings rebuilt successfully",
    schema: {
      type: "object",
      properties: {
        holdingsCreated: { type: "number" },
        holdingsUpdated: { type: "number" },
        holdingsDeleted: { type: "number" },
      },
    },
  })
  rebuild(@Request() req) {
    return this.holdingsService.rebuildFromTransactions(req.user.id);
  }
}
